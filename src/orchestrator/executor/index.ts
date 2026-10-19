// Private journal entries (A1): tracked{exec,pid,start,child?} (child:true identifies the direct pi process);
// loss{exec}; settled{exec};
// stop-intent{call}; forward{rid,rid2,dest,hash,envelope:{to,kind,body,cond?}};
// forward-delivered{rid,rid2,call,reason?}: the first observed child receipt of a forward (once per forward; reason when
// the child resolved it as rejected, e.g. withdrawn); forward-retired{rid,rid2,reason}: sealed/retired without a receipt (P27);
// an undelivered notify becomes a pending-note{rid,call,key,message} first (../notes.ts).
// observation{exec,event}; selected{exec,model}; switch-observed{exec,rid,pool}.
// P28 entries are documented in hibernate.ts; generation session publication in generation.ts.
// ended{exec,call,procs:[{pid,command}],more?}: agent fence SIGKILL targets other than its direct child (EX1/WK8).
// session-corrupt{call,line}: a malformed native session line was skipped (once per line, E4).
// spawn-env-failed{exec,call,command,error}: launching the child failed for a reason of the environment (ENOENT, EACCES:
// pi or its interpreter missing or not executable); the call stays queued and launches again after a backoff.
// Command calls (CallSpec.command) record no exec/tracked/fenced entries (nothing that handles agent executions picks them
// up): command-intent{call,id,n} before the spawn (id = command:<call>#<n> is the attempt and its process tag DSA_EXEC;
// n is 1, or 2 for the single rerun); command-started{call,id,pid,start,dir} after it (the wrapper's identity, the
// attempt directory; its ts starts the wall-clock timeout); command-spawn-failed{call,id,error}: the command could not
// start (it seals failed, never reruns); command-timeout{call,id}: the deadline passed, recorded before the process tree
// is ended (as stop-intent is for a stop), so a crash during that fence still seals timeout; command-withdrawn{call,id}:
// the intent was recorded but no process started (a retirement or the orchestrator's exit came first): a later start
// decides again, as if there were no intent.
// fence-failed{exec,error} is documented in sweep.ts. The orchestrator ledger owns hold/release{pool,slot,exec}
// and mem{available,admitted,exec} (every admission; a repeated refusal at most every 30 s per call). All transitions are serialized before publication.
import { mkdir, open, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CT, JT, askFields, attentionEntries, isCommandCall, isEntry, type CallResult, type Containment, type Entry, type JournalHandle, type ModelBody, type ProcInfo, type Request, type SendBody, type Spawned, type WithdrawBody } from "../../types.ts";
import { binDir, callDir, callInbox, callSession, journalPath, outboxRoot } from "../../paths.ts";
import { readJournalSnapshot, syncDirectory } from "../../kernel/journal.ts";
import { Outbox } from "../../kernel/mailbox.ts";
import { contentHash, forwardRid } from "../../kernel/ids.ts";
import { capacity, seal } from "../../kernel/guards.ts";
import { buildPiArgs } from "../../compat/pi-args.ts";
import { parseModel, plainModel, resolveModel, sameModel, type Model } from "../../compat/model.ts";
import { buildCallResult } from "../../compat/result.ts";
import type { CallEffects, CallTicket, Executor, Ledgers } from "../contract.ts";
import createEffects from "./effects/index.ts";
import { continueSession } from "./generation.ts";
import { fenceAgent } from "./ended.ts";
import { answerInFlight, boundAnswer, hibernation, openAsked, openQuestion, supersededByBinding } from "./hibernate.ts";
import { SessionFold, answerKey, digestOpenQuestion, supersededBy } from "./digest.ts";
import { emptyLedger, foldLedger, holdings as holdingsOf, settingsOf } from "../ledger.ts";
import { evidence, fatalProviderError, quotaExhausted, refusedByProvider, forgetSession, readSessionState, receiptId, sessionModel, type SessionEntry } from "./session.ts";
import { activeTotal } from "./time.ts";
import { callEntries, entriesOf, forwardsTo, trackedState, usageIds } from "./indexes.ts";
import { RECOVERED, RECOVERY_VERSION, completeCalls } from "./recovered.ts";
import { observeExecution } from "./observe.ts";
import { availableMemory } from "./memory.ts";
import { reached, sessionUsage, totalUsage, type Usage } from "./usage.ts";
import { indexSweep, seededSweep, recordFenceFailure, resolveFenceAttention, serialContainment, skipLostCandidate, sweepExecutions } from "./sweep.ts";
import { gateRetired } from "./effects/gate.ts";
import { WorktreeIndex, worktreeCalls, worktreeLabel, worktreePair, worktreeRoots, type WorktreeWrite } from "./worktree.ts";
import { failedModel, modelFailures, MODEL_RETRY_MS, parentPinned, spillCandidates } from "./pool.ts";
import { PENDING_NOTE, UNDELIVERED_FOLLOW_UP } from "../notes.ts";
import { COMMAND_LOG, exitMeaning, readExitRecord, readTail, spawnCommand, type SpawnedCommand } from "../../platform/command.ts";
import { captureStart } from "../../platform/proctable.ts";
import { heldIn } from "../snapshot.ts";
import { COMMAND_INTENT, COMMAND_SPAWN_FAILED, COMMAND_STARTED, COMMAND_TIMEOUT, COMMAND_WITHDRAWN, commandDirName, commandEnvironment, commandId, retiredCommandAttempts } from "./command.ts";

type Envelope = Pick<Request, "to" | "kind" | "body" | "cond">;
type Active = { ticket: CallTicket; controller: AbortController; promise: Promise<CallResult>; wake: () => void; stopped: boolean; retired?: boolean; suspended?: boolean; commandStarting?: boolean;
  parking?: string; onPark: Set<() => void>; refusedAt?: number;
  /** Restart: set while its execution's child runs (from the launch gate to the fence) or its gates run before the seal. */
  live?: { exec: string; since: number; phase: "child" | "gate" } };
const MEM_RECORD_MS = 30000;
/** How long the processes of a stopped or timed-out command get between SIGTERM and SIGKILL. */
const COMMAND_GRACE_MS = 2000;
/** A command's exit status as a result: 0 is ok; otherwise the error names the status, or the signal (exitMeaning). */
function exitResult(status: number): { exitCode: number | null; signal: string | null; error?: string } {
  const meaning = exitMeaning(status);
  return status === 0 ? meaning : { ...meaning, error: meaning.signal ? `Command killed by ${meaning.signal}` : `Command exited ${status}` };
}
/** A4, P29: A child admitted within this window may not show in MemAvailable yet; its share is reserved explicitly. */
const MEM_WARMUP_MS = 30000;
/** Quota refusals in a row that find a provider's usage window used up while pi is still retrying. */
const QUOTA_REFUSALS = 2;
const ignoreMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; };
const callOf = (exec: string) => exec.slice(0, exec.lastIndexOf("#"));
const shutdownError = () => Object.assign(new Error("executor shutdown; call resumes on recovery"), { name: "ExecutorShutdown" });
const extension = fileURLToPath(new URL(`../../agent/extension.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
const entriesFor = callEntries;
const current = (journal: JournalHandle, call: string) => entriesFor(journal, call).findLast(e => e.type === JT.exec)?.exec as string | undefined;
const sealed = (journal: JournalHandle, call: string) => entriesFor(journal, call).find(e => e.type === JT.sealed)?.result as CallResult | undefined;
const retiredCall = (journal: JournalHandle, call: string) => entriesFor(journal, call).some(e => e.type === "retired");
const has = (journal: JournalHandle, type: string, exec: string) => entriesOf(journal, type, exec).length > 0;
/** The run of executions of `call` whose launches failed for a reason of the environment, ending at `exec`: its first
 *  execution and the one before it (absent for the call's first). Undefined when `exec` did not fail so. */
function envFailedChain(journal: JournalHandle, call: string, exec: string): { first: string; before?: string } | undefined {
  if (!has(journal, "spawn-env-failed", exec)) return undefined;
  const execs = entriesFor(journal, call).filter(e => e.type === JT.exec).map(e => String(e.exec));
  let i = execs.lastIndexOf(exec);
  if (i < 0) return undefined;
  while (i > 0 && has(journal, "spawn-env-failed", execs[i - 1]!)) i--;
  return { first: execs[i]!, ...(i > 0 ? { before: execs[i - 1]! } : {}) };
}
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
const callWid = (call: string) => /^(.*)@\d+\/.*@\d+$/.exec(call)?.[1];
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
/** EX2: Appended to every derived agent prompt, never to the pinned agent definition. */
export const CHILD_LIFECYCLE_NOTE = "Processes you start end when your turn ends: dsa stops every process of this call when it seals.\n" +
  "To run something that must outlive your turn (a long build, test suite or measurement), start it as a durable command call and end your turn:\n" +
  "  pi-durable-subagents run --request <unique id> --wake caller -- <program> [args…]\n" +
  "It keeps running after your turn; when it finishes you get a follow-up with its exit status and output tail.";
/** An asker hibernates while it waits (its execution is stopped to free the provider slot), so the answer says so. */
export const HIBERNATED_NOTE = "While you waited for the answer below your execution was stopped; processes your tools had " +
  "started (background ones included) were stopped with it. Check them before relying on them.";
/** D2: an answer bound to another question than the one its call hibernated on supersedes that one. */
function supersedes(sleeping: Entry, qid: unknown, rev: unknown): { superseded?: { qid: string; rev: number }[] } {
  return qid === sleeping.qid && rev === sleeping.rev ? {} : { superseded: [{ qid: String(sleeping.qid), rev: Number(sleeping.rev) }] };
}
/** D2: what the resumed asker is told of the question it hibernated on, when the answer it resumes with is another's. */
function withdrawn(entries: readonly Entry[], call: string, sleeping: Entry, qid: unknown, rev: unknown): string {
  if (qid === sleeping.qid && rev === sleeping.rev) return "";
  const text = attentionEntries(entries).find(e => e.item.call === call && e.item.qid === sleeping.qid && e.item.rev === sleeping.rev)?.item.text;
  return ` Your later question "${text ?? String(sleeping.qid)}" is withdrawn: the answer below is to your earlier question. Ask again if you still need it answered.`;
}
/** A launch failure the environment causes (the command or its interpreter is missing or not executable): fixing the
 *  environment, or another orchestrator started from a better one, makes the same launch work. */
export const environmentSpawnError = (error: unknown) => ["ENOENT", "EACCES"].includes(String((error as NodeJS.ErrnoException | undefined)?.code));
/** The default wait before an environment launch failure is retried (an orchestrator restart retries at once). */
export const SPAWN_RETRY_MS = 60_000;
/** A call's environment launch failures print one console line at the first, then at most one per this interval. */
export const SPAWN_CONSOLE_MS = 600_000;
export default function createExecutor(ledgers: Ledgers, options: { memory?: () => Promise<number>; sweepMs?: number; effects?: CallEffects; containment?: Containment;
  /** The pi subagents run (absolute; the orchestrator resolved it at start); a bare `pi` from PATH without one. */
  pi?: string; spawnRetryMs?: number;
  /** Tests: the directory sync of an inbox cleanup (kernel/journal.ts syncDirectory by default). */
  syncDirectory?: (dir: string) => Promise<void>;
  /** Observes each slot attempt that admitted nothing: the execution and the providers it found full. */
  attempted?: (exec: string, full: readonly string[]) => void } = {}): Executor {
  const { home, config, orch } = ledgers;
  const containment = options.containment ?? serialContainment(), effects = options.effects ?? createEffects(ledgers);
  const piCommand = options.pi ?? "pi";
  const active = new Map<string, Active>(), completed = new Map<string, Promise<CallResult>>(), journals = new Map<string, JournalHandle>();
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
  let suspending: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  // F1: execs whose fence failed in this process; they are retried only by the sweep.
  const failing = new Set<string>();
  // F2: a sweep error is transient: report it and retry at the next K1; it never blocks dispatch.
  /** The sweep state of settled journals not decoded (recover with `settled`). */
  const seeds = new WeakMap<JournalHandle, ReturnType<typeof seededSweep>>();
  const sweepTimer = setInterval(() => {
    if (!sweeping) sweeping = sweepExecutions([...journals.values()].filter(j => !j.closed), containment, { failing: exec => failing.has(exec), fenced: swept, failed: fenceFailed, seeded: journal => seeds.get(journal) })
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
      try { await fenceAgent(containment, journal, exec, tracked(journal, exec), opts.child); retired = true; }
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
  // Per call: what the periodic checks need from its session, folded over appended entries only (digest.ts).
  const folds = new Map<string, SessionFold>();
  const digestOf = (call: string, entries: readonly SessionEntry[]) => {
    let fold = folds.get(call);
    // Only a running call keeps its fold (it ends with the call); a one-off read (recovery, retirement) folds once.
    if (!fold) { fold = new SessionFold(call); if (active.has(call)) folds.set(call, fold); }
    return fold.update(entries);
  };
  const forgetCall = (call: string) => { const a = address(call); forgetSession(callSession(home, a.wid, a.key, a.gen)); folds.delete(call); };
  async function collectReceipts(call: string, entries: SessionEntry[]) {
    const done = collected.get(call) ?? new Set<string>(); collected.set(call, done);
    const fresh = new Set<string>();
    for (const rid of digestOf(call, entries).receipts.keys()) if (!done.has(rid) && !/^\.|[/\\\0]/.test(rid)) fresh.add(rid);
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
  /** Remove a sealed call's inbox files, then sync the directory: the removals are durable before anything recorded
   *  after them (a `recovered` receipt). The directory is synced whenever it exists, also when it is already empty (an
   *  earlier attempt may have removed the files and failed to sync); a failure rejects (the caller records no receipt). */
  async function collectSealed(call: string) {
    const sender = await outbox, dir = inbox(call);
    let exists = true;
    for (const name of await readdir(dir).catch(error => { ignoreMissing(error); exists = false; return []; })) {
      if (name.endsWith(".json") && !name.startsWith(".")) await sender.markResolved(name.slice(0, -5));
      await rm(join(dir, name), { force: true });
    }
    if (exists) await (options.syncDirectory ?? syncDirectory)(dir);
  }
  /** Sealed or retired calls a batched recovery read, finished by finishRecovery. */
  const unfinished: { journal: JournalHandle; calls: string[] }[] = [];
  /** The end of the recovery of sealed or retired calls, after republication: the inbox cleanup of the sealed ones (E2),
   *  then each call's `recovered` receipt (recovered.ts), once. A failed cleanup records none: the next start recovers
   *  the call again. */
  async function finishCalls(journal: JournalHandle, calls: readonly string[]) {
    for (const call of calls) {
      // F1: an execution whose fence failed is fenced again by every start (and the sweep) until it is: no receipt yet.
      let clean = entriesFor(journal, call).every(e => e.type !== JT.exec || has(journal, JT.fenced, String(e.exec)));
      if (clean && sealed(journal, call)) await collectSealed(call).catch(error => { clean = false; console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`); });
      if (clean) await serial(async () => {
        if (!journal.closed && !completeCalls(journal, address(call).wid).has(call)) await journal.append(RECOVERED, { call, v: RECOVERY_VERSION });
      });
    }
  }
  /** P7, P27: Record forward-delivered once when a forward's child receipt is first observed; serial sections only. */
  /** The reply to a model send says which model and when it applies (orchestrator ledger `send-note`, once per rid). */
  async function note(rid: string, model: string, effect: string, pool?: string) {
    if (!orch.entries().some(e => e.type === "send-note" && e.rid === rid)) await orch.append("send-note", { rid, model, effect, ...(pool ? { pool } : {}) });
  }
  async function forwardsDelivered(journal: JournalHandle, call: string, entries: SessionEntry[]) {
    const retired = entriesOf(journal, "forward-retired"), delivered = entriesOf(journal, "forward-delivered");
    const open = entriesOf(journal, "forward").filter(e => e.dest === call &&
      !retired.some(r => r.rid2 === e.rid2) && !delivered.some(r => r.rid2 === e.rid2 && r.call === call));
    if (!open.length) return;
    const receipts = digestOf(call, entries).receipts;
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
    for (const e of [...forwardsTo(journal, call)]) {
      if (!receipts.has(String(e.rid2)) && !entriesOf(journal, "forward-retired").some(r => r.rid2 === e.rid2)) {
        // A notify the call never received is not lost: it becomes a pending note (before its forward is retired, so a
        // crash in between finds the forward open again and the note is written once). A withdrawn one is not.
        const envelope = e.envelope as Envelope;
        const withdrawn = forwardsTo(journal, call).some(r => (r.envelope as Envelope).kind === "withdraw" && ((r.envelope as Envelope).body as { rids?: string[] }).rids?.includes(String(e.rid2)));
        if (envelope.kind === "notify" && !withdrawn && !entriesOf(journal, PENDING_NOTE).some(r => r.rid === e.rid))
          await journal.append(PENDING_NOTE, { rid: e.rid, call, key: address(call).key, message: String((envelope.body as { message?: unknown } | undefined)?.message ?? "") });
        // A follow-up the call never took is not lost either: the orchestrator opens the next generation with it (or a
        // later follow-up takes it along). A stop is final and drops it; a withdrawn one is gone.
        const reopen = envelope.kind === "follow-up" && !withdrawn && sealed(journal, call)?.status !== "stopped";
        await journal.append("forward-retired", { rid: e.rid, rid2: e.rid2, reason: reopen ? UNDELIVERED_FOLLOW_UP : "retired-without-child-receipt" });
      }
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
  // A journal not decoded (a settled workflow) has no open reminder and only ended calls: nothing of it is indexed.
  const indexed = () => writes.scan([...journals.values()].filter(j => j.loaded !== false));
  const endedCall = (call: string) => writes.ended(call) || journals.get(callWid(call) ?? "")?.loaded === false;
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
      if (call ? pair.includes(call) : pair.some(endedCall))
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
    // A refused call (CallTicket.refusal) runs none of the pre-seal effects (gate, output publication): it did no work.
    if (a && a.ticket.refusal === undefined && !sealed(journal, call) && !["stopped", "timeout", "budget"].includes(result.status)) {
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
  /** The origin of a workflow (its `wf-created` entry, else the orchestrator ledger's `created`), cached once known. */
  const origins = new Map<string, string>();
  function originOf(wid: string): string | undefined {
    let o = origins.get(wid);
    if (o === undefined) {
      const journal = journals.get(wid);
      const value = journal?.entries().find(e => e.type === "wf-created")?.origin ?? orch.entries().find(e => e.type === JT.created && e.wid === wid)?.origin;
      if (typeof value === "string") origins.set(wid, o = value);
    }
    return o;
  }
  const widOf = (exec: string) => exec.slice(0, exec.indexOf("@"));
  /** Slot precedence: every acquisition waiting now. `blockedOn`: the providers its latest attempt (at `at`) found full. */
  const acquiring = new Map<string, { a: Active; call: string; origin?: string; since: number; resume: boolean; blockedOn: ReadonlySet<string>; at: number }>();
  /** Whether another waiter with precedence for `provider` found it full on a recent attempt: then `exec` leaves the
   *  free slot to it. Precedence: a call that ran before (its session, cache and worktree are ready; a parent waits on it)
   *  before a fresh one; then the workflow origin holding fewer of the provider's slots; then the longer wait; then call id. */
  function yields(exec: string, provider: string): boolean {
    const me = acquiring.get(exec); if (!me) return false;
    const recent = 3 * (config.k?.trackerMs ?? 1000), now = Date.now();
    let held: Map<string | undefined, number> | undefined;
    const heldBy = (origin: string | undefined) => {
      if (!held) { held = new Map(); for (const h of holdings()) if (h.pool === provider) { const o = originOf(widOf(h.exec)); held.set(o, (held.get(o) ?? 0) + 1); } }
      return held.get(origin) ?? 0;
    };
    for (const [other, w] of acquiring) {
      if (other === exec || !w.blockedOn.has(provider) || now - w.at >= recent || interrupted(w.a)) continue;
      if (w.resume !== me.resume) { if (w.resume) return true; continue; }
      const mine = heldBy(me.origin), theirs = heldBy(w.origin);
      if (theirs !== mine) { if (theirs < mine) return true; continue; }
      if (w.since !== me.since ? w.since < me.since : w.call < me.call) return true;
    }
    return false;
  }
  /** Wait for a slot. The candidates are decided again on every attempt, inside the serial section that also applies
   *  config.json changes: a queued call follows a reloaded defaultModel, pool or limit, never a mix of two versions. */
  async function acquire(a: Active, exec: string, decide: () => Promise<Awaited<ReturnType<typeof launchModel>>>, writer?: string): Promise<{ model?: Model; continuation: boolean }> {
    const t = a.ticket, since = Date.now();
    // An execution that never started (its launch failed for a reason of the environment) does not make a resume.
    const resume = !!t.continueFrom || t.journal.entries().some(e => e.type === JT.exec && e.call === t.callId && e.exec !== exec && !has(t.journal, "spawn-env-failed", String(e.exec)));
    const mine = { a, call: t.callId, origin: originOf(t.wid), since, resume, blockedOn: new Set<string>() as ReadonlySet<string>, at: since };
    acquiring.set(exec, mine);
    try { return await acquireLoop(a, exec, decide, mine, writer); }
    finally { acquiring.delete(exec); }
  }
  async function acquireLoop(a: Active, exec: string, decide: () => Promise<Awaited<ReturnType<typeof launchModel>>>,
    mine: { since: number; blockedOn: ReadonlySet<string>; at: number }, writer?: string): Promise<{ model?: Model; continuation: boolean }> {
    let continuation = false;
    let pinnedWait: { model: Model; since: number } | undefined;
    let waitMark = "";
    for (;;) {
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      const blocked = new Set<string>();
      const chosen = await serial(async () => { try {
        if (interrupted(a) || await workflowReached(a.ticket)) return;
        if (writer && !await writerAdmit(a, writer)) return;
        const decision = await decide(), pool = decision.pool;
        let models = decision.candidates;
        const pinned = decision.spill?.[0];
        const full = (m: Model) => holdings().filter(h => h.pool === m.provider).length >= (settings().providers?.[m.provider ?? ""]?.slots ?? Infinity);
        if (pinned && full(pinned)) {
          if (!sameModel(pinnedWait?.model, pinned)) pinnedWait = { model: pinned, since: Date.now() };
          const ms = settings().k?.resumeSpillMs;
          if (ms !== null && (ms ?? 120_000) >= 0 && Date.now() - pinnedWait!.since >= (ms ?? 120_000))
            models = [...models, ...spillCandidates(pinned, decision.spill!)];
        } else pinnedWait = undefined;
        const mark = pinnedWait ? JSON.stringify(pinnedWait.model) : "";
        if (mark !== waitMark) {
          await a.ticket.journal.append("slot-wait", { call: a.ticket.callId, exec, ...(pinnedWait ? { model: plainModel(pinnedWait.model), since: pinnedWait.since, pool } : {}) });
          waitMark = mark;
        }
        continuation = decision.continuation;
        for (const model of models) {
          const spilling = !!pinned && !sameModel(model, pinned);
          if (pool && (spilling || !continuation && models.length > 1) && skipped(pool, model)) continue;
          if (failedModel(modelFailures(a.ticket.journal, a.ticket.callId), model)) continue;
          // A pool entry with afterMs waits its turn: it is taken only once this acquisition has waited that long.
          if (model.afterMs !== undefined && Date.now() - mine.since < model.afterMs) continue;
          const provider = model.provider;
          if (unavailable(provider)) continue;
          const probe = provider !== undefined && folded().exhausted.has(provider);
          const holders = holdings().filter(e => e.pool === provider);
          const limit = settings().providers?.[provider ?? ""]?.slots ?? Infinity;
          if (!capacity({ kind: "provider", holders: holders.length, capacity: limit })) { if (provider) blocked.add(provider); continue; }
          if (provider && yields(exec, provider)) continue;
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
          const plain = plainModel(model);
          if (spilling && pinnedWait) {
            continuation = false;
            await a.ticket.journal.append("spilled", { call: a.ticket.callId, exec, pool, from: plainModel(pinned!), to: plain, waitedMs: Date.now() - pinnedWait.since });
          }
          await a.ticket.journal.append("selected", { exec, model: plain, ...(pool ? { pool } : {}) });
          return plain;
        }
      } finally { mine.blockedOn = blocked; mine.at = Date.now(); } });
      if (!chosen) options.attempted?.(exec, [...blocked]);
      if (chosen || interrupted(a) || reached(totalUsage(a.ticket.journal.entries()), a.ticket.workflowBudget)) { waiters.delete(signal); return { model: chosen, continuation }; }
      const timer = setTimeout(signal, config.k?.trackerMs ?? 1000);
      try { await changed; } finally { clearTimeout(timer); waiters.delete(signal); }
    }
  }
  /** P13, C5, C8: Decide holdings and CLI model restoration from the same fenced session. */
  async function launchModel(t: CallTicket, entries: SessionEntry[], previous?: string): Promise<{ candidates: Model[]; continuation: boolean; pool?: string; spill?: Model[] }> {
    const recorded = sessionModel(entries);
    const ownSegment = entries.some(e => e.type === "custom" && e.customType === CT.exec && typeof e.data?.exec === "string" && e.data.exec.startsWith(`${t.callId}#`));
    const freshFork = t.spec.context === "fork" && !t.continueFrom && !ownSegment;
    const { defaultModel: configured, pools } = settings();
    const raw = t.spec.model ?? t.agent.model ?? configured ?? await defaultModel();
    const pool = raw && pools?.[raw] ? raw : undefined;
    const failures = modelFailures(t.journal, t.callId);
    const candidates = (raw ? resolveModel(raw, pools) : [{ id: "" }]).filter(m => !failedModel(failures, m));
    if (!candidates.length) throw new Error(`model-unavailable: no usable model remains; ${String(failures.at(-1)?.reason ?? raw)}`);
    const matches = (m: Model, other: Model | undefined) => sameModel(m, other) || !!other && t.journal.entries().some(e => e.type === "model-ready" && sameModel(e.selected as Model, m) && sameModel(e.model as Model, other));
    const candidate = recorded && candidates.some(m => matches(m, recorded));
    // Leave the session's model for the pool's others when its pool skips it after losses, or its provider's usage
    // window is used up; and at a new generation, go back to the pool's order of preference.
    // A new generation of a pool call starts from the pool also when the session's model is not one of its models
    // (switched outside it, or the follow-up named the pool).
    const skip = pool && (previous && has(t.journal, "model-unavailable", previous) || (candidate ? previous && ownSegment && skipped(pool, recorded!) || unavailable(recorded!.provider) || !ownSegment && !!t.continueFrom
      : !ownSegment && !!t.continueFrom));
    // A model the call was asked to use replaces the session's: launched with it, and holding its provider's slot.
    const wanted = requestedModel(t.journal, t.callId, t.model);
    // It outranks the pool's order at a new generation too, also when it names the model the session already has.
    // A requested model of the call's own pool keeps the pool: a used-up window still moves the call on.
    const keep = pool && candidates.some(m => m.provider === wanted?.provider && m.id === wanted?.id) ? pool : undefined;
    if (wanted && !failedModel(failures, wanted)) return recorded && !freshFork && recorded.provider === wanted.provider && recorded.id === wanted.id
      ? { candidates: [recorded], continuation: true, pool: keep }
      : { candidates: [wanted], continuation: false, pool: keep };
    if (recorded && !freshFork && !skip && !failedModel(failures, recorded)) return { candidates: [recorded], continuation: true, pool: candidate ? pool : undefined,
      spill: candidate && pool && !parentPinned(t) ? [recorded, ...candidates.map(m => matches(m, recorded) ? { ...m, id: recorded.id } : m)] : undefined };
    return { candidates, continuation: false, pool };
  }
  /** Resolve a bound answer before it waits for admission; also repairs an interrupted append pair. Called serially. */
  async function resolveBoundAnswer(journal: JournalHandle, call: string, qid: unknown, rev: unknown) {
    const id = `q:${call}:${qid}`;
    if (!journal.entries().some(e => e.type === JT.attentionResolved && e.id === id && e.rev === rev))
      await journal.append(JT.attentionResolved, { id, rev, resolution: "answered" });
  }
  async function questions(t: CallTicket, entries: SessionEntry[]) {
    await collectReceipts(t.callId, entries).catch(error => console.error(`durable-subagents: inbox cleanup of ${t.callId} failed: ${String(error)}`));
    await serial(async () => {
      await forwardsDelivered(t.journal, t.callId, entries);
      const digest = digestOf(t.callId, entries);
      for (const q of digest.questions) {
        const { qid, rev, question } = q;
        const id = `q:${t.callId}:${qid}`;
        if (!entriesOf(t.journal, JT.attention).some(r => isEntry(r, JT.attention) && r.item.id === id && r.item.rev === rev))
          await t.journal.append(JT.attention, { item: { id, rev, kind: "question", text: String(question), wid: t.wid, call: t.callId, qid, session: callSession(home, t.wid, t.key, t.gen), ...askFields(q) } });
        if (digest.answered.has(answerKey(qid, rev)) || t.journal.entries().some(e => e.type === "answer-bound" && e.call === t.callId && e.qid === qid && e.rev === rev))
          await resolveBoundAnswer(t.journal, t.callId, qid, rev);
        else if (digest.superseded.has(answerKey(qid, rev)) || supersededByBinding(t.journal.entries(), t.callId, qid, rev))
          await resolveQuestion(t.journal, t.callId, qid, rev, "superseded");
      }
      await resolveSuperseded(t.journal, t.callId);
      if (entries.length) await resolveCarried(t.journal, t.callId, digest.questions);
    });
  }
  /** D2, D4: close a question's attention item once (superseded, carried) unless already resolved. Called serially. */
  async function resolveQuestion(journal: JournalHandle, call: string, qid: unknown, rev: unknown, resolution: string) {
    const id = `q:${call}:${qid}`;
    if (attentionEntries(journal.entries(), id).some(e => e.item.rev === rev) && !journal.entries().some(e => e.type === JT.attentionResolved && e.id === id && e.rev === rev))
      await journal.append(JT.attentionResolved, { id, rev, resolution });
  }
  /** D2: the questions durable bindings superseded (answer-bound.superseded, the source of truth) resolve `superseded`:
   *  after a crash between the binding and its resolution, recovery and observation derive it. Called serially. */
  async function resolveSuperseded(journal: JournalHandle, call: string) {
    for (const b of journal.entries().filter(e => e.type === "answer-bound" && e.call === call && Array.isArray(e.superseded)))
      for (const s of b.superseded as { qid: unknown; rev: unknown }[]) await resolveQuestion(journal, call, s.qid, s.rev, "superseded");
  }
  /** D4: a question item of `call` that none of its executions asked (1.0.37 re-opened the questions of the session a
   *  generation continues) is resolved `carried`. `own`: the questions the call's executions asked. Called serially. */
  async function resolveCarried(journal: JournalHandle, call: string, own: readonly { qid: string; rev: number }[]) {
    for (const { item } of attentionEntries(journal.entries())) {
      if (item.kind !== "question" || item.call !== call || own.some(q => q.qid === item.qid && q.rev === item.rev)) continue;
      await resolveQuestion(journal, call, item.qid, item.rev, "carried");
    }
  }
  /** Model identity receipts are durable before the observer fences an unavailable execution. Serial sections only. */
  async function unavailableModel(journal: JournalHandle, exec: string, selected: Model, actual: Model, reason: string) {
    if (!has(journal, "model-unavailable", exec))
      await journal.append("model-unavailable", { exec, selected, actual, reason: `selected ${selected.provider}/${selected.id}, pi would use ${actual.provider ?? "none"}/${actual.id}: ${reason}`, until: Date.now() + MODEL_RETRY_MS });
  }
  function allowedModels(journal: JournalHandle, exec: string): Model[] {
    const log = journal.entries(), selected = log.find(e => e.type === "selected" && e.exec === exec)?.model as Model | undefined;
    const models = selected ? [selected] : [];
    for (const e of log) {
      const envelope = e.envelope as Envelope | undefined;
      if (e.type !== "forward" || e.dest !== callOf(exec) || envelope?.kind !== "model") continue;
      if (log.some(r => r.type === "forward-delivered" && r.rid2 === e.rid2 && r.reason !== undefined)) continue;
      if (log.some(r => r.type === "forward" && r.dest === e.dest && (r.envelope as Envelope)?.kind === "withdraw" && ((r.envelope as Envelope).body as WithdrawBody)?.rids?.includes(String(e.rid2)))) continue;
      const body = envelope.body as ModelBody;
      if (body.exec && body.exec !== exec) continue;
      models.push({ provider: body.provider, id: body.model });
    }
    for (const e of log) if (e.type === "model-ready" && e.exec === exec && models.some(m => sameModel(m, e.selected as Model))) models.push(e.model as Model);
    return models;
  }
  async function modelControl(journal: JournalHandle, exec: string, event: Record<string, unknown>) {
    if (event.exec !== exec) return;
    return serial(async () => {
      if (event.type === CT.modelUnavailable) {
        await unavailableModel(journal, exec, event.selected as Model, event.actual as Model, String(event.reason));
        return false;
      }
      if (event.type === CT.modelReady && allowedModels(journal, exec).some(m => sameModel(m, event.selected as Model)) &&
        !journal.entries().some(e => e.type === "model-ready" && e.exec === exec && sameModel(e.selected as Model, event.selected as Model)))
        await journal.append("model-ready", { exec, selected: event.selected, model: event.model, virtual: event.virtual === true });
      return !has(journal, "model-unavailable", exec);
    });
  }
  /** The model each execution last answered with (`selected`, then `model-used`), cached per execution. */
  const inUse = new Map<string, string>();
  async function switched(exec: string, journal: JournalHandle, event: Record<string, unknown>) {
    const message = event.message as { role?: string; provider?: string; model?: string } | undefined, provider = message?.provider;
    if (!provider) return;
    let accepted = true;
    await serial(async () => {
      // Evidence of the model in use: the provider and model of each assistant message, recorded when it changes.
      if (message.role === "assistant" && message.model) {
        const name = `${provider}/${message.model}`;
        if (!inUse.has(exec)) {
          const last = journal.entries().findLast(e => (e.type === "selected" || e.type === "model-used") && e.exec === exec)?.model as Model | undefined;
          if (last) inUse.set(exec, `${last.provider}/${last.id}`);
        }
        if (inUse.get(exec) !== name) { await journal.append("model-used", { exec, model: { provider, id: message.model } }); inUse.set(exec, name); }
        const virtual = journal.entries().findLast(e => e.type === "model-ready" && e.exec === exec)?.virtual === true;
        if (!virtual && !allowedModels(journal, exec).some(m => sameModel(m, { provider, id: message.model! }))) {
          const selected = journal.entries().find(e => e.type === "selected" && e.exec === exec)?.model as Model;
          await unavailableModel(journal, exec, selected, { provider, id: message.model }, "child reported an unselected model");
          accepted = false; return;
        }
      }
      const target = holdings().find(h => h.exec === exec && h.pool === provider && h.reserved);
      if (!target) return;
      if (!folded().observed.has(`${exec}\n${target.rid}`)) {
        await orch.append("switch-observed", { exec, rid: target.rid, pool: provider });
        for (const h of holdings().filter(h => h.exec === exec && h.pool !== provider && h.pool !== "memory")) await orch.append("release", { pool: h.pool, slot: h.slot, exec });
      }
    });
    wake();
    return accepted;
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
   *  neither used up nor full and has no afterMs (such an entry is for calls that waited for a slot), reserving that
   *  slot as a requested switch does. Without one, pi's retries go on and the call waits for the provider once they end. */
  async function failover(t: CallTicket, exec: string, provider: string) {
    if (pendingSwitch(exec)) return;
    const pool = t.journal.entries().findLast(e => e.type === "selected" && e.exec === exec)?.pool as string | undefined, pools = settings().pools;
    if (!pool || !pools?.[pool]) return;
    let models: Model[]; try { models = resolveModel(pool, pools); } catch { return; }
    for (const m of models) {
      if (!m.provider || m.provider === provider || m.afterMs !== undefined || unavailable(m.provider) || skipped(pool, m)) continue;
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
  /** When each call in environment retries last printed its console line. */
  const spawnConsoleAt = new Map<string, number>();
  /** Serial sections only: record an environment launch failure (before its execution is fenced: recovery after a crash
   *  in between finds an execution that never started, not a loss). */
  async function spawnEnvRecord(t: CallTicket, exec: string, error: unknown) {
    if (!has(t.journal, "spawn-env-failed", exec)) await t.journal.append("spawn-env-failed", { exec, call: t.callId, command: piCommand, error: String(error).slice(0, 300) });
  }
  /** Serial sections only: raise one `environment` alert for the call (a new revision only after an earlier one was
   *  resolved by a launch that worked); one console line at the first failure, then at most one per SPAWN_CONSOLE_MS. */
  async function spawnEnvFailed(t: CallTicket, exec: string, cwd: string, error: unknown) {
    const message = String(error).slice(0, 300), printed = spawnConsoleAt.get(t.callId);
    if (printed === undefined || Date.now() - printed >= SPAWN_CONSOLE_MS) {
      console.error(`durable-subagents: launching ${exec} failed: ${message}; retrying`);
      spawnConsoleAt.set(t.callId, Date.now());
    }
    const id = `environment:${t.callId}`, items = attentionEntries(t.journal.entries(), id), last = items.at(-1)?.item;
    if (last && !t.journal.entries().some(e => e.type === JT.attentionResolved && e.id === id && e.rev === last.rev)) return;
    const pi = piCommand === "pi" ? "`pi` from the orchestrator's PATH (no absolute pi was resolved; set DSA_PI_BIN, or start the orchestrator from an environment whose PATH has pi)"
      : `${piCommand} (DSA_PI_BIN / the PATH the orchestrator started with)`;
    const text = `${worktreeLabel(t.callId)} could not start: ${message}. It runs ${pi} in ${cwd}. ` +
      `The call retries every minute (and at once when the orchestrator restarts); stop it to give up`;
    await t.journal.append(JT.attention, { item: { id, rev: (last?.rev ?? 0) + 1, kind: "environment", text, wid: t.wid, call: t.callId } });
  }
  /** Serial sections only: a launch worked, so the call's open environment alert is resolved. */
  async function spawnEnvResolved(t: CallTicket) {
    spawnConsoleAt.delete(t.callId);
    const id = `environment:${t.callId}`, last = attentionEntries(t.journal.entries(), id).at(-1)?.item;
    if (last && !t.journal.entries().some(e => e.type === JT.attentionResolved && e.id === id && e.rev === last.rev))
      await t.journal.append(JT.attentionResolved, { id, rev: last.rev, resolution: "launched" });
  }
  /** Wait before launching again after an environment failure; a stop, retirement, suspension or shutdown ends it early. */
  async function retryWait(a: Active) {
    const until = Date.now() + (options.spawnRetryMs ?? SPAWN_RETRY_MS);
    while (!interrupted(a) && Date.now() < until)
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(until - Date.now(), config.k?.trackerMs ?? 1000)); a.wake = () => { clearTimeout(timer); resolve(); }; });
  }
  // ---- Command calls: no model, slot, usage, hibernation or budget; the process outlives the orchestrator. ----
  const commandTick = () => Math.min(config.k?.trackerMs ?? 1000, 1000);
  const hasStopIntent = (journal: JournalHandle, call: string) => entriesFor(journal, call).some(e => e.type === "stop-intent");
  /** The wrapper's identity of an attempt (from its latest command-started), for scans and fences. */
  const commandKnown = (started: Entry | undefined): ProcInfo[] => started && started.start ? [{ pid: Number(started.pid), ppid: 0, start: String(started.start) }] : [];
  /** The processes of an attempt: tagged with its id, the wrapper while it lives, and their live descendants. */
  async function commandProcesses(id: string, known: ProcInfo[]): Promise<ProcInfo[]> {
    return (await containment.scan(new Map([[id, known]]), { fresh: true })).get(id) ?? [];
  }
  /** End an attempt's whole process tree: SIGTERM, a grace period, then the fence (SIGKILL until a rescan finds none).
   *  A failing fence is retried until it works; the orchestrator's exit interrupts it (the next start fences again). */
  async function endCommand(id: string, known: ProcInfo[]) {
    let live = await commandProcesses(id, known);
    if (!live.length) return;
    for (const p of live) {
      if (p.start !== "" && await captureStart(p.pid).catch(() => "") !== p.start) continue;
      try { process.kill(p.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const graceUntil = Date.now() + COMMAND_GRACE_MS;
    while (Date.now() < graceUntil) {
      await delay(100);
      live = await commandProcesses(id, known);
      if (!live.length) return;
    }
    for (;;) {
      try { await containment.fence(id, [...known, ...live]); return; }
      catch (error) {
        console.error(`durable-subagents: fence of ${id} failed: ${String(error)}; retrying`);
        if (closed) throw shutdownError();
        await delay(commandTick());
      }
    }
  }
  /** Seal a command call through the normal seal path (forwards, attention, inbox) with the pinned result: a stop or a
   *  recorded timeout of the attempt wins, as they do for agent calls. */
  async function sealCommand(journal: JournalHandle, t: CallTicket, id: string, outcome: { status: CallResult["status"]; error?: string; exitCode?: number | null; signal?: string | null; at?: number }, dir?: string): Promise<CallResult> {
    const call = t.callId, output = dir ? await readTail(join(dir, COMMAND_LOG)) : "";
    const value = await serial(async () => {
      const old = sealed(journal, call);
      if (old) return old;
      if (closed || retiredCall(journal, call)) throw shutdownError();
      const started = entriesFor(journal, call).findLast(e => e.type === COMMAND_STARTED && e.id === id);
      let { status, error } = outcome;
      if (hasStopIntent(journal, call)) { status = "stopped"; error = undefined; }
      else if (entriesFor(journal, call).some(e => e.type === COMMAND_TIMEOUT && e.id === id)) { status = "timeout"; error = `Command timed out after ${t.spec.timeoutMs} ms`; }
      const durationMs = started ? Math.max(0, Math.round((outcome.at ?? Date.now()) - started.ts)) : 0;
      const result: CallResult = { ...buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) }),
        data: { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null, durationMs }, usage: { input: 0, output: 0, costUsd: 0 } };
      await journal.append(JT.sealed, { call, exec: id, result });
      await retireForwards(journal, call);
      await retireAttention(journal, call);
      await unknownAttention(journal, call);
      return result;
    });
    await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
    wake();
    return value;
  }
  /** Whether a drain holds workflow `wid` now (the engine's hold rule): a held command call does not start. */
  const held = (wid: string) => heldIn(orch.entries())(wid);
  /** Why a command call cannot start attempt `n` now: retired or closed (the run ends), stopped (it seals), held (the
   *  run ends; the engine runs the call again after resume), or undefined. */
  const commandBlocked = (a: Active): "shutdown" | "stopped" | "held" | undefined => {
    const t = a.ticket;
    if (closed || a.suspended || a.retired || retiredCall(t.journal, t.callId)) return "shutdown";
    if (stopped(a)) return "stopped";
    if (held(t.wid)) return "held";
    return undefined;
  };
  /** The writer lock of a command call with `writer: true`, before its first attempt; the reason it stopped waiting. */
  async function commandWriter(a: Active): Promise<"shutdown" | "stopped" | "held" | undefined> {
    const t = a.ticket, root = await roots(t.cwd, "x") ?? await realpath(t.cwd).catch(() => t.cwd);
    for (;;) {
      const blocked = commandBlocked(a); if (blocked) return blocked;
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      if (await serial(async () => !commandBlocked(a) && await writerAdmit(a, root))) { waiters.delete(signal); return undefined; }
      a.wake = signal;
      const timer = setTimeout(signal, commandTick());
      try { await changed; } finally { clearTimeout(timer); waiters.delete(signal); }
    }
  }
  /** Record the intent of attempt `n` (the start decision): in one serial step with the checks of commandBlocked, so no
   *  stop, retirement, close or hold slips in between. `a.commandStarting` marks the decision for suspend(). */
  function commandIntent(a: Active, n: number): Promise<Entry | "shutdown" | "stopped" | "held"> {
    const t = a.ticket, journal = t.journal, call = t.callId;
    return serial(async () => {
      const blocked = commandBlocked(a); if (blocked) return blocked;
      const existing = entriesFor(journal, call).findLast(e => e.type === COMMAND_INTENT && e.n === n && !intentWithdrawn(journal, call, String(e.id), e.seq));
      if (existing) return existing;
      a.commandStarting = true;
      return journal.append(COMMAND_INTENT, { call, id: commandId(call, n), n });
    });
  }
  /** Whether a later command-withdrawn voids the intent at `seq` (no process was started for it). */
  const intentWithdrawn = (journal: JournalHandle, call: string, id: string, seq: number) => entriesFor(journal, call).some(e => e.type === COMMAND_WITHDRAWN && e.id === id && e.seq > seq);
  /** Start the attempt whose intent is recorded; records command-started, or command-spawn-failed when it cannot start.
   *  Rechecked synchronously right before the spawn: a stop means no process (the watch seals it stopped), a retirement or the orchestrator's exit
   *  withdraws the intent (nothing started; the next start decides again). */
  async function launchCommand(a: Active, id: string, dir: string): Promise<SpawnedCommand | undefined> {
    const t = a.ticket;
    let spawned: SpawnedCommand;
    try {
      if (!(await stat(t.cwd).catch(() => undefined))?.isDirectory()) throw new Error(`cwd ${t.cwd} is not a directory`);
      await rm(join(dir, "exit"), { force: true }); await rm(join(dir, "exit.tmp"), { force: true });
      // The last check is synchronous, right before the spawn (spawnCommand calls it after its own preparation).
      let refused: "stopped" | "withdrawn" | undefined;
      const proceed = () => {
        if (stopped(a)) refused = "stopped";
        else if (closed || a.retired || retiredCall(t.journal, t.callId)) refused = "withdrawn";
        return refused === undefined;
      };
      const result = await spawnCommand({ command: t.spec.command!, cwd: t.cwd, dir, proceed,
        env: commandEnvironment(home, id, t.callId, t.spec.env) });
      if (!result) {
        if (refused === "withdrawn") await serial(() => t.journal.append(COMMAND_WITHDRAWN, { call: t.callId, id }));
        return undefined;
      }
      spawned = result;
    } catch (error) {
      await serial(() => t.journal.append(COMMAND_SPAWN_FAILED, { call: t.callId, id, error: String(error instanceof Error ? error.message : error).slice(0, 300) }));
      return undefined;
    }
    await serial(() => t.journal.append(COMMAND_STARTED, { call: t.callId, id, pid: spawned.pid, start: spawned.start, dir }));
    return spawned;
  }
  /** Run, adopt or settle a command call (see the journal records at the top). One attempt runs at a time; a lost first
   *  attempt of a `rerun: true` call starts once more, only after a scan found none of its processes. A start (the
   *  first attempt or the rerun) waits while the workflow is held: the run ends and the engine runs it after resume. */
  async function executeCommand(a: Active): Promise<CallResult> {
    const t = a.ticket, journal = t.journal, call = t.callId;
    const own = () => entriesFor(journal, call);
    const dirOf = (n: number) => join(callDir(home, t.wid, t.key, t.gen), commandDirName(n));
    const fail = (error: string) => sealCommand(journal, t, commandId(call, 1), { status: "failed", error });
    const latest = () => { const e = own().findLast(e => e.type === COMMAND_INTENT); return e && !intentWithdrawn(journal, call, String(e.id), e.seq) ? e : undefined; };
    /** Start attempt `n`: the intent, then the process; undefined when it did not start (and the run goes on). */
    const begin = async (n: number): Promise<{ spawned?: SpawnedCommand } | undefined> => {
      const intent = await commandIntent(a, n);
      if (intent === "stopped") return undefined;
      if (intent === "shutdown" || intent === "held") throw shutdownError();
      return { spawned: await launchCommand(a, String(intent.id), dirOf(n)) };
    };
    let spawned: SpawnedCommand | undefined;
    for (;;) {
      const old = sealed(journal, call); if (old) return old;
      if (closed || a.retired || retiredCall(journal, call)) {
        if (!closed) { const intent = latest(); if (intent) await endCommand(String(intent.id), commandKnown(own().findLast(e => e.type === COMMAND_STARTED && e.id === intent.id))); }
        throw shutdownError();
      }
      let intent = latest();
      if (!intent) {
        if (t.refusal !== undefined) return fail(t.refusal);
        const n = Math.max(1, ...own().filter(e => e.type === COMMAND_INTENT).map(e => Number(e.n)));
        if (stopped(a)) return sealCommand(journal, t, commandId(call, n), { status: "stopped" });
        if (t.spec.writer === true) {
          const blocked = await commandWriter(a);
          if (blocked === "stopped") continue;
          if (blocked) throw shutdownError();
        }
        spawned = (await begin(n))?.spawned;
        continue;
      }
      const id = String(intent.id), n = Number(intent.n), dir = dirOf(n);
      const failed = own().find(e => e.type === COMMAND_SPAWN_FAILED && e.id === id);
      if (failed) return sealCommand(journal, t, id, { status: "failed", error: `Command could not start: ${String(failed.error)}` });
      const outcome = await watchCommand(a, id, dir, intent, spawned);
      spawned = undefined;
      if (outcome !== "lost") return outcome;
      if (n === 1 && t.spec.rerun === true) {
        // The scan found no process of the first attempt: start it once more (attempt 2 never reruns), a new start.
        if (!own().some(e => e.type === COMMAND_INTENT && e.n === 2)) { spawned = (await begin(2))?.spawned; continue; }
      }
      return sealCommand(journal, t, id, { status: "unknown", error: "Command ended without an exit record" }, dir);
    }
  }
  /** Watch one attempt until it has an outcome: its exit record, a stop, its deadline, or its loss (no exit record and
   *  no process left). The orchestrator's exit ends the watch without touching the process (ExecutorShutdown). */
  async function watchCommand(a: Active, id: string, dir: string, intent: Entry, spawned?: SpawnedCommand): Promise<CallResult | "lost"> {
    const t = a.ticket, journal = t.journal, call = t.callId;
    let watcher: FSWatcher | undefined;
    try { watcher = watch(dir, () => a.wake()); watcher.on("error", () => watcher?.close()); } catch { watcher = undefined; }
    void spawned?.exited.then(() => a.wake());
    try {
      for (;;) {
        const started = entriesFor(journal, call).findLast(e => e.type === COMMAND_STARTED && e.id === id), known = commandKnown(started);
        // The timeout is wall clock from the start (command-started, else the intent: a crash before the started record),
        // downtime included.
        const deadline = t.spec.timeoutMs !== undefined ? (started ?? intent).ts + t.spec.timeoutMs : undefined;
        const exit = await readExitRecord(dir);
        if (exit) {
          // Processes the command left behind (background ones included) end with it, as a call's processes always do.
          if (!closed) await endCommand(id, known);
          // An exit after the deadline (seen late: the orchestrator was down) is a timeout, with the record's data.
          const late = deadline !== undefined && exit.at > deadline;
          return await sealCommand(journal, t, id, { status: late ? "timeout" : exit.status === 0 ? "ok" : "failed", ...exitResult(exit.status),
            ...(late ? { error: `Command timed out after ${t.spec.timeoutMs} ms` } : {}), at: exit.at }, dir);
        }
        if (closed) throw shutdownError();
        if (a.retired || retiredCall(journal, call)) { await endCommand(id, known); throw shutdownError(); }
        if (hasStopIntent(journal, call)) { await endCommand(id, known); return await sealCommand(journal, t, id, { status: "stopped" }, dir); }
        if (deadline !== undefined && Date.now() >= deadline || entriesFor(journal, call).some(e => e.type === COMMAND_TIMEOUT && e.id === id)) {
          await serial(async () => { if (!entriesFor(journal, call).some(e => e.type === COMMAND_TIMEOUT && e.id === id)) await journal.append(COMMAND_TIMEOUT, { call, id }); });
          await endCommand(id, known);
          return await sealCommand(journal, t, id, { status: "timeout" }, dir);
        }
        const wrapper = !!started?.start && await captureStart(Number(started.pid)).catch(() => "") === started.start;
        if (!wrapper && !(await commandProcesses(id, known)).length) {
          // The wrapper may have written its record just before it ended.
          const late = await readExitRecord(dir);
          if (!late) return "lost";
          continue;
        }
        const wait = Math.max(1, Math.min(commandTick(), deadline !== undefined ? deadline - Date.now() : Infinity));
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, wait); a.wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } finally { watcher?.close(); }
  }
  async function execute(a: Active): Promise<CallResult> {
    if (isCommandCall(a.ticket.spec)) return executeCommand(a);
    const t = a.ticket, journal = t.journal;
    const session = callSession(home, t.wid, t.key, t.gen), dir = callDir(home, t.wid, t.key, t.gen);
    const makeResult = (status: CallResult["status"], output = "", error?: string) => buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) });
    let cwd = t.cwd, writer: string | undefined;
    if (sealed(journal, t.callId)) { const result = sealed(journal, t.callId)!; await effects.afterSeal(t, result); return result; }
    // A call that cannot run (CallTicket.refusal) or whose preparation failed is sealed failed without a child.
    let unprepared = t.refusal;
    if (unprepared === undefined) try {
      await continueSession(home, t, session);
      cwd = (await effects.prepare(t, { sessionPath: session })).cwd;
    } catch (error) { unprepared = String(error); }
    if (unprepared !== undefined) {
      const exec = current(journal, t.callId) ?? `${t.callId}#1.1`;
      if (!current(journal, t.callId)) await serial(() => journal.append(JT.exec, { call: t.callId, exec }));
      await fence(journal, exec, { park: a });
      return finish(journal, t.callId, exec, makeResult("failed", "", unprepared));
    }
    for (;;) {
      const old = sealed(journal, t.callId); if (old) return old;
      if (closed || a.suspended || a.retired || journal.entries().some(e => e.type === "retired" && e.call === t.callId)) throw shutdownError();
      let exec = current(journal, t.callId);
      let entries = await readCall(journal, t.callId);
      let dangling: string[] = [];
      let bound: Entry | undefined;
      // D3: a bound answer is settled by its receipt in the session, or by one durable `answer-settled{rid2}` when the
      // session closed its question revision without it (the child took that answer, or superseded the question, before
      // it was fenced): the resume never waits for a receipt the child would not give.
      const answerSettled = (u: Entry, session: readonly SessionEntry[]) => session.some(e => receiptId(e) === u.rid2) ||
        journal.entries().some(e => e.type === "answer-settled" && e.call === t.callId && e.rid2 === u.rid2);
      const settleClosed = async (u: Entry | undefined, session: readonly SessionEntry[]) => {
        if (!u || answerSettled(u, session)) return;
        const d = digestOf(t.callId, session), key = answerKey(u.qid, u.rev);
        // D6: a newer revision of the question (the child asked it again, a steer having ended the ask, before the fence)
        // closes the bound one too: the child would refuse it as stale.
        const reason = d.answered.has(key) ? "answered-in-session" : d.superseded.has(key) ? "superseded-in-session" :
          d.questions.some(q => q.qid === u.qid && q.rev > Number(u.rev)) ? "newer-revision" : undefined;
        if (!reason) return;
        await serial(async () => {
          if (!journal.entries().some(e => e.type === "answer-settled" && e.call === t.callId && e.rid2 === u.rid2))
            await journal.append("answer-settled", { call: t.callId, rid2: u.rid2, qid: u.qid, rev: u.rev, reason });
        });
      };
      const sleeping = hibernation(journal, t.callId);
      if (exec && sleeping?.exec === exec) {
        await fence(journal, exec, { park: a }); await release(exec);
        await adoptAnswer(journal, t.callId, sleeping);
        for (;;) {
          if (interrupted(a) || has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs) break;
          if (reached(totalUsage(journal.entries(), t.callId), t.spec.budget) || reached(totalUsage(journal.entries()), t.workflowBudget))
            return finish(journal, t.callId, exec, makeResult("budget"));
          bound = boundAnswer(journal.entries(), sleeping);
          if (bound) break;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, config.k?.trackerMs ?? 1000); a.wake = () => { clearTimeout(timer); resolve(); }; });
        }
      }
      const pendingAnswer = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      await settleClosed(pendingAnswer, entries);
      if (!bound && pendingAnswer && !answerSettled(pendingAnswer, entries)) bound = pendingAnswer;
      if (exec) {
        await fence(journal, exec, { park: a });
        entries = await readCall(journal, t.callId);
        await serial(() => repairConsumedAnswers(journal, t.callId, entries));
        await questions(t, entries);
        bound ??= journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId && e.reason === "answered-in-session");
        // A binding excuses only the execution it was bound to (the asker it ended) and the first launch after it while
        // that launch never started a child. Every later or started execution is judged by its own evidence, so a
        // child that dies before writing its exec marker counts toward lossBound instead of relaunching forever.
        if (bound) {
          const all = journal.entries(), execSeq = all.find(r => r.type === JT.exec && r.exec === exec)!.seq;
          const firstAfter = !all.some(r => r.type === JT.exec && r.call === t.callId && r.seq > bound!.seq && r.seq < execSeq);
          if (!(bound.seq > execSeq || firstAfter && !has(journal, "tracked", exec) &&
            !digestOf(t.callId, entries).execAt.has(exec))) bound = undefined;
        }
        if (bound) await release(exec);
        // D6: after the fence the session is final. A bound answer it closed (answered, superseded, or re-asked as a newer
        // revision) is settled; if the session still has an open question of this call, the call does not launch: it
        // hibernates again on that question (its attention is open, so the parent is asked), and resumes only on a new
        // binding. Otherwise it launches with the plain continue. Each step is idempotent across a crash between them.
        if (bound) {
          await settleClosed(bound, entries);
          const asking = answerSettled(bound, entries) ? digestOpenQuestion(entries, digestOf(t.callId, entries)) : undefined;
          if (asking && !journal.entries().some(e => e.type === "hibernated" && e.call === t.callId && e.seq > bound!.seq)) {
            await serial(() => journal.append("hibernated", { call: t.callId, exec, qid: asking.qid, rev: asking.rev, reason: "rebound-settled" }));
            continue;
          }
        }
        await recordUsage(t, sessionUsage(entries, t.callId));
        const ev = evidence(entries, exec); dangling = ev.dangling;
        if (closed || a.suspended || a.retired) throw shutdownError();
        if (stopped(a)) return finish(journal, t.callId, exec, makeResult("stopped"));
        if (has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs)
          return finish(journal, t.callId, exec, makeResult("timeout"));
        if (ev.budget || reached(totalUsage(journal.entries(), t.callId), t.spec.budget)) return finish(journal, t.callId, exec, makeResult("budget"));
        for (const e of entries) if (e.customType === CT.modelUnavailable && e.data?.exec === exec)
          await modelControl(journal, exec, { type: CT.modelUnavailable, ...e.data });
        const modelFailure = entriesOf(journal, "model-unavailable", exec).at(-1);
        if (modelFailure) {
          const selected = entriesOf(journal, "selected", exec).at(-1);
          if (!selected?.pool) return finish(journal, t.callId, exec, makeResult("failed", "", `model-unavailable: ${String(modelFailure.reason)}`));
          await release(exec);
        }
        // A child that never started (its launch failed for a reason of the environment) lost nothing: launch again.
        if (!bound && !modelFailure && !has(journal, "spawn-env-failed", exec)) {
        // P28: an execution cut off while its only unfinished tool call is the open question's `ask` (before it
        // hibernated) was waiting, not working: it hibernates now and resumes with the answer, like a planned
        // hibernation; it is neither a loss nor, for `once`, an unknown outcome.
        const asking = openQuestion(entries);
        const segment = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.exec && e.data?.exec === exec);
        const ownQuestion = !!asking && segment >= 0 && entries.slice(segment + 1).some(e => e.customType === CT.question && e.data?.qid === asking.qid);
        if (asking && ownQuestion && dangling.length && dangling.every(d => d.startsWith("ask (")) && hibernation(journal, t.callId)?.exec !== exec) {
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
      await writeFile(prompt, `${t.agent.body}\n\n${CHILD_LIFECYCLE_NOTE}`);
      if (t.spec.schema !== undefined) await writeFile(schema, JSON.stringify(t.spec.schema));
      const sender = await outbox;
      if (bound) await serial(async () => {
        if (!journal.entries().some(e => e.type === "resumed" && e.call === t.callId && e.rid === bound!.rid)) await journal.append("resumed", { call: t.callId, rid: bound!.rid, exec });
      });
      // The answer uses its stable forwarded identity across every recovery incarnation.
      const unresolved = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      // D3: the child takes one answer per question revision; a bound answer to one the session already closed (answered
      // or superseded) is settled durably instead of sent (it would be dropped), and the execution continues.
      await settleClosed(unresolved, entries);
      const receipt = unresolved && answerSettled(unresolved, entries);
      const openingRid = t.opening && contentHash([t.opening.rid, "dispatch"]);
      const openingReceived = openingRid && entries.some(e => receiptId(e) === openingRid);
      // The task has one identity: the dispatch of the call's first execution. A later execution continues only once
      // the session holds that task; an execution interrupted before its child received it (still waiting for a
      // provider slot, say) leaves a session without a task, and "continue" would ask a fresh model to guess.
      const taskRid = contentHash([`${t.callId}#1.1`, "dispatch"]);
      const taskReceived = !openingRid && entries.some(e => receiptId(e) === taskRid);
      if (openingRid && !openingReceived) await sender.send(t.callId, "task", { message: t.opening!.message }, undefined, { rid: openingRid });
      else if (!openingRid && !taskReceived) await sender.send(t.callId, "task", { message: t.spec.task }, undefined, { rid: taskRid });
      else if (unresolved && !receipt) await sender.send(t.callId, "continue", { message: String(unresolved.message), ...(Array.isArray(unresolved.superseded) ? { superseded: unresolved.superseded } : {}) },
        { qid: String(unresolved.qid), rev: Number(unresolved.rev) }, { rid: String(unresolved.rid2) });
      else if (previous) {
        // After launches that failed for a reason of the environment, no child received their dispatches: the first
        // execution of that run of failures keeps its dispatch (rid and content), so one is pending, not one per retry.
        const chain = envFailedChain(journal, t.callId, previous);
        const prior = chain && sender.recorded(contentHash([chain.first, "dispatch"]));
        if (prior) await sender.send(t.callId, prior.kind, prior.body, prior.cond, { rid: prior.rid });
        else await sender.send(t.callId, "continue", { message: continueMessage(chain?.before ? evidence(entries, chain.before).dangling : dangling) }, undefined,
          { rid: contentHash([chain?.first ?? exec, "dispatch"]) });
      }
      else await sender.send(t.callId, "task", { message: t.opening?.message ?? t.spec.task }, undefined, { rid: contentHash([exec, "dispatch"]) });
      await launchGate(a, exec, "child");
      if (interrupted(a)) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let child: Spawned;
      try {
        child = await containment.spawn({ exec, command: piCommand, args: [...buildPiArgs(t.agent, t.spec, { sessionPath: session, systemPromptPath: prompt, continuation: decision.continuation, controlTools: t.spec.schema === undefined ? ["ask"] : ["ask", "report"], ...(model.id ? { model } : {}) }), "-e", extension], cwd,
          // The orchestrator's node follows binDir: a `#!/usr/bin/env node` pi runs under a PATH without node (a service's).
          env: { DSA_HOME: home, PATH: [binDir(home), dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), DSA_EXEC: exec, DSA_CALL: t.callId, DSA_INBOX: inbox(t.callId), DSA_JOURNAL: journal.path, DSA_ASK_REQUIRE_DECISION: String(config.askRequireDecision ?? false), ...(t.spec.schema !== undefined ? { DSA_SCHEMA: schema } : {}), ...(t.spec.budget ? { DSA_BUDGET: JSON.stringify(t.spec.budget) } : {}), ...(model.provider && model.id ? { DSA_MODEL: `${model.provider}/${model.id}` } : {}) } });
      } catch (error) {
        const environment = environmentSpawnError(error);
        if (environment) await serial(() => spawnEnvRecord(t, exec!, error));
        await fence(journal, exec, { park: a }); a.live = undefined;
        if (!environment) return finish(journal, t.callId, exec, makeResult("failed", "", `Spawn failed: ${String(error)}`));
        await release(exec);
        await serial(() => spawnEnvFailed(t, exec!, cwd, error));
        await retryWait(a);
        continue;
      }
      await serial(() => spawnEnvResolved(t));
      try {
        // EX1: retain the direct identity even if pi exited before start capture; otherwise a surviving grandchild
        // could become the first tracked process and be mistaken for pi on a recovery fence.
        if (child.pid > 0) await serial(async () => {
          await journal.append("tracked", { exec, pid: child.pid, start: child.start, child: true });
        });
        await track(journal, exec, [{ pid: child.pid, start: child.start, ppid: process.pid }]);
        await observeExecution({ home, config, ticket: t, exec, child, serial, read: () => readCall(journal, t.callId),
          setWake: fn => { a.wake = fn; }, interrupted: () => !!interrupted(a),
          track: () => track(journal, exec!), fence: async () => { await fence(journal, exec!, { child, park: a }); },
          questions: async entries => {
            await questions(t, entries);
            const digest = digestOf(t.callId, entries), q = digestOpenQuestion(entries, digest);
            const segment = digest.execAt.get(exec) ?? -1;
            if (!q || interrupted(a) || segment < 0 || !((digest.questionAt.get(q.qid) ?? -1) > segment) || entriesOf(journal, "answer-bound").some(e => e.call === t.callId && e.qid === q.qid && e.rev === q.rev)) return;
            await serial(async () => {
              const attention = entriesOf(journal, JT.attention).find(e => isEntry(e, JT.attention) && e.item.qid === q.qid && e.item.call === t.callId && e.item.rev === q.rev);
              const all = journal.entries();
              if (attention && Date.now() - attention.ts >= (config.k?.hibernateMs ?? 120000) && !interrupted(a) && current(journal, t.callId) === exec &&
                openAsked(all, t.callId, q.qid, q.rev) && !answerInFlight(all, t.callId) &&
                !all.some(e => e.type === "answer-bound" && e.call === t.callId && e.qid === q.qid && e.rev === q.rev) &&
                !has(journal, JT.fenced, exec!) && hibernation(journal, t.callId)?.exec !== exec) {
                await journal.append("hibernated", { call: t.callId, exec, qid: q.qid, rev: q.rev }); a.wake();
              }
            });
          }, recordUsage: values => recordUsage(t, values), usage: entries => digestOf(t.callId, entries).usage,
          wrote: path => wrote(t, exec!, cwd, path),
          modelControl: event => modelControl(journal, exec!, event),
          switched: event => switched(exec!, journal, event), answered: event => answered(t, exec!, event), pendingSwitch: () => pendingSwitch(exec!),
        });
      } finally { await fence(journal, exec, { child, park: a }); a.live = undefined; }
    }
  }
  /**
   * P28: reconcile an answer forwarded before an interrupted asker hibernated. A consumed answer continues the
   * session; an unconsumed one binds like an answer given during hibernation and retires its original forward.
   * The reply "apply" already given (and any retry with the same rid) stays true.
   */
  async function adoptAnswer(journal: JournalHandle, call: string, sleeping: Entry) {
    const entries = await readCall(journal, call);
    await serial(async () => { await repairConsumedAnswers(journal, call, entries); await adopt(journal, call, sleeping, entries); });
  }
  /** A fenced asker may have consumed its forwarded answer before the fence. Publish the binding first, then its
   *  derived resolution and delivery: every prefix is repaired on retry/recovery. Never resend the answer; the next
   *  execution uses a plain continue in the same session. Called serially, only after the current execution is fenced. */
  async function repairConsumedAnswers(journal: JournalHandle, call: string, entries: readonly SessionEntry[]) {
    const exec = current(journal, call);
    if (!exec || !has(journal, JT.fenced, exec) || sealed(journal, call) || journal.entries().some(e => e.type === "retired" && e.call === call)) return;
    const digest = digestOf(call, entries);
    for (const f of entriesOf(journal, "forward").filter(e => e.dest === call)) {
      const env = f.envelope as Envelope, qid = env.cond?.qid, rev = env.cond?.rev;
      if (env.kind !== "answer" || !digest.questions.some(q => q.qid === qid && q.rev === rev) ||
        journal.entries().some(e => e.type === "forward-retired" && e.rid2 === f.rid2)) continue;
      const receipt = digest.receipts.get(String(f.rid2)), details = receipt?.message?.details ?? receipt?.details;
      if (!receipt || details?.qid !== qid || details?.rev !== rev) continue;
      // The binding must not outlive the evidence it derives: fsync the native receipt before journal publication.
      await collectReceipts(call, [...entries]);
      const binding = journal.entries().find(e => e.type === "answer-bound" && e.call === call && e.qid === qid && e.rev === rev);
      // A normal settled turn needs no continuation, nor does an answer consumed in an earlier execution. A receipt
      // in this execution counts even if observation already resolved its attention before the fence.
      const sleeping = hibernation(journal, call), segment = digest.execAt.get(exec);
      const at = entries.indexOf(receipt), consumedHere = segment !== undefined && at > segment;
      // The execution stopped ON that ask: its result is the answer receipt and nothing ran after it (no report, no
      // question, no tool call, no finished assistant turn, no other unfinished tool). Otherwise the execution went on
      // working after the answer and its own evidence (report, once + dangling, loss) decides as usual.
      const after = entries.slice(at + 1);
      const stoppedOnAsk = consumedHere && receipt.message?.role === "toolResult" && receipt.message.toolName === "ask" &&
        !evidence([...entries], exec).dangling.length &&
        !after.some(e => e.type === "custom" && (e.customType === CT.report || e.customType === CT.question) ||
          e.message?.role === "assistant" && ((Array.isArray(e.message.content) && e.message.content.some(b => b.type === "toolCall")) ||
            (e.message.stopReason !== "aborted" && e.message.stopReason !== "error")));
      const superseded = supersededBy(details);
      const sleepingAnswered = sleeping?.exec === exec && (sleeping.qid === qid && sleeping.rev === rev ||
        superseded.some(q => q.qid === sleeping.qid && q.rev === sleeping.rev));
      if (!binding && (sleepingAnswered || stoppedOnAsk && !has(journal, "settled", exec)))
        await journal.append("answer-bound", { call, qid, rev, rid: f.rid, rid2: f.rid2, hash: f.hash, reason: "answered-in-session",
          ...(superseded.length ? { superseded } : {}) });
      await resolveBoundAnswer(journal, call, qid, rev);
      for (const q of superseded) await resolveQuestion(journal, call, q.qid, q.rev, "superseded");
    }
    await forwardsDelivered(journal, call, [...entries]);
  }
  /** The forward whose adoption was begun (its envelope withdrawn from the child's inbox) and not yet bound. */
  async function adoptionBegun(journal: JournalHandle, call: string): Promise<Entry | undefined> {
    const sender = await outbox, all = journal.entries();
    return all.find(e => e.type === "forward" && e.dest === call && (e.envelope as Envelope).kind === "answer" &&
      !all.some(r => r.rid2 === e.rid2 && r.type === "forward-retired") && !!sender.recorded(contentHash([String(e.rid2), "withdraw-adopted"])));
  }
  /** P28, D3: bind a pending answer forward to hibernation `sleeping` (see adoptAnswer). `onlyBegun`: only one whose
   *  adoption was begun before a crash (its envelope is withdrawn, so it can reach the child only through this binding).
   *  Called serially. */
  async function adopt(journal: JournalHandle, call: string, sleeping: Entry, entries: readonly SessionEntry[], onlyBegun = false) {
    const all = journal.entries(), bound = boundAnswer(all, sleeping);
    if (bound) {
      // Repair an adoption cut off after its binding but before resolution/retirement. The original forward and
      // derived bound identity prove adoption; a consumed answer instead keeps its original delivered identity.
      await resolveBoundAnswer(journal, call, bound.qid, bound.rev);
      await resolveSuperseded(journal, call);
      const f = all.find(e => e.type === "forward" && e.dest === call && e.rid === bound.rid &&
        contentHash([String(e.rid2), "hibernated"]) === bound.rid2);
      if (f && !all.some(e => e.type === "forward-retired" && e.rid2 === f.rid2))
        await journal.append("forward-retired", { rid: f.rid, rid2: f.rid2, reason: "bound-to-hibernation" });
      if (f) await (await outbox).markResolved(String(f.rid2));
      return;
    }
    const begun = await adoptionBegun(journal, call);
    const receipts = new Set(entries.map(receiptId).filter(rid => rid !== undefined));
    // The answer to the question it hibernated on, else to another of its questions still open (an earlier one).
    const pending = all.filter(e => {
      if (e.type !== "forward" || e.dest !== call) return false;
      const env = e.envelope as Envelope;
      return env.kind === "answer" && !receipts.has(String(e.rid2)) && !all.some(r => r.rid2 === e.rid2 && (r.type === "forward-retired" || r.type === "forward-delivered")) &&
        (env.cond?.qid === sleeping.qid && env.cond?.rev === sleeping.rev || openAsked(all, call, env.cond?.qid, env.cond?.rev));
    });
    // An adoption begun before a crash is completed first: its envelope is already withdrawn.
    const f = pending.find(e => e.rid2 === begun?.rid2) ?? (onlyBegun ? undefined : pending.find(e => (e.envelope as Envelope).cond?.qid === sleeping.qid) ?? pending[0]);
    if (!f) return;
    const { qid, rev } = (f.envelope as Envelope).cond!;
    const item = attentionEntries(all).find(e => e.item.call === call && e.item.qid === qid && e.item.rev === rev)?.item;
    const message = String(((f.envelope as Envelope).body as { message?: unknown } | undefined)?.message ?? "");
    // A new identity: the stale answer may still sit in the child's inbox under the forward's rid2. It is withdrawn
    // there (D3; before the bound continue is sent, so the resumed child drops it first): the continue carries the
    // answer and what it supersedes. Idempotent by rid, so a crash before the binding sends it once.
    await (await outbox).send(call, "withdraw", { rids: [String(f.rid2)] }, undefined, { rid: contentHash([String(f.rid2), "withdraw-adopted"]) });
    await journal.append("answer-bound", { event: true, call, qid, rev, rid: f.rid, rid2: contentHash([String(f.rid2), "hibernated"]), hash: f.hash,
      message: `${HIBERNATED_NOTE}${withdrawn(all, call, sleeping, qid, rev)}\n\nQuestion: ${item?.text ?? qid}\nAnswer: ${message}`, ...supersedes(sleeping, qid, rev) });
    await resolveBoundAnswer(journal, call, qid, rev);
    if (qid !== sleeping.qid || rev !== sleeping.rev) await resolveQuestion(journal, call, sleeping.qid, sleeping.rev, "superseded");
    await journal.append("forward-retired", { rid: f.rid, rid2: f.rid2, reason: "bound-to-hibernation" });
    await (await outbox).markResolved(String(f.rid2));
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
          for (const e of refusals.keys()) if (callOf(e) === ticket.callId) refusals.delete(e); forgetCall(ticket.callId); wake();
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
          if ((prior.envelope as Envelope).kind === "answer") {
            await repairConsumedAnswers(ctx.journal, dest, await readCall(ctx.journal, dest));
            const exec = current(ctx.journal, dest);
            if (exec && has(ctx.journal, JT.fenced, exec)) { active.get(dest)?.wake(); wake(); }
          }
          if (!ctx.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === prior.rid2)) await replayForward(prior);
          return { action: "apply" } as const;
        }
        const boundRetry = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.rid === req.rid);
        if (boundRetry) {
          if (boundRetry.hash !== hash) return { action: "reject", reason: "identity-conflict" } as const;
          await resolveBoundAnswer(ctx.journal, dest, boundRetry.qid, boundRetry.rev);
          return { action: "apply" } as const;
        }
        if (sealed(ctx.journal, dest)) return { action: "reject", reason: req.kind === "send" && (req.body as SendBody).kind === "answer" ? "retired" : "call-sealed" } as const;
        if (req.kind === "send" && (req.body as SendBody).kind === "answer") {
          const sleeping = hibernation(ctx.journal, dest);
          await repairConsumedAnswers(ctx.journal, dest, await readCall(ctx.journal, dest));
          const exec = current(ctx.journal, dest);
          if (exec && has(ctx.journal, JT.fenced, exec)) { active.get(dest)?.wake(); wake(); }
          // An adoption begun before a crash (the earlier answer withdrawn from the inbox, not yet bound) binds first.
          if (sleeping && current(ctx.journal, dest) === sleeping.exec && !boundAnswer(ctx.journal.entries(), sleeping) && await adoptionBegun(ctx.journal, dest))
            await adopt(ctx.journal, dest, sleeping, await readCall(ctx.journal, dest), true);
          const priorAnswer = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.qid === req.cond?.qid && e.rev === req.cond?.rev);
          if (priorAnswer) return priorAnswer.rid === req.rid && priorAnswer.hash === hash ? { action: "apply" } as const : { action: "reject", reason: "already-answered" } as const;
          // D2, D4: a superseded or carried question takes no answer.
          if (supersededByBinding(ctx.journal.entries(), dest, req.cond?.qid, req.cond?.rev) ||
            ctx.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `q:${dest}:${req.cond?.qid}` && e.rev === req.cond?.rev && (e.resolution === "superseded" || e.resolution === "carried")))
            return { action: "reject", reason: "stale-rev" } as const;
          // A hibernated call takes one answer: to the question it hibernated on, or to another of its open questions (an
          // earlier one, still open while the child asked a reminder). Once one is bound, a further answer to another
          // open question is forwarded like any other: the resumed child takes it at its next ask.
          if (sleeping && current(ctx.journal, dest) === sleeping.exec &&
            !(sleeping.qid === req.cond?.qid && sleeping.rev === req.cond?.rev) && !openAsked(ctx.journal.entries(), dest, req.cond?.qid, req.cond?.rev))
            return { action: "reject", reason: "stale-rev" } as const;
          if (sleeping && current(ctx.journal, dest) === sleeping.exec && !boundAnswer(ctx.journal.entries(), sleeping)) {
            const { qid, rev } = req.cond!;
            const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
            const item = attentionEntries(ctx.journal.entries()).find(e => e.item.call === dest && e.item.qid === qid && e.item.rev === rev)?.item;
            // `event`: the `answered` event derives from this entry (an unmarked older one: from its resolution).
            await ctx.journal.append("answer-bound", { event: true, call: dest, qid, rev, rid: req.rid, rid2, hash,
              message: `${HIBERNATED_NOTE}${withdrawn(ctx.journal.entries(), dest, sleeping, qid, rev)}\n\nQuestion: ${item?.text ?? qid}\nAnswer: ${(req.body as SendBody).message ?? ""}`, ...supersedes(sleeping, qid, rev) });
            await resolveBoundAnswer(ctx.journal, dest, qid, rev);
            if (qid !== sleeping.qid || rev !== sleeping.rev) await resolveQuestion(ctx.journal, dest, sleeping.qid, sleeping.rev, "superseded");
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
          // call) a free slot; an entry with afterMs is skipped (it is for calls that waited for a slot), as failover
          // skips it. The call's own pool stays, so a used-up window later moves it on as before.
          const pools = settings().pools, pool = pools && Object.hasOwn(pools, model) ? model : undefined;
          if (pool) {
            let models: Model[]; try { models = resolveModel(pool, pools); } catch { return { action: "reject", reason: "unknown-model" } as const; }
            const free = (p: string) => idle || holdings().some(h => h.exec === exec && h.pool === p) ||
              capacity({ kind: "provider", holders: holdings().filter(h => h.pool === p).length, capacity: settings().providers?.[p]?.slots ?? Infinity });
            const m = models.find(m => m.provider && m.afterMs === undefined && !unavailable(m.provider) && free(m.provider));
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
          // A notify is held by the child while its question is open (asking, or hibernated until the answer): the
          // reply says which (orchestrator ledger `send-note`, once per rid, before the forward is recorded).
          if (kind === "notify" && !orch.entries().some(e => e.type === "send-note" && e.rid === req.rid))
            await orch.append("send-note", { rid: req.rid, delivery: openQuestion(await readCall(ctx.journal, dest)) ? "held-until-answer" : "steered" });
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
      const calls = new Set(journal.entries().filter(e => (e.type === JT.exec || e.type === COMMAND_INTENT) && (!target.callId || e.call === target.callId)).map(e => String(e.call)));
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
        else if (entriesFor(journal, call).some(e => e.type === COMMAND_INTENT)) {
          // A command call nobody watches here (not adopted yet): end its tree, then seal it stopped.
          if (sealed(journal, call) || retiredCall(journal, call)) continue;
          const intent = entriesFor(journal, call).findLast(e => e.type === COMMAND_INTENT)!, id = String(intent.id);
          await endCommand(id, commandKnown(entriesFor(journal, call).findLast(e => e.type === COMMAND_STARTED && e.id === id)));
          const { wid, key, gen } = address(call);
          await sealCommand(journal, { wid, key, gen, callId: call, spec: {} } as CallTicket, id, { status: "stopped" },
            join(callDir(home, wid, key, gen), commandDirName(Number(intent.n)))).catch(error => { if (error?.name !== "ExecutorShutdown") throw error; });
        } else {
          const exec = current(journal, call); if (!exec || sealed(journal, call)) continue;
          // F1: a stuck fence leaves the call unsealed; the sweep seals it stopped once the exec is retired.
          if (!await fence(journal, exec)) continue;
          const { key, gen } = address(call);
          await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
        }
      }
    },
    async recover(wid, journal, options = {}) {
      journals.set(wid, journal);
      // A settled workflow (orchestrator/settled.ts) not decoded: every call recovered; only the sweep needs its executions.
      if (journal.loaded === false && options.settled) {
        seeds.set(journal, seededSweep(options.settled.sweep));
        return { calls: 0, skipped: options.settled.calls };
      }
      indexSweep(journal);
      // Batched (the engine recovers every workflow, then calls finishRecovery): the steps that do not depend on the
      // workflow run once, in finishRecovery.
      if (!options.batch) await serial(() => resolveWorktrees());
      await effects.recover(journal);
      // A call whose recovery ran to its end before (and that nothing concerned since) is not read again: all its
      // executions were fenced and released, its session read, its forwards, attention and inbox settled.
      // A retired command call's processes, if any still run (an orchestrator ended during its retirement), end now.
      if (entriesOf(journal, COMMAND_INTENT).length)
        for (const r of retiredCommandAttempts(journal.entries())) await endCommand(r.id, r.start ? [{ pid: r.pid!, ppid: 0, start: r.start }] : []);
      const complete = completeCalls(journal, wid), execs = entriesOf(journal, JT.exec).filter(e => !complete.has(String(e.call)));
      for (const e of execs) {
        // F1: an exec whose fence fails stays unfenced and holding; its call parks until a sweep retires it.
        const exec = String(e.exec); if (await fence(journal, exec)) await release(exec);
      }
      // Writers that waited before the restart keep their order while their calls come back.
      const waits = entriesOf(journal, "writer-wait");
      if (waits.length) for (const e of [...waits, ...entriesOf(journal, "writer-acquired"), ...entriesOf(journal, JT.sealed), ...entriesOf(journal, "retired")].sort((x, y) => x.seq - y.seq)) {
        const call = String(e.call);
        if (e.type === "writer-wait" && !writerWaits.has(call)) writerWaits.set(call, { root: String(e.root), since: e.ts, recovered: Date.now() });
        else if (e.type === "writer-acquired" || e.type === JT.sealed || e.type === "retired") { const w = writerWaits.get(call); if (w?.recovered !== undefined) writerWaits.delete(call); }
      }
      const calls = new Set(execs.map(e => String(e.call)));
      for (const call of calls) {
        const session = await readCall(journal, call), values = sessionUsage(session, call);
        await serial(async () => {
          await repairConsumedAnswers(journal, call, session);
          await forwardsDelivered(journal, call, session);
          const recorded = new Set(entriesFor(journal, call).filter(e => e.type === "usage").map(e => e.id));
          for (const u of values) if (!recorded.has(u.id)) await journal.append("usage", { call, ...u });
          if (sealed(journal, call) || retiredCall(journal, call)) {
            await retireForwards(journal, call); await retireAttention(journal, call); await unknownAttention(journal, call);
          } else {
            await resolveSuperseded(journal, call);
            if (session.length) await resolveCarried(journal, call, digestOf(call, session).questions);
          }
        });
        if (!active.has(call)) forgetCall(call);
      }
      const retiredForwards = new Set(entriesOf(journal, "forward-retired").map(r => r.rid2));
      for (const e of entriesOf(journal, "forward").filter(e => !retiredForwards.has(e.rid2))) await replayForward(e);
      const ended = [...calls].filter(call => sealed(journal, call) || retiredCall(journal, call));
      if (options.batch) unfinished.push({ journal, calls: ended });
      else {
        await (await outbox).republishPending();
        await finishCalls(journal, ended);
      }
      return { calls: calls.size, skipped: new Set(entriesOf(journal, JT.exec).map(e => String(e.call))).size - calls.size };
    },
    async finishRecovery() {
      const batch = unfinished.splice(0);
      await serial(() => resolveWorktrees());
      const sender = await outbox;
      await sender.republishPending();
      // E2: republication may restore envelopes of sealed calls, also of calls skipped as complete; the seal resolves them.
      const destinations = sender.pendingDestinations();
      for (const call of destinations) {
        const wid = callWid(call), journal = wid === undefined ? undefined : journals.get(wid);
        if (wid !== undefined && journal && completeCalls(journal, wid).has(call) && sealed(journal, call)) await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
      }
      for (const { journal, calls } of batch) await finishCalls(journal, calls);
    },
    recovered(journal, call) {
      const wid = address(call).wid;
      return completeCalls(journal, wid).has(call) && ![...folded().writers.values()].some(w => w.call === call);
    },
    async retire(widRev) {
      const journal = journals.get(widRev.slice(0, widRev.lastIndexOf("@"))); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => (e.type === JT.exec || e.type === COMMAND_INTENT) && String(e.call).startsWith(`${widRev}/`)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.widRev === widRev) { a.retired = true; a.controller.abort(); calls.add(a.ticket.callId); }
      await serial(async () => { for (const call of calls) if (!journal.entries().some(e => e.type === "retired" && e.call === call)) await journal.append("retired", { call }); });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call); if (a) await settledOrParked(a);
        for (const e of journal.entries().filter(e => e.type === JT.exec && e.call === call)) if (await fence(journal, String(e.exec))) await release(String(e.exec));
        // A command call's processes end with its retirement (one nobody watched here included).
        const intent = sealed(journal, call) ? undefined : entriesFor(journal, call).findLast(e => e.type === COMMAND_INTENT);
        if (intent) await endCommand(String(intent.id), commandKnown(entriesFor(journal, call).findLast(e => e.type === COMMAND_STARTED && e.id === intent.id)));
        await serial(async () => { await retireForwards(journal, call); await retireAttention(journal, call); });
      }
    },
    busy: () => active.size > 0,
    exclusive: fn => serial(fn),
    quiesce() {
      paused = true;
      const live = [...active.values()].filter(a => a.live).map(a => ({ wid: a.ticket.wid, key: a.ticket.key, gen: a.ticket.gen, callId: a.ticket.callId, ...a.live! }));
      // Command calls never count as live: they keep running across a restart and the successor adopts them.
      const commands = [...active.values()].filter(a => isCommandCall(a.ticket.spec)).length;
      return { live, commands, resume: () => { paused = false; for (const fn of [...unpaused]) fn(); } };
    },
    suspend(only?: (wid: string) => boolean) {
      // A drain with fence does not fence command calls: they keep running and seal (the held workflow starts nothing
      // after them). Only the orchestrator's exit (shutdown) ends their watchers, leaving the processes running.
      // One that has not started (no intent: waiting for the writer lock, say) is suspended like a call not launched.
      const suspendable = (a: Active) => closed || !isCommandCall(a.ticket.spec) || (!a.commandStarting && !entriesFor(a.ticket.journal, a.ticket.callId).some(e => e.type === COMMAND_INTENT));
      if (only) { // scoped (one session's quit, one workflow): other workflows keep running and dispatching
        const targets = [...active.values()].filter(a => only(a.ticket.wid) && suspendable(a));
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
      const targets = [...active.values()].filter(suspendable);
      for (const a of targets) { a.suspended = true; a.controller.abort(); a.wake(); }
      wake();
      suspending = (async () => {
        const results = await Promise.allSettled(targets.map(a => a.promise));
        await queue;
        const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
        if (failed?.status === "rejected") throw failed.reason;
      })().finally(() => { suspending = undefined; });
      return suspending;
    },
    async shutdown() {
      if (closed) return;
      closed = true; clearInterval(sweepTimer);
      try {
        await this.suspend();
        // Command watchers end at once (their processes keep running; the next start adopts them), also when an
        // earlier drain's suspension was still settling and did not include them.
        const commands = [...active.values()].filter(a => isCommandCall(a.ticket.spec));
        for (const a of commands) a.wake();
        await Promise.allSettled(commands.map(a => a.promise));
        await sweeping;
      }
      finally { await queue; await (await outbox).close(); }
    },
  };
}
