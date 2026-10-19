// Private orch entries: request {request} retains immutable admitted envelopes;
// drain {rid,fence} and undrain {rid} record durable dispatch admission: a drain holds the workflows that exist when it is
// recorded (until resume); workflows created after it run normally.
// Workflow entries: ev {n}; call {pos,key,gen,spec,fingerprint}; refused {pos,key,spec,fingerprint,reason};
// reused {pos,key,gen,spec,fingerprint,from}; exposed {pos}; value {n,kind,value};
// generation{rid,key,gen,from,spec,revision,opening,notes?} is a send resolution outside the script (notes: the pending
// notes its opening carries, see notes.ts); pending-note{rid,call,key,message} records a notify for a sealed call;
// its seal has a finished attention independent of workflow completion.
// resumed {rid,n} supersedes a terminal park. emit {pos,value} records script outputs.
// stop-requested {rid,call?} marks a call or workflow stop as taking effect, so its replay is applied, not already-sealed.
// Orch entry pruned {rid,wid,endedAt,bytes,status,request?,spec_digest?} is the decisive record of a prune: appended before
// the journal handle is closed and w/<wid> and its staging dirs are removed (bytes = footprint measured just before;
// status = the final workflow status; request/spec_digest when the workflow was created by a request id, request-id tombstone).
// Nothing is rewritten (A1): the admitted request and created entries stay, so a retried id still resolves to this wid.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from '../kernel/ids.ts';
import { LifecycleFold, planDecisions, type DecisionRecord, type Decision } from '../kernel/lifecycle.ts';
import { scanInbox } from '../kernel/mailbox.ts';
import { orchInbox, pinnedDir } from '../paths.ts';
import { SESSION_ID, requestId, specDigest } from '../requests.ts';
import { JT, attentionEntries, isCommandCall, isEntry, type Entry, type Request, type RunBody, type ReviseBody, type DrainBody, type RestartBody, type ResumeBody, type PruneBody, type SendBody, type EvalToOrch, type CallResult, type CallSpec } from '../types.ts';
import type { DiscoveryOptions } from '../compat/agents.ts';
import type { CallTicket, Executor, Ledgers } from './contract.ts';
import { isForceRestart, restartRefusal } from './restart.ts';
import { EvaluatorClient, type EvaluatorTransport } from './evaluator-client.ts';
import { Store, revisionEntries, terminalEntry, type Workflow } from './store.ts';
import { formatUsage, holdOf, refusedResult, snapshotFromEntries } from './snapshot.ts';
import { validateCallSpec } from '../compat/spec.ts';
import { EventPump } from '../events/pump.ts';
import { labelsProblem } from '../events/labels.ts';
import { WaitTracker, waitCollector, startWaiting, type WaitSeed } from '../events/waiting.ts';
import { readPage } from '../events/log.ts';
import { eventsLog } from '../paths.ts';
import { parseModel, resolveModel } from '../compat/model.ts';
import { generationModel } from './model-choice.ts';
import { PENDING_NOTE, generationRids, openingMessage, pendingFollowUps, pendingNotes, unsettledForward, unsettledNotify } from './notes.ts';
import { journalAppends } from '../kernel/journal.ts';
import { callEntries, entriesOf } from './executor/indexes.ts';
import { unsealedCommandCalls } from './executor/command.ts';
import { lazy, writeSettled } from './settled.ts';
import { STATS_EVERY_MS, readBytes, writeStats, type OrchestratorStats } from './stats.ts';

const tail = (text: string, n: number) => text.length > n ? `…${text.slice(-(n - 1))}` : text;
const charged = (u?: { input: number; output: number; costUsd: number }) => u && (u.input || u.output || u.costUsd) ? formatUsage(u) : undefined;
const wakeStatus = (status?: string) => {
  if (status === 'gate-failed') return 'failed';
  if (status === 'parked' || status === undefined) return 'unknown';
  return status;
};
/** A follow-up still going when its workflow ended has no result yet: say so instead of calling it unknown. */
/** A follow-up generation still going when its workflow ended is named by its phase; anything else without a result is unknown. */
const going = (c: { gen: number; phase: string; result?: CallResult }) => !c.result && c.phase !== 'sealed' && c.gen > 1;
const callStatus = (c: { gen: number; phase: string; result?: CallResult }) => going(c) ? c.phase : wakeStatus(c.result?.status);
/** v12 §6: Name available agents in the refusal instead of making the caller guess. */
export function unknownAgent(name: unknown, agents: readonly { name: string }[]): string {
  return `unknown agent ${JSON.stringify(name)}; available agents: ${agents.map(a => a.name).sort().join(", ") || "none"}`;
}
/** v12 §3: Wake with bounded latest-per-key results, preferring structured reports and preserving clipped tails. */
export function finishedText(wid: string, entries: readonly Entry[], call?: string, commandOutput = false): string {
  const snap = snapshotFromEntries(wid, entries), label = snap.name ?? wid;
  const latest = new Map(snap.calls.map(c => [c.key, c]));
  const calls = call ? snap.calls.filter(c => c.callId === call) : [...latest.values()];
  const counts = new Map<string, number>();
  for (const c of calls) {
    const status = callStatus(c);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = [...counts].map(([status, count]) => `${count} ${status}`);
  const heading = call ? `${label}/${calls[0]?.key ?? call}@${calls[0]?.gen ?? '?'} (follow-up) ${calls[0] ? callStatus(calls[0]) : 'unknown'}:` :
    `${label} (${wid}) ${snap.status}${parts.length ? `: ${parts.join('; ')}` : ''}`;
  const footer = `${snap.error ? `\nError: ${tail(snap.error, 500)}` : ''}${charged(snap.usage) ? `\nUsage: ${charged(snap.usage)}` : ''}\nFull output: subagents status wid:${wid}`;
  const prefix = tail(heading, Math.max(1, 6000 - footer.length - 1));
  // Share the space fairly: short results take what they need and the rest goes to longer ones (one agent may use it
  // all), so a notice is cut only when the results really exceed it; usage and the full-output hint are never lost.
  const want = calls.map(c => {
    const message = commandOutput && c.command !== undefined ? c.result?.output : c.result && Object.hasOwn(c.result, 'data') ? JSON.stringify(c.result.data) : c.result?.output;
    return 120 + (message?.length ?? 0) + Math.min(320, c.result?.error?.length ?? 0);
  });
  const shares = new Array<number>(calls.length).fill(0);
  let pool = Math.max(0, 6000 - prefix.length - footer.length);
  for (const [n, i] of [...want.keys()].sort((a, b) => want[a]! - want[b]!).entries()) {
    shares[i] = Math.min(want[i]!, Math.floor(pool / (calls.length - n))); pool -= shares[i]!;
  }
  const lines: string[] = [];
  for (const [i, c] of calls.entries()) {
    const allowance = shares[i]!;
    if (allowance < 2) continue;
    const result = c.result;
    // A stop leaves the agent's edits where they are; say so, so nobody mistakes a stopped agent for a clean undo.
    const still = going(c) ? ' (a follow-up still going; you are told when it ends)' : '';
    const name = `${c.key}${c.gen > 1 ? `@${c.gen}` : ''}: ${callStatus(c)}${still}${result?.status === 'stopped' ? ' (edits it made so far are left in place)' : ''}`;
    const title = `\n${tail(name, allowance - 1)}`;
    const error = result?.error && allowance - title.length > 10 ? `\n  Error: ${tail(result.error, Math.min(300, allowance - title.length - 9))}` : '';
    const space = allowance - title.length - error.length;
    const message = commandOutput && c.command !== undefined ? result?.output : result && Object.hasOwn(result, 'data') ? JSON.stringify(result.data) : result?.output;
    const line = title + (message && space > 4 ? `\n  ${tail(message.trimEnd(), space - 3)}` : '') + error;
    lines.push(line);
  }
  return `${prefix}${lines.join('')}${footer}`;
}

export function wakeText(rid: string, wid: string, done: Entry, entries: readonly Entry[]): string {
  const calls = [...new Map(snapshotFromEntries(wid, entries).calls.map(c => [c.key, c])).values()];
  const lines = calls.slice(0, 20).map(c => {
    const data = c.command !== undefined ? c.result?.data as { exitCode?: number | null; signal?: string | null; durationMs?: number } | undefined : undefined;
    const ms = data?.durationMs ?? (c.endedAt !== undefined && c.startedAt !== undefined ? c.endedAt - c.startedAt : 0);
    return `${c.key}: ${callStatus(c)}${data?.exitCode != null ? ` exit ${data.exitCode}` : ''}${data?.signal ? ` signal ${data.signal}` : ''} (${Math.max(0, Math.round(ms))}ms)`;
  });
  if (calls.length > 20) lines.push(`… ${calls.length - 20} more`);
  const head = `Durable run ${rid} (${wid}) that you started with --wake caller finished: ${done.status}.\n${lines.join('\n')}\n`;
  const prefix = head.slice(0, 4000), space = 4000 - prefix.length;
  return prefix + (space > 0 ? tail(finishedText(wid, entries, undefined, true), space) : '');
}

type State = { wf: Workflow; ev: number; calls: Map<number, Entry>; proposed: Set<number>; exposures: Entry[]; exposed: Set<number>; sent: number; replaying: boolean; ready: Map<number, CallResult>; running: Set<number>; outputs: Map<number, Entry>; values: Entry[]; needs: number };
export interface EngineOptions { evaluator?: EvaluatorTransport; discovery?: DiscoveryOptions }

/** A1, P2, P10, P11: Serialize decisions while executions run independently. */
/** A key's latest call in the current revision: its first call or its newest generation. */
function latestCall(wf: Workflow, key: string): Entry | undefined {
  return revisionEntries(wf).findLast(e => (e.type === 'call' || e.type === 'generation') && String(e.key) === key);
}
export class Engine {
  readonly store: Store;
  /** The cross-workflow event log's writer (derives milestones from the journals; waiting/moving emits through it). */
  readonly events: EventPump;
  private waiting?: { stop(): Promise<void>; tick(): Promise<void> };
  private ledgers: Ledgers;
  private executor: Executor;
  private evaluator: EvaluatorTransport;
  private discovery?: DiscoveryOptions;
  private states = new Map<string, State>();
  private queue: Promise<void> = Promise.resolve();
  private failure?: unknown;
  private closed = false;
  private restarting = false;
  private generations = new Set<string>();
  /** The tail of each workflow's generation openings, see serialOpen. */
  private opening = new Map<string, Promise<void>>();
  // wid -> executor runs whose follow-up has not run yet (prune never closes a journal they may still append to).
  private running = new Map<string, number>();
  /** Drain: held by a drain that applies to it (all, its session's origin, or itself) and recorded after its creation. */
  private held(wid: string): boolean {
    return holdOf(this.ledgers.orch.entries(), wid, this.store.workflows.get(wid)?.origin) !== undefined;
  }
  /** Follow-ups (generations) of the current revision that have not ended: on a finished workflow they are its only live work. */
  private openFollowUps(wf: Workflow): boolean {
    if (lazy(wf)) return false; // settled: none open
    const log = revisionEntries(wf), ended = new Set(log.filter(e => e.type === JT.sealed || e.type === 'retired').map(e => String(e.call)));
    return log.some(e => e.type === 'generation' && !ended.has(`${wf.wid}@${wf.revision}/${e.key}@${e.gen}`));
  }
  private watcher?: FSWatcher;
  private poll?: ReturnType<typeof setInterval>;
  constructor(ledgers: Ledgers, executor: Executor, options: EngineOptions = {}) {
    this.ledgers = ledgers; this.executor = executor; this.discovery = options.discovery;
    this.store = new Store(ledgers); this.evaluator = options.evaluator ?? new EvaluatorClient(ledgers);
    this.events = new EventPump({ home: ledgers.home, orch: ledgers.orch, store: this.store, retentionMs: () => ledgers.config.k?.eventRetentionMs });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, error => { this.failure ??= error; });
    return result;
  }
  private background(fn: () => Promise<void>) { if (!this.closed) void this.serial(fn).catch(() => {}); }
  private hold(wid: string) {
    this.running.set(wid, (this.running.get(wid) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true; const n = this.running.get(wid)! - 1; if (n) this.running.set(wid, n); else this.running.delete(wid);
      const wf = this.store.workflows.get(wid); if (wf) this.settle(wf);
    };
  }
  /** Nothing of the workflow is live: it ended (or parked), no script runs, no executor run or follow-up is open. */
  private quiescent(wf: Workflow): boolean {
    if (!this.terminal(wf) || this.wakePending(wf) || this.states.has(wf.wid) || this.running.has(wf.wid) || this.openFollowUps(wf)) return false;
    for (const id of this.generations) if (id.startsWith(`${wf.wid}@`)) return false;
    return true;
  }
  /** A workflow with nothing live rests its journal: the descriptor closes and nothing reads it periodically; the next
   *  append (a follow-up, resume, revise, stop, prune or a late executor record) reopens it. Only a descriptor is
   *  released: the entries stay in memory, so every decision reads them as before. */
  private settle(wf: Workflow) {
    if (wf.journal.closed) return;
    const quiet = wf.journal.resting = this.quiescent(wf);
    if (quiet) { this.recordSettled(wf); this.store.releasePins(wf); }
  }
  /** Journal lengths of the workflows whose settled record (settled.ts) was last written or found not due. */
  private settledAt = new Map<string, number>();
  /** Write the settled record of a quiescent workflow whose journal is decoded, once per journal length; a workflow
   *  that is not settled has its record removed. Never from a poller: from settle (start, seals, ends). */
  private recordSettled(wf: Workflow) {
    if (wf.journal.loaded === false || !this.executor.recovered) return;
    const length = wf.journal.count?.() ?? wf.journal.entries().length;
    if (this.settledAt.get(wf.wid) === length) return;
    this.settledAt.set(wf.wid, length);
    writeSettled(this.ledgers.home, wf, call => this.executor.recovered!(wf.journal, call));
  }
  /** Intake passes that ran (ms timestamps of the last minute) and the ledger length after the last one. */
  private passes: number[] = [];
  private consumed?: { length: number; pending: boolean };
  /** Counters of this process for status and doctor (published to orchestrator-stats.json). */
  stats(now = Date.now()): OrchestratorStats {
    while (this.passes.length && this.passes[0]! < now - 60_000) this.passes.shift();
    let live = 0, open = 0;
    for (const wf of this.store.workflows.values()) { if (!wf.journal.resting) live++; if (wf.journal.descriptorOpen !== false && !wf.journal.closed) open++; }
    const rchar = readBytes(), since = Math.min(60_000, now - this.started);
    return { pid: process.pid, at: now, workflows: this.store.workflows.size, liveWorkflows: live, openJournals: open,
      passesPerSecond: Math.round(this.passes.length / Math.max(1, since / 1000) * 100) / 100, ...(rchar !== undefined ? { readBytes: rchar } : {}) };
  }
  private started = Date.now();
  private terminal(wf: Workflow) { return lazy(wf) ? wf.settled.done : terminalEntry(revisionEntries(wf)); }
  private intakeFold = new LifecycleFold();
  private intakeSeen = 0;
  /** Journal positions preserve retained-envelope order, even for repeated request entries. */
  private retained = new Map<number, Request>();
  private retainedAt = new Map<string, Set<number>>();
  private sends = new Map<string, { at: number; request: Request }[]>();
  private rejectedStages = new Set<string>();
  private withdrawnStages = new Set<string>();
  /** One writer appends committed entries; folds never advance past an uncommitted append or an awaited decision. */
  private lifecycle(): LifecycleFold {
    const entries = this.ledgers.orch.committed?.() ?? this.ledgers.orch.entries();
    for (; this.intakeSeen < entries.length; this.intakeSeen++) {
      const entry = entries[this.intakeSeen]!;
      if (entry.type === 'request') {
        const request = entry.request as Request;
        if (request.kind === 'send') {
          const sent = this.sends.get(request.rid) ?? [];
          sent.push({ at: this.intakeSeen, request }); this.sends.set(request.rid, sent);
        }
        if (!this.intakeFold.resolved.has(request.rid)) {
          this.retained.set(this.intakeSeen, request);
          const positions = this.retainedAt.get(request.rid) ?? new Set<number>();
          positions.add(this.intakeSeen); this.retainedAt.set(request.rid, positions);
        }
      } else if (['admitted', 'applied', 'rejected', 'withdrawn'].includes(entry.type)) {
        const record = entry as unknown as DecisionRecord;
        this.intakeFold.apply(record);
        if (record.type === 'withdrawn') for (const rid of record.rids) this.withdrawnStages.add(rid);
        else {
          const resolution = this.intakeFold.resolved.get(record.rid);
          if (resolution) {
            for (const at of this.retainedAt.get(record.rid) ?? []) this.retained.delete(at);
            this.retainedAt.delete(record.rid);
            if (resolution.type === 'rejected' && ['run', 'revise'].includes(this.intakeFold.admitted.get(record.rid)?.kind ?? '')) this.rejectedStages.add(record.rid);
          }
        }
      }
    }
    return this.intakeFold;
  }
  /** A2, P10: Recover executor authority before replaying each unfinished workflow. Returns what it recovered: the
   *  workflows, the calls the executor read and repaired, and those it skipped as already recovered. */
  async recover(): Promise<{ workflows: number; calls: number; skipped: number }> {
    await this.store.recover();
    // Before any recovery append, so every journal entry from here on is derived promptly (and a new log derives
    // everything still on disk).
    await this.events.open();
    // An executor that can finish a batch runs its workflow-independent steps once, after every workflow.
    const batch = this.executor.finishRecovery !== undefined ? { batch: true } : undefined;
    let calls = 0, skipped = 0;
    for (const wf of this.store.workflows.values()) {
      // A settled workflow not decoded (settled.ts): nothing below applies to it (its facts say so).
      const settled = lazy(wf) ? { settled: { calls: wf.settled.calls, sweep: wf.settled.sweep } } : undefined;
      const counts = await this.executor.recover(wf.wid, wf.journal, settled ? { ...batch, ...settled } : batch);
      if (counts) { calls += counts.calls; skipped += counts.skipped; }
      if (settled && wf.journal.loaded === false) continue;
      // A seal may survive a crash before post-seal effects, even after workflow completion.
      let revision = 1;
      for (const entry of wf.journal.entries()) {
        if (entry.type === 'revised') revision = Number(entry.revision);
        if (entry.type !== 'call' && entry.type !== 'generation') continue;
        const call = `${wf.wid}@${revision}/${entry.key}@${entry.gen}`;
        if (!this.worktreeUnsettled(wf, call)) continue;
        // A revision whose pinned files no longer verify skips this step (the start goes on; the next one retries).
        let original: Workflow;
        try { original = await this.store.atRevision(wf, revision); }
        catch (error) { console.error(`durable-subagents: worktree step of ${call} skipped: pin-failed: ${error instanceof Error ? error.message : String(error)}`); continue; }
        await this.executor.run(this.ticket({ wf: original } as State, entry));
      }
    }
    await this.executor.finishRecovery?.();
    await this.startHost();
    for (const intent of this.ledgers.orch.entries().filter(e => e.type === 'revise-intent')) await this.revise(intent);
    for (const wf of this.store.workflows.values()) {
      // Settled and not decoded: its finished attention is recorded, no generation is open, no follow-up pending.
      if (lazy(wf)) continue;
      if (!this.terminal(wf)) await this.startWorkflow(wf);
      else await this.attention(wf);
      for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) if (!this.settledGeneration(wf, entry)) this.dispatchGeneration(wf, entry);
      await this.reopenForwarded(wf);
    }
    // Command calls outlive the orchestrator: each with an attempt and no seal is adopted, also in a held or ended
    // workflow (whose replay dispatches nothing), and watched until it seals.
    for (const wf of this.store.workflows.values()) if (!lazy(wf)) this.adoptCommands(wf);
    await this.intake();
    for (const wf of this.store.workflows.values()) this.settle(wf);
    this.startWaiting();
    return { workflows: this.store.workflows.size, calls, skipped };
  }
  /** Watch every unsealed command call of the current revision (Executor.run is idempotent per call: a replay's
   *  dispatch of the same call joins the same run). */
  private adoptCommands(wf: Workflow) {
    for (const call of unsealedCommandCalls(wf.journal.entries())) {
      const m = /^(.*)@(\d+)\/(.*)@(\d+)$/.exec(call);
      if (!m || Number(m[2]) !== wf.revision) continue;
      const entry = revisionEntries(wf).find(e => (e.type === 'call' || e.type === 'generation') && String(e.key) === m[3] && Number(e.gen) === Number(m[4]));
      if (!entry) continue;
      const release = this.hold(wf.wid);
      wf.journal.resting = false;
      void this.executor.run(this.unpinnedTicket(wf, entry)).then(() => this.background(async () => {
        try { await this.deliverAdopted(wf, entry); } finally { release(); }
      }), error => {
        release();
        if (!(error instanceof Error && error.name === 'ExecutorShutdown')) console.error(`durable-subagents: adopted command ${call}: ${String(error)}`);
      });
    }
  }
  /** An adopted command call sealed: its result reaches the workflow as a dispatched call's does. The replay proposed
   *  it without dispatching (a held workflow dispatches nothing): it is ready now, and the script goes on (a new call
   *  it makes stays queued under the hold; a workflow that ends records done and its finished notice). One the replay
   *  has not reached yet is found sealed when it gets there; one a dispatch runs is delivered by that dispatch. */
  private async deliverAdopted(wf: Workflow, entry: Entry) {
    const st = this.states.get(wf.wid);
    if (!st || st.wf !== wf || this.terminal(wf) || entry.type !== 'call') return;
    const pos = entry.pos as number, own = st.calls.get(pos);
    if (!own || !st.proposed.has(pos) || st.running.has(pos) || st.ready.has(pos)) return;
    const result = this.sealed(st, own);
    if (!result) return;
    st.ready.set(pos, result); await this.flush(st);
  }
  /** A successful call with a worktree whose removal (or keeping) is not recorded yet: its post-seal effect is due. */
  private worktreeUnsettled(wf: Workflow, call: string): boolean {
    const log = callEntries(wf.journal, call), result = log.find(e => e.type === JT.sealed)?.result as CallResult | undefined;
    return result?.status === 'ok' && log.some(e => e.type === 'wt-intent') && !log.some(e => e.type === 'wt-removed' || e.type === 'wt-kept');
  }
  /** A sealed generation a start need not run again: the executor has nothing to recover for it, its finished attention
   *  is recorded and no worktree effect is due (running it would only repeat these post-seal steps). */
  private settledGeneration(wf: Workflow, entry: Entry): boolean {
    const id = `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`;
    if (!callEntries(wf.journal, id).some(e => e.type === JT.sealed) || !this.executor.recovered?.(wf.journal, id) || this.worktreeUnsettled(wf, id)) return false;
    return entriesOf(wf.journal, JT.attention).some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`);
  }
  /** Every k.waitCheckMs (read here, at orchestrator start), why each live call does not move, as `waiting`/`moving`
   *  events through the pump. The tracker starts from the log's latest transition per call, so a restart repeats none
   *  (and a call that ended or started moving meanwhile gets its `moving`). The seed reads from seq 0: retention keeps
   *  events below `dropped`. A seed that cannot be read is logged and the tracker starts empty (recovery never fails on it). */
  private startWaiting() {
    if (this.closed || this.waiting) return;
    const latest = new Map<string, WaitSeed>(), head = this.events.head;
    try {
      if (head) for (let since = 0, more = true; more;) {
        const page = readPage(eventsLog(this.ledgers.home), since, 1000);
        if (!page || page.epoch !== head.epoch) break;
        for (const e of page.events) if ((e.type === 'waiting' || e.type === 'moving') && e.call) latest.set(e.call, e as WaitSeed);
        more = page.more && page.events.length > 0;
        if (page.events.length) since = Number(page.events.at(-1)!.cursor.split(':')[1]);
      }
    } catch (error) {
      console.error(`durable-subagents: waiting seed from the event log failed, starting without it: ${String(error)}`);
      latest.clear();
    }
    const tracker = new WaitTracker(); tracker.seed(latest);
    const collect = waitCollector({ home: this.ledgers.home, workflows: () => this.store.workflows.values(), orch: this.ledgers.orch, config: this.ledgers.config });
    this.waiting = startWaiting({ collect: () => collect(), sink: this.events, intervalMs: this.ledgers.config.k?.waitCheckMs, tracker, epoch: () => this.events.head?.epoch });
  }
  private async startHost() {
    await this.evaluator.start(message => this.background(() => this.message(message)), () => this.background(async () => {
      await this.startHost();
      for (const wf of this.store.workflows.values()) if (!this.terminal(wf)) await this.startWorkflow(wf);
    }));
  }
  private async startWorkflow(wf: Workflow) {
    if (this.terminal(wf)) return;
    await this.store.ready(wf);
    if (this.terminal(wf)) return;
    wf.journal.resting = false;
    await this.resolveFinished(wf);
    const log = revisionEntries(wf);
    const ev = Math.max(0, ...wf.journal.entries().filter(e => e.type === 'ev').map(e => e.n as number)) + 1;
    await wf.journal.append('ev', { n: ev });
    const calls = new Map(log.filter(e => ['call', 'refused', 'reused'].includes(e.type)).map(e => [e.pos as number, e]));
    const st: State = { wf, ev, calls, proposed: new Set(), exposures: log.filter(e => e.type === 'exposed'), exposed: new Set(log.filter(e => e.type === 'exposed').map(e => e.pos as number)), sent: 0, replaying: true, ready: new Map(), running: new Set(), outputs: new Map(log.filter(e => ['call', 'refused', 'reused', 'emit'].includes(e.type)).map(e => [e.pos as number, e])), values: log.filter(e => e.type === 'value'), needs: 0 };
    this.states.set(wf.wid, st);
    this.evaluator.send({ t: 'start', wid: wf.wid, ev, scriptPath: wf.scriptPath, args: wf.pins.args, inputs: wf.inputs });
  }
  /** P5, P6, A3: Commit lifecycle decisions in kernel order before acknowledging intake. */
  intake(): Promise<void> { return this.serial(() => this.consume()); }
  /** The 1 s poll behind the inbox watcher: a full pass only when a request file waits, the ledger changed since the
   *  last pass, or an admitted request is unresolved; otherwise an idle orchestrator reads one empty directory. */
  private async pollIntake() {
    const files = await readdir(orchInbox(this.ledgers.home)).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    const last = this.consumed;
    const length = this.ledgers.orch.count?.() ?? (this.ledgers.orch.committed?.() ?? this.ledgers.orch.entries()).length;
    if (!files.length && last && !last.pending && last.length === length) return;
    await this.consume();
  }
  private async consume() {
    this.passes.push(Date.now());
    const scanned = (await scanInbox(orchInbox(this.ledgers.home))).filter(r => r.to === 'orch');
    const before = this.lifecycle(), staged = new Set<string>();
    // The watermark index removes envelopes only after a committed terminal resolution.
    const candidates = [...this.retained.values(), ...scanned];
    for (const request of candidates) {
      if (!['run', 'revise'].includes(request.kind) || before.admitted.has(request.rid) || before.tombstones.has(request.rid) || staged.has(request.rid)) continue;
      await this.store.stage(request as Request<RunBody>, this.discovery);
      staged.add(request.rid);
    }
    const records = planDecisions(this.lifecycle(), candidates, () => ({ action: 'defer' }));
    for (const [index, record] of records.entries()) {
      if (record.type === 'admitted') {
        const request = candidates.find(r => r.rid === record.rid && contentHash(r) === record.hash)!;
        await this.ledgers.orch.append('request', { request });
      }
      if (record.type === 'applied') {
        const req = candidates.find(r => r.rid === record.rid);
        if (req?.kind === 'withdraw') await this.withdraw(req);
      }
      const { type, ...fields } = record;
      const withdrawal = type === 'withdrawn' ? records.slice(index + 1).find(r => r.type === 'applied') : undefined;
      await this.ledgers.orch.append(type, { ...fields, ...(withdrawal && 'rid' in withdrawal ? { rid: withdrawal.rid } : {}) });
    }
    for (;;) {
      let selected: Request | undefined;
      planDecisions(this.lifecycle(), candidates, req => { selected ??= req; return { action: 'defer' }; });
      if (!selected) break;
      const decision = await this.decide(selected);
      if (decision.action === 'defer') break;
      const resolution = planDecisions(this.lifecycle(), candidates, req => req.rid === selected!.rid ? decision : { action: 'defer' });
      for (const { type, ...fields } of resolution) await this.ledgers.orch.append(type, fields);
    }
    const view = this.lifecycle();
    for (const pending of [this.rejectedStages, this.withdrawnStages]) {
      for (const rid of pending) { await this.store.discardStage(rid); pending.delete(rid); }
    }
    for (const req of scanned) {
      if (view.resolved.has(req.rid) || (view.admitted.has(req.rid) && view.admitted.get(req.rid)!.hash !== contentHash(req))) {
        await unlink(join(orchInbox(this.ledgers.home), `${req.rid}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    await this.deliverWakes();
    this.consumed = { length: this.intakeSeen, pending: this.lifecycle().open.size > 0 };
  }
  private findCall(to: string, bareWid = false): { wf: Workflow; entry: Entry } | undefined {
    for (const wf of this.store.workflows.values()) {
      // Every address of a call starts with its wid: another workflow's journal need not be decoded.
      if (wf.journal.loaded === false && !String(to).startsWith(wf.wid)) continue;
      const calls = revisionEntries(wf).filter(e => e.type === 'call' || e.type === 'generation');
      // For sends, a bare wid addresses its call when the workflow has exactly one key (stop <wid> means the workflow).
      const keys = new Set(calls.map(e => String(e.key)));
      const named = calls.findLast(e => to === `${wf.wid}@${wf.revision}/${e.key}@${e.gen}` || to === `${wf.wid}/${e.key}` || (bareWid && to === wf.wid && keys.size === 1));
      const entry = named && calls.findLast(e => e.key === named.key);
      if (entry) return { wf, entry };
    }
  }
  /** P25: Explain an unknown send target with the addresses that would work. */
  private unknownCall(to: unknown): string {
    const wid = String(to ?? '').split(/[@/]/)[0]!, wf = this.store.workflows.get(wid);
    if (!wf) return `unknown-call: no workflow ${JSON.stringify(wid)}; address a call as '<wid>/<key>'`;
    const keys = [...new Set(revisionEntries(wf).filter(e => e.type === 'call' || e.type === 'generation').map(e => `${wf.wid}/${String(e.key)}`))];
    return `unknown-call: use one of ${keys.join(', ') || '(no calls yet)'}`;
  }
  private context(wf: Workflow, entry: Entry) { return { journal: wf.journal, widRev: `${wf.wid}@${wf.revision}` as const, key: entry.key as string, gen: entry.gen as number }; }
  private async withdraw(req: Request) {
    const rids = (req.body as { rids: string[] }).rids;
    this.lifecycle();
    const sent = [...new Set(rids)].flatMap(rid => this.sends.get(rid) ?? []).sort((a, b) => a.at - b.at).map(item => item.request);
    for (const wf of this.store.workflows.values()) {
      const visited = new Set<string>();
      for (const target of sent) {
        const found = this.findCall((target.body as SendBody).to, true);
        if (!found || found.wf !== wf || visited.has(found.entry.key as string)) continue;
        visited.add(found.entry.key as string);
        await this.executor.forward(req, this.context(wf, found.entry));
      }
    }
  }
  private async decide(req: Request): Promise<Decision> {
    const body = req.body as { to?: string; target?: string; wid?: string } | null;
    for (const address of [body?.to, body?.target, body?.wid, req.cond?.epoch]) {
      const match = typeof address === 'string' && /^([^/@]+)@(\d+)(?:\/|$)/.exec(address);
      if (match && this.store.workflows.has(match[1]!) && this.store.workflows.get(match[1]!)!.revision !== Number(match[2])) return { action: 'reject', reason: 'stale-revision' };
    }
    if (req.cond?.epoch) {
      const target = req.kind === 'send' ? this.findCall((req.body as SendBody).to, true) : undefined;
      if (!target || req.cond.epoch !== `${target.wf.wid}@${target.wf.revision}`) return { action: 'reject', reason: 'stale-epoch' };
    }
    if (req.kind === 'run') {
      const created = this.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid);
      if (!created && (req.body as RunBody | null)?.wake !== undefined) {
        const { wake, caller } = req.body as RunBody;
        const match = typeof caller === 'string' && /^([^@/]+)@(\d+)\/(.+)@(\d+)$/.exec(caller);
        const parent = match ? this.store.workflows.get(match[1]!) : undefined;
        const refuse = (reason: string): Decision => ({ action: 'reject', reason: `wake caller: ${reason}` });
        if (!match || !wake || wake.to !== `${match[1]}/${match[3]}`) return refuse('invalid caller');
        if (!parent || this.store.pruned().has(parent.wid)) return refuse('workflow missing or pruned');
        if (parent.revision !== Number(match[2])) return refuse('stale-revision');
        const entry = latestCall(parent, match[3]!);
        if (!entry) return refuse('unknown key');
        if (isCommandCall(entry.spec as CallSpec)) return refuse('command call');
      }
      // Senders validate labels; a hand-written request must not bypass that.
      const labels = (req.body as RunBody | null)?.labels, invalid = !created && labels !== undefined ? labelsProblem(labels) : undefined;
      if (invalid) return { action: 'reject', reason: `invalid-labels: ${invalid}` };
      const session = (req.body as RunBody | null)?.session;
      if (!created && session !== undefined && (typeof session !== 'string' || !SESSION_ID.test(session))) return { action: 'reject', reason: 'invalid-session: a pi session id' };
      if (created && this.store.pruned().has(String(created.wid))) return { action: 'apply' }; // Never resurrect a pruned run.
      let wf = created ? this.store.workflows.get(created.wid as string) : undefined;
      if (!wf) {
        try { await this.store.staged(req as Request<RunBody>); }
        catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` }; }
        wf = await this.store.create(req as Request<RunBody>);
      }
      if (!this.states.has(wf!.wid) && !this.terminal(wf!)) await this.startWorkflow(wf!);
    } else if (req.kind === 'revise') {
      const wf = this.store.workflows.get((req.body as ReviseBody)?.wid);
      if (!wf) return { action: 'reject', reason: 'unknown-workflow' };
      try { await this.store.staged(req as Request<ReviseBody>); }
      catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` }; }
      await this.revise(await this.store.revisionIntent(req as Request<ReviseBody>, wf));
      if (!this.states.has(wf.wid) && !this.terminal(wf)) await this.startWorkflow(wf);
    } else if (req.kind === 'send') {
      // A generation that took this request is in the workflow it addresses (see findCall).
      const to = String((req.body as SendBody)?.to ?? '');
      const existing = [...this.store.workflows.values()].filter(wf => wf.journal.loaded !== false || to.startsWith(wf.wid)).flatMap(wf => wf.journal.entries().filter(e => e.type === 'generation' && generationRids(e).includes(req.rid)).map(entry => ({ wf, entry })))[0];
      if (existing) { this.dispatchGeneration(existing.wf, existing.entry); return { action: 'apply' }; }
      // A sealed choice was committed before its reply. Replay it even if another request has since opened a generation.
      const chosen = [...this.store.workflows.values()].filter(wf => wf.journal.loaded !== false || to.startsWith(wf.wid))
        .flatMap(wf => revisionEntries(wf).filter(e => e.type === 'model-choice' && e.rid === req.rid))[0];
      if (chosen) { await this.note(req.rid, String(chosen.model), 'next-generation'); return { action: 'apply' }; }
      if ((req.body as SendBody)?.kind === 'model') {
        // A live forward may have committed just before a crash, then been refused or superseded before replay.
        // Keep its original outcome; never turn it into a fresh sealed choice or send it to a newer generation.
        for (const wf of this.store.workflows.values()) {
          if (wf.journal.loaded === false && !to.startsWith(wf.wid)) continue;
          const log = revisionEntries(wf), prior = log.find(e => e.type === 'forward' && e.rid === req.rid && (e.envelope as { kind?: string } | undefined)?.kind === 'model');
          if (!prior) continue;
          const entry = log.find(e => (e.type === 'call' || e.type === 'generation') && `${wf.wid}@${wf.revision}/${e.key}@${e.gen}` === prior.dest);
          if (entry && !log.some(e => (e.type === JT.sealed || e.type === 'retired') && e.call === prior.dest)) return this.executor.forward(req, this.context(wf, entry));
          return { action: 'apply' };
        }
      }
      const target = this.findCall((req.body as SendBody)?.to, true);
      if (!target) return { action: 'reject', reason: this.unknownCall((req.body as SendBody)?.to) };
      const { wf, entry } = target, send = req.body as SendBody;
      // A command call runs a process, not an agent: nothing receives a message or switches a model (stop ends it).
      if (isCommandCall(entry.spec as CallSpec | undefined)) return { action: 'reject', reason: `command call: ${String(send.kind)} is not supported (stop it, or start a new call)` };
      const from = `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`;
      const seal = wf.journal.entries().find(e => e.type === JT.sealed && e.call === from);
      if (seal && send.kind === 'steer') return { action: 'reject', reason: `finished:${(seal.result as CallResult).status} — use kind "follow-up" to continue it` };
      if (send.kind === 'notify') return this.notify(req, wf, entry, from, seal !== undefined);
      // A pool's name is a model too: the call keeps the pool, and its order and failover apply to the new generation.
      const pools = this.ledgers.config.pools, pool = send.model !== undefined && pools && Object.hasOwn(pools, send.model);
      if ((send.kind === 'follow-up' || send.kind === 'model') && send.model !== undefined && !pool) {
        try { if (!parseModel(send.model).provider) throw new Error('missing provider'); }
        catch { return { action: 'reject', reason: 'unknown-model' }; }
      }
      if (seal && (send.kind === 'follow-up' || send.kind === 'model')) return this.serialOpen(wf.wid, async () => {
        // A generation opened meanwhile (undelivered follow-ups after a seal) is the call this follow-up now reaches.
        if (latestCall(wf, String(entry.key))?.gen !== entry.gen) return { action: 'defer' } as const;
        // Pending notes and undelivered follow-ups ride on the opening message, recorded in the same entry (consumed
        // exactly once). A notify or follow-up whose fate the seal has not settled yet may still become one: wait for it.
        if (unsettledForward(revisionEntries(wf), from)) return { action: 'defer' } as const;
        // A1: the generation runs from the workflow's pinned files: verify them (once per process) before opening it.
        try { await this.store.ready(wf); } catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` } as const; }
        if (send.kind === 'model') {
          if (!send.model) return { action: 'reject', reason: 'unknown-model' } as const;
          // Record only intent. No execution, generation, mailbox delivery or provider reservation is created here.
          try { resolveModel(send.model, pools); } catch { return { action: 'reject', reason: 'unknown-model' } as const; }
          await wf.journal.append('model-choice', { rid: req.rid, call: from, model: send.model });
          await this.note(req.rid, send.model, 'next-generation');
          return { action: 'apply' } as const;
        }
        if (send.model !== undefined) await this.note(req.rid, send.model, 'next-generation');
        const opened = await this.openGeneration(wf, entry, from, { rid: req.rid, message: send.message ?? '', ...(send.model !== undefined ? { model: send.model } : {}) });
        this.dispatchGeneration(wf, opened); return { action: 'apply' } as const;
      });
      // A follow-up naming a model, queued on unfinished work: the executor records its model request with the message.
      const forwarded = await this.executor.forward(req, this.context(wf, entry));
      // The executor's serial queue may have sealed the call after our lookup; retry through the same sealed branch.
      return send.kind === 'model' && forwarded.action === 'reject' && forwarded.reason === 'call-sealed' ? { action: 'defer' } : forwarded;
    } else if (req.kind === 'stop') {
      const target = (req.body as { target: string })?.target;
      const call = this.findCall(target), wf = call?.wf ?? this.store.workflows.get(target);
      if (!wf) return { action: 'reject', reason: 'unknown-workflow' };
      const callId = call ? `${wf.wid}@${wf.revision}/${call.entry.key}@${call.entry.gen}` : undefined;
      if (callId) {
        // A seal wins over a late stop (V2); say so instead of reporting a stop that cannot happen.
        const log = wf.journal.entries(), seal = log.find(e => e.type === JT.sealed && e.call === callId);
        if (!log.some(e => e.type === 'stop-requested' && e.rid === req.rid)) {
          if (seal) return { action: 'reject', reason: `already-sealed:${(seal.result as CallResult).status}` };
          await wf.journal.append('stop-requested', { rid: req.rid, call: callId });
        }
      }
      if (!callId) {
        // Stopping a finished workflow does nothing; say so (the replay of an applied stop stays applied).
        const log = wf.journal.entries(), done = this.terminal(wf);
        if (!log.some(e => e.type === 'stop-requested' && e.rid === req.rid)) {
          if (done && done.status !== 'parked') return { action: 'reject', reason: `terminal:${String(done.status)}` };
          await wf.journal.append('stop-requested', { rid: req.rid });
        }
      }
      await this.executor.stop({ wid: wf.wid, ...(callId ? { callId } : {}) });
      if (!call) await this.finish(wf, 'stopped');
    } else if (req.kind === 'resume') {
      const { wid, origin } = (req.body as ResumeBody) ?? {};
      if (wid && !this.store.workflows.has(wid)) return { action: 'reject', reason: 'unknown-workflow' };
      // A resume releases held work in its scope (one workflow, one session's, or all) and continues parked workflows;
      // running ones need nothing and final ones are final.
      const inScope = (wf: Workflow) => wid ? wf.wid === wid : origin ? wf.origin === origin : true;
      const took = (wf: Workflow) => lazy(wf) ? wf.settled.resumed.includes(req.rid) : wf.journal.entries().some(e => e.type === 'resumed' && e.rid === req.rid);
      const replayed = this.ledgers.orch.entries().some(e => e.type === 'undrain' && e.rid === req.rid);
      // Held follow-ups of a finished workflow are released too; they run again through dispatchGeneration below.
      const holding = [...this.store.workflows.values()].filter(wf => inScope(wf) && this.held(wf.wid) && (!this.terminal(wf) || this.openFollowUps(wf)));
      const releasing = replayed || holding.length > 0;
      const final = (wf: Workflow) => { const done = this.terminal(wf); return done && done.status !== 'parked' ? String(done.status) : undefined; };
      const parked = (wf: Workflow) => this.terminal(wf)?.status === 'parked';
      if (!releasing) {
        const target = wid ? this.store.workflows.get(wid)! : undefined;
        if (target && final(target) && !took(target)) return { action: 'reject', reason: `terminal:${final(target)} — start a new run` };
        if (target && !parked(target) && !took(target)) return { action: 'reject', reason: 'not-parked: already running' };
        if (!target && ![...this.store.workflows.values()].some(wf => inScope(wf) && (parked(wf) || took(wf)))) return { action: 'reject', reason: 'nothing-to-resume' };
      }
      // A1: the pinned files of a finished workflow this resume starts are verified first (a start no longer hashes
      // them): a changed file refuses the resume before anything is recorded.
      for (const wf of this.store.workflows.values()) {
        const done = this.terminal(wf);
        if (!inScope(wf) || !(done?.status === 'parked' || (releasing && !done))) continue;
        try { await this.store.ready(wf); } catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` }; }
      }
      if (releasing && !replayed) await this.ledgers.orch.append('undrain', { rid: req.rid, ...(wid ? { wid } : origin ? { origin } : {}) });
      for (const wf of this.store.workflows.values()) {
        const done = this.terminal(wf), released = releasing && inScope(wf) && !done && (replayed || holding.includes(wf));
        if (!released && !(inScope(wf) && done?.status === 'parked')) continue;
        if (!took(wf)) {
          const n = (!released ? this.states.get(wf.wid)?.ev : undefined) ?? Math.max(0, ...wf.journal.entries().filter(e => e.type === 'ev').map(e => Number(e.n))) + 1;
          await wf.journal.append('resumed', { rid: req.rid, n });
          await this.resolveFinished(wf);
        }
        if (released) {
          const st = this.states.get(wf.wid);
          if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
          this.states.delete(wf.wid);
        }
        if (!this.states.has(wf.wid)) await this.startWorkflow(wf);
      }
      // A settled workflow not decoded has no generation to run (each ended, its finished attention recorded).
      for (const wf of this.store.workflows.values()) if (!lazy(wf)) for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) this.dispatchGeneration(wf, entry);
    } else if (req.kind === 'drain') {
      const { fence, origin, wid } = (req.body as DrainBody) ?? {}, scoped = Boolean(origin || wid);
      // Recorded in one step of the executor's serial queue (F2): a command call's intent is either before the drain
      // (it started; the hold never stops it) or after it (its start decision sees the hold and records none).
      const record = async () => {
        if (!this.ledgers.orch.entries().some(e => e.type === 'drain' && e.rid === req.rid)) {
          await this.ledgers.orch.append('drain', { rid: req.rid, fence: fence === true, ...(wid ? { wid } : origin ? { origin } : {}) });
        }
      };
      await (this.executor.exclusive ? this.executor.exclusive(record) : record());
      if (fence === true) {
        await this.executor.suspend(scoped ? w => this.held(w) : undefined);
        for (const st of this.states.values()) if (!scoped || this.held(st.wf.wid)) st.running.clear();
      }
    } else if (req.kind === 'restart') {
      // A replay (the restart was recorded, then the process ended before its resolution) applies without restarting again.
      if (!this.ledgers.orch.entries().some(e => e.type === 'restart' && e.rid === req.rid)) {
        // Only a restart that fenced something is recorded as a force (a token with nothing running fences nothing).
        const body = (req.body as RestartBody | null) ?? {}, force = isForceRestart(body);
        // A claimed subagent call only restricts (it cannot force); otherwise the main session's sender is authoritative.
        const initiator = body.initiator && 'call' in body.initiator ? body.initiator : req.from.startsWith('main:') ? { origin: req.from } : body.initiator ?? { origin: req.from };
        const gate = this.executor.quiesce?.() ?? { live: [], resume() {} };
        const reason = restartRefusal(this.ledgers.home, gate.live.map(l => ({ ...l, origin: this.store.workflows.get(l.wid)?.origin })), body, req.from.startsWith('main:'), Date.now(), gate.commands ?? 0);
        if (reason) { gate.resume(); return { action: 'reject', reason }; }
        try { await this.ledgers.orch.append('restart', { rid: req.rid, force: force && gate.live.length > 0, reason: body.reason, initiator, from: req.from, live: gate.live.map(l => l.exec) }); }
        catch (error) { gate.resume(); throw error; }
        this.restarting = true;
      }
    } else if (req.kind === 'prune') return this.prune(req as Request<PruneBody>);
    else return { action: 'reject', reason: 'unsupported-kind' };
    return { action: 'apply' };
  }
  /** Set by an applied restart: the loop ends and the process exits; its successor recovers every workflow. */
  get restartRequested(): boolean { return this.restarting; }
  /** A1, housekeeping: Prune finished workflows (named, or all ended more than olderThanDays ago); a replay of a
   *  committed prune is applied again and continues with the workflows still eligible. */
  private async prune(req: Request<PruneBody>): Promise<Decision> {
    const { wid, olderThanDays } = req.body ?? {};
    if ((wid !== undefined && (typeof wid !== 'string' || !wid)) || (olderThanDays !== undefined && !(typeof olderThanDays === 'number' && Number.isFinite(olderThanDays) && olderThanDays >= 0)))
      return { action: 'reject', reason: 'invalid-prune' };
    const cutoff = olderThanDays === undefined ? undefined : Date.now() - olderThanDays * 86_400_000;
    if (wid === undefined) {
      // A replayed prune may have pruned some already (before a crash).
      let count = this.ledgers.orch.entries().some(e => e.type === 'pruned' && e.rid === req.rid) ? 1 : 0;
      for (const wf of [...this.store.workflows.values()].sort((a, b) => a.wid < b.wid ? -1 : 1)) {
        if (this.unprunable(wf, cutoff)) continue;
        const failed = await this.pruneWorkflow(req.rid, wf);
        // Once some went, the prune stays applied (its pruned entries name them); the rest wait for the next prune.
        if (failed) { if (!count) return { action: 'reject', reason: failed }; console.error(`durable-subagents: prune ${req.rid} stopped early, the rest waits for the next prune: ${failed}`); break; }
        count++;
      }
      return { action: 'apply' };
    }
    if (this.ledgers.orch.entries().some(e => e.type === 'pruned' && e.rid === req.rid && e.wid === wid)) return { action: 'apply' };
    const wf = this.store.workflows.get(wid);
    if (!wf) return { action: 'reject', reason: this.store.pruned().has(wid) ? 'already-pruned' : 'unknown-workflow' };
    const reason = this.unprunable(wf, cutoff) ?? await this.pruneWorkflow(req.rid, wf);
    return reason ? { action: 'reject', reason } : { action: 'apply' };
  }
  /** Housekeeping: Why a workflow cannot be pruned: not final (parked or running), open executor work, an unresolved
   *  fence failure, or ended after the cutoff. */
  private unprunable(wf: Workflow, cutoff?: number): string | undefined {
    if (this.wakePending(wf)) return 'wake pending';
    const done = this.terminal(wf), status = done ? String(done.status) : 'running';
    if (!['done', 'failed', 'stopped'].includes(status)) return `not-finished:${status}`;
    if (lazy(wf)) {
      // Settled (settled.ts): no open generation, every execution fenced, no unresolved fence failure.
      if (this.running.has(wf.wid) || [...this.generations].some(id => id.startsWith(`${wf.wid}@`))) return 'open-generation';
      return cutoff !== undefined && done!.ts > cutoff ? 'too-recent' : undefined;
    }
    const log = wf.journal.entries(), has = (type: string, field: string, value: unknown) => log.some(e => e.type === type && e[field] === value);
    const openGeneration = log.some(e => e.type === 'generation' && !has(JT.sealed, 'call', `${wf.wid}@${e.revision}/${e.key}@${e.gen}`) && !has('retired', 'call', `${wf.wid}@${e.revision}/${e.key}@${e.gen}`));
    const liveExec = log.some(e => e.type === JT.exec && !has(JT.fenced, 'exec', e.exec) && !has(JT.sealed, 'call', e.call));
    if (unsealedCommandCalls(log).length) return 'running-command';
    if (openGeneration || liveExec || this.running.has(wf.wid) || [...this.generations].some(id => id.startsWith(`${wf.wid}@`))) return 'open-generation';
    if (log.some(e => e.type === 'fence-failed' && !log.some(r => r.seq > e.seq && ((r.type === JT.fenced && r.exec === e.exec) || (r.type === 'gate' && r.id === e.exec) ||
      (r.type === JT.attentionResolved && r.id === `fence:${String(e.exec)}`))))) return 'fence-failed';
    if (cutoff !== undefined && done!.ts > cutoff) return 'too-recent';
    return undefined;
  }
  /** A1, housekeeping: The pruned entry commits first; then the handle closes and the files go (recovery finishes them).
   *  Returns the reject reason `event-log: …` when the workflow's events could not be logged first (nothing removed). */
  private async pruneWorkflow(rid: string, wf: Workflow): Promise<string | undefined> {
    const bytes = await this.store.footprint(wf.wid);
    const done = this.terminal(wf)!, entries = this.ledgers.orch.entries();
    const createdBy = String(entries.find(e => e.type === JT.created && e.wid === wf.wid)?.rid ?? '');
    const admitted = requestId(createdBy) !== undefined ? entries.find(e => e.type === 'request' && (e.request as Request).rid === createdBy)?.request as Request | undefined : undefined;
    const identity = admitted ? { request: requestId(createdBy), spec_digest: specDigest(admitted) } : {};
    // Its events are derived and logged before the journal can go (recovery removes it once `pruned` is committed);
    // when they cannot be, the prune is rejected and the caller retries later.
    try { await this.events.flush(); }
    catch (error) { return `event-log: ${error instanceof Error ? error.message : String(error)}`; }
    const wake = wf.wake && wf.journal.entries().findLast(e => e.type === 'wake-outcome');
    const wakeReceipt = wake ? { wake: { to: wf.wake!.to, state: wake.state, rev: wake.rev, ...(wake.generation !== undefined ? { generation: wake.generation } : {}), ...(wake.reason !== undefined ? { reason: wake.reason } : {}) } } : {};
    await this.ledgers.orch.append('pruned', { rid, wid: wf.wid, endedAt: done.ts, bytes, status: String(done.status), ...identity, ...wakeReceipt });
    this.states.delete(wf.wid);
    await this.store.drop(wf.wid);
    try { await this.store.remove(wf.wid); }
    catch (error) { console.error(`durable-subagents: removal of pruned workflow ${wf.wid} failed, retrying at next start: ${String(error)}`); }
  }
  /** Open the next generation of `entry`'s key (its latest call), continuing sealed call `from`. The opening message
   *  carries the key's pending notes, then its undelivered follow-ups, then `own` (a follow-up sent to the sealed call;
   *  without one the undelivered follow-ups open it by themselves). The latest model named replaces the session's. */
  private async openGeneration(wf: Workflow, entry: Entry, from: string, own?: { rid: string; message: string; model?: string }): Promise<Entry> {
    const log = revisionEntries(wf), key = String(entry.key), notes = pendingNotes(log, key), carried = pendingFollowUps(log, key);
    const asked = (rid: string) => ((this.ledgers.orch.entries().findLast(e => e.type === 'request' && (e.request as Request | undefined)?.rid === rid)?.request as Request | undefined)?.body as SendBody | undefined)?.model;
    const model = own?.model ?? generationModel(log, from) ?? carried.map(c => asked(c.rid)).filter((m): m is string => typeof m === 'string').at(-1) ??
      (typeof entry.choice === 'string' ? entry.choice : undefined);
    const pools = this.ledgers.config.pools, pool = model !== undefined && pools && Object.hasOwn(pools, model);
    const rid = own?.rid ?? carried[0]!.rid, follows = carried.map(c => c.rid).filter(r => r !== rid);
    const gen = Math.max(0, ...wf.journal.entries().filter(e => ['call', 'generation'].includes(e.type) && e.key === entry.key).map(e => Number(e.gen))) + 1;
    // A follow-up's explicit model or a new manual choice persists in the spec of every later generation.
    const spec = model !== undefined ? { ...(entry.spec as CallSpec), model } : entry.spec;
    const message = openingMessage(notes.map(n => String(n.message)), [...carried.map(c => c.message), own?.message ?? '']);
    return wf.journal.append('generation', { rid, key: entry.key, gen, from, spec, revision: wf.revision, opening: { rid, kind: 'follow-up', message },
      ...(notes.length ? { notes: notes.map(n => String(n.rid)) } : {}), ...(follows.length ? { follows } : {}), ...(model !== undefined ? { choice: model } : {}), ...(model !== undefined && !pool ? { model } : {}) });
  }
  /** Follow-ups forwarded into running work whose call sealed before taking them (`undelivered-follow-up`) open the
   *  key's next generation, as a follow-up sent after the seal would: once its latest generation has sealed, unless a
   *  later follow-up took them along. Idempotent; run after every seal and at start. */
  private reopenForwarded(wf: Workflow): Promise<void> { return this.serialOpen(wf.wid, () => this.reopenForwardedNow(wf)); }
  private async reopenForwardedNow(wf: Workflow): Promise<void> {
    const log = revisionEntries(wf);
    if (!log.some(e => e.type === 'forward-retired' && e.reason === 'undelivered-follow-up')) return;
    for (const key of new Set(log.filter(e => e.type === 'call' || e.type === 'generation').map(e => String(e.key)))) {
      if (!pendingFollowUps(revisionEntries(wf), key).length) continue;
      const latest = latestCall(wf, key)!;
      const from = `${wf.wid}@${wf.revision}/${key}@${latest.gen}`, entries = wf.journal.entries();
      if (!entries.some(e => e.type === JT.sealed && e.call === from) || entries.some(e => e.type === 'retired' && e.call === from)) continue;
      if (unsettledForward(revisionEntries(wf), from)) continue;
      this.dispatchGeneration(wf, await this.openGeneration(wf, latest, from));
    }
  }
  /** One generation opening at a time per workflow, so the check that a key's latest call is sealed and unopened and
   *  the `generation` it appends are one step. Otherwise the reopen at start, the one after a seal and a follow-up's
   *  each see the key unopened and open it twice. */
  private async serialOpen<T>(wid: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.opening.get(wid) ?? Promise.resolve()).then(fn), tail = run.then(() => {}, () => {});
    this.opening.set(wid, tail);
    try { return await run; } finally { if (this.opening.get(wid) === tail) this.opening.delete(wid); }
  }
  private dispatchGeneration(wf: Workflow, entry: Entry, refusal?: string, checked = false) {
    const id = `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`;
    if (this.generations.has(id) || this.held(wf.wid) || wf.journal.entries().some(e => e.type === 'retired' && e.call === id)) return;
    // A finished workflow's pinned files are verified before a generation of it runs (the ticket names its origin); a
    // sealed generation's run only repeats post-seal steps, which read no pinned file. When they do not verify, the
    // generation is sealed failed (`pin-failed: …`) without a child, like any call that cannot be prepared: the engine
    // goes on, the workflow ends again, and a later follow-up verifies the files again.
    // Released pins (not resident) take the same asynchronous path: a getter must never throw out of this method.
    if (refusal === undefined && !checked && !(this.store.verified(wf.wid) && this.store.pinsResident(wf)) && !callEntries(wf.journal, `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`).some(e => e.type === JT.sealed)) {
      const revision = wf.revision, current = () => wf.revision === revision && this.store.workflows.get(wf.wid) === wf && !this.closed;
      void this.store.ready(wf).then(() => { if (current()) this.dispatchGeneration(wf, entry, undefined, true); }, error => {
        if (!current()) return;
        const reason = `pin-failed: ${error instanceof Error ? error.message : String(error)}`;
        try { this.dispatchGeneration(wf, entry, reason); } catch (failure) { console.error(`durable-subagents: ${String(failure)}`); }
      });
      return;
    }
    // Pins not verified (a refusal, or the post-seal steps of a sealed generation): the ticket comes from the journal's
    // entry alone, so a damaged pinned record cannot keep the call from sealing.
    // After ready, pins released again before this dispatch reload through the checked getter; a load that fails
    // seals this generation alone (`pin-failed: …`), so no getter error escapes and ready is not retried in a loop.
    let ticket: CallTicket;
    if (refusal !== undefined || !this.store.verified(wf.wid)) ticket = { ...this.unpinnedTicket(wf, entry), ...(refusal !== undefined ? { refusal } : {}) };
    else try { ticket = this.ticket({ wf } as State, entry); }
    catch (error) {
      refusal = `pin-failed: ${error instanceof Error ? error.message : String(error)}`;
      ticket = { ...this.unpinnedTicket(wf, entry), refusal };
    }
    this.generations.add(id); wf.journal.resting = false;
    void this.executor.run(ticket).then(result => this.background(async () => {
      if (!wf.journal.entries().some(e => e.type === JT.sealed && e.call === id)) throw new Error(`Generation returned without seal: ${id}`);
      if (refusal !== undefined) console.error(`durable-subagents: generation ${id} sealed ${result.status}${result.status === 'failed' ? `: ${result.error ?? refusal}` : ''}`);
      await this.reopenForwarded(wf);
      if (!wf.journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`))
        await wf.journal.append(JT.attention, { item: { id: `finished:${id}`, rev: 1, kind: 'finished', wid: wf.wid, call: id, text: finishedText(wf.wid, wf.journal.entries(), id), origin: wf.origin } });
      this.generations.delete(id); this.settle(wf);
    }), error => {
      this.generations.delete(id); this.settle(wf);
      if (error instanceof Error && error.name === 'ExecutorShutdown') return;
      this.background(async () => { throw error; });
    });
  }
  /** A notify: forwarded to a running call (the executor says steered or held-until-answer); for a sealed call, or one
   *  that sealed before the forward was recorded, a pending note in the workflow journal (`noted`). A replay (the
   *  orchestrator died before its decision was recorded) follows what already happened to this rid: a forward the child
   *  received is no note; one retired at the seal already became its note; one not settled yet is waited for. The reply
   *  (the rid's latest `send-note`) is corrected to match. */
  private async notify(req: Request, wf: Workflow, entry: Entry, from: string, sealed: boolean): Promise<Decision> {
    const message = (req.body as SendBody).message;
    if (typeof message !== 'string' || !message) return { action: 'reject', reason: 'malformed: notify needs a message' };
    // Forwards of this rid to any generation of the key (a follow-up may have opened a newer one since).
    const callKey = (call: string) => call.slice(0, call.lastIndexOf('@'));
    const forwards = () => revisionEntries(wf).filter(e => e.type === 'forward' && e.rid === req.rid && callKey(String(e.dest)) === callKey(from));
    if (!sealed && forwards().every(f => f.dest === from)) {
      const decision = await this.executor.forward(req, this.context(wf, entry));
      if (!(decision.action === 'reject' && decision.reason === 'call-sealed')) return decision;
    }
    const log = revisionEntries(wf), noted = () => revisionEntries(wf).some(e => e.type === PENDING_NOTE && e.rid === req.rid);
    const forwarded = forwards();
    if (forwarded.length) {
      if (forwarded.some(f => !log.some(r => r.rid2 === f.rid2 && (r.type === 'forward-delivered' || r.type === 'forward-retired')))) return { action: 'defer' };
      await this.delivery(req.rid, noted() ? 'noted' : undefined);
      return { action: 'apply' };
    }
    if (!noted()) {
      // Notes keep the order they were accepted in: one forwarded earlier becomes a note first.
      if (unsettledNotify(log, from)) return { action: 'defer' };
      await wf.journal.append(PENDING_NOTE, { rid: req.rid, call: from, key: entry.key, message });
    }
    await this.delivery(req.rid, 'noted');
    return { action: 'apply' };
  }
  /** Make the rid's reply say `delivery` (the latest `send-note` counts; see sendReceipt); undefined: the forward reached
   *  the call (or was withdrawn), so a recorded held-until-answer stays and anything else says steered. */
  private async delivery(rid: string, delivery: 'noted' | 'steered' | undefined): Promise<void> {
    const last = this.ledgers.orch.entries().findLast(e => e.type === 'send-note' && e.rid === rid);
    const want = delivery ?? (last?.delivery === 'held-until-answer' ? 'held-until-answer' : 'steered');
    if (last?.delivery !== want) await this.ledgers.orch.append('send-note', { rid, delivery: want });
  }
  /** The reply to a send that names a model says which model and when it applies (orchestrator ledger `send-note`). */
  private async note(rid: string, model: string, effect: string): Promise<void> {
    if (!this.ledgers.orch.entries().some(e => e.type === 'send-note' && e.rid === rid)) await this.ledgers.orch.append('send-note', { rid, model, effect });
  }
  private ticket(st: State, entry: Entry): CallTicket {
    const spec = entry.spec as CallSpec;
    // A command call runs no agent: its ticket carries the placeholder agent of an unpinned ticket.
    if (isCommandCall(spec)) return this.unpinnedTicket(st.wf, entry);
    const agent = st.wf.pins.agents.find(a => a.name === spec.agent);
    if (!agent) throw new Error(`Unknown pinned agent: ${spec.agent}`);
    return { wid: st.wf.wid, widRev: `${st.wf.wid}@${st.wf.revision}`, key: entry.key as string, gen: entry.gen as number,
      callId: `${st.wf.wid}@${st.wf.revision}/${entry.key}@${entry.gen}`, spec, agent, workflowBudget: st.wf.pins.usageBudget, cwd: resolve(st.wf.cwd, spec.cwd ?? '.'), journal: st.wf.journal,
      ...(st.wf.originPath !== undefined ? { originSession: st.wf.originPath } : {}),
      ...(entry.type === 'generation' ? { continueFrom: entry.from as CallTicket['continueFrom'], opening: entry.opening as CallTicket['opening'] } : {}),
      ...(entry.type === 'generation' && typeof entry.model === 'string' ? { model: entry.model } : {}) };
  }
  /** A ticket from the generation entry alone (call id, key, gen, spec, model), none of the workflow's pinned metadata:
   *  the agent is the spec's name only. For a call that is sealed without running, or only repeats post-seal steps. */
  private unpinnedTicket(wf: Workflow, entry: Entry): CallTicket {
    const spec = entry.spec as CallSpec, name = String(spec?.agent ?? '');
    let agent: CallTicket['agent'] | undefined;
    try { agent = wf.pins.agents.find(a => a.name === name); } catch { /* damaged pins: the placeholder below */ }
    return { wid: wf.wid, widRev: `${wf.wid}@${wf.revision}`, key: String(entry.key), gen: Number(entry.gen), callId: `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`,
      spec, cwd: resolve(wf.cwd, spec?.cwd ?? '.'), journal: wf.journal,
      agent: agent ?? { name, description: '', body: '', sourcePath: '', source: 'project', systemPromptMode: 'append', inheritProjectContext: false, inheritSkills: false },
      ...(entry.type === 'generation' ? { continueFrom: entry.from as CallTicket['continueFrom'], opening: entry.opening as CallTicket['opening'] } : {}),
      ...(entry.type === 'generation' && typeof entry.model === 'string' ? { model: entry.model } : {}) };
  }
  private sealed(st: State, entry: Entry): CallResult | undefined {
    if (entry.type === 'refused') return refusedResult(String(entry.key), entry.reason);
    const call = entry.type === 'reused' ? entry.from : `${st.wf.wid}@${st.wf.revision}/${entry.key}@${entry.gen}`;
    return st.wf.journal.entries().find(e => e.type === JT.sealed && e.call === call)?.result as CallResult | undefined;
  }
  private dispatch(st: State, entry: Entry) {
    const pos = entry.pos as number;
    if (st.running.has(pos)) return;
    const sealed = this.sealed(st, entry);
    if (sealed) { st.ready.set(pos, sealed); return; }
    if (this.held(st.wf.wid)) return;
    st.running.add(pos);
    const release = this.hold(st.wf.wid);
    void this.executor.run(this.ticket(st, entry)).then(() => this.background(async () => {
      try {
        if (this.states.get(st.wf.wid) === st) await this.reopenForwarded(st.wf);
        if (this.states.get(st.wf.wid) !== st || this.terminal(st.wf)) return;
        const result = this.sealed(st, entry);
        if (!result) throw new Error(`Executor returned without seal: ${entry.key}`);
        st.ready.set(pos, result); await this.flush(st);
      } finally { release(); }
    }), error => {
      if (error instanceof Error && error.name === 'ExecutorShutdown') { release(); return; }
      this.background(async () => { try { if (this.states.get(st.wf.wid) === st) throw error; } finally { release(); } });
    });
  }
  private async flush(st: State) {
    while (st.sent < st.exposures.length) {
      const pos = st.exposures[st.sent]!.pos as number;
      if (!st.proposed.has(pos)) return;
      const entry = st.calls.get(pos), result = entry && this.sealed(st, entry);
      if (!result) { await this.finish(st.wf, 'parked', undefined, `Missing sealed result at ${pos}`); return; }
      this.evaluator.send({ t: 'expose', wid: st.wf.wid, ev: st.ev, pos, result });
      st.ready.delete(pos); st.sent++;
    }
    if (st.replaying) return;
    // A position is exposed at most once per workflow state (F1): two observers of one seal (an adopted command's watch
    // and a dispatch of the same call) may both deliver it; the first one wins, a later one is dropped.
    for (const [pos, result] of st.ready) {
      if (st.exposed.has(pos)) { st.ready.delete(pos); continue; }
      st.exposed.add(pos);
      try { await st.wf.journal.append('exposed', { pos }); }
      catch (error) { st.exposed.delete(pos); throw error; }
      this.evaluator.send({ t: 'expose', wid: st.wf.wid, ev: st.ev, pos, result });
      st.ready.delete(pos);
    }
  }
  private async message(message: EvalToOrch) {
    const st = this.states.get(message.wid);
    if (!st || st.ev !== message.ev || this.terminal(st.wf)) return;
    const park = (error: string) => this.finish(st.wf, 'parked', undefined, error);
    if (message.t === 'call') {
      // An unknown agent name refuses that call (the script gets a failed result naming the available agents), like an invalid spec.
      // A command call names no agent (its fingerprint pins agent null).
      const command = isCommandCall(message.spec), agent = command ? null : st.wf.pins.agents.find(a => a.name === message.spec.agent) ?? null;
      const fingerprint = contentHash({ spec: message.spec, agent }), old = st.outputs.get(message.pos);
      if (st.proposed.has(message.pos) || (old && (!['call', 'refused', 'reused'].includes(old.type) || old.key !== message.key || old.fingerprint !== fingerprint))) return park(`Replay mismatch at ${message.pos}`);
      if (!old && [...st.calls.values()].some(e => e.key === message.key)) return park(`Duplicate call key: ${message.key}`);
      let entry = old;
      if (!entry) {
        const history = st.wf.journal.entries(), boundary = history.findLast(e => e.type === 'revised')?.seq ?? 0;
        let revision = 1;
        const matching: string[] = [];
        for (const e of history) {
          if (e.type === 'revised') revision = Number(e.revision);
          if (e.seq < boundary && e.type === 'call' && e.key === message.key && e.fingerprint === fingerprint) matching.push(`${st.wf.wid}@${revision}/${e.key}@${e.gen}`);
        }
        const reused = history.findLast(e => e.type === JT.sealed && matching.includes(String(e.call)));
        const fields = { pos: message.pos, key: message.key, spec: message.spec, fingerprint };
        const problems = validateCallSpec(message.spec);
        if (!problems.length && !agent && !command) problems.push(unknownAgent(message.spec.agent, st.wf.pins.agents));
        // A malformed spec from a script never runs: the script gets a failed result naming every problem.
        if (problems.length) entry = await st.wf.journal.append('refused', { ...fields, reason: `invalid spec: ${problems.join('; ')}` });
        else if (reused) entry = await st.wf.journal.append('reused', { ...fields, from: reused.call, gen: (reused.result as CallResult).gen });
        else if (history.filter(e => e.type === 'call').length >= (st.wf.pins.maxCalls ?? 300)) {
          entry = await st.wf.journal.append('refused', { ...fields, reason: 'spawn-budget' });
        } else {
          const gen = Math.max(0, ...history.filter(e => ['call', 'generation'].includes(e.type) && e.key === message.key).map(e => Number(e.gen))) + 1;
          entry = await st.wf.journal.append('call', { ...fields, gen });
        }
      }
      st.calls.set(message.pos, entry); st.proposed.add(message.pos);
      if (!st.exposures.some(e => e.pos === message.pos)) this.dispatch(st, entry);
      await this.flush(st);
    } else if (message.t === 'need') {
      const old = st.values[message.n];
      if (message.n !== st.needs++ || (old && old.kind !== message.kind)) return park(`Value mismatch at ${message.n}`);
      const value = old?.value as number | undefined ?? (message.kind === 'now' ? Date.now() : Math.random());
      if (!old) await st.wf.journal.append('value', { n: message.n, kind: message.kind, value });
      this.evaluator.send({ t: 'value', wid: st.wf.wid, ev: st.ev, n: message.n, value });
    } else if (message.t === 'emit') {
      const old = st.outputs.get(message.pos);
      if (old && (old.type !== 'emit' || contentHash(old.value) !== contentHash(message.value))) return park(`Emit mismatch at ${message.pos}`);
      if (!old) await st.wf.journal.append('emit', { pos: message.pos, value: message.value });
      st.proposed.add(message.pos);
    } else if (message.t === 'idle') {
      if (st.replaying && st.sent === st.exposures.length && message.exposed >= st.sent) {
        if ([...st.outputs.keys()].some(pos => !st.proposed.has(pos)) || st.needs < st.values.length) return park('Missing output at replay frontier');
        st.replaying = false; await this.flush(st);
      }
    } else if (message.t === 'done') {
      if ([...st.outputs.keys()].some(pos => !st.proposed.has(pos)) || st.sent !== st.exposures.length || st.needs < st.values.length) return park('Missing output at replay completion');
      await this.finish(st.wf, 'done', message.result);
    } else if (message.t === 'error') await this.finish(st.wf, message.kind === 'script' ? 'failed' : 'parked', undefined, message.error);
  }
  private async attention(wf: Workflow) {
    const done = this.terminal(wf);
    const rev = wf.journal.entries().filter(e => e.type === JT.done).length;
    if (done && !wf.journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${wf.wid}` && e.item.rev === rev)) {
      await wf.journal.append(JT.attention, { item: { id: `finished:${wf.wid}`, rev, kind: 'finished', wid: wf.wid, text: finishedText(wf.wid, wf.journal.entries()) } });
    }
    await this.deliverWake(wf);
  }
  /** A pending wake keeps the journal decoded and unprunable until its durable outcome is recorded. */
  private wakePending(wf: Workflow): boolean {
    if (!wf.wake || lazy(wf)) return false;
    const log = wf.journal.entries(), rev = log.filter(e => e.type === JT.done).length;
    return !rev || !log.some(e => e.type === 'wake-outcome' && e.rev === rev);
  }
  private async deliverWakes() {
    for (const wf of this.store.workflows.values()) if (wf.wake && !lazy(wf)) { await this.deliverWake(wf); this.settle(wf); }
  }
  /** The intent pins the message before admission. Lifecycle resolution and send's existing generation/forward
   *  receipts make every crash cut replayable, including a crash between the send effect and its decision. */
  private waking = new Map<string, Promise<void>>();
  private deliverWake(wf: Workflow): Promise<void> {
    const pending = this.waking.get(wf.wid);
    if (pending) return pending;
    const run = this.deliverWakeNow(wf).finally(() => { if (this.waking.get(wf.wid) === run) this.waking.delete(wf.wid); });
    this.waking.set(wf.wid, run); return run;
  }
  private async deliverWakeNow(wf: Workflow) {
    if (!wf.wake || lazy(wf)) return;
    const { rid, to, caller } = wf.wake;
    const dones = wf.journal.entries().filter(e => e.type === JT.done);
    for (const [n, done] of dones.entries()) {
      const rev = n + 1;
      if (wf.journal.entries().some(e => e.type === 'wake-outcome' && e.rev === rev)) continue;
      let intent = wf.journal.entries().find(e => e.type === 'wake-request' && e.rev === rev);
      if (!intent) {
        const target = this.findCall(to), id = target && `${target.wf.wid}@${target.wf.revision}/${target.entry.key}@${target.entry.gen}`;
        const seal = target?.wf.journal.entries().find(e => e.type === JT.sealed && e.call === id);
        if (target && `${target.wf.wid}@${target.wf.revision}` === caller.slice(0, caller.indexOf('/')) && (seal?.result as CallResult | undefined)?.status === 'stopped') {
          await wf.journal.append('wake-outcome', { rev, state: 'skipped', reason: 'caller stopped' }); continue;
        }
        const request: Request<SendBody> = { rid: `wake-${contentHash([rid, rev]).slice(0, 32)}`, from: `wake:${rid}:${rev}`, to: 'orch', sseq: 1,
          kind: 'send', cond: { epoch: caller.slice(0, caller.indexOf('/')) }, body: { to, kind: 'follow-up', message: wakeText(requestId(rid) ?? rid, wf.wid, done, wf.journal.entries().filter(e => e.seq <= done.seq)) } };
        intent = await wf.journal.append('wake-request', { rev, request });
      }
      const request = intent.request as Request<SendBody>;
      for (const { type, ...fields } of planDecisions(this.lifecycle(), [request], () => ({ action: 'defer' }))) {
        if (type === 'admitted') await this.ledgers.orch.append('request', { request });
        await this.ledgers.orch.append(type, fields);
      }
      let resolution = this.lifecycle().resolved.get(request.rid);
      if (!resolution) {
        const decision = await this.decide(request);
        if (decision.action === 'defer') return;
        for (const { type, ...fields } of planDecisions(this.lifecycle(), [request], () => decision)) await this.ledgers.orch.append(type, fields);
        resolution = this.lifecycle().resolved.get(request.rid);
      }
      if (!resolution) continue;
      const target = this.findCall(to), opened = target && revisionEntries(target.wf).find(e => e.type === 'generation' && generationRids(e).includes(request.rid));
      const forward = target && target.wf.journal.entries().find(e => e.type === 'forward' && e.rid === request.rid);
      const generation = opened ? Number(opened.gen) : forward ? Number(String(forward.dest).match(/@(\d+)$/)?.[1]) : undefined;
      await wf.journal.append('wake-outcome', { rev, state: resolution.type === 'applied' ? 'applied' : 'rejected',
        ...(resolution.type === 'rejected' ? { reason: resolution.reason } : {}), ...(generation !== undefined ? { generation } : {}) });
    }
  }
  private async resolveFinished(wf: Workflow) {
    for (const { item } of attentionEntries(wf.journal.entries())) {
      if (item.kind === 'finished' && !wf.journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev)) {
        await wf.journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: 'resumed' });
      }
    }
  }
  private async revise(intent: Entry) {
    const wf = this.store.workflows.get(String(intent.wid));
    if (!wf || wf.revision >= Number(intent.revision)) return;
    const st = this.states.get(wf.wid);
    this.states.delete(wf.wid); // Retired promises and queued evaluator events cannot mutate the new revision.
    await this.executor.retire(`${wf.wid}@${wf.revision}`);
    if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
    await this.store.revise(intent);
    await this.resolveFinished(wf);
  }
  private async finish(wf: Workflow, status: string, result?: unknown, error?: string) {
    if (!this.terminal(wf)) await wf.journal.append(JT.done, { status, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) });
    await this.attention(wf);
    const st = this.states.get(wf.wid);
    if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
    this.states.delete(wf.wid);
    this.settle(wf);
  }
  /** K6, P5: Watch with polling fallback and exit only after continuous quiescence. */
  async loop(signal?: AbortSignal): Promise<void> {
    const inbox = orchInbox(this.ledgers.home);
    await mkdir(inbox, { recursive: true });
    this.watcher = watch(inbox, () => this.background(() => this.consume()));
    this.watcher.on('error', () => { this.watcher?.close(); });
    this.poll = setInterval(() => this.background(() => this.pollIntake()), 1000);
    const publish = () => { this.statsWritten = this.statsWritten.then(() => writeStats(this.ledgers.home, this.stats())).catch(error => console.error(`durable-subagents: orchestrator stats not written: ${String(error)}`)); };
    publish(); this.publishing = setInterval(publish, STATS_EVERY_MS); this.publishing.unref?.();
    let idleSince = performance.now();
    try {
      while (!signal?.aborted && !this.closed && !this.restarting) {
        await this.queue;
        if (this.failure) throw this.failure;
        const files = await readdir(inbox);
        // Held (drained) workflows cannot progress until a resume request, which restarts the orchestrator: they do not keep it alive.
        if (this.generations.size || this.executor.busy() || files.length || this.unfinished()) idleSince = performance.now();
        else if (performance.now() - idleSince >= (this.ledgers.config.k?.idleExitMs ?? 10_000)) return;
        await delay(Math.min(100, this.ledgers.config.k?.idleExitMs ?? 100));
      }
    } finally { this.watcher?.close(); clearInterval(this.poll); clearInterval(this.publishing); await this.statsWritten; }
  }
  private publishing?: ReturnType<typeof setInterval>;
  private statsWritten: Promise<void> = Promise.resolve();
  /** A workflow that can still progress (not terminal, not held). Both depend only on journal entries and the set of
   *  workflows, so the answer is reused until this process appends to a journal or the set changes. */
  private unfinished(): boolean {
    const key = `${journalAppends()}:${this.store.workflows.size}`;
    if (this.unfinishedAt?.key === key) return this.unfinishedAt.value;
    let value = false;
    for (const w of this.store.workflows.values()) if (!this.terminal(w) && !this.held(w.wid)) { value = true; break; }
    this.unfinishedAt = { key, value };
    return value;
  }
  private unfinishedAt?: { key: string; value: boolean };
  /** A1, A2: Retire asynchronous producers before closing their journals. */
  async close(): Promise<void> {
    this.closed = true; this.watcher?.close(); clearInterval(this.poll); clearInterval(this.publishing); await this.statsWritten;
    await this.waiting?.stop(); await this.queue; await this.evaluator.close(); await this.executor.shutdown(); await this.events.close(); await this.store.close();
  }
}
