// Read-only status snapshots (P25: `status` is always a fresh snapshot). Pure readers of committed journals:
// never depend on orchestrator memory, so the UI, the CLI and the main agent see the same durable state.
import { initiatorSummary, restartLine } from "./restart.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileFanout } from "../compat/fanout.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath, orchLedger, pinnedDir, workflowDir } from "../paths.ts";
import { JT, isEntry, type AttentionItem, type CallResult, type Entry, type EntryOf } from "../types.ts";
import { emptyLedger, foldLedger, type LedgerState } from "./ledger.ts";
import type { Exhaustion } from "./providers.ts";
import { packageVersion } from "../version.ts";
import { worktreeCalls, worktreeLabel } from "./executor/worktree.ts";
import { leaseCalls, leaseLines, leaseState } from "../platform/lease.ts";

export type CallPhase = "queued" | "running" | "asking" | "sealed";
export type Usage = { input: number; output: number; costUsd: number };
/** P7, P27: A request forwarded to a call: pending until the child's receipt is observed, or retired by the seal. */
export interface CallSend {
  rid: string; kind: string; state: "pending" | "delivered" | "retired";
  /** Wall-clock ms of the latest state change. */
  at: number;
  /** The child resolved it by rejecting it (e.g. `withdrawn`). */
  reason?: string;
  /** A model switch's target ("provider/id"). */
  model?: string;
}
export interface CallSnapshot {
  key: string; gen: number; callId: string; agent: string; phase: CallPhase;
  /** Other calls named by an open shared-worktree reminder. */
  sharedWorktree?: string[];
  result?: CallResult;
  /** The model in use: the provider/model of the latest answer (`model-used`), else the one launched (`selected`), else
   *  the one the call asked for while it waits for a slot. */
  model?: string; exec?: string;
  pos?: number; refused?: string; reused?: string;
  /** Wall-clock ms of the latest durable evidence for this call (display only). */
  lastActivity?: number; startedAt?: number; endedAt?: number;
  /** P31: the sealed result's usage, else the committed usage entries so far. */
  usage?: Usage;
  /** Tool executions observed across the call's executions. */
  tools?: number;
  /** Forwarded requests in forward order; `pending` counts pending messages (steer, follow-up, answer). */
  sends?: CallSend[]; pending?: number;
  /** The latest model requested ("provider/id") while the call is not answering with it yet: a running call switches at
   *  its next provider request, one with no live execution (queued, hibernated) launches on it. */
  switching?: string;
  /** The latest model request was refused by the child: "provider/id (reason)"; the model in use stays. */
  switchFailed?: string;
  /** A follow-up still open on a finished workflow: live work although the workflow's status is final. */
  afterEnd?: true;
  /** P28: asking and hibernated: its execution is fenced and holds no provider slot until the answer arrives. */
  hibernated?: true;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
}
export interface WorkflowSnapshot {
  wid: string; rev: number; name?: string; origin?: string; cwd?: string;
  status: "running" | "done" | "failed" | "parked" | "stopped";
  error?: string; result?: unknown;
  calls: CallSnapshot[];
  counts: Record<CallPhase, number>;
  attention: AttentionItem[];
  startedAt?: number; endedAt?: number;
  /** Drain: the orchestrator is drained (stop-all); queued calls start only after resume. */
  paused?: boolean;
  /** Follow-ups still open on a finished workflow: its status stays final (its result does not change), but this work
   *  runs, can be paused and shows as live — see `isLive`. */
  followUps?: number;
  /** v12 §4: planned total — the tasks/chain length pinned at admission; scripts have none. */
  planned?: number;
  /** P31: every call ever charged to this workflow, across revisions (always set by snapshotFromEntries). */
  usage?: Usage;
}

/** A workflow has live work: it runs, or follow-ups opened on it after it finished have not ended yet. */
export function isLive(wf: Pick<WorkflowSnapshot, "status" | "followUps">): boolean {
  return wf.status === "running" || (wf.followUps ?? 0) > 0;
}

/** The calls of a workflow that are live work: every unfinished call of a running workflow, else open follow-ups. */
export function liveCalls(wf: Pick<WorkflowSnapshot, "status" | "calls">): CallSnapshot[] {
  return wf.calls.filter(c => c.phase !== "sealed" && (wf.status === "running" || c.afterEnd === true));
}

/** v12 §4: done/total of one workflow: `done` counts keys whose latest generation is sealed; `total` is the planned
 *  count when known, else keys proposed so far (`plus` marks the `n+` script case while the workflow runs). */
export function progressOf(wf: Pick<WorkflowSnapshot, "calls" | "planned" | "status">): { done: number; total: number; plus: boolean } {
  const latest = new Map(wf.calls.map(c => [c.key, c] as const)); // later generations of a key replace earlier ones
  const done = [...latest.values()].filter(c => c.phase === "sealed").length;
  return { done, total: wf.planned ?? latest.size, plus: wf.planned === undefined && wf.status === "running" };
}

// v12 §4: the exact bodies compileFanout emits after the `const steps = [...];` line, so only true fanouts count as planned.
const fanoutBodies = [compileFanout({ tasks: [] }).source, compileFanout({ chain: [] }).source].map(s => s.slice(s.indexOf("\n") + 1));
/** v12 §4: The planned total of a pinned script: its steps count when it is a compiled tasks/chain fanout; scripts have none. */
export function plannedFromScript(source: string): number | undefined {
  const cut = source.indexOf("\n"), head = source.slice(0, Math.max(0, cut)), rest = source.slice(cut + 1);
  if (!head.startsWith("const steps = ") || !head.endsWith(";") || !fanoutBodies.some(body => rest === body)) return undefined;
  try {
    const steps = JSON.parse(head.slice("const steps = ".length, -1)) as unknown;
    return Array.isArray(steps) ? steps.length : undefined;
  } catch { return undefined; }
}
// v12 §4: pins are write-once (kernel publishFile), so the parsed planned total is cached by script path for the process.
const plannedByPath = new Map<string, number | undefined>();
/** v12 §4: The current revision's planned total, read lazily from the pinned run body and cached (pins are immutable). */
function plannedTotal(home: string, wid: string, rev: number): number | undefined {
  const path = join(pinnedDir(home, wid), rev === 1 ? "script.js" : join(`r${rev}`, "script.js"));
  if (!plannedByPath.has(path)) {
    try { plannedByPath.set(path, plannedFromScript(readFileSync(path, "utf8"))); } catch { plannedByPath.set(path, undefined); }
  }
  return plannedByPath.get(path);
}

const zero = (): Usage => ({ input: 0, output: 0, costUsd: 0 });
const nonzero = (u?: Usage) => !!u && (u.input > 0 || u.output > 0 || u.costUsd > 0);
const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n)}…` : text;
const MESSAGES = new Set(["steer", "follow-up", "answer", "continue", "task"]);
/** P7, P27: A pending send that carries a message to the agent (model switches and withdrawals are controls). */
export const pendingMessage = (s: CallSend) => s.state === "pending" && MESSAGES.has(s.kind);
/** P37: The display name of a call id `wid@r/key@g`: the key, with its generation when later than the first. */
function callKey(call: unknown): string {
  const text = String(call), match = /^.*\/(.*)@(\d+)$/.exec(text);
  return match ? (Number(match[2]) > 1 ? `${match[1]}@${match[2]}` : match[1]!) : text;
}

/** P25, P31: Build a workflow snapshot from its journal entries alone. */
/** P36, contracts: The one place that turns a refusal reason into the failed result scripts and status both see. */
export function refusedResult(key: string, reason: unknown): CallResult {
  return { key, gen: 0, status: "failed", ok: false, error: reason === "spawn-budget" ? "spawn budget exceeded" : String(reason), output: "" };
}
function snapshotReducer(wid: string, entries: readonly Entry[]) {
  const created = entries.find(e => e.type === "wf-created");
  const rev = Math.max(1, ...entries.filter(e => e.type === "wf-created" || e.type === "revised").map(e => Number(e.revision) || 1));
  const boundary = entries.findLastIndex(e => e.type === "revised");
  const current = entries.slice(Math.max(0, boundary));
  let terminal = current.findLast(e => e.type === JT.done || (e.type === "resumed" && !e.call));
  const calls = new Map<string, CallSnapshot>();
  const byExec = new Map<string, CallSnapshot>();
  const hibernating = new Map<string, string>(); // callId → exec that decided to hibernate and is not fenced yet
  const resolved = new Set<string>();
  const generations = new Set<string>(), retired = new Set<string>();
  const attention: AttentionItem[] = [];
  // P31: usage per call id, deduplicated by message id; a seal carries the authoritative total.
  const live = new Map<string, Usage>(), sealedUsage = new Map<string, Usage>(), seen = new Set<string>();
  const tools = new Map<string, number>();
  // P7, P27: forward / forward-delivered / forward-retired, by destination call; retirements carry only rid2.
  const sends = new Map<string, CallSend[]>(), byRid2 = new Map<string, CallSend>();
  function apply(batch: readonly Entry[], from = 0) {
    for (let i = from; i < batch.length; i++) {
      const e = batch[i]!;
      if (i >= boundary && (e.type === JT.done || (e.type === "resumed" && !e.call))) terminal = e;
      if (e.type === JT.attentionResolved) resolved.add(`${e.id}@${e.rev}`);
      if (["call", "generation", "refused", "reused"].includes(e.type)) {
        if (boundary >= 0 && e.seq < entries[boundary]!.seq) continue;
        const key = String(e.key), gen = Number(e.gen) || (e.type === "refused" ? 0 : 1);
        const callId = e.type === "reused" ? String(e.from) : `${wid}@${rev}/${key}@${gen}`;
        if (e.type === "generation") generations.add(callId);
        const result = e.type === "refused" ? refusedResult(key, e.reason) :
          e.type === "reused" ? entries.find(s => s.type === JT.sealed && s.call === e.from)?.result as CallResult | undefined : undefined;
        const wanted = (e.spec as { model?: unknown } | undefined)?.model;
        calls.set(callId, { key, gen, callId, pos: Number(e.pos), agent: String((e.spec as { agent?: string } | undefined)?.agent ?? ""),
          // Until a slot is acquired (`selected`), show the model the call asked for, not nothing.
          ...(typeof wanted === "string" && wanted ? { model: wanted } : {}),
          phase: result ? "sealed" : "queued", ...(result ? { result, endedAt: e.ts } : {}),
          ...(e.type === "refused" ? { refused: String(e.reason) } : {}), ...(e.type === "reused" ? { reused: String(e.from) } : {}) });
      } else if (e.type === "retired") { retired.add(String(e.call));
      } else if (e.type === JT.exec) {
        const call = calls.get(String(e.call)); if (!call) continue;
        // An execution waits for a provider slot and memory before it launches; it is running once `selected` says so
        // (otherwise a call still waiting for a slot reads "thinking · 2m").
        call.exec = String(e.exec); call.phase = "queued"; call.startedAt ??= e.ts; call.lastActivity = e.ts; byExec.set(call.exec, call);
        delete call.hibernated; hibernating.delete(call.callId);
      } else if (e.type === "writer-wait" || e.type === "writer-acquired") {
        const call = calls.get(String(e.call)), holder = String(e.holder ?? "");
        if (call && e.type === "writer-wait") call.writerWait = { root: String(e.root), holder: holder.includes("/") ? `${holder.split("@")[0]}/${holder.split("/")[1]!.split("@")[0]}` : holder };
        else if (call) delete call.writerWait;
      } else if (e.type === "hibernated") {
        // The decision to hibernate precedes the fence; the slot is released only once the execution is fenced.
        const call = calls.get(String(e.call)); if (call?.exec && call.exec === e.exec) hibernating.set(call.callId, call.exec);
      } else if (e.type === "answer-bound" || (e.type === "resumed" && e.call)) {
        const call = calls.get(String(e.call)); if (call) { delete call.hibernated; hibernating.delete(call.callId); }
      } else if (e.type === JT.fenced) {
        // A fenced execution without a seal (stop-all, a quit pi, a loss before its continuation) waits to run again.
        const call = byExec.get(String(e.exec)); if (call && call.phase === "running") call.phase = "queued";
        if (call && hibernating.get(call.callId) === e.exec) call.hibernated = true;
      } else if (e.type === "selected") {
        const call = byExec.get(String(e.exec)), m = e.model as { provider?: string; id?: string } | undefined;
        if (call && m) call.model = m.provider ? `${m.provider}/${m.id}` : m.id;
        if (call && call.phase === "queued") call.phase = "running";
      } else if (e.type === "model-used") {
        // Evidence of a switch: the execution answered with another model than it launched with.
        const call = byExec.get(String(e.exec)), m = e.model as { provider?: string; id?: string } | undefined;
        if (call && m) call.model = m.provider ? `${m.provider}/${m.id}` : m.id;
      } else if (e.type === "observation") {
        // Only what the agent did counts as activity; tracker scans and time checkpoints are bookkeeping.
        const call = byExec.get(String(e.exec)); if (call) call.lastActivity = e.ts;
        if (call && e.type === "observation" && (e.event as { type?: string } | undefined)?.type === "tool_execution_start") tools.set(call.callId, (tools.get(call.callId) ?? 0) + 1);
      } else if (e.type === "usage") {
        const id = `${e.call}:${e.id}`, u = e.usage as Usage | undefined;
        if (seen.has(id) || !u) continue;
        seen.add(id);
        const total = live.get(String(e.call)) ?? zero();
        total.input += u.input; total.output += u.output; total.costUsd += u.costUsd; live.set(String(e.call), total);
      } else if (e.type === JT.sealed) {
        const usage = (e.result as CallResult | undefined)?.usage;
        if (usage) sealedUsage.set(String(e.call), usage);
        const call = calls.get(String(e.call)); if (!call) continue;
        call.phase = "sealed"; call.result = e.result as CallResult; call.endedAt = e.ts; delete call.hibernated; delete call.writerWait; hibernating.delete(call.callId);
      } else if (isEntry(e, JT.attention)) {
        const item = e.item;
        attention.push(item);
      } else if (e.type === "forward") {
        const envelope = e.envelope as { kind?: string; body?: { provider?: string; model?: string } } | undefined;
        const send: CallSend = { rid: String(e.rid), kind: String(envelope?.kind ?? ""), state: "pending", at: e.ts,
          ...(envelope?.kind === "model" && envelope.body?.provider ? { model: `${envelope.body.provider}/${envelope.body.model}` } : {}) };
        const list = sends.get(String(e.dest)) ?? []; list.push(send); sends.set(String(e.dest), list);
        // A withdrawn model request no longer stands (the executor ignores it for the next launch as well).
        if (envelope?.kind === "withdraw") for (const rid2 of (envelope.body as { rids?: string[] } | undefined)?.rids ?? []) {
          const target = byRid2.get(`${e.dest}\n${rid2}`); if (target?.kind === "model" && target.state === "pending") target.reason = "withdrawn";
        }
        byRid2.set(`${e.dest}\n${e.rid2}`, send); byRid2.set(String(e.rid2), send);
      } else if (e.type === "forward-delivered" || e.type === "forward-retired") {
        const send = byRid2.get(e.type === "forward-delivered" ? `${e.call}\n${e.rid2}` : String(e.rid2));
        if (!send || send.state !== "pending") continue;
        send.state = e.type === "forward-delivered" ? "delivered" : "retired"; send.at = e.ts;
        if (e.type === "forward-delivered" && e.reason !== undefined) send.reason = String(e.reason);
      }
    }
  }
  apply(entries);
  function finish(): WorkflowSnapshot {
    const done = terminal?.type === JT.done ? terminal : undefined;
    // Finish owns every exposed object; UI decoration and consumers cannot alter reducer history.
    const list = structuredClone([...calls.values()]);
    const openAttention = structuredClone(attention.filter(item => !resolved.has(`${item.id}@${item.rev}`)));
    for (const item of openAttention) {
      if (item.kind === "conflict") {
        const pair = worktreeCalls(item.id);
        for (const c of list) if (pair.includes(c.callId))
          c.sharedWorktree = [...new Set([...(c.sharedWorktree ?? []), ...pair.filter(id => id !== c.callId).map(worktreeLabel)])].sort();
      }
      const call = item.kind === "question" ? list.find(c => item.id.startsWith(`q:${c.callId}:`)) : undefined;
      if (call && (call.phase === "running" || call.phase === "queued")) call.phase = "asking"; // a hibernated asker is fenced
    }
    for (const c of list) if (c.hibernated && c.phase !== "asking") delete c.hibernated;
    const usageOf = (callId: string) => sealedUsage.get(callId) ?? live.get(callId);
    const counts: Record<CallPhase, number> = { queued: 0, running: 0, asking: 0, sealed: 0 };
    for (const c of list) {
      counts[c.phase]++;
      const usage = usageOf(c.callId); if (usage) c.usage = { ...usage };
      const n = tools.get(c.callId); if (n) c.tools = n;
      const forwarded = sends.get(c.callId);
      if (forwarded) {
        c.sends = structuredClone(forwarded); const pending = forwarded.filter(pendingMessage).length; if (pending) c.pending = pending;
        const last = c.phase !== "sealed" && !retired.has(c.callId) ? forwarded.findLast(s => s.kind === "model" && s.reason !== "withdrawn" && s.reason !== "stale-execution") : undefined;
        if (last?.reason !== undefined) c.switchFailed = `${last.model} (${last.reason})`;
        else if (last && last.state !== "retired" && last.model !== c.model?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")) c.switching = last.model;
      }
    }
    const after = done ? list.filter(c => generations.has(c.callId) && c.phase !== "sealed" && !retired.has(c.callId)) : [];
    for (const c of after) c.afterEnd = true;
    const followUps = after.length;
    const usage = zero();
    for (const id of new Set([...live.keys(), ...sealedUsage.keys()])) {
      const u = usageOf(id)!; usage.input += u.input; usage.output += u.output; usage.costUsd += u.costUsd;
    }
    return {
      wid, rev, ...(typeof created?.name === "string" ? { name: created.name } : {}),
      ...(created ? { origin: String(created.origin), cwd: String(created.cwd), startedAt: created.ts } : {}),
      status: done ? done.status as WorkflowSnapshot["status"] : "running",
      ...(done?.error ? { error: String(done.error) } : {}), ...(done && "result" in done ? { result: structuredClone(done.result) } : {}),
      ...(done ? { endedAt: done.ts } : {}),
      ...(followUps ? { followUps } : {}),
      calls: list, counts, attention: openAttention, usage,
    };
  }
  // Only the current revision's reuse looks ahead for a seal (entries before the boundary are skipped).
  return { apply, finish, hasReuse: current.some(e => e.type === "reused") };
}

export function snapshotFromEntries(wid: string, entries: readonly Entry[]): WorkflowSnapshot {
  return snapshotReducer(wid, entries).finish();
}

/** P25: Snapshot one workflow from its durable journal (v12 §4: plus the planned total of its pinned run body). */
// A journal snapshot is immutable and replaced on every append, so its derived workflow snapshot is reused until then:
// re-deriving every historical workflow on each UI refresh dominated pi's main thread.
const FOLDS = 256; // workflows whose fold state is kept; pruned and long-idle ones fall out
const folds = new Map<string, { wid: string; length: number; last?: Entry; reducer: ReturnType<typeof snapshotReducer> }>();
const derived = new WeakMap<readonly Entry[], { wid: string; snapshot: WorkflowSnapshot }>();
export function workflowSnapshot(home: string, wid: string): WorkflowSnapshot {
  const path = journalPath(home, wid), entries = readJournalSnapshot(path), hit = derived.get(entries);
  let wf: WorkflowSnapshot;
  if (hit?.wid === wid) wf = hit.snapshot;
  else {
    const prior = folds.get(path);
    // The journal reader preserves entry identity only when extending the same committed prefix.
    const prefix = prior?.wid === wid && entries.length >= prior.length &&
      (prior.length === 0 || entries[prior.length - 1] === prior.last);
    let reusable = prefix;
    if (reusable) for (let i = prior!.length; i < entries.length; i++) {
      const e = entries[i]!;
      // Revisions change earlier call identities/boundaries. Reuse looks ahead for the first seal.
      if (e.type === "revised" || e.type === "wf-created" || e.type === "reused" ||
          (prior!.reducer.hasReuse && e.type === JT.sealed)) { reusable = false; break; }
    }
    const reducer = reusable ? prior!.reducer : snapshotReducer(wid, entries);
    if (reusable) reducer.apply(entries, prior!.length);
    wf = reducer.finish();
    if (entries.length) {
      folds.delete(path); folds.set(path, { wid, length: entries.length, last: entries.at(-1), reducer }); // least recently folded first
      if (folds.size > FOLDS) folds.delete(folds.keys().next().value!);
      derived.set(entries, { wid, snapshot: wf });
    } else folds.delete(path);
  }
  const planned = plannedTotal(home, wid, wf.rev);
  return planned === undefined ? wf : { ...wf, planned };
}

/** Ops: wids archived by `prune` (orchestrator ledger `pruned{wid}`); they no longer exist for any reader. */
function prunedIds(home: string): Set<string> {
  return ledgerIndex(readJournalSnapshot(orchLedger(home))).pruned;
}

/** What the readers polled by pi's main thread need from the orchestrator ledger, folded once per ledger snapshot
 *  (and extended in place when a live ledger array grows): scanning the whole ledger once per workflow on every
 *  refresh cost pi a steady few percent of its main thread. Indexes are positions in the ledger. */
export interface LedgerIndex {
  /** First `created` entry per wid (the raw `wid` value is the key, compared like `===`). */
  created: Map<unknown, Entry>;
  /** wids archived by `prune`. */
  pruned: Set<string>;
  /** Last drain/undrain without scope, per `wid` and per `origin`. */
  global?: number; byWid: Map<unknown, number>; byOrigin: Map<unknown, number>;
  lastDrain?: number;
}
type Folded = LedgerIndex & { length: number; last?: Entry };
const ledgerIndexes = new WeakMap<readonly Entry[], Folded>();
export function ledgerIndex(ledger: readonly Entry[]): LedgerIndex {
  let ix = ledgerIndexes.get(ledger);
  if (!ix || ix.length > ledger.length || (ix.length && ledger[ix.length - 1] !== ix.last)) {
    ix = { length: 0, created: new Map(), pruned: new Set(), byWid: new Map(), byOrigin: new Map() };
    ledgerIndexes.set(ledger, ix);
  }
  for (let i = ix.length; i < ledger.length; i++) {
    const e = ledger[i]!;
    if (e.type === JT.created) { if (!ix.created.has(e.wid)) ix.created.set(e.wid, e); }
    else if (e.type === "pruned") ix.pruned.add(String(e.wid));
    else if (e.type === "drain" || e.type === "undrain") {
      if (e.type === "drain") ix.lastDrain = i;
      if (e.wid === undefined && e.origin === undefined) ix.global = i;
      if (e.wid !== undefined) ix.byWid.set(e.wid, i);
      if (e.origin !== undefined) ix.byOrigin.set(e.origin, i);
    }
  }
  ix.length = ledger.length; ix.last = ledger[ledger.length - 1];
  return ix;
}

function workflowIds(home: string): string[] {
  let wids: string[] = [];
  try { wids = readdirSync(join(home, "w")).filter(n => !n.startsWith(".")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pruned = prunedIds(home);
  return wids.filter(wid => !pruned.has(wid));
}

/** Drain: the one hold rule. drain/undrain entries apply to every workflow (no scope), one session's (`origin`) or one
 *  workflow (`wid`). A workflow is held when the newest entry that applies to it is a drain recorded after it was created. */
export function holdOf(ledger: readonly Entry[], wid: string, origin?: string): Entry | undefined {
  // The newest applicable entry is the newest of the newest unscoped, the newest for this wid and the newest for its origin.
  const ix = ledgerIndex(ledger);
  const at = Math.max(ix.global ?? -1, ix.byWid.get(wid) ?? -1, origin !== undefined ? ix.byOrigin.get(origin) ?? -1 : -1);
  const last = at >= 0 ? ledger[at] : undefined;
  if (last?.type !== "drain") return undefined;
  const created = ix.created.get(wid);
  return !created || created.seq < last.seq ? last : undefined;
}
/** Drain: the workflows a drain (stop-all, a quit pi) holds until resume, and since when. */
export function heldWorkflows(home: string): { since?: number; held: (wid: string) => boolean } {
  const ledger = readJournalSnapshot(orchLedger(home)), ix = ledgerIndex(ledger);
  const origin = (wid: string) => ix.created.get(wid)?.origin as string | undefined;
  const hold = (wid: string) => holdOf(ledger, wid, origin(wid));
  const since = ix.lastDrain !== undefined ? ledger[ix.lastDrain]!.ts : undefined;
  return { ...(since !== undefined ? { since } : {}), held: wid => hold(wid) !== undefined };
}

/** P25: Snapshot every workflow under DSA_HOME (newest first by wid, which is a ULID); `paused` marks work a drain holds. */
export function allWorkflows(home: string): WorkflowSnapshot[] {
  const { held } = heldWorkflows(home);
  return workflowIds(home).sort().reverse().map(wid => { const wf = workflowSnapshot(home, wid); return isLive(wf) && held(wid) ? { ...wf, paused: true } : wf; });
}

/** P10/P11: Per-workflow script console log written by the orchestrator (bounded, human-readable). */
export function scriptLogPath(home: string, wid: string): string { return join(workflowDir(home, wid), "script.log"); }

/** P31: Human-readable usage total, e.g. "1.2M in / 15.0K out, $0.42". */
export function formatUsage(u: Usage): string {
  const n = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
  return `${n(u.input)} in / ${n(u.output)} out${u.costUsd > 0 ? `, $${u.costUsd.toFixed(u.costUsd < 0.01 ? 4 : 2)}` : ""}`;
}

export interface StatusCall {
  key: string; gen: number; callId: string; phase: CallPhase;
  sharedWorktree?: string[];
  status?: CallResult["status"]; ok?: boolean; model?: string; tools?: number; usage?: Usage;
  /** Messages forwarded to the call whose child receipt has not been observed yet (P7). */
  pending?: number;
  /** The latest model requested while the call does not answer with it yet (running: at its next provider request;
   *  queued or hibernated: when it launches). */
  switching?: string;
  /** The child refused the latest model request: "provider/id (reason)"; `model` stays in use. */
  switchFailed?: string;
  /** Last non-empty output line (clipped); the full output is in `status wid=<wid>`. */
  lastLine?: string; error?: string;
  /** Asking and hibernated: no provider slot is held while it waits (P28). */
  hibernated?: true;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
  /** Resource leases (`pi-durable-subagents hold`): "holds lease machine" / "waiting for lease machine 3m". */
  lease?: string;
}
export interface StatusWorkflow {
  wid: string; name?: string; origin?: string; status: WorkflowSnapshot["status"]; rev: number;
  startedAt?: number; endedAt?: number; error?: string; usage: Usage; counts: Record<CallPhase, number>;
  /** v12 §4: planned total (tasks/chain length) when known; absent for scripts. */
  planned?: number;
  /** v12 §4: keys of the current revision whose latest generation is sealed (the `done` of done/total). */
  done: number;
  calls: StatusCall[]; attention: Pick<AttentionItem, "id" | "rev" | "kind" | "text" | "call" | "qid">[];
  /** Drain: held by stop-all/drain or a quit pi; `resume` continues it. */
  paused?: boolean;
  /** Follow-ups still open on this finished workflow. */
  followUps?: number;
}
export interface StatusView {
  workflows: StatusWorkflow[];
  /** Finished workflows older than the newest `keep` finished ones, collapsed (T10). */
  olderFinished?: number;
  hint?: string;
  /** Drain: set while the orchestrator is drained by stop-all/drain; nothing new starts until resume. */
  paused?: string;
  /** Provider slots held / limit, the settings in effect and a rejected config.json change (see slotsView). */
  slots?: string[]; config?: string; configRejected?: string; exhausted?: string[];
  /** Resource leases held or waited for, one line per resource (see leaseLines). */
  leases?: string[];
  /** The orchestrator version running, and a note when it is not the one this process loaded (see orchestratorView). */
  orchestrator?: string; versionNote?: string;
}
export type StatusDetail = WorkflowSnapshot & { scriptLog?: string };

/** P25, T10: Compact one workflow snapshot: per-call one-line facts, usage, open attention; no outputs or entries. */
export function compactWorkflow(wf: WorkflowSnapshot, leases?: Map<string, string>): StatusWorkflow {
  const progress = progressOf(wf); // v12 §4
  return {
    wid: wf.wid, ...(wf.name ? { name: wf.name } : {}), ...(wf.origin ? { origin: wf.origin } : {}), status: wf.status, rev: wf.rev,
    ...(wf.startedAt !== undefined ? { startedAt: wf.startedAt } : {}), ...(wf.endedAt !== undefined ? { endedAt: wf.endedAt } : {}),
    ...(wf.error ? { error: clip(wf.error, 500) } : {}), usage: wf.usage ?? zero(), counts: wf.counts,
    ...(wf.planned !== undefined ? { planned: wf.planned } : {}), done: progress.done,
    calls: wf.calls.map(c => {
      const r = c.result, last = r?.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
      return { key: c.key, gen: c.gen, callId: c.callId, phase: c.phase, ...(r ? { status: r.status, ok: r.ok } : {}),
        ...(c.sharedWorktree ? { sharedWorktree: c.sharedWorktree } : {}),
        ...(c.model ? { model: c.model } : {}), ...(c.tools ? { tools: c.tools } : {}), ...(c.pending ? { pending: c.pending } : {}), ...(c.switching ? { switching: c.switching } : {}), ...(c.switchFailed ? { switchFailed: c.switchFailed } : {}), ...(nonzero(c.usage) ? { usage: c.usage } : {}),
        ...(last ? { lastLine: clip(last, 200) } : {}), ...(r?.error ? { error: clip(r.error, 300) } : {}), ...(c.hibernated ? { hibernated: true as const } : {}),
        ...(c.writerWait && !r ? { writerWait: c.writerWait } : {}), ...(!r && leases?.get(c.callId) ? { lease: leases.get(c.callId) } : {}) };
    }),
    attention: wf.attention.map(a => ({ id: a.id, rev: a.rev, kind: a.kind, text: clip(a.text, 300), ...(a.call ? { call: a.call } : {}), ...(a.qid ? { qid: a.qid } : {}) })),
    ...(wf.paused ? { paused: true } : {}), ...(wf.followUps ? { followUps: wf.followUps } : {}),
  };
}

function origins(home: string): Map<string, string | undefined> {
  const ids = new Map<string, string | undefined>();
  const pruned = prunedIds(home);
  for (const e of readJournalSnapshot(orchLedger(home))) if (e.type === JT.created && !pruned.has(String(e.wid))) ids.set(String(e.wid), e.origin as string | undefined);
  for (const wid of workflowIds(home)) if (!ids.has(wid)) ids.set(wid, undefined);
  return ids;
}

/** Every workflow with its origin and hold, own session first, then newest first. */
function snapshots(home: string, origin?: string): { all: WorkflowSnapshot[]; since?: number } {
  const own = (w: WorkflowSnapshot) => Number(!!origin && w.origin === origin);
  const { since, held } = heldWorkflows(home);
  const all = [...origins(home)].sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0).map(([wid, origin]) => {
    const wf = workflowSnapshot(home, wid), withOrigin = wf.origin === undefined && origin !== undefined ? { ...wf, origin } : wf;
    return isLive(withOrigin) && held(wid) ? { ...withOrigin, paused: true } : withOrigin;
  }).sort((a, b) => own(b) - own(a));
  return { all, ...(since !== undefined ? { since } : {}) };
}

/** P25, T10: Compact status of all workflows: own session first, then newest first; finished ones beyond the first `keep` collapse into a count. */
export function statusView(home: string, options: { origin?: string; keep?: number } = {}): StatusView {
  const keep = options.keep ?? 10;
  const { all, since } = snapshots(home, options.origin), leases = leaseState(home), byCall = leaseCalls(leases);
  let finished = 0;
  const shown = all.filter(w => !settled(w) || ++finished <= keep);
  const hidden = all.length - shown.length;
  const paused = all.filter(w => w.paused).length;
  return { workflows: shown.map(w => compactWorkflow(w, byCall)), ...(hidden ? { olderFinished: hidden, hint: "status wid=<wid> shows any workflow in detail" } : {}),
    ...(paused ? { paused: `${paused} workflow${paused > 1 ? "s" : ""} paused (stop-all, drain or a quit pi) since ${new Date(since!).toISOString()}; resume continues them (new runs are not affected)` } : {}),
    ...slotsView(home), ...(leases.length ? { leases: leaseLines(leases) } : {}) };
}

const FINAL = ["done", "failed", "stopped"];
/** Finished with nothing left running (a follow-up on a finished workflow is live work). */
const settled = (w: WorkflowSnapshot) => FINAL.includes(w.status) && !w.followUps;
const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const tokens = (u?: Usage) => { const n = u ? u.input + u.output : 0; return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n); };
/** The latest generation of every key, in first-call order. */
const latestCalls = (wf: WorkflowSnapshot) => [...new Map(wf.calls.map(c => [c.key, c] as const)).values()];

export interface BriefCall {
  key: string; agent: string; phase: CallPhase; model?: string;
  sharedWorktree?: string[];
  /** Since the call started, and since its last activity (shown when quiet for a minute or more). */
  for?: string; quiet?: string;
  /** Input + output tokens so far: a running call at 0 has done nothing yet. */
  tokens?: string; status?: CallResult["status"]; error?: string;
  /** Asking and hibernated: it holds no provider slot while it waits (P28). */
  hibernated?: true;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
  /** Resource leases (`pi-durable-subagents hold`): "holds lease machine" / "waiting for lease machine 3m". */
  lease?: string;
  /** `model` is the model in use; `switching` one requested and not answering yet; `switchFailed` a refused request. */
  switching?: string; switchFailed?: string;
}
export interface BriefWorkflow {
  wid: string; name?: string; status: WorkflowSnapshot["status"]; paused?: true;
  /** Follow-ups still open on this finished workflow (its status stays final). */
  followUps?: number;
  /** "done/total" of the current revision ("+" while a script may still add calls). */
  progress: string; tokens: string;
  /** Only the calls that need a look: not finished, or finished not ok. */
  calls: BriefCall[];
  /** Open questions (answer with kind "answer" to "<wid>/<key>") and alerts (stall, unknown outcome, budget). */
  asking?: { to: string; qid?: string; hibernated?: true; question: string }[];
  alerts?: string[];
}
export interface StatusBrief {
  active: BriefWorkflow[];
  /** Running workflows of other pi sessions, one line each. */
  otherSessions?: string[];
  /** The newest finished workflows, one line each. */
  finished: string[];
  olderFinished?: number;
  paused?: string;
  /** Provider slots held / limit, e.g. "s2a 3/4" or "mccodex 2 (no limit)": configured providers and any held ones. */
  slots?: string[];
  /** The orchestrator settings in effect: "<hash> since <age>" (config.json is applied when it changes). */
  config?: string;
  /** The latest change of config.json that was not applied, while the earlier settings stay in effect. */
  configRejected?: string;
  /** Providers whose usage window is used up: avoided until the next try, then probed by one call (see providers.ts). */
  exhausted?: string[];
  /** Resource leases held or waited for (`pi-durable-subagents hold`), one line per resource. */
  leases?: string[];
  /** The orchestrator version running, and a note when it is not the one this pi loaded. */
  orchestrator?: string; versionNote?: string;
  hint: string;
}

/** Provider slots from the orchestrator ledger: holders per provider (hold/release{pool,slot,exec}) and the limits of
 *  the settings in effect (the latest config{hash,config}); config-rejected after it is reported too. */
// One fold per orchestrator ledger, extended as it grows (ledger.ts; the executor folds the same entries the same way).
const ledgerStates = new Map<string, LedgerState>();
/** The orchestrator running now (its last `orchestrator` record, without an exit, whose process lives), and a note when
 *  its version is not the one this process loaded: running work stays on the version it started with. */
export function orchestratorView(state: LedgerState, loaded = packageVersion(), now = Date.now()): { orchestrator?: string; versionNote?: string } {
  const o = state.orchestrator;
  if (!o || o.exited || !processAlive(o.pid, o.start)) return {};
  const r = o.forceRestart, note = r && now - r.ts < 24 * 60 * 60_000
    ? `; restarted by force ${age(now - r.ts)} ago by ${initiatorSummary(r.initiator, r.from)}: ${restartLine(r.reason ?? "no reason recorded")}` : "";
  return { orchestrator: `${o.version} (pid ${o.pid})${note}`, ...(o.version === loaded ? {} : { versionNote: versionNote(o.version, loaded) }) };
}
/** Whether the recorded orchestrator still runs. On Linux its start time also tells it from a later process given the
 *  same pid after a crash (elsewhere the pid alone is checked). */
export function processAlive(pid: number, start?: string): boolean {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (!start || process.platform !== "linux") return true;
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === start; }
  catch { return false; }
}
const parts = (v: string) => v.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
function newer(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
export function versionNote(running: string, loaded: string): string {
  return newer(running, loaded)
    ? `this pi session loaded durable-subagents ${loaded}, older than the running orchestrator ${running}; start a new pi session to use ${running}`
    : `the orchestrator runs durable-subagents ${running}, this pi loaded ${loaded}: running work stays on ${running}. ` +
      `It exits about 10 s after all work ends and starts again on the installed version. To switch sooner: ` +
      `restart (\`pi-durable-subagents restart\` or the subagents tool's restart action) — refused while an execution runs, ` +
      `calls waiting for an answer or a slot do not block it; force with the refusal's token, a reason and explicit user approval fences running executions, which resume on the new version`;
}

/** orchestratorView of the home's orchestrator ledger. */
export function runningOrchestrator(home: string): { orchestrator?: string; versionNote?: string } {
  const path = orchLedger(home), state = foldLedger(ledgerStates.get(path) ?? emptyLedger(), readJournalSnapshot(path));
  ledgerStates.set(path, state);
  return orchestratorView(state);
}

/** One `exhausted` line of the status views (the `provider-exhausted` wait uses it as its detail). */
export function exhaustedLine(provider: string, x: Exhaustion, now: number): string {
  return `${provider} exhausted since ${age(now - x.since)} ago (${clip(x.error, 80)}), ` +
    (x.probe ? `probing with ${x.probe.split("#")[0]}` : x.nextTry > now ? `next try in ${age(x.nextTry - now)}` : "next call probes it");
}
/** One `slots` line of the status views: "<provider> <held>/<limit>" or "<provider> <held> (no limit)". */
export function slotLine(provider: string, held: number, limit?: number): string {
  return typeof limit === "number" ? `${provider} ${held}/${limit}` : `${provider} ${held} (no limit)`;
}
export function slotsView(home: string, now = Date.now()): Pick<StatusBrief, "slots" | "config" | "configRejected" | "exhausted" | "orchestrator" | "versionNote"> {
  const path = orchLedger(home), state = foldLedger(ledgerStates.get(path) ?? emptyLedger(), readJournalSnapshot(path));
  ledgerStates.set(path, state);
  const { held, config, rejected } = state, used = state.exhausted;
  const exhausted = [...used].sort(([a], [b]) => a.localeCompare(b)).map(([p, x]) => exhaustedLine(p, x, now));
  const limits: Record<string, { slots?: number }> = config?.settings.providers ?? {};
  const holders = new Map<string, number>();
  for (const e of held.values()) if (e.pool !== "memory") holders.set(e.pool, (holders.get(e.pool) ?? 0) + 1);
  const names = [...new Set([...Object.keys(limits), ...holders.keys()])].sort();
  const slots = names.map(p => slotLine(p, holders.get(p) ?? 0, limits[p]?.slots));
  return { ...orchestratorView(state, packageVersion(), now), ...(slots.length ? { slots } : {}), ...(config ? { config: `${config.hash} since ${age(now - config.ts)} ago` } : {}),
    ...(exhausted.length ? { exhausted } : {}),
    ...(rejected ? { configRejected: `${clip(rejected.error, 200)} (${age(now - rejected.ts)} ago); ${config ? config.hash : "the start settings"} stay in effect` } : {}) };
}

/** Tool status without a wid: what runs, what waits for an answer and what failed, with finished workflows one line each.
 *  The full view (every call's last line and usage) ran to tens of thousands of tokens on a busy home. */
export function statusBrief(home: string, options: { origin?: string; keep?: number; now?: number } = {}): StatusBrief {
  const keep = options.keep ?? 5, now = options.now ?? Date.now(), origin = options.origin;
  const { all } = snapshots(home, origin), leases = leaseState(home), byCall = leaseCalls(leases, now);
  const mine = (w: WorkflowSnapshot) => !origin || w.origin === origin;
  const line = (w: WorkflowSnapshot) => {
    const p = progressOf(w), notOk = latestCalls(w).filter(c => c.result && !c.result.ok).length;
    return [w.wid, w.name, `${w.paused ? "paused" : w.followUps ? `${w.status}, follow-up running` : w.status}`, `${p.done}/${p.total}${p.plus ? "+" : ""} done`, notOk ? `${notOk} not ok` : "",
      w.endedAt !== undefined ? `ended ${age(now - w.endedAt)} ago` : w.startedAt !== undefined ? `started ${age(now - w.startedAt)} ago` : ""].filter(Boolean).join(" · ");
  };
  const brief = (w: WorkflowSnapshot): BriefWorkflow => {
    const p = progressOf(w), open = w.attention.filter(a => a.kind !== "finished");
    const calls = latestCalls(w).filter(c => c.phase !== "sealed" || (c.result && !c.result.ok)).map((c): BriefCall => {
      const live = c.phase !== "sealed", quiet = c.lastActivity !== undefined ? now - c.lastActivity : undefined;
      return { key: c.key, agent: c.agent, phase: c.phase, ...(c.model ? { model: c.model } : {}),
        ...(c.sharedWorktree ? { sharedWorktree: c.sharedWorktree } : {}),
        ...(live && c.startedAt !== undefined ? { for: age(now - c.startedAt) } : {}),
        ...(live && c.phase !== "asking" && quiet !== undefined && quiet >= 60_000 ? { quiet: age(quiet) } : {}),
        ...(live && c.startedAt !== undefined ? { tokens: tokens(c.usage) } : {}),
        ...(c.result ? { status: c.result.status, ...(c.result.error ? { error: clip(c.result.error, 200) } : {}) } : {}),
        ...(c.hibernated ? { hibernated: true as const } : {}), ...(live && c.writerWait ? { writerWait: c.writerWait } : {}),
        ...(live && byCall.get(c.callId) ? { lease: byCall.get(c.callId) } : {}),
        ...(live && c.switching ? { switching: c.switching } : {}), ...(live && c.switchFailed ? { switchFailed: c.switchFailed } : {}) };
    });
    const asking = open.filter(a => a.kind === "question" && a.call).map(a => ({ to: `${w.wid}/${callKey(a.call)}`, ...(a.qid ? { qid: a.qid } : {}),
      ...(w.calls.some(c => c.callId === a.call && c.hibernated) ? { hibernated: true as const } : {}), question: clip(a.text, 300) }));
    const alerts = open.filter(a => a.kind !== "question").map(a => `${a.kind}${a.call ? ` ${w.wid}/${callKey(a.call)}` : ""}: ${clip(a.text, 200)}`);
    return { wid: w.wid, ...(w.name ? { name: w.name } : {}), status: w.status, ...(w.paused ? { paused: true as const } : {}), ...(w.followUps ? { followUps: w.followUps } : {}),
      progress: `${p.done}/${p.total}${p.plus ? "+" : ""}`, tokens: tokens(w.usage), calls,
      ...(asking.length ? { asking } : {}), ...(alerts.length ? { alerts } : {}) };
  };
  const active = all.filter(w => !settled(w));
  const finished = all.filter(w => settled(w) && mine(w));
  const others = active.filter(w => !mine(w));
  const heldMine = active.filter(w => mine(w) && w.paused).length, heldOthers = others.filter(w => w.paused);
  const paused = [heldMine ? `${heldMine} workflow${heldMine > 1 ? "s" : ""} of this session ${heldMine > 1 ? "are" : "is"} paused (stop-all, drain or a quit pi); resume continues ${heldMine > 1 ? "them" : "it"}` : "",
    heldOthers.length ? `${heldOthers.length} workflow${heldOthers.length > 1 ? "s" : ""} of other sessions paused (${heldOthers.slice(0, 8).map(w => w.wid).join(", ")}); resume wid=<wid> continues one` : ""].filter(Boolean).join("; ");
  return {
    active: active.filter(mine).map(brief), ...(others.length ? { otherSessions: others.slice(0, 10).map(line) } : {}),
    finished: finished.slice(0, keep).map(line), ...(finished.length > keep ? { olderFinished: finished.length - keep } : {}),
    ...(paused ? { paused } : {}), ...slotsView(home, now), ...(leases.length ? { leases: leaseLines(leases, now) } : {}),
    hint: "status wid=<wid> shows one workflow (outputs clipped); add key=<key> for one call's full result, or full:true for everything",
  };
}

/** Running workflows of other sessions that a pause holds, as "wid" or "wid (name)": a session's own resume skips them. */
export function pausedElsewhere(home: string, origin: string): string[] {
  return snapshots(home, origin).all.filter(w => w.paused && w.origin !== origin && !settled(w)).map(w => w.name ? `${w.wid} (${w.name})` : w.wid);
}
/** "<rid>" or "<rid>/<rest>" of a run request that created a workflow → the same address with its wid; else unchanged.
 *  A run replies {submitted:{rid}} when its workflow is not created within 10 s, so the rid is all the caller has. */
export function widOfRid(ledger: readonly Entry[], value: string): string {
  const cut = value.indexOf("/"), head = cut < 0 ? value : value.slice(0, cut);
  const created = head ? ledger.find(e => e.type === JT.created && e.rid === head) : undefined;
  return created ? `${String(created.wid)}${value.slice(head.length)}` : value;
}

export type StatusCallDetail = Omit<CallSnapshot, "sends"> & { wid: string; sends?: CallSend[] };
export type StatusCompactDetail = Omit<StatusWorkflow, "calls"> & { cwd?: string; scriptLog?: string; result?: unknown;
  calls: (StatusCall & { agent: string; output?: string })[]; hint: string };
const OUTPUT = 600;
/** Tool status with a wid: one workflow with each call's output clipped (the full detail repeated every output twice and
 *  reached ~100K characters); `key` gives one call in full. */
export function statusCompactDetail(home: string, wid: string): StatusCompactDetail {
  const detail = statusDetail(home, wid), compact = compactWorkflow(detail);
  const byId = new Map(detail.calls.map(c => [c.callId, c]));
  const calls = compact.calls.map(({ lastLine: _l, ...c }) => {
    const full = byId.get(c.callId)!, output = full.result?.output?.trim();
    return { ...c, agent: full.agent, ...(output ? { output: output.length > OUTPUT ? `${output.slice(0, OUTPUT)}… [${output.length - OUTPUT} more chars: status wid key=${c.key}]` : output } : {}) };
  });
  let result: unknown;
  if (detail.result !== undefined) {
    const json = JSON.stringify(detail.result) ?? "";
    result = json.length <= 2000 ? detail.result : `${json.slice(0, 2000)}… [${json.length - 2000} more chars: status wid full:true]`;
  }
  return { ...compact, ...(detail.cwd ? { cwd: detail.cwd } : {}), ...(detail.scriptLog ? { scriptLog: detail.scriptLog } : {}),
    ...(result !== undefined ? { result } : {}), calls, hint: "key=<key> gives one call's full result; full:true gives everything" };
}
/** Tool status with a wid and key: that call's latest generation in full (result, usage, sends). */
export function statusCallDetail(home: string, wid: string, key: string): StatusCallDetail {
  const detail = statusDetail(home, wid);
  const call = detail.calls.findLast(c => c.key === key || c.callId === key || `${c.key}@${c.gen}` === key);
  if (!call) throw new Error(`No call "${key}" in ${wid}; calls: ${[...new Set(detail.calls.map(c => c.key))].join(", ")}`);
  return { wid, ...call };
}

/** P25, T10: One workflow in full detail (results, outputs, script log path) but without raw journal entries. */
export function statusDetail(home: string, wid: string): StatusDetail {
  const origin = origins(home);
  if (!origin.has(wid)) throw new Error(prunedIds(home).has(wid) ? `Workflow ${wid} was pruned` : `Unknown workflow: ${wid}`);
  const wf = workflowSnapshot(home, wid), log = scriptLogPath(home, wid);
  return { ...wf, ...(wf.origin === undefined && origin.get(wid) !== undefined ? { origin: origin.get(wid) } : {}), ...(existsSync(log) ? { scriptLog: log } : {}) };
}

export interface TimelineEvent { seq: number; ts: number; event: string; [field: string]: unknown }
/** P25, T10: Project a workflow journal into meaningful events (no observations, time or tracking). */
export function eventsFromEntries(entries: readonly Entry[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const forwards = new Map<string, Entry>();
  const add = (e: Entry, event: string, fields: Record<string, unknown>) => {
    out.push({ seq: e.seq, ts: e.ts, event, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  };
  for (const e of entries) {
    const spec = e.spec as { agent?: string } | undefined;
    switch (e.type) {
      case "wf-created": add(e, "created", { name: e.name, origin: e.origin, cwd: e.cwd }); break;
      case "revised": add(e, "revised", { revision: e.revision, rid: e.rid }); break;
      case "ev": add(e, "script-start", { ev: e.n }); break;
      case "call": add(e, "call", { key: e.key, gen: e.gen, agent: spec?.agent }); break;
      case "refused": add(e, "refused", { key: e.key, reason: e.reason }); break;
      case "reused": add(e, "reused", { key: e.key, gen: e.gen, from: e.from }); break;
      case "generation": add(e, "generation", { key: e.key, gen: e.gen, kind: (e.opening as { kind?: string } | undefined)?.kind, rid: e.rid }); break;
      case JT.exec: add(e, "exec", { call: e.call, exec: e.exec }); break;
      case "selected": { const m = e.model as { provider?: string; id?: string } | undefined; add(e, "model", { exec: e.exec, model: m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : undefined }); break; }
      case "loss": add(e, "loss", { exec: e.exec }); break;
      case "stop-intent": add(e, "stop", { call: e.call }); break;
      case "timeout-intent": add(e, "timeout", { call: e.call, exec: e.exec }); break;
      case "hibernated": add(e, "hibernated", { call: e.call, qid: e.qid }); break;
      case "forward": {
        forwards.set(String(e.rid2), e);
        add(e, "forward", { rid: e.rid, kind: (e.envelope as { kind?: string } | undefined)?.kind, dest: e.dest }); break;
      }
      case "forward-delivered": case "forward-retired": {
        const f = forwards.get(String(e.rid2)), call = e.call ?? f?.dest;
        add(e, e.type === "forward-delivered" ? "delivered" : "retired", { kind: (f?.envelope as { kind?: string } | undefined)?.kind ?? "request",
          key: call === undefined ? undefined : callKey(call), rid: e.rid, reason: e.type === "forward-delivered" ? e.reason : undefined });
        break;
      }
      case JT.sealed: {
        const r = e.result as CallResult | undefined;
        add(e, "sealed", { call: e.call, status: r?.status, ok: r?.ok, usage: nonzero(r?.usage) ? r?.usage : undefined, error: r?.error ? clip(r.error, 300) : undefined });
        break;
      }
      case JT.attention: { const a = (e as EntryOf<"attention">).item; add(e, "attention", { kind: a.kind, id: a.id, rev: a.rev, text: clip(a.text, 300) }); break; }
      case JT.attentionResolved: add(e, "attention-resolved", { id: e.id, rev: e.rev, resolution: e.resolution }); break;
      case "resumed": add(e, "resumed", { rid: e.rid, call: e.call }); break;
      case JT.done: add(e, "done", { status: e.status, error: e.error ? clip(String(e.error), 500) : undefined }); break;
    }
  }
  return out;
}

/** P25: One human-readable timeline line. */
export function renderEvent(e: TimelineEvent): string {
  const { seq, ts, event, usage, ...rest } = e, fields: string[] = [];
  // P7, P27: delivery outcomes read as one sentence, e.g. "steer delivered to b" / "steer retired (call ended first)".
  if (event === "delivered" || event === "retired") {
    const { kind, key, reason } = rest; delete rest.kind; delete rest.reason;
    if (event === "delivered") delete rest.key;
    fields.push(event === "delivered" ? `${kind} delivered to ${key ?? "?"}${reason ? ` (rejected: ${reason})` : ""}` : `${kind} retired (call ended first)`);
  }
  fields.push(...Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`));
  if (usage) fields.push(`usage=${JSON.stringify(formatUsage(usage as Usage))}`);
  return `${new Date(ts).toISOString()} #${seq} ${event.padEnd(10)} ${fields.join(" ")}`.trimEnd();
}
