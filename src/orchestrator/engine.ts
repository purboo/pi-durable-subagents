// Private orch entries: request {request} retains immutable admitted envelopes;
// drain {rid,fence} and undrain {rid} record durable dispatch admission: a drain holds the workflows that exist when it is
// recorded (until resume); workflows created after it run normally.
// Workflow entries: ev {n}; call {pos,key,gen,spec,fingerprint}; refused {pos,key,spec,fingerprint,reason};
// reused {pos,key,gen,spec,fingerprint,from}; exposed {pos}; value {n,kind,value};
// generation{rid,key,gen,from,spec,revision,opening} is a send resolution outside the script;
// its seal has a finished attention independent of workflow completion.
// resumed {rid,n} supersedes a terminal park. emit {pos,value} records script outputs.
// stop-requested {rid,call?} marks a call or workflow stop as taking effect, so its replay is applied, not already-sealed.
// Orch entry pruned {rid,wid,endedAt,bytes,status,request?,spec_digest?} is the decisive record of a prune: appended before
// the journal handle is closed and w/<wid> and its staging dirs are removed (bytes = footprint measured just before;
// status = the final workflow status; request/spec_digest when the workflow was created by a request id, R1 tombstone).
// Nothing is rewritten (A1): the admitted request and created entries stay, so a retried id still resolves to this wid.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from '../kernel/ids.ts';
import { planDecisions, reduceLifecycle, type DecisionRecord, type Decision } from '../kernel/lifecycle.ts';
import { scanInbox } from '../kernel/mailbox.ts';
import { orchInbox, pinnedDir } from '../paths.ts';
import { requestId, specDigest } from '../requests.ts';
import { JT, attentionEntries, isEntry, type Entry, type Request, type RunBody, type ReviseBody, type DrainBody, type RestartBody, type ResumeBody, type PruneBody, type SendBody, type EvalToOrch, type CallResult, type CallSpec } from '../types.ts';
import type { DiscoveryOptions } from '../compat/agents.ts';
import type { CallTicket, Executor, Ledgers } from './contract.ts';
import { isForceRestart, restartRefusal } from './restart.ts';
import { EvaluatorClient, type EvaluatorTransport } from './evaluator-client.ts';
import { Store, revisionEntries, terminalEntry, type Workflow } from './store.ts';
import { formatUsage, holdOf, refusedResult, snapshotFromEntries } from './snapshot.ts';
import { validateCallSpec } from '../compat/spec.ts';
import { EventPump } from '../events/pump.ts';
import { labelsProblem } from '../events/labels.ts';
import { R7Tracker, r7Collector, startR7, type R7Seed } from '../events/r7.ts';
import { readPage } from '../events/log.ts';
import { eventsLog } from '../paths.ts';
import { parseModel } from '../compat/model.ts';

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
export function finishedText(wid: string, entries: readonly Entry[], call?: string): string {
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
    const message = c.result && Object.hasOwn(c.result, 'data') ? JSON.stringify(c.result.data) : c.result?.output;
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
    const message = result && Object.hasOwn(result, 'data') ? JSON.stringify(result.data) : result?.output;
    const line = title + (message && space > 4 ? `\n  ${tail(message.trimEnd(), space - 3)}` : '') + error;
    lines.push(line);
  }
  return `${prefix}${lines.join('')}${footer}`;
}

type State = { wf: Workflow; ev: number; calls: Map<number, Entry>; proposed: Set<number>; exposures: Entry[]; sent: number; replaying: boolean; ready: Map<number, CallResult>; running: Set<number>; outputs: Map<number, Entry>; values: Entry[]; needs: number };
export interface EngineOptions { evaluator?: EvaluatorTransport; discovery?: DiscoveryOptions }

/** A1, P2, P10, P11: Serialize decisions while executions run independently. */
export class Engine {
  readonly store: Store;
  /** R2: the cross-workflow event log's writer (derives milestones from the journals; R7 emits through it). */
  readonly events: EventPump;
  private r7?: { stop(): Promise<void>; tick(): Promise<void> };
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
  // wid -> executor runs whose follow-up has not run yet (prune never closes a journal they may still append to).
  private running = new Map<string, number>();
  /** Drain: held by a drain that applies to it (all, its session's origin, or itself) and recorded after its creation. */
  private held(wid: string): boolean {
    return holdOf(this.ledgers.orch.entries(), wid, this.store.workflows.get(wid)?.origin) !== undefined;
  }
  /** Follow-ups (generations) of the current revision that have not ended: on a finished workflow they are its only live work. */
  private openFollowUps(wf: Workflow): boolean {
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
    return () => { if (released) return; released = true; const n = this.running.get(wid)! - 1; if (n) this.running.set(wid, n); else this.running.delete(wid); };
  }
  private terminal(wf: Workflow) { return terminalEntry(revisionEntries(wf)); }
  private lifecycle(): DecisionRecord[] { return this.ledgers.orch.entries().filter(e => ['admitted', 'applied', 'rejected', 'withdrawn'].includes(e.type)) as unknown as DecisionRecord[]; }
  /** A2, P10: Recover executor authority before replaying each unfinished workflow. */
  async recover(): Promise<void> {
    await this.store.recover();
    // R2: before any recovery append, so every journal entry from here on is derived promptly (and a new log derives
    // everything still on disk).
    await this.events.open();
    for (const wf of this.store.workflows.values()) {
      await this.executor.recover(wf.wid, wf.journal);
      // A seal may survive a crash before post-seal effects, even after workflow completion.
      let revision = 1;
      for (const entry of wf.journal.entries()) {
        if (entry.type === 'revised') revision = Number(entry.revision);
        if (entry.type !== 'call' && entry.type !== 'generation') continue;
        const call = `${wf.wid}@${revision}/${entry.key}@${entry.gen}`;
        const log = wf.journal.entries();
        const result = log.find(e => e.type === JT.sealed && e.call === call)?.result as CallResult | undefined;
        if (result?.status !== 'ok' || !log.some(e => e.type === 'wt-intent' && e.call === call) ||
          log.some(e => ['wt-removed', 'wt-kept'].includes(e.type) && e.call === call)) continue;
        const original = await this.store.atRevision(wf, revision);
        await this.executor.run(this.ticket({ wf: original } as State, entry));
      }
    }
    await this.startHost();
    for (const intent of this.ledgers.orch.entries().filter(e => e.type === 'revise-intent')) await this.revise(intent);
    for (const wf of this.store.workflows.values()) {
      if (!this.terminal(wf)) await this.startWorkflow(wf);
      else await this.attention(wf);
      for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) this.dispatchGeneration(wf, entry);
    }
    await this.intake();
    this.startR7();
  }
  /** R7: every k.r7Ms (read here, at orchestrator start), why each live call does not move, as `waiting`/`moving`
   *  events through the pump. The tracker starts from the log's latest transition per call, so a restart repeats none
   *  (and a call that ended or started moving meanwhile gets its `moving`). The seed reads from seq 0: retention keeps
   *  events below `dropped`. A seed that cannot be read is logged and R7 starts empty (recovery never fails on it). */
  private startR7() {
    if (this.closed || this.r7) return;
    const latest = new Map<string, R7Seed>(), head = this.events.head;
    try {
      if (head) for (let since = 0, more = true; more;) {
        const page = readPage(eventsLog(this.ledgers.home), since, 1000);
        if (!page || page.epoch !== head.epoch) break;
        for (const e of page.events) if ((e.type === 'waiting' || e.type === 'moving') && e.call) latest.set(e.call, e as R7Seed);
        more = page.more && page.events.length > 0;
        if (page.events.length) since = Number(page.events.at(-1)!.cursor.split(':')[1]);
      }
    } catch (error) {
      console.error(`durable-subagents: R7 seed from the event log failed, starting without it: ${String(error)}`);
      latest.clear();
    }
    const tracker = new R7Tracker(); tracker.seed(latest);
    const collect = r7Collector({ home: this.ledgers.home, workflows: () => this.store.workflows.values(), orch: this.ledgers.orch, config: this.ledgers.config });
    this.r7 = startR7({ collect: () => collect(), sink: this.events, intervalMs: this.ledgers.config.k?.r7Ms, tracker });
  }
  private async startHost() {
    await this.evaluator.start(message => this.background(() => this.message(message)), () => this.background(async () => {
      await this.startHost();
      for (const wf of this.store.workflows.values()) if (!this.terminal(wf)) await this.startWorkflow(wf);
    }));
  }
  private async startWorkflow(wf: Workflow) {
    if (this.terminal(wf)) return;
    await this.resolveFinished(wf);
    const log = revisionEntries(wf);
    const ev = Math.max(0, ...wf.journal.entries().filter(e => e.type === 'ev').map(e => e.n as number)) + 1;
    await wf.journal.append('ev', { n: ev });
    const calls = new Map(log.filter(e => ['call', 'refused', 'reused'].includes(e.type)).map(e => [e.pos as number, e]));
    const st: State = { wf, ev, calls, proposed: new Set(), exposures: log.filter(e => e.type === 'exposed'), sent: 0, replaying: true, ready: new Map(), running: new Set(), outputs: new Map(log.filter(e => ['call', 'refused', 'reused', 'emit'].includes(e.type)).map(e => [e.pos as number, e])), values: log.filter(e => e.type === 'value'), needs: 0 };
    this.states.set(wf.wid, st);
    this.evaluator.send({ t: 'start', wid: wf.wid, ev, scriptPath: wf.scriptPath, args: wf.pins.args, inputs: wf.inputs });
  }
  /** P5, P6, A3: Commit lifecycle decisions in kernel order before acknowledging intake. */
  intake(): Promise<void> { return this.serial(() => this.consume()); }
  private async consume() {
    const scanned = (await scanInbox(orchInbox(this.ledgers.home))).filter(r => r.to === 'orch');
    const retained = this.ledgers.orch.entries().filter(e => e.type === 'request').map(e => e.request as Request);
    const candidates = [...retained, ...scanned];
    const before = reduceLifecycle(this.lifecycle()), staged = new Set<string>();
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
    const view = reduceLifecycle(this.lifecycle());
    for (const [rid, resolution] of view.resolved) {
      if (resolution.type === 'rejected' && ['run', 'revise'].includes(view.admitted.get(rid)?.kind ?? '')) await this.store.discardStage(rid);
    }
    for (const rid of view.tombstones) await this.store.discardStage(rid);
    for (const req of scanned) {
      if (view.resolved.has(req.rid) || (view.admitted.has(req.rid) && view.admitted.get(req.rid)!.hash !== contentHash(req))) {
        await unlink(join(orchInbox(this.ledgers.home), `${req.rid}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  private findCall(to: string, bareWid = false): { wf: Workflow; entry: Entry } | undefined {
    for (const wf of this.store.workflows.values()) {
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
    for (const wf of this.store.workflows.values()) {
      const requests = this.ledgers.orch.entries().filter(e => e.type === 'request').map(e => e.request as Request);
      const sent = requests.filter(r => r.kind === 'send' && rids.includes(r.rid));
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
      // R6: senders validate labels; a hand-written request must not bypass that.
      const labels = (req.body as RunBody | null)?.labels, invalid = !created && labels !== undefined ? labelsProblem(labels) : undefined;
      if (invalid) return { action: 'reject', reason: `invalid-labels: ${invalid}` };
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
      const existing = [...this.store.workflows.values()].flatMap(wf => wf.journal.entries().filter(e => e.type === 'generation' && e.rid === req.rid).map(entry => ({ wf, entry })))[0];
      if (existing) { this.dispatchGeneration(existing.wf, existing.entry); return { action: 'apply' }; }
      const target = this.findCall((req.body as SendBody)?.to, true);
      if (!target) return { action: 'reject', reason: this.unknownCall((req.body as SendBody)?.to) };
      const { wf, entry } = target, send = req.body as SendBody;
      const from = `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`;
      const seal = wf.journal.entries().find(e => e.type === JT.sealed && e.call === from);
      if (seal && send.kind === 'steer') return { action: 'reject', reason: `finished:${(seal.result as CallResult).status} — use kind "follow-up" to continue it` };
      // A pool's name is a model too: the call keeps the pool, and its order and failover apply to the new generation.
      const pools = this.ledgers.config.pools, pool = send.model !== undefined && pools && Object.hasOwn(pools, send.model);
      if (send.kind === 'follow-up' && send.model !== undefined && !pool) {
        try { if (!parseModel(send.model).provider) throw new Error('missing provider'); }
        catch { return { action: 'reject', reason: 'unknown-model' }; }
      }
      if (seal && send.kind === 'follow-up') {
        const gen = Math.max(0, ...wf.journal.entries().filter(e => ['call', 'generation'].includes(e.type) && e.key === entry.key).map(e => Number(e.gen))) + 1;
        // A follow-up's model replaces the continued session's for this generation and those continuing it.
        const spec = send.model !== undefined ? { ...(entry.spec as CallSpec), model: send.model } : entry.spec;
        if (send.model !== undefined) await this.note(req.rid, send.model, 'next-generation');
        const opened = await wf.journal.append('generation', { rid: req.rid, key: entry.key, gen, from, spec, revision: wf.revision, opening: { rid: req.rid, kind: send.kind, message: send.message ?? '' }, ...(send.model !== undefined && !pool ? { model: send.model } : {}) });
        this.dispatchGeneration(wf, opened); return { action: 'apply' };
      }
      // A follow-up naming a model, queued on unfinished work: the executor records its model request with the message.
      return this.executor.forward(req, this.context(wf, entry));
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
      const took = (wf: Workflow) => wf.journal.entries().some(e => e.type === 'resumed' && e.rid === req.rid);
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
      for (const wf of this.store.workflows.values()) for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) this.dispatchGeneration(wf, entry);
    } else if (req.kind === 'drain') {
      const { fence, origin, wid } = (req.body as DrainBody) ?? {}, scoped = Boolean(origin || wid);
      if (!this.ledgers.orch.entries().some(e => e.type === 'drain' && e.rid === req.rid)) {
        await this.ledgers.orch.append('drain', { rid: req.rid, fence: fence === true, ...(wid ? { wid } : origin ? { origin } : {}) });
      }
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
        const reason = restartRefusal(this.ledgers.home, gate.live.map(l => ({ ...l, origin: this.store.workflows.get(l.wid)?.origin })), body, req.from.startsWith('main:'));
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
    const done = this.terminal(wf), status = done ? String(done.status) : 'running';
    if (!['done', 'failed', 'stopped'].includes(status)) return `not-finished:${status}`;
    const log = wf.journal.entries(), has = (type: string, field: string, value: unknown) => log.some(e => e.type === type && e[field] === value);
    const openGeneration = log.some(e => e.type === 'generation' && !has(JT.sealed, 'call', `${wf.wid}@${e.revision}/${e.key}@${e.gen}`) && !has('retired', 'call', `${wf.wid}@${e.revision}/${e.key}@${e.gen}`));
    const liveExec = log.some(e => e.type === JT.exec && !has(JT.fenced, 'exec', e.exec) && !has(JT.sealed, 'call', e.call));
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
    // R2: its events are derived and logged before the journal can go (recovery removes it once `pruned` is committed);
    // when they cannot be, the prune is rejected and the caller retries later.
    try { await this.events.flush(); }
    catch (error) { return `event-log: ${error instanceof Error ? error.message : String(error)}`; }
    await this.ledgers.orch.append('pruned', { rid, wid: wf.wid, endedAt: done.ts, bytes, status: String(done.status), ...identity });
    this.states.delete(wf.wid);
    await this.store.drop(wf.wid);
    try { await this.store.remove(wf.wid); }
    catch (error) { console.error(`durable-subagents: removal of pruned workflow ${wf.wid} failed, retrying at next start: ${String(error)}`); }
  }
  private dispatchGeneration(wf: Workflow, entry: Entry) {
    const ticket = this.ticket({ wf } as State, entry), id = ticket.callId;
    if (this.generations.has(id) || this.held(wf.wid) || wf.journal.entries().some(e => e.type === 'retired' && e.call === id)) return;
    this.generations.add(id);
    void this.executor.run(ticket).then(() => this.background(async () => {
      if (!wf.journal.entries().some(e => e.type === JT.sealed && e.call === id)) throw new Error(`Generation returned without seal: ${id}`);
      if (!wf.journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`))
        await wf.journal.append(JT.attention, { item: { id: `finished:${id}`, rev: 1, kind: 'finished', wid: wf.wid, call: id, text: finishedText(wf.wid, wf.journal.entries(), id), origin: wf.origin } });
      this.generations.delete(id);
    }), error => {
      this.generations.delete(id);
      if (error instanceof Error && error.name === 'ExecutorShutdown') return;
      this.background(async () => { throw error; });
    });
  }
  /** The reply to a send that names a model says which model and when it applies (orchestrator ledger `send-note`). */
  private async note(rid: string, model: string, effect: string): Promise<void> {
    if (!this.ledgers.orch.entries().some(e => e.type === 'send-note' && e.rid === rid)) await this.ledgers.orch.append('send-note', { rid, model, effect });
  }
  private ticket(st: State, entry: Entry): CallTicket {
    const spec = entry.spec as CallSpec, agent = st.wf.pins.agents.find(a => a.name === spec.agent);
    if (!agent) throw new Error(`Unknown pinned agent: ${spec.agent}`);
    return { wid: st.wf.wid, widRev: `${st.wf.wid}@${st.wf.revision}`, key: entry.key as string, gen: entry.gen as number,
      callId: `${st.wf.wid}@${st.wf.revision}/${entry.key}@${entry.gen}`, spec, agent, workflowBudget: st.wf.pins.usageBudget, cwd: resolve(st.wf.cwd, spec.cwd ?? '.'), journal: st.wf.journal,
      ...(st.wf.originPath !== undefined ? { originSession: st.wf.originPath } : {}),
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
    for (const [pos, result] of st.ready) {
      await st.wf.journal.append('exposed', { pos });
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
      const agent = st.wf.pins.agents.find(a => a.name === message.spec.agent) ?? null;
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
        if (!problems.length && !agent) problems.push(unknownAgent(message.spec.agent, st.wf.pins.agents));
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
  }
  /** K6, P5: Watch with polling fallback and exit only after continuous quiescence. */
  async loop(signal?: AbortSignal): Promise<void> {
    const inbox = orchInbox(this.ledgers.home);
    await mkdir(inbox, { recursive: true });
    this.watcher = watch(inbox, () => this.background(() => this.consume()));
    this.watcher.on('error', () => { this.watcher?.close(); });
    this.poll = setInterval(() => this.background(() => this.consume()), 1000);
    let idleSince = performance.now();
    try {
      while (!signal?.aborted && !this.closed && !this.restarting) {
        await this.queue;
        if (this.failure) throw this.failure;
        const files = await readdir(inbox);
        // Held (drained) workflows cannot progress until a resume request, which restarts the orchestrator: they do not keep it alive.
        if (this.generations.size || [...this.store.workflows.values()].some(w => !this.terminal(w) && !this.held(w.wid)) || this.executor.busy() || files.length) idleSince = performance.now();
        else if (performance.now() - idleSince >= (this.ledgers.config.k?.idleExitMs ?? 10_000)) return;
        await delay(Math.min(100, this.ledgers.config.k?.idleExitMs ?? 100));
      }
    } finally { this.watcher?.close(); clearInterval(this.poll); }
  }
  /** A1, A2: Retire asynchronous producers before closing their journals. */
  async close(): Promise<void> {
    this.closed = true; this.watcher?.close(); clearInterval(this.poll);
    await this.r7?.stop(); await this.queue; await this.evaluator.close(); await this.executor.shutdown(); await this.events.close(); await this.store.close();
  }
}
