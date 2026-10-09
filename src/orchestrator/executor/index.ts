// Private journal entries (A1): tracked{exec,pid,start}; loss{exec}; settled{exec};
// stop-intent{call}; forward{rid,rid2,dest,hash,envelope:{to,kind,body,cond?}};
// forward-delivered{rid,rid2,call,reason?}: the first observed child receipt of a forward (once per forward; reason when
// the child resolved it as rejected, e.g. withdrawn); forward-retired{rid,rid2,reason}: sealed/retired without a receipt (P27).
// observation{exec,event}; selected{exec,model}; switch-observed{exec,rid,pool}.
// P28 entries are documented in hibernate.ts; generation session publication in generation.ts.
// session-corrupt{call,line}: a malformed native session line was skipped (once per line, E4).
// fence-failed{exec,error} is documented in sweep.ts. The orchestrator ledger owns hold/release{pool,slot,exec}
// and mem{available,admitted,exec} (every admission; a repeated refusal at most every 30 s per call). All transitions are serialized before publication.
import { mkdir, open, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CT, JT, attentionEntries, isEntry, type CallResult, type Containment, type Entry, type JournalHandle, type ModelBody, type ProcInfo, type Request, type SendBody, type Spawned, type WithdrawBody } from "../../types.ts";
import { binDir, callDir, callInbox, callSession, journalPath, outboxRoot } from "../../paths.ts";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { Outbox } from "../../kernel/mailbox.ts";
import { contentHash, forwardRid } from "../../kernel/ids.ts";
import { capacity, seal } from "../../kernel/guards.ts";
import { buildPiArgs } from "../../compat/pi-args.ts";
import { parseModel, resolveModel, type Model } from "../../compat/model.ts";
import { buildCallResult } from "../../compat/result.ts";
import type { CallEffects, CallTicket, Executor, Ledgers } from "../contract.ts";
import createEffects from "./effects/index.ts";
import { continueSession } from "./generation.ts";
import { hibernation, openQuestion } from "./hibernate.ts";
import { emptyLedger, foldLedger, holdings as holdingsOf, settingsOf } from "../ledger.ts";
import { evidence, fatalProviderError, quotaExhausted, refusedByProvider, forgetSession, readSessionState, receiptId, sessionModel, type SessionEntry } from "./session.ts";
import { activeTotal } from "./time.ts";
import { entriesOf, trackedState, usageIds } from "./indexes.ts";
import { observeExecution } from "./observe.ts";
import { availableMemory } from "./memory.ts";
import { reached, sessionUsage, totalUsage, type Usage } from "./usage.ts";
import { indexSweep, recordFenceFailure, resolveFenceAttention, serialContainment, skipLostCandidate, sweepExecutions } from "./sweep.ts";
import { gateRetired } from "./effects/gate.ts";
import { WorktreeIndex, worktreeCalls, worktreeLabel, worktreePair, worktreeRoots, type WorktreeWrite } from "./worktree.ts";

type Envelope = Pick<Request, "to" | "kind" | "body" | "cond">;
type Active = { ticket: CallTicket; controller: AbortController; promise: Promise<CallResult>; wake: () => void; stopped: boolean; retired?: boolean; suspended?: boolean;
  parking?: string; onPark: Set<() => void>; refusedAt?: number;
  /** Restart: set while its execution's child runs (from the launch gate to the fence) or its gates run before the seal. */
  live?: { exec: string; since: number; phase: "child" | "gate" } };
const MEM_RECORD_MS = 30000;
/** A4, P29: A child admitted within this window may not show in MemAvailable yet; its share is reserved explicitly. */
const MEM_WARMUP_MS = 30000;
/** Quota refusals in a row that find a provider's usage window used up while pi is still retrying. */
const QUOTA_REFUSALS = 2;
const ignoreMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; };
const callOf = (exec: string) => exec.slice(0, exec.lastIndexOf("#"));
const shutdownError = () => Object.assign(new Error("executor shutdown; call resumes on recovery"), { name: "ExecutorShutdown" });
const extension = fileURLToPath(new URL(`../../agent/extension.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
const entriesFor = (journal: JournalHandle, call: string) => journal.entries().filter(e => e.call === call);
const current = (journal: JournalHandle, call: string) => entriesFor(journal, call).findLast(e => e.type === JT.exec)?.exec as string | undefined;
const sealed = (journal: JournalHandle, call: string) => entriesFor(journal, call).find(e => e.type === JT.sealed)?.result as CallResult | undefined;
const has = (journal: JournalHandle, type: string, exec: string) => entriesOf(journal, type, exec).length > 0;
/** The rid of the model request a follow-up naming a model makes (P12): derived, so withdrawing or replacing the
 *  follow-up withdraws its model request too. */
export const modelRid = (rid: string) => contentHash([rid, "model"]);
/** The model a call was asked to use and has not used yet: a follow-up's `model`, then each model send in order. One the
 *  child rejected or that was withdrawn does not count; one already used does not either — the child applied it, or an
 *  execution of the call answered with it — so the session's model and the pool's fallback rule again after that.
 *  Its next execution launches on it (P12, P37). */
export function requestedModel(journal: JournalHandle, call: string, followUp?: string): Model | undefined {
  const all = journal.entries(), execs = new Set(all.filter(e => e.type === JT.exec && e.call === call).map(e => String(e.exec)));
  const same = (a: Model, b: unknown) => (b as Model | undefined)?.provider === a.provider && (b as Model | undefined)?.id === a.id;
  const usedAfter = (m: Model, index: number) => all.some((e, i) => i > index && (e.type === "selected" || e.type === "model-used") && execs.has(String(e.exec)) && same(m, e.model));
  let wanted: Model | undefined;
  if (followUp) { const m = parseModel(followUp); if (!usedAfter(m, -1)) wanted = m; }
  for (const [index, e] of all.entries()) {
    // A failover's switch is not a request: an execution that ends before applying it leaves the choice to the pool.
    if (e.type !== "forward" || e.dest !== call || (e.envelope as Envelope | undefined)?.kind !== "model" || e.failover) continue;
    const delivered = all.find(r => r.type === "forward-delivered" && r.call === call && r.rid2 === e.rid2);
    if (delivered) { wanted = undefined; continue; } // applied by the child (now the session's model) or refused by it
    if (all.some(r => r.type === "forward" && r.dest === call && (r.envelope as Envelope).kind === "withdraw" && ((r.envelope as Envelope).body as { rids?: string[] }).rids?.includes(String(e.rid2)))) continue;
    const body = (e.envelope as Envelope).body as ModelBody;
    const m: Model = { provider: body.provider, id: body.model, ...(body.thinking ? { thinking: body.thinking as Model["thinking"] } : {}) };
    wanted = usedAfter(m, index) ? undefined : m;
  }
  return wanted;
}
function address(call: string) {
  const match = /^(.*)@(\d+)\/(.*)@(\d+)$/.exec(call);
  if (!match) throw new Error(`Invalid call identity: ${call}`);
  return { wid: match[1]!, key: match[3]!, gen: Number(match[4]) };
}

async function defaultModel(): Promise<string | undefined> {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as { defaultProvider?: string; defaultModel?: string };
  return settings.defaultModel ? `${settings.defaultProvider ? `${settings.defaultProvider}/` : ""}${settings.defaultModel}` : undefined;
}

/** P2, P9, P22: Construct the journal-owned execution authority under the engine's OS lock. */
/** Restart feedback: a resumed child believed the test loop it had started was still running and slept on it. Its
 *  previous execution was stopped (fenced), and with it every process its tools started, background ones included. */
export function continueMessage(dangling: readonly string[]): string {
  return "Your previous execution was interrupted and this one continues the task. Processes your tools started " +
    "(background ones included) were stopped with it: do not wait for them or their output; check what they left " +
    "and start again what is still needed. Tool calls whose outcomes are unknown: " + (dangling.join(", ") || "none") + ".";
}
/** An asker hibernates while it waits (its execution is stopped to free the provider slot), so the answer says so. */
export const HIBERNATED_NOTE = "While you waited for the answer below your execution was stopped; processes your tools had " +
  "started (background ones included) were stopped with it. Check them before relying on them.";
export default function createExecutor(ledgers: Ledgers, options: { memory?: () => Promise<number>; sweepMs?: number; effects?: CallEffects; containment?: Containment } = {}): Executor {
  const { home, config, orch } = ledgers;
  const containment = options.containment ?? serialContainment(), effects = options.effects ?? createEffects(ledgers);
  const active = new Map<string, Active>(), completed = new Map<string, Promise<CallResult>>(), journals = new Map<string, JournalHandle>();
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
  let suspending: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  // F1: execs whose fence failed in this process; they are retried only by the sweep.
  const failing = new Set<string>();
  // F2: a sweep error is transient: report it and retry at the next K1; it never blocks dispatch.
  const sweepTimer = setInterval(() => {
    if (!sweeping) sweeping = sweepExecutions([...journals.values()].filter(j => !j.closed), containment, { failing: exec => failing.has(exec), fenced: swept, failed: fenceFailed })
      .catch(error => console.error(`durable-subagents: sweep failed, retrying in K1: ${String(error)}`)).finally(() => { sweeping = undefined; });
  }, options.sweepMs ?? 30000);
  sweepTimer.unref();
  const waiters = new Set<() => void>();
  const inbox = (call: string) => { const a = address(call); return callInbox(home, a.wid, a.key, a.gen); };
  const outbox = Outbox.open(outboxRoot(home), "orch", inbox);
  // Serial sections contain durable transitions, never slot waits, process waits or fences.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn); queue = next.catch(() => {}); return next;
  };
  const wake = () => { for (const fn of waiters) fn(); waiters.clear(); };
  // F3, A1: fold only orchestrator entries appended since the last fold (ledger.ts, shared with `status`).
  const ledger = emptyLedger();
  const folded = () => foldLedger(ledger, orch.entries());
  /** A4: guards read the settings recorded in the ledger (config.json changes are recorded between admissions). */
  const settings = () => settingsOf(folded(), config);
  const holdings = () => holdingsOf(folded());
  const skipped = (pool: string, model: Model) => (folded().skips.get(`${pool}\n${model.provider}/${model.id}`) ?? 0) > Date.now();
  /** A provider whose usage window is used up admits no call until its next try, and then one probe at a time. */
  const unavailable = (provider: string | undefined) => {
    const x = provider ? folded().exhausted.get(provider) : undefined;
    return !!x && (Date.now() < x.nextTry || x.probe !== undefined);
  };
  async function release(exec: string) {
    await serial(async () => { for (const h of holdings().filter(e => e.exec === exec)) await orch.append("release", { pool: h.pool, slot: h.slot, exec }); });
    wake();
  }
  function tracked(journal: JournalHandle, exec: string): ProcInfo[] {
    return trackedState(journal, exec).rows;
  }
  /** Persist every newly seen identity, tagged or not: a process that later clears its tag and leaves the tree must
   *  still be fenced after an orchestrator restart. */
  async function track(journal: JournalHandle, exec: string, found?: ProcInfo[]) {
    const known = tracked(journal, exec);
    found ??= (await containment.scan(new Map([[exec, known]]), { maxAgeMs: config.k?.trackerMs ?? 1000 })).get(exec) ?? [];
    await serial(async () => {
      const { ids } = trackedState(journal, exec);
      for (const p of found) if (p.start && !ids.has(`${p.pid}:${p.start}`)) {
        await journal.append("tracked", { exec, pid: p.pid, start: p.start }); trackedState(journal, exec);
      }
    });
    return found;
  }
  /** P22, F1: Fence an execution; false when its processes did not provably exit. With `park` the call instead waits,
   *  unsealed and without a new execution, until a sweep proves retirement (suspend/shutdown still interrupt it). */
  async function fence(journal: JournalHandle, exec: string, opts: { child?: Spawned; park?: Active } = {}): Promise<boolean> {
    opts.child?.stdin.end();
    if (has(journal, JT.fenced, exec)) return true;
    if (!failing.has(exec)) {
      let retired = false;
      try { await containment.fence(exec, tracked(journal, exec)); retired = true; }
      catch (error) { await fenceFailed(journal, exec, callOf(exec), error); }
      if (retired) { await fenceSucceeded(journal, exec); return true; }
    }
    if (!opts.park) return false;
    await parked(opts.park, journal, exec);
    return true;
  }
  async function fenceSucceeded(journal: JournalHandle, exec: string) {
    failing.delete(exec);
    await serial(async () => {
      if (!has(journal, JT.fenced, exec)) await journal.append(JT.fenced, { exec });
      await resolveFenceAttention(journal, exec);
    });
  }
  /** F1: A fence timeout is recorded once with one unknown attention item for the origin; any failure parks the exec. */
  async function fenceFailed(journal: JournalHandle, exec: string, call: string, error: unknown) {
    if (!failing.has(exec)) console.error(`durable-subagents: fence of ${exec} failed: ${String(error)}`);
    failing.add(exec);
    if (/Fence timeout/.test(String(error))) await serial(() => recordFenceFailure(journal, exec, call, error));
  }
  async function parked(a: Active, journal: JournalHandle, exec: string) {
    a.parking = exec;
    for (const fn of a.onPark) fn();
    try {
      while (!has(journal, JT.fenced, exec)) {
        if (closed || a.suspended) throw shutdownError();
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, config.k?.trackerMs ?? 1000); a.wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } finally { a.parking = undefined; }
  }
  /** F1: Wait for a run to settle, or to park on an unfenced execution (a stop/retire never waits on a stuck fence). */
  function settledOrParked(a: Active): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (a.parking) return resolve(undefined);
      const now = () => resolve(undefined);
      a.onPark.add(now);
      void a.promise.then(resolve, reject).finally(() => a.onPark.delete(now));
    });
  }
  /** P23, F1: A sweep proved an exec retired: commit the fence, free its slots and resume or settle its call. */
  async function swept(journal: JournalHandle, exec: string, call: string, wasFenced: boolean) {
    if (exec.startsWith("gate:")) { failing.delete(exec); await serial(() => gateRetired(journal, exec)); return; }
    await fenceSucceeded(journal, exec);
    if (wasFenced) return;
    await release(exec);
    const a = active.get(call);
    if (a) { a.wake(); return; }
    if (closed || sealed(journal, call) || current(journal, call) !== exec || !entriesFor(journal, call).some(e => e.type === "stop-intent")) return;
    const { key, gen } = address(call);
    await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
  }
  // E4: a malformed native session line is skipped exactly like pi does, and recorded once per line.
  const corruptions = new Set<string>();
  async function readCall(journal: JournalHandle, call: string): Promise<SessionEntry[]> {
    const a = address(call), { entries, corrupt } = await readSessionState(callSession(home, a.wid, a.key, a.gen));
    for (const line of corrupt) {
      const id = `${call}\n${line}`;
      if (corruptions.has(id)) continue;
      corruptions.add(id);
      if (journal.entries().some(e => e.type === "session-corrupt" && e.call === call && e.line === line)) continue;
      console.error(`durable-subagents: skipped malformed line ${line} of the session of ${call}`);
      await journal.append("session-corrupt", { call, line });
    }
    return entries;
  }
  // E2: inbox files are deleted once their resolution is durable: a child receipt (after an fsync of the session)
  // or the call's seal. The child never re-applies a resolved request: its receipts are in the session it recovers.
  const collected = new Map<string, Set<string>>();
  async function collectReceipts(call: string, entries: SessionEntry[]) {
    const done = collected.get(call) ?? new Set<string>(); collected.set(call, done);
    const fresh = new Set<string>();
    for (const e of entries) {
      const rid = receiptId(e);
      if (rid && !done.has(rid) && !/^\.|[/\\\0]/.test(rid) && !(e.customType === CT.rejected && e.data?.reason === "identity-conflict")) fresh.add(rid);
    }
    if (!fresh.size) return;
    const a = address(call), file = await open(callSession(home, a.wid, a.key, a.gen), "r");
    try { await file.sync(); } finally { await file.close(); }
    const sender = await outbox, dir = inbox(call);
    for (const rid of fresh) {
      await sender.markResolved(rid);
      await unlink(join(dir, `${rid}.json`)).catch(ignoreMissing);
      done.add(rid);
    }
  }
  async function collectSealed(call: string) {
    const sender = await outbox, dir = inbox(call);
    for (const name of await readdir(dir).catch(error => { ignoreMissing(error); return []; })) {
      if (name.endsWith(".json") && !name.startsWith(".")) await sender.markResolved(name.slice(0, -5));
      await rm(join(dir, name), { force: true });
    }
  }
  /** P7, P27: Record forward-delivered once when a forward's child receipt is first observed; serial sections only. */
  /** The reply to a model send says which model and when it applies (orchestrator ledger `send-note`, once per rid). */
  async function note(rid: string, model: string, effect: string, pool?: string) {
    if (!orch.entries().some(e => e.type === "send-note" && e.rid === rid)) await orch.append("send-note", { rid, model, effect, ...(pool ? { pool } : {}) });
  }
  async function forwardsDelivered(journal: JournalHandle, call: string, entries: SessionEntry[]) {
    const all = journal.entries();
    const open = all.filter(e => e.type === "forward" && e.dest === call &&
      !all.some(r => r.rid2 === e.rid2 && (r.type === "forward-retired" || (r.type === "forward-delivered" && r.call === call))));
    if (!open.length) return;
    const receipts = new Map<string, SessionEntry>();
    for (const e of entries) {
      const rid = receiptId(e);
      if (rid && !receipts.has(rid) && !(e.customType === CT.rejected && e.data?.reason === "identity-conflict")) receipts.set(rid, e);
    }
    for (const e of open) {
      const receipt = receipts.get(String(e.rid2)); if (!receipt) continue;
      const reason = receipt.customType === CT.rejected ? receipt.data?.reason : undefined;
      await journal.append("forward-delivered", { rid: e.rid, rid2: e.rid2, call, ...(reason !== undefined ? { reason: String(reason) } : {}) });
    }
  }
  async function retireForwards(journal: JournalHandle, call: string) {
    const entries = await readCall(journal, call);
    await forwardsDelivered(journal, call, entries);
    const receipts = new Set(entries.map(receiptId).filter(rid => rid !== undefined));
    for (const e of journal.entries().filter(e => e.type === "forward" && e.dest === call)) {
      if (!receipts.has(String(e.rid2)) && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))
        await journal.append("forward-retired", { rid: e.rid, rid2: e.rid2, reason: "retired-without-child-receipt" });
      await (await outbox).markResolved(String(e.rid2));
    }
  }
  async function recordUsage(t: CallTicket, values: { id: string; usage: Usage }[]) {
    await serial(async () => {
      for (const u of values) if (!usageIds(t.journal, t.callId).has(u.id)) await t.journal.append("usage", { call: t.callId, ...u });
      await workflowReached(t);
    });
  }
  async function workflowReached(t: CallTicket) {
    const hit = reached(totalUsage(entriesOf(t.journal, "usage")), t.workflowBudget), id = `budget:${t.wid}`;
    if (hit && !entriesOf(t.journal, JT.attention).some(e => isEntry(e, JT.attention) && e.item.id === id))
      await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "budget", text: "Workflow budget reached", wid: t.wid } });
    return hit;
  }
  const roots = worktreeRoots(), writes = new WorktreeIndex();
  const indexed = () => writes.scan(journals.values());
  const origin = (w: WorktreeWrite) => writes.origin(w.journal) ?? orch.entries().find(e => e.type === JT.created && e.wid === address(w.call).wid)?.origin;
  // Serial sections only: wrote and attention are durable before another writer or seal can interleave.
  /** Remind of every pair of calls that wrote in `root` and have not ended, once per pair and journal. The index must be
   *  current; each append here is indexed at once (only that journal is read). */
  async function remind(root: string) {
    const live = writes.live(root);
    for (let i = 0; i < live.length; i++) for (let k = i + 1; k < live.length; k++) {
      const [first, second] = WorktreeIndex.order(live[i]!, live[k]!), id = worktreePair(first.call, second.call);
      // A retry after a partial cross-workflow append keeps the reminder (and its writer) as first written.
      const prior = writes.reminder(id), secondWid = address(second.call).wid;
      const targets = origin(first) === origin(second) ? [prior && prior.wid !== secondWid ? first : second] : [second, first];
      const item = prior ?? { id, rev: 1, kind: "conflict" as const, call: second.call, wid: secondWid,
        text: `${worktreeLabel(first.call)} and ${worktreeLabel(second.call)} both write in ${root} (edit/write seen); assign one owner or move one to its own worktree` };
      for (const target of targets) if (!writes.remindedIn(id, target.journal))
        { await target.journal.append(JT.attention, { item: { ...item, wid: address(target.call).wid } }); writes.scan([target.journal]); }
    }
  }
  async function wrote(t: CallTicket, exec: string, cwd: string, path: string) {
    const root = await roots(cwd, path); if (!root) return;
    await serial(async () => {
      if (sealed(t.journal, t.callId) || has(t.journal, JT.fenced, exec) || current(t.journal, t.callId) !== exec) return;
      if (indexed().has(exec, root)) return;
      const after = writes.live(root).map(w => w.call).filter(c => c !== t.callId);
      await t.journal.append("wrote", { exec, root, ...(after.length ? { after } : {}) });
      writes.scan([t.journal]);
      await remind(root);
    });
  }
  /** Close the reminders of pairs where `call` (or, without one, any participant) ended. */
  async function resolveWorktrees(call?: string) {
    for (const { id, journal, item } of indexed().open()) {
      const pair = worktreeCalls(id);
      if (call ? pair.includes(call) : pair.some(c => writes.ended(c)))
        await journal.append(JT.attentionResolved, { id, rev: item.rev, resolution: "ended" });
    }
  }
  async function retireAttention(journal: JournalHandle, call: string) {
    await resolveWorktrees(call);
    for (const { item } of attentionEntries(journal.entries())) {
      if (item.kind === "finished" || item.id === `unknown:${call}` || item.id.startsWith("fence:")) continue;
      if (item.call === call && !journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev))
        await journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: "retired" });
    }
  }
  /** P15, AC4: A call sealed `unknown` raises exactly one unknown item for its origin; seal and recovery both run this. */
  async function unknownAttention(journal: JournalHandle, call: string) {
    const result = sealed(journal, call), id = `unknown:${call}`;
    if (result?.status !== "unknown" || journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === id)) return;
    const text = `Call ${call} ended with an unknown outcome: ${result.error || "no evidence of what it did"}. It was not re-run; check its effects before continuing.`;
    await journal.append(JT.attention, { item: { id, rev: 1, kind: "unknown", text, wid: address(call).wid, call } });
  }
  async function finish(journal: JournalHandle, call: string, exec: string, result: CallResult) {
    const a = active.get(call);
    if (a && !sealed(journal, call) && !["stopped", "timeout", "budget"].includes(result.status)) {
      const started = Date.now(), prior = activeTotal(journal.entries(), call);
      const check = async () => {
        if (stopped(a)) a.controller.abort();
        if (a.ticket.spec.timeoutMs !== undefined && prior + Date.now() - started >= a.ticket.spec.timeoutMs) {
          a.controller.abort();
          await serial(async () => { if (!has(journal, "timeout-intent", exec)) await journal.append("timeout-intent", { exec, call }); });
        }
        if (reached(totalUsage(journal.entries(), call), a.ticket.spec.budget)) a.controller.abort();
      };
      let checking = Promise.resolve();
      const timer = setInterval(() => { checking = checking.then(check); }, config.k?.trackerMs ?? 1000);
      try {
        await check(); await launchGate(a, exec, "gate");
        if (!interrupted(a)) result = await effects.beforeSeal(a.ticket, exec, result, { signal: a.controller.signal });
        await check();
      }
      catch (error) { result = buildCallResult({ key: result.key, gen: result.gen, status: "failed", output: result.output, error: String(error) }); }
      finally { clearInterval(timer); await checking; a.live = undefined; }
    }
    const value = await serial(async () => {
      const old = sealed(journal, call);
      if (old) return old;
      if (!seal({ sealed: false, exec: current(journal, call) ?? "" }, { exec })) throw new Error(`Stale seal: ${exec}`);
      if (!has(journal, JT.fenced, exec)) throw new Error(`Unfenced seal: ${exec}`);
      if (closed || active.get(call)?.suspended || journal.entries().some(e => e.type === "retired" && e.call === call)) throw shutdownError();
      if (entriesFor(journal, call).some(e => e.type === "stop-intent")) result = buildCallResult({ key: result.key, gen: result.gen, status: "stopped", output: "" });
      else if (has(journal, "timeout-intent", exec)) result = buildCallResult({ key: result.key, gen: result.gen, status: "timeout", output: "" });
      else if (a && reached(totalUsage(journal.entries(), call), a.ticket.spec.budget)) result = buildCallResult({ key: result.key, gen: result.gen, status: "budget", output: "" });
      result = { ...result, usage: totalUsage(journal.entries(), call) };
      await journal.append(JT.sealed, { call, exec, result });
      await retireForwards(journal, call);
      const selected = journal.entries().find(e => e.type === "selected" && e.exec === exec);
      if (selected?.pool && result.status === "ok") await orch.append("candidate-success", { pool: selected.pool, model: `${(selected.model as Model).provider}/${(selected.model as Model).id}`, exec });
      await retireAttention(journal, call);
      await unknownAttention(journal, call);
      return result;
    });
    await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
    await release(exec);
    if (a) await effects.afterSeal(a.ticket, value);
    return value;
  }
  const stopped = (a: Active) => a.stopped || entriesFor(a.ticket.journal, a.ticket.callId).some(e => e.type === "stop-intent");
  const interrupted = (a: Active) => closed || a.suspended || a.retired || stopped(a);
  // Restart (RestartBody): while one is decided no execution passes this gate, so the executions it finds live are all
  // there are; one that passes is live until its fence (or the end of its gates). Synchronous from the check to the mark.
  let paused = false;
  const unpaused = new Set<() => void>();
  async function launchGate(a: Active, exec: string, phase: "child" | "gate") {
    while (paused && !interrupted(a)) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, config.k?.trackerMs ?? 1000);
        function done() { clearTimeout(timer); unpaused.delete(done); resolve(); }
        unpaused.add(done); a.wake = done;
      });
    }
    if (!interrupted(a)) a.live = { exec, since: Date.now(), phase };
  }
  // Writer lock: one call that writes in a worktree runs there at a time. Ownership is durable (writer-hold/-release in
  // the orchestrator ledger) and lasts from the first admission to the call's seal or retirement, across executions,
  // hibernation and orchestrator restarts. Waiters are admitted in the order they first waited.
  const writerWaits = new Map<string, { root: string; since: number; holder?: string; recovered?: number }>();
  /** A waiter recovered from the journal keeps its place this long for its call to come back after a restart. */
  const RECOVERED_WAIT_MS = 60_000;
  async function writerRoot(t: CallTicket, cwd: string): Promise<string | undefined> {
    if (t.spec.isolation === "worktree") return;
    const tools = t.spec.tools ?? t.agent.tools;
    if (!(t.spec.writer ?? (!tools || tools.some(n => n === "edit" || n === "write")))) return;
    return await roots(cwd, "x") ?? await realpath(cwd).catch(() => cwd);
  }
  /** Whether every execution of `call` was fenced: until then its processes may still write. */
  function writerFenced(entries: readonly Entry[], call: string): boolean {
    const fenced = new Set(entries.filter(e => e.type === JT.fenced).map(e => String(e.exec)));
    return entries.every(e => e.type !== JT.exec || callOf(String(e.exec)) !== call || fenced.has(String(e.exec)));
  }
  /** An owner whose call ended (sealed, retired, revised away, its workflow done or pruned) and whose executions were
   *  all fenced no longer holds the lock. */
  function writerEnded(call: string): boolean {
    if (active.has(call)) return false;
    const { wid } = address(call), rev = Number(/^.*@(\d+)\//.exec(call)?.[1]);
    const journal = journals.get(wid), entries = journal && !journal.closed ? journal.entries() : readJournalSnapshot(journalPath(home, wid));
    if (!entries.length) return true;
    if (!writerFenced(entries, call)) return false;
    const revised = entries.findLastIndex(e => e.type === "revised");
    if (revised >= 0 && Number(entries[revised]!.revision) > rev) return true;
    return entries.some((e, i) => (e.type === JT.sealed || e.type === "retired") && e.call === call || i > revised && e.type === JT.done);
  }
  /** Serial sections only: whether `a` may write in `root` now; records the wait (durably, for status) when not. */
  async function writerAdmit(a: Active, root: string): Promise<boolean> {
    if ((settings().writerLock ?? "queue") === "off") return true;
    const t = a.ticket, call = t.callId;
    let owner = folded().writers.get(root)?.call;
    if (owner && owner !== call && writerEnded(owner)) { await orch.append("writer-release", { root, call: owner, ended: true }); owner = undefined; }
    if (owner === call) return true;
    const mine = writerWaits.get(call) ?? { root, since: t.journal.entries().find(e => e.type === "writer-wait" && e.call === call)?.ts ?? Date.now() };
    writerWaits.set(call, mine);
    delete mine.recovered;
    const waiting = (c: string, w: { recovered?: number }) => active.has(c) ? !interrupted(active.get(c)!)
      : w.recovered !== undefined && Date.now() - w.recovered < RECOVERED_WAIT_MS && !writerEnded(c);
    const earlier = [...writerWaits].filter(([c, w]) => c !== call && w.root === root && (w.since < mine.since || w.since === mine.since && c < call) && waiting(c, w)).map(([c]) => c);
    const holder = owner ?? earlier[0];
    if (!holder) {
      await orch.append("writer-hold", { root, call });
      writerWaits.delete(call);
      const waited = t.journal.entries().findLast(e => (e.type === "writer-wait" || e.type === "writer-acquired") && e.call === call);
      if (waited?.type === "writer-wait") {
        await t.journal.append("writer-acquired", { call, root });
        const item = attentionEntries(t.journal.entries()).find(x => x.item.id === `writer:${call}`)?.item;
        if (item && !t.journal.entries().some(e => e.type === JT.attentionResolved && e.id === item.id && e.rev === item.rev))
          await t.journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: "acquired" });
      }
      return true;
    }
    const last = t.journal.entries().findLast(e => (e.type === "writer-wait" || e.type === "writer-acquired") && e.call === call);
    if (mine.holder !== holder && !(last?.type === "writer-wait" && last.holder === holder && last.root === root)) {
      await t.journal.append("writer-wait", { call, root, holder, ...(owner ? {} : { queued: true }) });
    }
    mine.holder = holder;
    const id = `writer:${call}`;
    if (!t.journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === id)) {
      const h = address(holder);
      const text = `${worktreeLabel(call)} waits for the writer lock of ${root}: ${h.wid}/${h.key} ${owner ? "holds it" : "waits for it first"}. ` +
        `It starts when that call ends. To run it now: stop one of them, run it with writer:false (when it does not write there) or isolation:"worktree"`;
      await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "conflict", text, wid: t.wid, call } });
    }
    return false;
  }
  async function writerRelease(call: string) {
    await serial(async () => {
      writerWaits.delete(call);
      for (const [root, owner] of folded().writers) if (owner.call === call) await orch.append("writer-release", { root, call });
    });
    wake();
  }
  /** Wait for a slot. The candidates are decided again on every attempt, inside the serial section that also applies
   *  config.json changes: a queued call follows a reloaded defaultModel, pool or limit, never a mix of two versions. */
  async function acquire(a: Active, exec: string, decide: () => Promise<Awaited<ReturnType<typeof launchModel>>>, writer?: string): Promise<{ model?: Model; continuation: boolean }> {
    let continuation = false;
    for (;;) {
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      const chosen = await serial(async () => {
        if (interrupted(a) || await workflowReached(a.ticket)) return;
        if (writer && !await writerAdmit(a, writer)) return;
        const decision = await decide(), models = decision.candidates, pool = decision.pool;
        continuation = decision.continuation;
        for (const model of models) {
          if (!continuation && pool && models.length > 1 && skipped(pool, model)) continue;
          const provider = model.provider;
          if (unavailable(provider)) continue;
          const probe = provider !== undefined && folded().exhausted.has(provider);
          const holders = holdings().filter(e => e.pool === provider);
          const limit = settings().providers?.[provider ?? ""]?.slots ?? Infinity;
          if (!capacity({ kind: "provider", holders: holders.length, capacity: limit })) continue;
          // A burst of dispatches all read the same MemAvailable before any child has grown: subtract the children
          // admitted in the last 30 s (their memory is not visible yet), so a burst cannot over-commit the headroom.
          const perChild = settings().memory?.perChildMb ?? 300;
          const warming = holdings().filter(e => e.pool === "memory" && Date.now() - e.ts < MEM_WARMUP_MS).length;
          const measured = await (options.memory ?? availableMemory)(), available = measured - warming * perChild;
          const admitted = capacity({ kind: "memory", available, reserve: settings().memory?.reserveMb ?? 2048, perChild });
          // F3: every admitted dispatch is recorded; repeated refusals at most once per 30 s per call.
          if (admitted || a.refusedAt === undefined || Date.now() - a.refusedAt >= MEM_RECORD_MS) {
            await orch.append("mem", { available, admitted, exec, ...(warming ? { measured, warming } : {}) }); a.refusedAt = admitted ? undefined : Date.now();
          }
          if (!admitted) return;
          const memory = holdings().filter(e => e.pool === "memory");
          let memorySlot = 0; while (memory.some(e => e.slot === memorySlot)) memorySlot++;
          await orch.append("hold", { pool: "memory", slot: memorySlot, exec });
          if (provider) {
            let slot = 0; while (holders.some(e => e.slot === slot)) slot++;
            await orch.append("hold", { pool: provider, slot, exec });
            // After its next try, the first call admitted to a used-up provider is its probe: its first request
            // either goes through (the provider is available again) or is refused, which uses no quota.
            if (probe) await orch.append("provider-probe", { provider, exec });
          }
          await a.ticket.journal.append("selected", { exec, model, ...(pool ? { pool } : {}) });
          return model;
        }
      });
      if (chosen || interrupted(a) || reached(totalUsage(a.ticket.journal.entries()), a.ticket.workflowBudget)) { waiters.delete(signal); return { model: chosen, continuation }; }
      const timer = setTimeout(signal, config.k?.trackerMs ?? 1000);
      try { await changed; } finally { clearTimeout(timer); waiters.delete(signal); }
    }
  }
  /** P13, C5, C8: Decide holdings and CLI model restoration from the same fenced session. */
  async function launchModel(t: CallTicket, entries: SessionEntry[], previous?: string) {
    const recorded = sessionModel(entries);
    const ownSegment = entries.some(e => e.type === "custom" && e.customType === CT.exec && typeof e.data?.exec === "string" && e.data.exec.startsWith(`${t.callId}#`));
    const freshFork = t.spec.context === "fork" && !t.continueFrom && !ownSegment;
    const { defaultModel: configured, pools } = settings();
    const raw = t.spec.model ?? t.agent.model ?? configured ?? await defaultModel();
    const pool = raw && pools?.[raw] ? raw : undefined;
    const candidates = raw ? resolveModel(raw, pools) : [{ id: "" }];
    const candidate = recorded && candidates.some(m => m.provider === recorded.provider && m.id === recorded.id);
    // Leave the session's model for the pool's others when its pool skips it after losses, or its provider's usage
    // window is used up; and at a new generation, go back to the pool's order of preference.
    // A new generation of a pool call starts from the pool also when the session's model is not one of its models
    // (switched outside it, or the follow-up named the pool).
    const skip = pool && (candidate ? previous && ownSegment && skipped(pool, recorded!) || unavailable(recorded!.provider) || !ownSegment && !!t.continueFrom
      : !ownSegment && !!t.continueFrom);
    // A model the call was asked to use replaces the session's: launched with it, and holding its provider's slot.
    const wanted = requestedModel(t.journal, t.callId, t.model);
    // It outranks the pool's order at a new generation too, also when it names the model the session already has.
    // A requested model of the call's own pool keeps the pool: a used-up window still moves the call on.
    const keep = pool && candidates.some(m => m.provider === wanted?.provider && m.id === wanted?.id) ? pool : undefined;
    if (wanted) return recorded && !freshFork && recorded.provider === wanted.provider && recorded.id === wanted.id
      ? { candidates: [recorded], continuation: true, pool: keep }
      : { candidates: [wanted], continuation: false, pool: keep };
    if (recorded && !freshFork && !skip) return { candidates: [recorded], continuation: true, pool: candidate ? pool : undefined };
    return { candidates, continuation: false, pool };
  }
  async function questions(t: CallTicket, entries: SessionEntry[]) {
    await collectReceipts(t.callId, entries).catch(error => console.error(`durable-subagents: inbox cleanup of ${t.callId} failed: ${String(error)}`));
    await serial(async () => {
      await forwardsDelivered(t.journal, t.callId, entries);
      for (const e of entries) {
        if (e.type !== "custom" || e.customType !== CT.question || !e.data) continue;
        const { qid, rev, question } = e.data;
        if (typeof qid !== "string" || typeof rev !== "number") continue;
        const id = `q:${t.callId}:${qid}`;
        if (!t.journal.entries().some(r => isEntry(r, JT.attention) && r.item.id === id && r.item.rev === rev))
          await t.journal.append(JT.attention, { item: { id, rev, kind: "question", text: String(question), wid: t.wid, call: t.callId, qid, session: callSession(home, t.wid, t.key, t.gen) } });
        const answered = entries.some(r => {
          const details = r.message?.details ?? r.details;
          return details?.qid === qid && details?.rev === rev && receiptId(r) !== undefined;
        });
        if (answered && !t.journal.entries().some(r => r.type === JT.attentionResolved && r.id === id && r.rev === rev))
          await t.journal.append(JT.attentionResolved, { id, rev, resolution: "answered" });
      }
    });
  }
  /** The model each execution last answered with (`selected`, then `model-used`), cached per execution. */
  const inUse = new Map<string, string>();
  async function switched(exec: string, journal: JournalHandle, event: Record<string, unknown>) {
    const message = event.message as { role?: string; provider?: string; model?: string } | undefined, provider = message?.provider;
    if (!provider) return;
    await serial(async () => {
      // Evidence of the model in use: the provider and model of each assistant message, recorded when it changes.
      if (message.role === "assistant" && message.model) {
        const name = `${provider}/${message.model}`;
        if (!inUse.has(exec)) {
          const last = journal.entries().findLast(e => (e.type === "selected" || e.type === "model-used") && e.exec === exec)?.model as Model | undefined;
          if (last) inUse.set(exec, `${last.provider}/${last.id}`);
        }
        if (inUse.get(exec) !== name) { await journal.append("model-used", { exec, model: { provider, id: message.model } }); inUse.set(exec, name); }
      }
      const target = holdings().find(h => h.exec === exec && h.pool === provider && h.reserved);
      if (!target) return;
      if (!folded().observed.has(`${exec}\n${target.rid}`)) {
        await orch.append("switch-observed", { exec, rid: target.rid, pool: provider });
        for (const h of holdings().filter(h => h.exec === exec && h.pool !== provider && h.pool !== "memory")) await orch.append("release", { pool: h.pool, slot: h.slot, exec });
      }
    });
    wake();
  }
  /** The model an execution last answered with, or was launched on. */
  function modelOf(journal: JournalHandle, exec: string): Model | undefined {
    return journal.entries().findLast(e => (e.type === "selected" || e.type === "model-used") && e.exec === exec)?.model as Model | undefined;
  }
  /** Record a used-up provider once per window: again only when its probe (or any call after the next try) is refused. */
  async function recordExhausted(provider: string, exec: string, error: string) {
    const x = folded().exhausted.get(provider), now = Date.now();
    // While a probe runs, its outcome alone decides: a late refusal of an execution admitted earlier changes nothing.
    if (x && (x.probe ? x.probe !== exec : now < x.nextTry)) return;
    // Once per execution and provider: an execution moved on by failover can find a second provider used up too.
    if (orch.entries().some(e => e.type === "provider-exhausted" && e.exec === exec && e.provider === provider)) return;
    await orch.append("provider-exhausted", { provider, exec, since: x?.since ?? now, nextTry: now + (config.k?.probeMs ?? 900_000), error: error.slice(0, 300) });
  }
  /** Quota refusals in a row per execution, from one provider (pi retries a refused request on its own). */
  const refusals = new Map<string, { provider: string; count: number }>();
  /** A used-up window shows while pi still retries: the second refusal in a row (the first for a probe) finds the
   *  provider used up, and a call launched from a pool switches to the pool's next model at its next request. */
  async function refused(t: CallTicket, exec: string, provider: string, error: string) {
    if (!quotaExhausted(error)) return;
    const last = refusals.get(exec), count = last?.provider === provider ? last.count + 1 : 1;
    refusals.set(exec, { provider, count });
    const probe = folded().exhausted.get(provider)?.probe === exec;
    if (count < (probe ? 1 : QUOTA_REFUSALS)) return;
    await serial(async () => {
      if (has(t.journal, JT.fenced, exec) || current(t.journal, t.callId) !== exec) return;
      await recordExhausted(provider, exec, error);
      await failover(t, exec, provider);
    });
    wake();
  }
  /** Switch a running execution off a used-up provider: to the first model of its pool on another provider that is
   *  neither used up nor full, reserving that slot as a requested switch does. Without one, pi's retries go on and
   *  the call waits for the provider once they end. */
  async function failover(t: CallTicket, exec: string, provider: string) {
    if (pendingSwitch(exec)) return;
    const pool = t.journal.entries().findLast(e => e.type === "selected" && e.exec === exec)?.pool as string | undefined, pools = settings().pools;
    if (!pool || !pools?.[pool]) return;
    let models: Model[]; try { models = resolveModel(pool, pools); } catch { return; }
    for (const m of models) {
      if (!m.provider || m.provider === provider || unavailable(m.provider) || skipped(pool, m)) continue;
      const rid = contentHash([exec, "failover", provider]);
      if (t.journal.entries().some(e => e.type === "forward" && e.rid === rid)) return;
      const probe = folded().exhausted.has(m.provider); // its next try is due (`unavailable` said so): this is its probe
      if (!await reserveSwitch(exec, m.provider, rid)) continue;
      if (probe) await orch.append("provider-probe", { provider: m.provider, exec });
      // Bound to this execution: replayed after it ended, a later execution (which chose its model at launch) refuses it.
      const body: ModelBody = { provider: m.provider, model: m.id, ...(m.thinking ? { thinking: m.thinking } : {}), exec };
      const envelope: Envelope = { to: t.callId, kind: "model", body }, hash = contentHash(envelope);
      const entry = await t.journal.append("forward", { rid, rid2: forwardRid(rid, t.callId.slice(0, t.callId.indexOf("/")), t.key, hash), dest: t.callId, hash, envelope, failover: provider });
      await replayForward(entry);
      return;
    }
  }
  /** Hold a slot of `provider` for a running execution's switch, unless it holds one; false when it is full. */
  async function reserveSwitch(exec: string, provider: string, rid: string): Promise<boolean> {
    if (holdings().some(h => h.exec === exec && h.pool === provider)) return true;
    const target = holdings().filter(h => h.pool === provider);
    if (!capacity({ kind: "provider", holders: target.length, capacity: settings().providers?.[provider]?.slots ?? Infinity })) return false;
    let slot = 0; while (target.some(h => h.slot === slot)) slot++;
    await orch.append("hold", { pool: provider, slot, exec, reserved: true, rid });
    return true;
  }
  /** An answer from a used-up provider, requested after it was found used up: available again. */
  async function answered(t: CallTicket, exec: string, event: Record<string, unknown>) {
    const message = event.message as { role?: string; provider?: string; stopReason?: string; timestamp?: number; errorMessage?: string } | undefined, provider = message?.provider;
    if (message?.role !== "assistant" || !provider) return;
    if (message.stopReason === "error") return refused(t, exec, provider, String(message.errorMessage ?? ""));
    refusals.delete(exec);
    await serial(async () => {
      const x = folded().exhausted.get(provider);
      if (x && (x.probe === exec || Number(message.timestamp) > x.since)) await orch.append("provider-available", { provider, exec });
    });
    wake();
  }
  function pendingSwitch(exec: string) {
    return holdings().find(h => h.exec === exec && h.reserved && !folded().observed.has(`${exec}\n${h.rid}`));
  }
  async function execute(a: Active): Promise<CallResult> {
    const t = a.ticket, journal = t.journal;
    const session = callSession(home, t.wid, t.key, t.gen), dir = callDir(home, t.wid, t.key, t.gen);
    const makeResult = (status: CallResult["status"], output = "", error?: string) => buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) });
    let cwd = t.cwd, writer: string | undefined;
    if (sealed(journal, t.callId)) { const result = sealed(journal, t.callId)!; await effects.afterSeal(t, result); return result; }
    try {
      await continueSession(home, t, session);
      cwd = (await effects.prepare(t, { sessionPath: session })).cwd;
    } catch (error) {
      const exec = current(journal, t.callId) ?? `${t.callId}#1.1`;
      if (!current(journal, t.callId)) await serial(() => journal.append(JT.exec, { call: t.callId, exec }));
      await fence(journal, exec, { park: a });
      return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
    }
    for (;;) {
      const old = sealed(journal, t.callId); if (old) return old;
      if (closed || a.suspended || a.retired || journal.entries().some(e => e.type === "retired" && e.call === t.callId)) throw shutdownError();
      let exec = current(journal, t.callId);
      let entries = await readCall(journal, t.callId);
      let dangling: string[] = [];
      let bound: Entry | undefined;
      const sleeping = hibernation(journal, t.callId);
      if (exec && sleeping?.exec === exec) {
        await fence(journal, exec, { park: a }); await release(exec);
        for (;;) {
          if (interrupted(a) || has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs) break;
          if (reached(totalUsage(journal.entries(), t.callId), t.spec.budget) || reached(totalUsage(journal.entries()), t.workflowBudget))
            return finish(journal, t.callId, exec, makeResult("budget"));
          bound = journal.entries().find(e => e.type === "answer-bound" && e.call === t.callId && e.qid === sleeping.qid && e.rev === sleeping.rev);
          if (bound) break;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, config.k?.trackerMs ?? 1000); a.wake = () => { clearTimeout(timer); resolve(); }; });
        }
      }
      const pendingAnswer = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      if (!bound && pendingAnswer && !entries.some(e => receiptId(e) === pendingAnswer.rid2)) bound = pendingAnswer;
      if (exec) {
        await fence(journal, exec, { park: a });
        await questions(t, entries = await readCall(journal, t.callId));
        await recordUsage(t, sessionUsage(entries, t.callId));
        const ev = evidence(entries, exec); dangling = ev.dangling;
        if (closed || a.suspended || a.retired) throw shutdownError();
        if (stopped(a)) return finish(journal, t.callId, exec, makeResult("stopped"));
        if (has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs)
          return finish(journal, t.callId, exec, makeResult("timeout"));
        if (ev.budget || reached(totalUsage(journal.entries(), t.callId), t.spec.budget)) return finish(journal, t.callId, exec, makeResult("budget"));
        if (!bound) {
        // P28: an execution cut off while its only unfinished tool call is the open question's `ask` (before it
        // hibernated) was waiting, not working: it hibernates now and resumes with the answer, like a planned
        // hibernation; it is neither a loss nor, for `once`, an unknown outcome.
        const asking = openQuestion(entries);
        if (asking && dangling.length && dangling.every(d => d.startsWith("ask (")) && hibernation(journal, t.callId)?.exec !== exec) {
          await serial(() => journal.append("hibernated", { call: t.callId, exec, qid: asking.qid, rev: asking.rev }));
          continue;
        }
        if (ev.report) return finish(journal, t.callId, exec, buildCallResult({ key: t.key, gen: t.gen, status: ev.report.outcome as "ok" | "failed", output: ev.text, usage: ev.usage,
          ...(Object.hasOwn(ev.report, "data") ? { report: { data: ev.report.data } } : {}), ...(Array.isArray(ev.report.artifacts) ? { artifacts: ev.report.artifacts as string[] } : {}) }));
        if (t.spec.schema === undefined && has(journal, "settled", exec) && ev.text)
          return finish(journal, t.callId, exec, { ...makeResult("ok", ev.text), usage: ev.usage });
        if (t.spec.once && dangling.length) return finish(journal, t.callId, exec, makeResult("unknown", "", `Unknown tool outcomes: ${dangling.join(", ")}`));
        if (has(journal, "settled", exec) && !ev.text && ev.error && fatalProviderError(ev.error))
          return finish(journal, t.callId, exec, makeResult("failed", "", `Provider error: ${ev.error}`));
        // A refusal of the content is deterministic: the same request is refused again, so it is reported, not retried.
        if (has(journal, "settled", exec) && !ev.text && ev.error && refusedByProvider(ev.error))
          return finish(journal, t.callId, exec, makeResult("failed", "", `Refused by the provider (not retried): ${ev.error.slice(0, 500)}`));
        // A used-up usage window is no loss: the provider is avoided until a probe finds it accepting requests again,
        // and the call goes on with the pool's next model, or waits for that provider.
        const exhausted = has(journal, "settled", exec) && !ev.text && ev.error && quotaExhausted(ev.error) ? modelOf(journal, exec)?.provider : undefined;
        if (exhausted) await serial(() => recordExhausted(exhausted, exec!, ev.error!));
        else await serial(async () => {
          if (!has(journal, "loss", exec!)) await journal.append("loss", { exec });
          await skipLostCandidate(journal, orch, exec!);
        });
        const losses = journal.entries().filter(e => e.type === "loss" && String(e.exec).startsWith(`${t.callId}#`)).length;
        if (losses >= (config.k?.lossBound ?? 5)) return finish(journal, t.callId, exec, makeResult("failed", "", `lost ×${losses}${ev.error ? `; last error: ${ev.error.slice(0, 300)}` : ""}`));
        await release(exec);
        }
      }
      const previous = exec;
      const epoch = previous ? Number(previous.split(".").at(-1)) + 1 : 1;
      exec = `${t.callId}#1.${epoch}`;
      await serial(() => journal.append(JT.exec, { exec, call: t.callId }));
      if (interrupted(a)) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("stopped")); }
      if (await serial(() => workflowReached(t))) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("failed", "", "workflow budget reached")); }
      let decision: Awaited<ReturnType<typeof acquire>>;
      try {
        decision = await acquire(a, exec, () => launchModel(t, entries, previous), writer ??= await writerRoot(t, cwd));
      } catch (error) {
        await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
      }
      const model = decision.model;
      if (!model || interrupted(a)) {
        await fence(journal, exec, { park: a });
        return finish(journal, t.callId, exec, !interrupted(a) ? makeResult("failed", "", "workflow budget reached") : makeResult("stopped"));
      }
      await mkdir(dir, { recursive: true });
      const prompt = join(dir, "system.txt"), schema = join(dir, "schema.json");
      // These are derived launch inputs, reconstructed from the pinned ticket after a crash.
      await writeFile(prompt, t.agent.body);
      if (t.spec.schema !== undefined) await writeFile(schema, JSON.stringify(t.spec.schema));
      const sender = await outbox;
      if (bound) await serial(async () => {
        if (!journal.entries().some(e => e.type === "resumed" && e.call === t.callId && e.rid === bound!.rid)) await journal.append("resumed", { call: t.callId, rid: bound!.rid, exec });
      });
      // The answer uses its stable forwarded identity across every recovery incarnation.
      const unresolved = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      const receipt = unresolved && entries.some(e => receiptId(e) === unresolved.rid2);
      const openingRid = t.opening && contentHash([t.opening.rid, "dispatch"]);
      const openingReceived = openingRid && entries.some(e => receiptId(e) === openingRid);
      // The task has one identity: the dispatch of the call's first execution. A later execution continues only once
      // the session holds that task; an execution interrupted before its child received it (still waiting for a
      // provider slot, say) leaves a session without a task, and "continue" would ask a fresh model to guess.
      const taskRid = contentHash([`${t.callId}#1.1`, "dispatch"]);
      const taskReceived = !openingRid && entries.some(e => receiptId(e) === taskRid);
      if (openingRid && !openingReceived) await sender.send(t.callId, "task", { message: t.opening!.message }, undefined, { rid: openingRid });
      else if (!openingRid && !taskReceived) await sender.send(t.callId, "task", { message: t.spec.task }, undefined, { rid: taskRid });
      else if (unresolved && !receipt) await sender.send(t.callId, "continue", { message: String(unresolved.message) }, { qid: String(unresolved.qid), rev: Number(unresolved.rev) }, { rid: String(unresolved.rid2) });
      else if (previous) await sender.send(t.callId, "continue", { message: continueMessage(dangling) }, undefined, { rid: contentHash([exec, "dispatch"]) });
      else await sender.send(t.callId, "task", { message: t.opening?.message ?? t.spec.task }, undefined, { rid: contentHash([exec, "dispatch"]) });
      await launchGate(a, exec, "child");
      if (interrupted(a)) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let child: Spawned;
      try {
        child = await containment.spawn({ exec, command: "pi", args: [...buildPiArgs(t.agent, t.spec, { sessionPath: session, systemPromptPath: prompt, continuation: decision.continuation, controlTools: t.spec.schema === undefined ? ["ask"] : ["ask", "report"], ...(model.id ? { model } : {}) }), "-e", extension], cwd,
          env: { DSA_HOME: home, PATH: [binDir(home), process.env.PATH].filter(Boolean).join(delimiter), DSA_EXEC: exec, DSA_CALL: t.callId, DSA_INBOX: inbox(t.callId), DSA_JOURNAL: journal.path, ...(t.spec.schema !== undefined ? { DSA_SCHEMA: schema } : {}), ...(t.spec.budget ? { DSA_BUDGET: JSON.stringify(t.spec.budget) } : {}), ...(model.provider && model.id ? { DSA_MODEL: `${model.provider}/${model.id}` } : {}) } });
      } catch (error) {
        await fence(journal, exec, { park: a }); a.live = undefined;
        return finish(journal, t.callId, exec, makeResult("failed", "", `Spawn failed: ${String(error)}`));
      }
      try {
        await track(journal, exec, [{ pid: child.pid, start: child.start, ppid: process.pid }]);
        await observeExecution({ home, config, ticket: t, exec, child, serial, read: () => readCall(journal, t.callId),
          setWake: fn => { a.wake = fn; }, interrupted: () => !!interrupted(a),
          track: () => track(journal, exec!), fence: async () => { await fence(journal, exec!, { child, park: a }); },
          questions: async entries => {
            await questions(t, entries);
            const q = openQuestion(entries);
            const segment = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.exec && e.data?.exec === exec);
            if (!q || interrupted(a) || segment < 0 || !entries.slice(segment + 1).some(e => e.customType === CT.question && e.data?.qid === q.qid) || journal.entries().some(e => e.type === "answer-bound" && e.call === t.callId && e.qid === q.qid && e.rev === q.rev)) return;
            await serial(async () => {
              const attention = journal.entries().find(e => isEntry(e, JT.attention) && e.item.qid === q.qid && e.item.call === t.callId && e.item.rev === q.rev);
              if (attention && Date.now() - attention.ts >= (config.k?.hibernateMs ?? 120000) && !has(journal, JT.fenced, exec!) && hibernation(journal, t.callId)?.exec !== exec) {
                await journal.append("hibernated", { call: t.callId, exec, qid: q.qid, rev: q.rev }); a.wake();
              }
            });
          }, recordUsage: values => recordUsage(t, values),
          wrote: path => wrote(t, exec!, cwd, path),
          switched: event => switched(exec!, journal, event), answered: event => answered(t, exec!, event), pendingSwitch: () => pendingSwitch(exec!),
        });
      } finally { await fence(journal, exec, { child, park: a }); a.live = undefined; }
    }
  }
  async function replayForward(e: Entry) {
    const envelope = e.envelope as Envelope;
    await (await outbox).send(envelope.to, envelope.kind, envelope.body, envelope.cond, { rid: String(e.rid2) });
  }
  return {
    async reconfigure(apply) { await serial(apply); wake(); },
    run(ticket) {
      const existing = completed.get(ticket.callId); if (existing) return existing;
      if (closed || suspending) return Promise.reject(shutdownError());
      journals.set(ticket.wid, ticket.journal);
      const a: Active = { ticket, controller: new AbortController(), stopped: false, wake: () => {}, promise: undefined!, onPark: new Set() };
      active.set(ticket.callId, a);
      a.promise = serial(async () => {
        // Repair a crash between wrote and attention (or between the two origin journals).
        for (const root of indexed().contested()) await remind(root);
        await resolveWorktrees();
      }).then(() => execute(a)).catch(error => {
        completed.delete(ticket.callId);
        if (a.retired || ticket.journal.entries().some(e => e.type === "retired" && e.call === ticket.callId)) return buildCallResult({ key: ticket.key, gen: ticket.gen, status: "stopped", output: "", error: "retired" });
        throw error;
      }).finally(async () => {
        const exec = current(ticket.journal, ticket.callId);
        try {
          if (exec && await fence(ticket.journal, exec)) await release(exec);
          // The writer lock outlives executions and restarts; it ends with the call (or its retirement).
          // Not before every execution is fenced: a later sweep proves it, and the next writer's admission releases it.
          if ((sealed(ticket.journal, ticket.callId) || a.retired || ticket.journal.entries().some(e => e.type === "retired" && e.call === ticket.callId))
            && writerFenced(ticket.journal.entries(), ticket.callId)) await writerRelease(ticket.callId);
        }
        finally {
          writerWaits.delete(ticket.callId);
          active.delete(ticket.callId); collected.delete(ticket.callId); for (const e of inUse.keys()) if (callOf(e) === ticket.callId) inUse.delete(e);
          for (const e of refusals.keys()) if (callOf(e) === ticket.callId) refusals.delete(e); forgetSession(callSession(home, ticket.wid, ticket.key, ticket.gen)); wake();
        }
      });
      // Shutdown rejection is still delivered to callers, without an unhandled rejection during teardown.
      void a.promise.catch(() => {});
      completed.set(ticket.callId, a.promise);
      return a.promise;
    },
    async forward(req, ctx) {
      return serial(async () => {
        const dest = `${ctx.widRev}/${ctx.key}@${ctx.gen}`, hash = contentHash(req);
        journals.set(address(dest).wid, ctx.journal);
        if (ctx.journal.entries().some(e => e.type === "retired" && e.call === dest)) return { action: "reject", reason: req.kind === "send" && (req.body as SendBody).kind === "answer" ? "retired" : "stale-revision" } as const;
        const opening = active.get(dest)?.ticket.opening;
        if (opening && !sealed(ctx.journal, dest)) await (await outbox).send(dest, "task", { message: opening.message }, undefined, { rid: contentHash([opening.rid, "dispatch"]) });
        const prior = ctx.journal.entries().find(e => e.type === "forward" && e.rid === req.rid && e.dest === dest);
        if (prior) {
          if (prior.hash !== hash) return { action: "reject", reason: "identity-conflict" } as const;
          if (!ctx.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === prior.rid2)) await replayForward(prior);
          return { action: "apply" } as const;
        }
        const boundRetry = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.rid === req.rid);
        if (boundRetry) return boundRetry.hash === hash ? { action: "apply" } as const : { action: "reject", reason: "identity-conflict" } as const;
        if (sealed(ctx.journal, dest)) return { action: "reject", reason: req.kind === "send" && (req.body as SendBody).kind === "answer" ? "retired" : "call-sealed" } as const;
        if (req.kind === "send" && (req.body as SendBody).kind === "answer") {
          const sleeping = hibernation(ctx.journal, dest);
          const priorAnswer = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.qid === req.cond?.qid && e.rev === req.cond?.rev);
          if (priorAnswer) return priorAnswer.rid === req.rid && priorAnswer.hash === hash ? { action: "apply" } as const : { action: "reject", reason: "already-answered" } as const;
          if (sleeping && current(ctx.journal, dest) === sleeping.exec) {
            if (sleeping.qid !== req.cond?.qid || sleeping.rev !== req.cond?.rev) return { action: "reject", reason: "stale-rev" } as const;
            const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
            const item = attentionEntries(ctx.journal.entries()).find(e => e.item.call === dest && e.item.qid === sleeping.qid && e.item.rev === sleeping.rev)?.item;
            await ctx.journal.append("answer-bound", { call: dest, qid: sleeping.qid, rev: sleeping.rev, rid: req.rid, rid2, hash, message: `${HIBERNATED_NOTE}\n\nQuestion: ${item?.text ?? sleeping.qid}\nAnswer: ${(req.body as SendBody).message ?? ""}` });
            active.get(dest)?.wake(); wake();
            return { action: "apply" } as const;
          }
        }
        /** P12: a model request to this call, recorded with the rid given; a reject has no effect. */
        const requestModel = async (rid: string, model: string, hash: string, cond?: Envelope["cond"]) => {
          let body: ModelBody;
          const exec = current(ctx.journal, dest);
          // P28: with no live execution (not started yet, between executions, hibernated while asking) the model is
          // recorded and the next execution launches on it (`requestedModel`); its slot is acquired then, as for any launch.
          const idle = !exec || has(ctx.journal, JT.fenced, exec) || !has(ctx.journal, "selected", exec);
          // A pool's name asks for its first model that can take the call now: provider not used up, and (for a running
          // call) a free slot. The call's own pool stays, so a used-up window later moves it on as before.
          const pools = settings().pools, pool = pools && Object.hasOwn(pools, model) ? model : undefined;
          if (pool) {
            let models: Model[]; try { models = resolveModel(pool, pools); } catch { return { action: "reject", reason: "unknown-model" } as const; }
            const free = (p: string) => idle || holdings().some(h => h.exec === exec && h.pool === p) ||
              capacity({ kind: "provider", holders: holdings().filter(h => h.pool === p).length, capacity: settings().providers?.[p]?.slots ?? Infinity });
            const m = models.find(m => m.provider && !unavailable(m.provider) && free(m.provider));
            if (!m) return { action: "reject", reason: "pool-unavailable" } as const;
            model = `${m.provider}/${m.id}${m.thinking ? `:${m.thinking}` : ""}`;
          }
          try { const m = parseModel(model); if (!m.provider) throw new Error("Missing provider"); body = { provider: m.provider, model: m.id, ...(m.thinking ? { thinking: m.thinking } : {}) }; }
          catch { return { action: "reject", reason: "unknown-model" } as const; }
          const envelope: Envelope = { to: dest, kind: "model", body, ...(cond && Object.keys(cond).length ? { cond } : {}) };
          const rid2 = forwardRid(rid, ctx.widRev, ctx.key, hash);
          // Launching (`selected`, not `tracked` yet): the child may start on the old model; ask again in a moment.
          if (!idle && !has(ctx.journal, "tracked", exec!)) return { action: "reject", reason: "call-starting" } as const;
          if (!idle && pendingSwitch(exec!)) return { action: "reject", reason: "switch-pending" } as const;
          if (!idle && !await reserveSwitch(exec!, body.provider, rid)) return { action: "reject", reason: "provider-full" } as const;
          await note(req.rid, model, idle ? "next-execution" : "next-request", pool);
          const entry = await ctx.journal.append("forward", { rid, rid2, dest, hash, envelope });
          await replayForward(entry);
          if (idle) { active.get(dest)?.wake(); wake(); }
          return undefined;
        };
        let kind: Request["kind"], body: unknown;
        if (req.kind === "send" && (req.body as SendBody).kind === "follow-up" && (req.body as SendBody).model !== undefined) {
          // A follow-up naming a model, queued on unfinished work: the model request and the message are recorded in one
          // section, so a seal cannot come between them (both or neither). A replay finds the model request recorded.
          const mrid = modelRid(req.rid);
          if (!ctx.journal.entries().some(e => e.type === "forward" && e.rid === mrid && e.dest === dest)) {
            const refused = await requestModel(mrid, (req.body as SendBody).model!, contentHash([hash, "model"]));
            if (refused) return { action: "reject", reason: `model: ${refused.reason}` } as const;
          }
        }
        if (req.kind === "withdraw") {
          kind = "withdraw";
          const targets = (req.body as WithdrawBody).rids.flatMap(rid => [rid, modelRid(rid)]);
          body = { rids: ctx.journal.entries().filter(e => e.type === "forward" && e.dest === dest && targets.includes(String(e.rid))).map(e => String(e.rid2)) };
        } else if (req.kind === "send") {
          const send = req.body as SendBody; kind = send.kind;
          body = kind === "model" ? undefined : { message: send.message ?? "" };
        } else return { action: "reject", reason: "unsupported" } as const;
        const cond = { ...req.cond }; delete cond.epoch;
        if (cond.after) {
          const dependency = ctx.journal.entries().find(e => e.type === "forward" && e.dest === dest && e.rid === cond.after);
          if (dependency) cond.after = String(dependency.rid2); else delete cond.after;
        }
        if (kind === "model") return (await requestModel(req.rid, (req.body as SendBody).model ?? "", hash, cond)) ?? { action: "apply" } as const;
        const envelope: Envelope = { to: dest, kind, body, ...(Object.keys(cond).length ? { cond } : {}) };
        const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
        const entry = await ctx.journal.append("forward", { rid: req.rid, rid2, dest, hash, envelope });
        await replayForward(entry);
        if (kind === "withdraw") {
          const exec = current(ctx.journal, dest), reservation = exec && pendingSwitch(exec);
          if (reservation && (req.body as WithdrawBody).rids.some(rid => rid === reservation.rid || modelRid(rid) === reservation.rid)) active.get(dest)?.wake();
        }
        return { action: "apply" } as const;
      });
    },
    async stop(target) {
      const journal = journals.get(target.wid); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && (!target.callId || e.call === target.callId)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.wid === target.wid && (!target.callId || a.ticket.callId === target.callId)) calls.add(a.ticket.callId);
      for (const call of calls) { const a = active.get(call); if (a) { a.stopped = true; a.controller.abort(); } }
      await serial(async () => {
        for (const call of calls) if (!sealed(journal, call) && !entriesFor(journal, call).some(e => e.type === "stop-intent")) await journal.append("stop-intent", { call });
      });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call);
        if (a) await settledOrParked(a);
        else {
          const exec = current(journal, call); if (!exec || sealed(journal, call)) continue;
          // F1: a stuck fence leaves the call unsealed; the sweep seals it stopped once the exec is retired.
          if (!await fence(journal, exec)) continue;
          const { key, gen } = address(call);
          await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
        }
      }
    },
    async recover(wid, journal) {
      journals.set(wid, journal);
      indexSweep(journal);
      await serial(() => resolveWorktrees());
      await effects.recover(journal);
      for (const e of journal.entries().filter(e => e.type === JT.exec)) {
        // F1: an exec whose fence fails stays unfenced and holding; its call parks until a sweep retires it.
        const exec = String(e.exec); if (await fence(journal, exec)) await release(exec);
      }
      // Writers that waited before the restart keep their order while their calls come back.
      for (const e of journal.entries()) {
        const call = String(e.call);
        if (e.type === "writer-wait" && !writerWaits.has(call)) writerWaits.set(call, { root: String(e.root), since: e.ts, recovered: Date.now() });
        else if (e.type === "writer-acquired" || e.type === JT.sealed || e.type === "retired") { const w = writerWaits.get(call); if (w?.recovered !== undefined) writerWaits.delete(call); }
      }
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec).map(e => String(e.call)));
      for (const call of calls) {
        const session = await readCall(journal, call), values = sessionUsage(session, call);
        await serial(async () => {
          await forwardsDelivered(journal, call, session);
          const recorded = new Set(journal.entries().filter(e => e.type === "usage" && e.call === call).map(e => e.id));
          for (const u of values) if (!recorded.has(u.id)) await journal.append("usage", { call, ...u });
          if (sealed(journal, call) || journal.entries().some(e => e.type === "retired" && e.call === call)) {
            await retireForwards(journal, call); await retireAttention(journal, call); await unknownAttention(journal, call);
          }
        });
        if (!active.has(call)) { const a = address(call); forgetSession(callSession(home, a.wid, a.key, a.gen)); }
      }
      for (const e of journal.entries().filter(e => e.type === "forward" && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))) await replayForward(e);
      await (await outbox).republishPending();
      // E2: republication may restore envelopes of sealed calls; those are resolved by the seal.
      for (const call of calls) if (sealed(journal, call)) await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
    },
    async retire(widRev) {
      const journal = journals.get(widRev.slice(0, widRev.lastIndexOf("@"))); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && String(e.call).startsWith(`${widRev}/`)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.widRev === widRev) { a.retired = true; a.controller.abort(); calls.add(a.ticket.callId); }
      await serial(async () => { for (const call of calls) if (!journal.entries().some(e => e.type === "retired" && e.call === call)) await journal.append("retired", { call }); });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call); if (a) await settledOrParked(a);
        for (const e of journal.entries().filter(e => e.type === JT.exec && e.call === call)) if (await fence(journal, String(e.exec))) await release(String(e.exec));
        await serial(async () => { await retireForwards(journal, call); await retireAttention(journal, call); });
      }
    },
    busy: () => active.size > 0,
    quiesce() {
      paused = true;
      const live = [...active.values()].filter(a => a.live).map(a => ({ wid: a.ticket.wid, key: a.ticket.key, gen: a.ticket.gen, callId: a.ticket.callId, ...a.live! }));
      return { live, resume: () => { paused = false; for (const fn of [...unpaused]) fn(); } };
    },
    suspend(only?: (wid: string) => boolean) {
      if (only) { // scoped (one session's quit, one workflow): other workflows keep running and dispatching
        const targets = [...active.values()].filter(a => only(a.ticket.wid));
        for (const a of targets) { a.suspended = true; a.controller.abort(); a.wake(); }
        wake();
        return (async () => {
          const results = await Promise.allSettled(targets.map(a => a.promise));
          await queue;
          const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
          if (failed?.status === "rejected") throw failed.reason;
        })();
      }
      if (suspending) return suspending;
      for (const a of active.values()) { a.suspended = true; a.controller.abort(); a.wake(); }
      wake();
      suspending = (async () => {
        const results = await Promise.allSettled([...active.values()].map(a => a.promise));
        await queue;
        const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
        if (failed?.status === "rejected") throw failed.reason;
      })().finally(() => { suspending = undefined; });
      return suspending;
    },
    async shutdown() {
      if (closed) return;
      closed = true; clearInterval(sweepTimer);
      try { await this.suspend(); await sweeping; }
      finally { await queue; await (await outbox).close(); }
    },
  };
}
