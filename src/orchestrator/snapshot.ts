// Read-only status snapshots (P25: `status` is always a fresh snapshot). Pure readers of committed journals:
// never depend on orchestrator memory, so the UI, the CLI and the main agent see the same durable state.
import { initiatorSummary, restartLine } from "./restart.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FANOUT_BODIES } from "../compat/fanout.ts";
import { crc32, forgetJournalSnapshot, forgetJournalSnapshotsIf, journalAppends, readJournalRecord, readJournalSnapshot, readJournalUncached, type JournalRecord } from "../kernel/journal.ts";
import { readCache, writeCache } from "../kernel/cache.ts";
import { digestDir, journalPath, pinnedDir, workflowDir } from "../paths.ts";
import { JT, attentionEntries, isEntry, type AttentionItem, type CallResult, type Entry, type EntryOf } from "../types.ts";
import { parseModel, resolveModel } from "../compat/model.ts";
import { type LedgerState } from "./ledger.ts";
import { awaitingRuns, readerHold, readerLedger, readerLedgerIdentity, type AwaitingRun, type ReaderLedger } from "./reader-ledger.ts";
import type { Exhaustion } from "./providers.ts";
import { packageVersion } from "../version.ts";
import { worktreeCalls, worktreeLabel } from "./executor/worktree.ts";
import { leaseCalls, leaseLines, leaseState } from "../platform/lease.ts";
import { labelsOf } from "../events/derive.ts";
import { PENDING_NOTE, generationRids, UNDELIVERED_FOLLOW_UP } from "./notes.ts";
import { readStats, type OrchestratorStats } from "./stats.ts";

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
  /** Question revision addressed by an answer forward. */
  question?: { qid: string; rev: number };
}
/** Durable pending-answer evidence; timestamps stay fresh even when an unchanged snapshot is cached. */
export type AnswerForwarded = { rid: string; qid: string; rev: number; at: number };
export function answerForwardedNote(c: { answerForwarded?: AnswerForwarded }, now = Date.now()): string {
  const answer = c.answerForwarded;
  return answer && now - answer.at >= 30_000 ? `answer forwarded ${age(now - answer.at)} ago, not delivered` : "";
}
export interface ModelStatus {
  selectedModel?: string;
  usedModel?: string;
  virtualModel?: boolean;
  routedModel?: string;
  modelMismatch?: { used: string; selected: string };
  modelUnavailable?: string;
  poolWait?: { since: number; model: string; pool?: string; free: string[] };
  spill?: { from: string; to: string; waitedMs: number };
}
const modelName = (m: unknown): string => { const v = m as { provider?: string; id: string }; return v.provider ? `${v.provider}/${v.id}` : v.id; };
const modelStatus = (c: ModelStatus): ModelStatus => Object.fromEntries(Object.entries(c).filter(([key]) =>
  ["routedModel", "modelMismatch", "modelUnavailable", "poolWait", "spill"].includes(key)));
/** Scheduling and model identity facts shared by detailed and compact text status. */
export function modelStatusText(c: ModelStatus, now = Date.now()): string {
  const w = c.poolWait, s = c.spill, m = c.modelMismatch;
  return (w ? ` (queued ${age(now - w.since)} on ${w.model.split("/")[0]} (full)${w.free.length ? `; pool has free slots: ${w.free.join(", ")}` : ""})` : "") +
    (s ? ` (spilled after ${age(s.waitedMs)}: ${s.from.split("/")[0]} full -> ${s.to})` : "") +
    (c.routedModel ? ` (routed ${c.routedModel})` : "") +
    (m ? ` (used ${m.used}, selected ${m.selected})` : "") + (c.modelUnavailable ? ` (model-unavailable: ${c.modelUnavailable})` : "");
}
/** A command call's command as one line: an argv array joined with spaces (an argument that needs it single-quoted as
 *  for sh), a string as it is. */
export function commandText(command: unknown): string {
  if (Array.isArray(command)) return command.map(a => { const s = String(a); return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`; }).join(" ");
  return String(command ?? "");
}
/** R8: The pinned refusal of a send to a command call (the engine gives the same reason). */
export const commandSendRefusal = (kind: string) => `command call: ${kind} is not supported (stop it, or start a new call)`;
/** R8, F5: Whether a send address names a command call, matched whole as the engine's findCall does, among the
 *  current revision's calls: `<wid>/<key>`, `<wid>@<rev>/<key>@<gen>`, or a bare wid of a workflow with one key. A key
 *  may contain `@` and digits: nothing is stripped. Read-only; false for anything it cannot resolve. */
export function isCommandTarget(home: string, to: unknown): boolean {
  if (typeof to !== "string" || !to) return false;
  const wid = to.split(/[@/]/, 1)[0]!; // a wid has neither '@' nor '/'
  if (!wid || !existsSync(journalPath(home, wid))) return false;
  let entries: readonly Entry[];
  try { entries = readJournalSnapshot(journalPath(home, wid)); } catch { return false; }
  const rev = Math.max(1, ...entries.filter(e => e.type === "wf-created" || e.type === "revised").map(e => Number(e.revision) || 1));
  const start = entries.findLastIndex(e => e.type === "revised");
  const calls = (start < 0 ? entries : entries.slice(start)).filter(e => e.type === "call" || e.type === "generation");
  const keys = new Set(calls.map(e => String(e.key)));
  const named = calls.findLast(e => to === `${wid}/${e.key}` || to === `${wid}@${rev}/${e.key}@${e.gen}` || (to === wid && keys.size === 1));
  if (!named) return false;
  return (calls.findLast(e => e.key === named.key)!.spec as { command?: unknown } | undefined)?.command !== undefined;
}
/** A command clipped to one display line of at most `n` characters ("command: <clipped>" in status and the UI). */
export function commandLine(command: string, n = 80): string {
  return clip(command.replace(/\s+/g, " ").trim(), n);
}
/** A command call's facts while it runs or after it ended, from its `command-intent`/`command-started` records. */
export interface CommandFacts {
  /** The attempt (1, or 2 for the single rerun) and its id `command:<callId>#<n>`. */
  attempt?: number; id?: string;
  /** The process started for the attempt (absent between the intent and the start). */
  pid?: number;
  /** `<attempt dir>/output.log`: stdout and stderr, interleaved. */
  log?: string;
}
export interface CallSnapshot extends ModelStatus {
  key: string; gen: number; callId: string; agent: string; phase: CallPhase;
  /** A command call (no agent or model): its command as one line (commandText), and its process facts. A running command
   *  call is `running` from its intent; `startedAt` is the start of its latest attempt (`command-started`). */
  command?: string; commandRun?: CommandFacts;
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
  /** Hibernated: its execution is fenced and holds no provider slot, including while its answered call queues. */
  hibernated?: true;
  /** Bound question id, until the next execution starts running. */
  answered?: string;
  /** An answer to an open question was forwarded but its child receipt is not confirmed yet. */
  answerForwarded?: AnswerForwarded;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
  /** Notes (send kind "notify") recorded for this call while it was not running; its next follow-up carries them. */
  notesPending?: number;
  /** Why a queued call does not start, when the orchestrator ledger says so (see queueWait); readers add it. */
  queuedFor?: QueueWait;
  awaiting?: AwaitingRun[];
  endedAtSeal?: { pid: number; command: string }[];
  endedAtSealMore?: number;
}
/** Why a queued call waits, most specific first: the orchestrator is still recovering (`since` its start), the call's
 *  every provider is used up, it waits for its worktree's writer lock, or every provider it can start on is full. */
export interface QueueWait { reason: "starting" | "provider-exhausted" | "writer-lock" | "slot"; detail: string; since?: number }
export interface WorkflowSnapshot {
  wid: string; rev: number; name?: string; origin?: string; cwd?: string;
  /** The run's result; follow-ups leave a final status unchanged. */
  status: "running" | "done" | "failed" | "parked" | "stopped";
  /** Work is still going in a latest-generation call (a follow-up when the run has finished). */
  active?: true;
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
  /** The run's labels (from its run request in the orchestrator ledger), when it has any. */
  labels?: Record<string, string>;
  /** The pi session that shows the run as its own besides its origin (RunBody.session), when the run named one. */
  session?: string;
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

// v12 §4: the exact bodies compileFanout emits (or emitted) after the `const steps = [...];` line, so only true fanouts count as planned.
const fanoutBodies = FANOUT_BODIES;
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
  const scripts = pathsOf(home, wid).scripts;
  const path = scripts[rev] ??= join(pinnedDir(home, wid), rev === 1 ? "script.js" : join(`r${rev}`, "script.js"));
  if (!plannedByPath.has(path)) {
    try { plannedByPath.set(path, plannedFromScript(readFileSync(path, "utf8"))); } catch { plannedByPath.set(path, undefined); }
  }
  return plannedByPath.get(path);
}

const zero = (): Usage => ({ input: 0, output: 0, costUsd: 0 });
const nonzero = (u?: Usage) => !!u && (u.input > 0 || u.output > 0 || u.costUsd > 0);
const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n)}…` : text;
const MESSAGES = new Set(["steer", "notify", "follow-up", "answer", "continue", "task"]);
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
  const byCommand = new Map<string, CallSnapshot>(); // command attempt id -> its call
  const hibernating = new Map<string, string>(); // callId → exec that decided to hibernate and is not fenced yet
  const fenced = new Set<string>();
  const resolved = new Set<string>();
  const generations = new Set<string>(), retired = new Set<string>();
  const attention: AttentionItem[] = [];
  // P31: usage per call id, deduplicated by message id; a seal carries the authoritative total.
  const live = new Map<string, Usage>(), sealedUsage = new Map<string, Usage>(), seen = new Set<string>();
  const tools = new Map<string, number>();
  const endedAtSeal = new Map<string, { procs: { pid: number; command: string }[]; more: number }>();
  // P7, P27: forward / forward-delivered / forward-retired, by destination call; retirements carry only rid2.
  const sends = new Map<string, CallSend[]>(), byRid2 = new Map<string, CallSend>();
  // Pending notes of the current revision by key (notes.ts): recorded rids, and those a generation carried.
  const notes = new Map<string, Set<string>>(), carried = new Set<string>();
  function apply(batch: readonly Entry[], from = 0) {
    for (let i = from; i < batch.length; i++) {
      const e = batch[i]!;
      if (i >= boundary && (e.type === JT.done || (e.type === "resumed" && !e.call))) terminal = e;
      if (e.type === JT.attentionResolved) resolved.add(`${e.id}@${e.rev}`);
      if (["call", "generation", "refused", "reused"].includes(e.type)) {
        if (boundary >= 0 && e.seq < entries[boundary]!.seq) continue;
        const key = String(e.key), gen = Number(e.gen) || (e.type === "refused" ? 0 : 1);
        const callId = e.type === "reused" ? String(e.from) : `${wid}@${rev}/${key}@${gen}`;
        if (e.type === "generation") { generations.add(callId); for (const rid of Array.isArray(e.notes) ? e.notes : []) carried.add(String(rid)); }
        const result = e.type === "refused" ? refusedResult(key, e.reason) :
          e.type === "reused" ? entries.find(s => s.type === JT.sealed && s.call === e.from)?.result as CallResult | undefined : undefined;
        const wanted = (e.spec as { model?: unknown } | undefined)?.model;
        const command = (e.spec as { command?: unknown } | undefined)?.command;
        calls.set(callId, { key, gen, callId, pos: Number(e.pos), agent: String((e.spec as { agent?: string } | undefined)?.agent ?? ""),
          ...(command !== undefined ? { command: commandText(command) } : {}),
          // Until a slot is acquired (`selected`), show the model the call asked for, not nothing.
          ...(typeof wanted === "string" && wanted ? { model: wanted } : {}),
          phase: result ? "sealed" : "queued", ...(result ? { result, endedAt: e.ts } : {}),
          ...(e.type === "refused" ? { refused: String(e.reason) } : {}), ...(e.type === "reused" ? { reused: String(e.from) } : {}) });
      } else if (e.type === PENDING_NOTE) {
        if (boundary >= 0 && e.seq < entries[boundary]!.seq) continue;
        const set = notes.get(String(e.key)) ?? new Set<string>(); set.add(String(e.rid)); notes.set(String(e.key), set);
      } else if (e.type === "retired") { retired.add(String(e.call));
      } else if (e.type === JT.exec) {
        const call = calls.get(String(e.call)); if (!call) continue;
        // An execution waits for a provider slot and memory before it launches; it is running once `selected` says so
        // (otherwise a call still waiting for a slot reads "thinking · 2m").
        call.exec = String(e.exec); delete call.poolWait; delete call.usedModel; delete call.virtualModel; call.phase = "queued"; call.startedAt ??= e.ts; call.lastActivity = e.ts; byExec.set(call.exec, call);
        if (!call.answered) { delete call.hibernated; hibernating.delete(call.callId); }
      } else if (e.type === "command-intent") {
        // A command call runs from its intent until its seal; it never has an `exec`, so nothing treats it as an execution.
        const call = calls.get(String(e.call));
        if (call && call.phase !== "sealed") {
          call.commandRun = { attempt: Number(e.n) || 1, id: String(e.id) }; call.phase = "running"; call.startedAt = e.ts; call.lastActivity = e.ts;
          delete call.writerWait; byCommand.set(String(e.id), call);
        }
      } else if (e.type === "command-started") {
        const call = byCommand.get(String(e.id)), dir = e.dir;
        if (call && call.commandRun?.id === e.id) {
          call.commandRun = { ...call.commandRun, ...(Number.isSafeInteger(e.pid) ? { pid: Number(e.pid) } : {}), ...(typeof dir === "string" ? { log: join(dir, "output.log") } : {}) };
          call.startedAt = e.ts; call.lastActivity = e.ts;
        }
      } else if (e.type === "slot-wait") {
        const call = byExec.get(String(e.exec));
        if (call && call.exec === e.exec) {
          if (e.model) call.poolWait = { since: Number(e.since), model: modelName(e.model), ...(typeof e.pool === "string" ? { pool: e.pool } : {}), free: [] };
          else delete call.poolWait;
        }
      } else if (e.type === "spilled") {
        const call = byExec.get(String(e.exec));
        if (call) call.spill = { from: modelName(e.from), to: modelName(e.to), waitedMs: Number(e.waitedMs) };
      } else if (e.type === "model-unavailable") {
        const call = byExec.get(String(e.exec)); if (call) call.modelUnavailable = String(e.reason);
      } else if (e.type === "model-ready") {
        const call = byExec.get(String(e.exec));
        if (call && call.exec === e.exec) { call.selectedModel = modelName(e.model); call.virtualModel = e.virtual === true; }
      } else if (e.type === "writer-wait" || e.type === "writer-acquired") {
        const call = calls.get(String(e.call)), holder = String(e.holder ?? "");
        if (call && e.type === "writer-wait") call.writerWait = { root: String(e.root), holder: holder.includes("/") ? `${holder.split("@")[0]}/${holder.split("/")[1]!.split("@")[0]}` : holder };
        else if (call) delete call.writerWait;
      } else if (e.type === "hibernated") {
        // The decision to hibernate precedes the fence; the slot is released only once the execution is fenced.
        // Recovery may record the hibernation after fencing the interrupted asker.
        const call = calls.get(String(e.call));
        if (call?.exec && call.exec === e.exec) {
          hibernating.set(call.callId, call.exec); if (fenced.has(call.exec)) call.hibernated = true;
          // D6: hibernated again after a bound answer the session had already closed: it waits for a new answer.
          if (call.phase !== "sealed") delete call.answered;
        }
      } else if (e.type === "answer-bound") {
        resolved.add(`q:${e.call}:${e.qid}@${e.rev}`);
        const call = calls.get(String(e.call));
        if (call && call.phase !== "sealed") { call.answered = String(e.qid); call.phase = "queued"; }
      } else if (e.type === "resumed" && e.call) {
        const call = calls.get(String(e.call));
        if (call && call.phase !== "sealed" && (!e.exec || call.exec === e.exec)) {
          call.phase = "running"; delete call.answered; delete call.hibernated; hibernating.delete(call.callId);
        }
      } else if (e.type === JT.fenced) {
        fenced.add(String(e.exec));
        // A fenced execution without a seal (stop-all, a quit pi, a loss before its continuation) waits to run again.
        const call = byExec.get(String(e.exec)); if (call && call.phase === "running") call.phase = "queued";
        if (call && hibernating.get(call.callId) === e.exec) call.hibernated = true;
      } else if (e.type === "selected") {
        const call = byExec.get(String(e.exec)), m = e.model as { provider?: string; id?: string } | undefined;
        if (call && call.exec === e.exec && m) { call.model = m.provider ? `${m.provider}/${m.id}` : m.id; call.selectedModel = call.model; delete call.poolWait; delete call.usedModel; delete call.virtualModel; }
        if (call && call.exec === e.exec && call.phase === "queued") {
          call.phase = "running"; delete call.answered; delete call.hibernated; hibernating.delete(call.callId);
        }
      } else if (e.type === "model-used") {
        // Evidence of a switch: the execution answered with another model than it launched with.
        const call = byExec.get(String(e.exec)), m = e.model as { provider?: string; id?: string } | undefined;
        if (call && call.exec === e.exec && m) {
          call.model = m.provider ? `${m.provider}/${m.id}` : m.id; call.usedModel = call.model;
          if (sends.get(call.callId)?.some(s => s.kind === "model" && !s.reason && s.model?.toLowerCase() === call.model?.toLowerCase())) call.selectedModel = call.model;
        }
      } else if (e.type === "observation") {
        // Only what the agent did counts as activity; tracker scans and time checkpoints are bookkeeping.
        const call = byExec.get(String(e.exec)); if (call) call.lastActivity = e.ts;
        const event = e.event as { type?: string; provider?: string; model?: string } | undefined;
        if (call && call.exec === e.exec && event?.type === "message_start" && event.provider && event.model) call.usedModel = `${event.provider}/${event.model}`;
        if (call && e.type === "observation" && (e.event as { type?: string } | undefined)?.type === "tool_execution_start") tools.set(call.callId, (tools.get(call.callId) ?? 0) + 1);
      } else if (e.type === "usage") {
        const id = `${e.call}:${e.id}`, u = e.usage as Usage | undefined;
        if (seen.has(id) || !u) continue;
        seen.add(id);
        const total = live.get(String(e.call)) ?? zero();
        total.input += u.input; total.output += u.output; total.costUsd += u.costUsd; live.set(String(e.call), total);
      } else if (isEntry(e, 'ended')) {
        const prior = endedAtSeal.get(e.call), procs = [...(prior?.procs ?? []), ...e.procs];
        endedAtSeal.set(e.call, { procs: procs.slice(0, 20), more: (prior?.more ?? 0) + Math.max(0, procs.length - 20) + (e.more ?? 0) });
      } else if (e.type === JT.sealed) {
        const usage = (e.result as CallResult | undefined)?.usage;
        if (usage) sealedUsage.set(String(e.call), usage);
        const call = calls.get(String(e.call)); if (!call) continue;
        call.phase = "sealed"; call.result = e.result as CallResult; call.endedAt = e.ts; delete call.answered; delete call.hibernated; delete call.writerWait; delete call.poolWait; hibernating.delete(call.callId);
      } else if (isEntry(e, JT.attention)) {
        const item = e.item;
        attention.push(item);
      } else if (e.type === "forward") {
        const envelope = e.envelope as { kind?: string; body?: { provider?: string; model?: string }; cond?: { qid?: string; rev?: number } } | undefined;
        const send: CallSend = { rid: String(e.rid), kind: String(envelope?.kind ?? ""), state: "pending", at: e.ts,
          ...(envelope?.kind === "model" && envelope.body?.provider ? { model: `${envelope.body.provider}/${envelope.body.model}` } : {}),
          ...(envelope?.kind === "answer" && typeof envelope.cond?.qid === "string" && typeof envelope.cond.rev === "number"
            ? { question: { qid: envelope.cond.qid, rev: envelope.cond.rev } } : {}) };
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
    for (const c of list) if (c.hibernated && c.phase !== "asking" && !c.answered) delete c.hibernated;
    const usageOf = (callId: string) => sealedUsage.get(callId) ?? live.get(callId);
    const counts: Record<CallPhase, number> = { queued: 0, running: 0, asking: 0, sealed: 0 };
    for (const c of list) {
      if (c.phase !== "sealed" && c.phase !== "queued") delete c.poolWait;
      counts[c.phase]++;
      const ended = endedAtSeal.get(c.callId);
      if (ended?.procs.length) c.endedAtSeal = structuredClone(ended.procs);
      if (ended?.more) c.endedAtSealMore = ended.more;
      const usage = usageOf(c.callId); if (usage) c.usage = { ...usage };
      const n = tools.get(c.callId); if (n) c.tools = n;
      const forwarded = sends.get(c.callId);
      if (forwarded) {
        c.sends = structuredClone(forwarded); const pending = forwarded.filter(pendingMessage).length; if (pending) c.pending = pending;
        const answer = c.phase === "asking" && forwarded.find(s => s.kind === "answer" && s.state === "pending" && s.question &&
          openAttention.some(a => a.call === c.callId && a.qid === s.question!.qid && a.rev === s.question!.rev));
        if (answer) c.answerForwarded = { rid: answer.rid, ...answer.question!, at: answer.at };
        const last = c.phase !== "sealed" && !retired.has(c.callId) ? forwarded.findLast(s => s.kind === "model" && s.reason !== "withdrawn" && s.reason !== "stale-execution") : undefined;
        if (last?.reason !== undefined) c.switchFailed = `${last.model} (${last.reason})`;
        else if (last && last.state !== "retired" && last.model !== (c.virtualModel ? c.selectedModel : c.model)?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")) c.switching = last.model;
      }
      const selected = c.switching ?? c.selectedModel;
      if (c.usedModel && c.virtualModel) c.routedModel = c.usedModel;
      else if (c.usedModel && selected && c.usedModel.toLowerCase() !== selected.toLowerCase())
        c.modelMismatch = { used: c.usedModel, selected };
    }
    for (const [key, rids] of notes) {
      const n = [...rids].filter(rid => !carried.has(rid)).length, call = list.findLast(c => c.key === key);
      if (n && call) call.notesPending = n;
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
      ...(latestCalls({ calls: list }).some(c => c.phase !== "sealed") ? { active: true as const } : {}),
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
export function workflowSnapshot(home: string, wid: string, ledger?: string): WorkflowSnapshot {
  const base = workflowDigest(home, wid, ledger).snapshot;
  const wf = base.calls.some(c => c.poolWait || c.phase === "queued") ? withLedgerFacts(base, readerLedger(home).state.state) : base;
  const planned = plannedTotal(home, wid, wf.rev);
  return planned === undefined ? wf : { ...wf, planned };
}

/** P37: a generation opened by a send (possibly after the workflow finished) that has no seal yet is pending work. */
const opened = new WeakMap<object, { length: number; open: boolean }>();
export function openGeneration(entries: readonly { type: string; [k: string]: unknown }[]): boolean {
  const hit = opened.get(entries);
  if (hit?.length === entries.length) return hit.open;
  // Sealed call ids end in `/<key>@<gen>`; collect every such suffix once instead of rescanning per generation.
  const sealed = new Set<string>();
  for (const s of entries) if (s.type === JT.sealed) { const call = String(s.call); for (let i = call.indexOf("/"); i >= 0; i = call.indexOf("/", i + 1)) sealed.add(call.slice(i)); }
  const open = entries.some(g => g.type === "generation" && !sealed.has(`/${String(g.key)}@${String(g.gen)}`));
  opened.set(entries, { length: entries.length, open });
  return open;
}
const unresolvedByEntries = new WeakMap<readonly Entry[], AttentionItem[]>();
/** P15: The attention items of one immutable journal snapshot without an `attention-resolved`, computed once per snapshot. */
export function unresolvedAttention(entries: readonly Entry[]): AttentionItem[] {
  let items = unresolvedByEntries.get(entries);
  if (items) return items;
  const done = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => `${e.id}\0${e.rev}`));
  items = attentionEntries(entries).map(e => e.item).filter(item => !done.has(`${item.id}\0${item.rev}`));
  unresolvedByEntries.set(entries, items);
  return items;
}

/** What pi's pollers need from one workflow journal. A finished workflow with no live call or open generation
 *  carries `settled` attention and task fallbacks, so pollers can release the journal. Late writes are rechecked. */
export interface WorkflowDigest { snapshot: WorkflowSnapshot; settled?: { attention: AttentionItem[]; tasks: Record<string, string> } }
// A settled workflow's digest is kept in memory and on disk (DSA_HOME/cache), keyed by the journal's inode and committed
// size: committed bytes never change (A1), so the same device, inode and size reduce to the same digest. Readers used to
// decode every historical journal at each pi start (hundreds of MB: seconds of pi's main thread and hundreds of MB
// per pi window) only to find them finished. The key also names this reduction's code, so a changed reducer reads its
// journals again instead of trusting digests an older one wrote.
const DIGEST_FORMAT = 2;
let digestCode: string | undefined;
function digestVersion(): string {
  if (digestCode === undefined) {
    try {
      const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
      digestCode = `${DIGEST_FORMAT}.${crc32(Buffer.concat([new URL(import.meta.url), ...[`../types.${ext}`, `./executor/worktree.${ext}`, `./notes.${ext}`].map(p => new URL(p, import.meta.url))].map(u => readFileSync(u))))}`;
    } catch { digestCode = ""; }
  }
  return digestCode;
}
const digests = new Map<string, { dev: number; ino: number; size: number; digest: WorkflowDigest; checked: number; ledger?: string; appends: number }>();
const FINAL_STATUS = new Set(["done", "failed", "stopped"]);
/** Post-seal/recovery work that can append without a new request must not enter a polling trust window. */
export function pendingRecovery(wid: string, entries: readonly Entry[]): boolean {
  const rev = entries.filter(e => e.type === JT.done).length;
  if (entries.some(e => e.type === 'wf-created' && e.wake) && !entries.some(e => e.type === 'wake-outcome' && e.rev === rev)) return true;
  const start = entries.findLastIndex(e => e.type === "revised"), current = start < 0 ? entries : entries.slice(start);
  const consumed = new Set(current.filter(e => e.type === "generation").flatMap(generationRids));
  const retiredForwards = new Map(entries.filter(e => e.type === "forward-retired").map(e => [String(e.rid2), e]));
  const delivered = new Set(entries.filter(e => e.type === "forward-delivered").map(e => String(e.rid2)));
  // collectSealed repairs forwarding receipts of older revisions as well.
  for (const e of entries) if (e.type === "forward" && !retiredForwards.has(String(e.rid2)) && !delivered.has(String(e.rid2))) return true;
  for (const e of current) if (e.type === "forward" && retiredForwards.get(String(e.rid2))?.reason === UNDELIVERED_FOLLOW_UP && !consumed.has(String(e.rid))) return true;
  const fenced = new Set(entries.filter(e => e.type === JT.fenced).map(e => e.exec));
  const gates = new Set(entries.filter(e => e.type === "gate").map(e => e.id));
  const cleaned = new Set(entries.filter(e => e.type === "wt-removed" || e.type === "wt-kept").map(e => e.call));
  const seals = new Map(entries.filter(e => e.type === JT.sealed).map(e => [e.call, e]));
  const attention = attentionEntries(entries), resolved = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => JSON.stringify([e.id, e.rev])));
  const hasAttention = (id: string, rev?: number) => attention.some(e => e.item.id === id && (rev === undefined || e.item.rev === rev));
  // Engine.attention repairs completion notices, including on already-ended workflows after a crash.
  if (current.some(e => e.type === JT.done) && !hasAttention(`finished:${wid}`, entries.filter(e => e.type === JT.done).length)) return true;
  for (const e of entries) {
    if (e.type === JT.exec && !fenced.has(e.exec)) return true;
    if (e.type === "gate-intent" && !gates.has(e.id)) return true;
    if (e.type === "wt-intent" && (seals.get(e.call)?.result as CallResult | undefined)?.status === "ok" && !cleaned.has(e.call)) return true;
    if (e.type === JT.sealed && (e.result as CallResult | undefined)?.status === "unknown" && !hasAttention(`unknown:${String(e.call)}`)) return true;
    if (e.type === "generation" && e.revision !== undefined) {
      const call = `${wid}@${e.revision}/${String(e.key)}@${String(e.gen)}`;
      if (seals.has(call) && !hasAttention(`finished:${call}`)) return true;
    }
  }
  // Retirement, fence repair, and cross-workflow conflict resolution can still close these items.
  for (const { item } of attention) if (!resolved.has(JSON.stringify([item.id, item.rev]))) {
    if (item.id.startsWith("fence:") || item.kind === "conflict") return true;
    if (item.call && seals.has(item.call) && item.kind !== "finished" && item.id !== `unknown:${item.call}`) return true;
  }
  return false;
}
function digestOf(wf: WorkflowSnapshot, entries: readonly Entry[], complete: boolean): WorkflowDigest {
  const settled = complete && FINAL_STATUS.has(wf.status) && !wf.active && !wf.followUps &&
    entries.some(e => e.type === JT.done) && !openGeneration(entries) && !pendingRecovery(wf.wid, entries);
  const tasks: Record<string, string> = Object.create(null);
  if (settled) for (const e of entries) if (e.type === "call") tasks[`${e.key}\0${e.gen}`] = String((e.spec as { task?: string } | undefined)?.task ?? "");
  return settled ? { snapshot: wf, settled: { attention: structuredClone(unresolvedAttention(entries)), tasks } } : { snapshot: wf };
}
type StoredDigest = { v: string; home: string; dev: number; ino: number; size: number; digest: WorkflowDigest };
function storedDigest(home: string, wid: string, dev: number, ino: number, size: number): WorkflowDigest | undefined {
  const stored = readCache(join(digestDir(home), `${wid}.json`)) as StoredDigest | undefined;
  const d = stored?.digest, wf = d?.snapshot;
  if (!(digestVersion() && stored?.v === digestVersion() && stored.home === home && stored.dev === dev && stored.ino === ino && stored.size === size &&
    d?.settled && Array.isArray(d.settled.attention) && d.settled.tasks && wf?.wid === wid && Array.isArray(wf.calls) &&
    Array.isArray(wf.attention) && wf.counts && FINAL_STATUS.has(wf.status) && !wf.active && !wf.followUps)) return undefined;
  // The reducer always sets pos with Number(e.pos); a missing position is NaN, which JSON represents as null.
  for (const call of wf.calls) if ((call.pos as unknown) === null) call.pos = NaN;
  return d;
}
/** Concurrent windows publish independently; an old writer's identity cannot pass a new journal's key. */
function storeDigest(home: string, wid: string, record: JournalRecord, digest: WorkflowDigest): void {
  const v = digestVersion();
  if (v) writeCache(join(digestDir(home), `${wid}.json`), { v, home, dev: record.dev, ino: record.ino, size: record.size, digest } satisfies StoredDigest, journalPath(home, wid));
}
// Path strings per workflow: joining them for every workflow on every UI refresh cost pi's main thread milliseconds.
const pathsByHome = new Map<string, Map<string, { journal: string; scripts: string[] }>>();
function pathsOf(home: string, wid: string): { journal: string; scripts: string[] } {
  let byWid = pathsByHome.get(home);
  if (!byWid) pathsByHome.set(home, byWid = new Map());
  let paths = byWid.get(wid);
  if (!paths) byWid.set(wid, paths = { journal: journalPath(home, wid), scripts: [] });
  return paths;
}
/** Intake commits requests before applying their generation or revision, then decisions afterward. Recovery and
 *  late attention can also append without a fresh request: an unchanged ledger skips settled journal IO only for
 *  this bounded window. Local appends end it too; turn boundaries check immediately. */
export const SETTLED_RECHECK_MS = 5000;
/** P25: The current digest of one workflow, from its committed journal. With `ledger` (the orchestrator ledger's
 *  identity, see allWorkflows) a settled digest checked under the same ledger less than SETTLED_RECHECK_MS ago is
 *  reused without a stat. */
export function workflowDigest(home: string, wid: string, ledger?: string): WorkflowDigest {
  const path = pathsOf(home, wid).journal, memo = digests.get(path), now = Date.now();
  if (memo?.digest.settled) releasable.add(path);
  if (ledger !== undefined && memo?.digest.settled && memo.ledger === ledger && memo.appends === journalAppends() && now >= memo.checked && now - memo.checked < SETTLED_RECHECK_MS) return memo.digest;
  let dev: number | undefined, ino: number | undefined, size: number | undefined;
  try { ({ dev, ino, size } = statSync(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (memo && memo.dev === dev && memo.ino === ino && memo.size === size) {
    memo.ledger = ledger; memo.checked = now; memo.appends = journalAppends();
    return memo.digest;
  }
  if (dev !== undefined && ino !== undefined && size !== undefined && !memo) {
    const stored = storedDigest(home, wid, dev, ino, size);
    if (stored) { digests.set(path, { dev, ino, size, digest: stored, checked: now, ledger, appends: journalAppends() }); releasable.add(path); return stored; }
  }
  const record = readJournalRecord(path), entries = record?.entries ?? [];
  const digest = digestOf(foldSnapshot(path, wid, entries), entries, !!record && record.length === record.size);
  if (!record) { digests.delete(path); return digest; }
  digests.set(path, { dev: record.dev, ino: record.ino, size: record.size, digest, checked: now, ledger, appends: journalAppends() });
  if (digest.settled) { storeDigest(home, wid, record, digest); releasable.add(path); }
  return digest;
}
/** Last journal identity check of the current digest. Reuse never renews this timestamp. */
export function workflowDigestChecked(home: string, wid: string): number {
  return digests.get(pathsOf(home, wid).journal)?.checked ?? -Infinity;
}
/** The digest is all a poller reads of a settled workflow: its entries and fold state need not stay in memory. Pollers
 *  (allWorkflows, the main agent's workflows) release them after a pass; a one-off reader that compares journal
 *  snapshots by identity around a digest (describe) keeps them. */
const releasable = new Set<string>();
/** Explicit one-off readers may load settled history between polling passes. */
export function releaseLoadedSettledJournals(): void {
  forgetJournalSnapshotsIf(path => !!digests.get(path)?.digest.settled);
}
export function releaseSettledJournals(): void {
  for (const path of releasable) { forgetJournalSnapshot(path); folds.delete(path); }
  releasable.clear();
}
function foldSnapshot(path: string, wid: string, entries: readonly Entry[]): WorkflowSnapshot {
  const hit = derived.get(entries);
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
  return wf;
}

/** Ops: wids archived by `prune` (orchestrator ledger `pruned{wid}`); they no longer exist for any reader. */
function prunedIds(home: string): Set<string> {
  return readerLedger(home).state.pruned;
}

/** What the readers polled by pi's main thread need from the orchestrator ledger, folded once per ledger snapshot
 *  (and extended in place when a live ledger array grows): scanning the whole ledger once per workflow on every
 *  refresh cost pi a steady few percent of its main thread. Indexes are positions in the ledger. */
export interface LedgerIndex {
  /** First `created` entry per wid (the raw `wid` value is the key, compared like `===`). */
  created: Map<unknown, Entry>;
  /** The origin of each workflow's `create-intent`, by wid: the engine records it before it creates the workflow's
   *  directory and journal, and appends `created` only after the journal's `wf-created`, so between the two the
   *  intent is the ledger's only word on who started it. */
  intents: Map<string, unknown>;
  /** wids archived by `prune`. */
  pruned: Set<string>;
  /** The labels of each workflow's run request (only workflows that have any). */
  labels: Map<string, Record<string, string>>;
  /** Run requests with labels, by rid, until their workflow is created. */
  runLabels: Map<string, Record<string, string>>;
  /** The pi session each workflow's run request named (RunBody.session), and the same by rid until creation. */
  sessions: Map<string, string>; runSessions: Map<string, string>;
  /** Last drain/undrain without scope, per `wid` and per `origin`. */
  global?: number; byWid: Map<unknown, number>; byOrigin: Map<unknown, number>;
  lastDrain?: number;
}
type Folded = LedgerIndex & { length: number; last?: Entry };
const ledgerIndexes = new WeakMap<readonly Entry[], Folded>();
export function ledgerIndex(ledger: readonly Entry[]): LedgerIndex {
  let ix = ledgerIndexes.get(ledger);
  if (!ix || ix.length > ledger.length || (ix.length && ledger[ix.length - 1] !== ix.last)) {
    ix = { length: 0, created: new Map(), intents: new Map(), pruned: new Set(), labels: new Map(), runLabels: new Map(), sessions: new Map(), runSessions: new Map(), byWid: new Map(), byOrigin: new Map() };
    ledgerIndexes.set(ledger, ix);
  }
  for (let i = ix.length; i < ledger.length; i++) {
    const e = ledger[i]!;
    if (e.type === JT.created) {
      if (!ix.created.has(e.wid)) ix.created.set(e.wid, e);
      const labels = ix.runLabels.get(String(e.rid));
      if (labels) { if (!ix.labels.has(String(e.wid))) ix.labels.set(String(e.wid), labels); ix.runLabels.delete(String(e.rid)); }
      const session = ix.runSessions.get(String(e.rid));
      if (session) { if (!ix.sessions.has(String(e.wid))) ix.sessions.set(String(e.wid), session); ix.runSessions.delete(String(e.rid)); }
    } else if (e.type === "create-intent") {
      if (!ix.intents.has(String(e.wid))) ix.intents.set(String(e.wid), e.origin);
    } else if (e.type === "request") {
      const r = e.request as { rid?: unknown; kind?: unknown; body?: unknown } | undefined, labels = r?.kind === "run" ? labelsOf(r.body) : undefined;
      if (labels && typeof r?.rid === "string") ix.runLabels.set(r.rid, labels);
      const session = r?.kind === "run" ? (r.body as { session?: unknown } | null)?.session : undefined;
      if (typeof session === "string" && session && typeof r?.rid === "string") ix.runSessions.set(r.rid, session);
    } else if (e.type === JT.rejected) { ix.runLabels.delete(String(e.rid)); ix.runSessions.delete(String(e.rid)); }
    else if (e.type === "pruned") { ix.pruned.add(String(e.wid)); ix.labels.delete(String(e.wid)); ix.sessions.delete(String(e.wid)); }
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
  forgetRemovedWorkflows(home, wids, pruned);
  return wids.filter(wid => !pruned.has(wid));
}
function forgetRemovedWorkflows(home: string, names: string[], pruned: Set<string>): void {
  const paths = pathsByHome.get(home), present = new Set(names);
  if (paths) for (const [wid, p] of paths) if (pruned.has(wid) || !present.has(wid)) {
    digests.delete(p.journal); folds.delete(p.journal); forgetJournalSnapshot(p.journal); firstOrigins.delete(p.journal);
    for (const script of p.scripts) if (script) plannedByPath.delete(script);
    paths.delete(wid);
  }
}

/** Ledger types that determine holdOf/heldIn (other ledgerIndex projections do not affect holds). */
export const HOLD_ENTRY_TYPES = [JT.created, 'drain', 'undrain'] as const;

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
/** Drain: whether a drain holds workflow `wid`, from the orchestrator ledger's entries. */
export function heldIn(ledger: readonly Entry[]): (wid: string) => boolean {
  return wid => holdOf(ledger, wid, ledgerIndex(ledger).created.get(wid)?.origin as string | undefined) !== undefined;
}
/** Drain: the workflows a drain (stop-all, a quit pi) holds until resume, and since when. */
export function heldWorkflows(home: string): { since?: number; held: (wid: string) => boolean; labels: (wid: string) => Record<string, string> | undefined; session: (wid: string) => string | undefined } {
  const ix = readerLedger(home).state;
  const origin = (wid: string) => ix.created.get(wid)?.origin as string | undefined;
  const hold = (wid: string) => readerHold(ix, wid, origin(wid));
  const since = ix.lastDrain?.ts;
  return { ...(since !== undefined ? { since } : {}), held: wid => hold(wid) !== undefined, labels: wid => ix.labels.get(wid), session: wid => ix.sessions.get(wid) };
}
/** The origin of a workflow's `wf-created`, the first entry of its journal, for a workflow the ledger does not attribute
 *  (only a damaged or hand-made home has one), read without keeping the journal in the snapshot cache. The first entry
 *  never changes once written, so a successful read is kept for the life of the process. A journal that cannot be read
 *  counts as no origin (no session's own) only while it stays as it was: the failure is kept with the file's identity
 *  (inode, size, ctime and mode: ctime ticks coarsely, so a chmod right after the failure may leave it unchanged) and
 *  the read is retried once that changes. A journal without its first
 *  entry yet is asked again. */
const firstOrigins = new Map<string, { origin: unknown } | { failed: { ino: number; size: number; ctimeMs: number; mode: number } | undefined }>();
function firstOrigin(home: string, wid: string): unknown {
  const path = journalPath(home, wid), known = firstOrigins.get(path);
  if (known && "origin" in known) return known.origin;
  const identity = () => { try { const st = statSync(path); return { ino: st.ino, size: st.size, ctimeMs: st.ctimeMs, mode: st.mode }; } catch { return undefined; } };
  const same = (a: ReturnType<typeof identity>, b: ReturnType<typeof identity>) => !!a && !!b && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
  // The identity is taken before the read, and a failure is kept only when the file did not change during the read:
  // a chmod between the failed read and a later sample would otherwise be recorded as the failure's identity.
  const before = identity();
  if (known && same(before, known.failed)) return undefined;
  let first: Entry | undefined;
  try { first = readJournalUncached(path)?.entries[0]; }
  catch {
    if (same(before, identity())) firstOrigins.set(path, { failed: before }); else firstOrigins.delete(path);
    return undefined;
  }
  if (!first) { firstOrigins.delete(path); return undefined; }
  const origin = first.type === "wf-created" ? first.origin : undefined;
  firstOrigins.set(path, { origin });
  return origin;
}
/** The workflow with its run's labels and session, when it has them. */
function labelled<T extends WorkflowSnapshot>(wf: T, labels: Record<string, string> | undefined, session?: string): T {
  return labels || session ? { ...wf, ...(labels ? { labels } : {}), ...(session ? { session } : {}) } : wf;
}
/** Whether `origin` ("main:<pi session id>") shows the workflow as its own: it started it, or the run named that pi
 *  session (RunBody.session, e.g. a CLI driver started from that session). */
export function ownedBy(w: Pick<WorkflowSnapshot, "origin" | "session">, origin: string): boolean {
  return w.origin === origin || (w.session !== undefined && `main:${w.session}` === origin);
}
/** Labels clipped for one status line: "[k=v k2=v2]", at most `width` characters (empty without labels). */
export function labelsText(labels: Record<string, string> | undefined, width = 60): string {
  if (!labels) return "";
  const text = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(" ").replace(/\s+/g, " ");
  return text ? `[${clip(text, Math.max(1, width - 3))}]` : "";
}

const decorated = new WeakMap<WorkflowSnapshot, { planned?: number; labels?: Record<string, string>; session?: string; paused: boolean; slotMark?: string; wf: WorkflowSnapshot }>();
/** The orchestrator that is still recovering the home's workflows: its start entry says it recovers first, it has not
 *  recorded `recovered` and its process lives. Undefined for an orchestrator that does not say so (older versions). */
export function orchestratorStarting(state: LedgerState): { pid: number; since: number } | undefined {
  const o = state.orchestrator;
  if (!o?.recovery || o.recovered || o.exited) return undefined;
  // Readers ask on every refresh; the process check is kept for a second per start entry.
  const now = Date.now(), hit = startingChecks.get(o);
  const alive = hit && now >= hit.at && now - hit.at < 1000 ? hit.alive : processAlive(o.pid, o.start);
  if (!hit || hit.alive !== alive || now < hit.at || now - hit.at >= 1000) startingChecks.set(o, { at: now, alive });
  return alive ? { pid: o.pid, since: o.ts } : undefined;
}
const startingChecks = new WeakMap<object, { at: number; alive: boolean }>();
/** A queued call's wait as one phrase: "orchestrator starting (12s)", "waiting for a free slot (p 2/2)", ... */
export function queuedText(w: QueueWait, now = Date.now(), span: (ms: number) => string = age): string {
  return w.reason === "starting" ? `orchestrator starting (${span(now - (w.since ?? now))})` : w.detail;
}
const providerOf = (model: string) => { try { return parseModel(model).provider; } catch { return undefined; } };
/** Why a queued call waits, from what the orchestrator ledger records (precedence as events/waiting.ts): the
 *  orchestrator still recovering; every candidate provider used up and not admitted now; the writer lock of its worktree;
 *  every candidate provider full. Undefined when none is known: a call is never said to wait for a slot without a full
 *  provider (memory headroom and an admission in progress look the same from here). Candidates: the provider it waits
 *  for to resume on, else those of the model or pool it asked for (else the configured default). */
export function queueWait(c: CallSnapshot, state: LedgerState, now = Date.now(), starting = orchestratorStarting(state)): QueueWait | undefined {
  if (c.phase !== "queued") return undefined;
  if (starting) return { reason: "starting", detail: "orchestrator starting", since: starting.since };
  // A command call takes no provider slot: only the orchestrator's start and a writer lock hold it back.
  const settings = state.config?.settings ?? {}, pools = settings.pools ?? {}, wanted = c.command !== undefined ? undefined : c.poolWait?.model ?? c.model ?? settings.defaultModel;
  let providers: string[] = [];
  if (wanted && Object.hasOwn(pools, wanted)) { try { providers = [...new Set(resolveModel(wanted, pools).map(m => m.provider).filter((p): p is string => !!p))]; } catch { /* an invalid pool: unknown */ } }
  else if (wanted) { const p = providerOf(wanted); if (p) providers = [p]; }
  const used = providers.map(p => [p, state.exhausted.get(p)] as const);
  if (used.length && used.every(([, x]) => x && (now < x.nextTry || x.probe !== undefined)))
    return { reason: "provider-exhausted", detail: `${providers.join(", ")} usage window${providers.length > 1 ? "s" : ""} used up` };
  if (c.writerWait) return { reason: "writer-lock", detail: `waiting for the writer lock of ${c.writerWait.root}` };
  if (!providers.length) return undefined;
  let full = true;
  const lines = providers.map(p => {
    let held = 0; for (const h of state.held.values()) if (h.pool === p) held++;
    const limit = settings.providers?.[p]?.slots;
    if (limit === undefined || held < limit) full = false;
    return slotLine(p, held, limit);
  });
  return full ? { reason: "slot", detail: `waiting for a free slot (${lines.join(", ")})` } : undefined;
}
/** A mark of the ledger facts a workflow's queued calls show: they are derived again when it changes. */
function queueMark(wf: WorkflowSnapshot, state: LedgerState, mark: string): string | undefined {
  if (!wf.calls.some(c => c.poolWait || c.phase === "queued")) return undefined;
  return `${mark}:${[...state.exhausted.values()].map(x => x.nextTry > Date.now()).join(",")}:${orchestratorStarting(state)?.since ?? ""}`;
}
/** Free slots and why queued calls wait are live ledger state, not repeated workflow journal records. */
function withLedgerFacts(wf: WorkflowSnapshot, state: LedgerState): WorkflowSnapshot {
  if (!wf.calls.some(c => c.poolWait || c.phase === "queued")) return wf;
  const held = new Map<string, number>(), now = Date.now(), starting = orchestratorStarting(state);
  for (const h of state.held.values()) held.set(h.pool, (held.get(h.pool) ?? 0) + 1);
  const pools = state.config?.settings.pools, limits = state.config?.settings.providers;
  return { ...wf, calls: wf.calls.map(c => {
    const why = queueWait(c, state, now, starting);
    if (why) c = { ...c, queuedFor: why };
    const wait = c.poolWait;
    if (!wait) return c;
    let providers: string[] = [];
    if (wait.pool && pools?.[wait.pool]) {
      try { providers = resolveModel(wait.pool, pools).map(m => m.provider).filter((p): p is string => !!p); }
      catch { /* A removed or invalid pool has no available entries to show. */ }
    }
    const pinned = wait.model.split("/")[0];
    const free = [...new Set(providers)].filter(p => p !== pinned && (held.get(p) ?? 0) < (limits?.[p]?.slots ?? Infinity) &&
      !(state.exhausted.get(p)?.nextTry && state.exhausted.get(p)!.nextTry > Date.now()));
    return { ...c, poolWait: { ...wait, free } };
  }) };
}
/** P25: Snapshot every workflow under DSA_HOME (newest first by wid, which is a ULID); `paused` marks work a drain holds. */
export function allWorkflows(home: string): WorkflowSnapshot[] {
  return snapshotsOf(home, workflowIds(home));
}
export function ledgerIdentity(record: JournalRecord | undefined): string {
  return record ? `${record.dev}:${record.ino}:${record.size}` : "";
}
function snapshotWithLedger(home: string, wid: string, ix: ReaderLedger, mark: string): WorkflowSnapshot {
  const pendingRevision = (ix.revisions.get(wid) ?? 0) > (digests.get(pathsOf(home, wid).journal)?.digest.snapshot.rev ?? 0);
  const base = workflowDigest(home, wid, pendingRevision ? undefined : mark).snapshot, planned = plannedTotal(home, wid, base.rev), l = ix.labels.get(wid), s = ix.sessions.get(wid);
  const paused = isLive(base) && !!readerHold(ix, wid, ix.created.get(wid)?.origin as string | undefined), hit = decorated.get(base);
  const slotMark = queueMark(base, ix.state, mark);
  if (hit && hit.planned === planned && hit.labels === l && hit.session === s && hit.paused === paused && hit.slotMark === slotMark) return hit.wf;
  const live = withLedgerFacts(base, ix.state);
  const planned1 = planned === undefined ? live : { ...live, planned }, labelled1 = labelled(planned1, l, s);
  const wf = paused ? { ...labelled1, paused: true } : labelled1;
  decorated.set(base, { planned, labels: l, session: s, paused, slotMark, wf });
  return wf;
}
function snapshotsOf(home: string, wids: string[]): WorkflowSnapshot[] {
  const record = readerLedger(home), mark = readerLedgerIdentity(record);
  try { return wids.sort().reverse().map(wid => snapshotWithLedger(home, wid, record.state, mark)); }
  finally { releaseSettledJournals(); }
}
/** Directory effects follow committed create-intent/pruned entries (Store.create/materialize, Engine.prune).
 *  Check identity first for the fast path; if a scan is needed, read the attributing ledger AFTER listing w/. */
const listings = new Map<string, { mark: string; checked: number; names: string[] }>();
export function readerWorkflowListing(home: string, fresh = false): { record: ReturnType<typeof readerLedger>; names: string[]; checked: number } {
  let record = readerLedger(home);
  const memo = listings.get(home), now = Date.now();
  if (!fresh && memo && memo.mark === readerLedgerIdentity(record) && now >= memo.checked && now - memo.checked < SETTLED_RECHECK_MS) return { record, names: memo.names, checked: memo.checked };
  let names: string[];
  try { names = readdirSync(join(home, "w")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  record = readerLedger(home);
  forgetRemovedWorkflows(home, names, record.state.pruned);
  // An intent can be committed before its directory is materialized. Until all unpruned intents are present,
  // a second pass must list again even if no more ledger bytes arrive (including a create during this scan).
  const present = new Set(names), incomplete = [...record.state.intents.keys()].some(wid => !record.state.pruned.has(wid) && !present.has(wid));
  if (incomplete) listings.delete(home);
  else listings.set(home, { mark: readerLedgerIdentity(record), checked: now, names });
  return { record, names, checked: now };
}
type OwnPass = { mark: string; checked: number; appends: number; names: string[]; retryUnknown: boolean; candidates: string[]; pending: string[]; result: WorkflowSnapshot[] };
const ownPasses = new Map<string, Map<string, OwnPass>>();
/** The workflows `own` ("main:<pi session id>") shows as its own (`ownedBy`), snapshotted exactly as `allWorkflows`
 *  does: the same list as `allWorkflows(home).filter(w => ownedBy(w, own))`, but who owns a workflow is decided from
 *  the orchestrator ledger alone (the origin of its create-intent or `created`, the session its run named), so the
 *  journals of other sessions' workflows are never opened. A pi process polls only its own workflows: reading and
 *  caching every workflow of the machine cost it seconds at startup and hundreds of MB.
 *  The engine records a workflow's create-intent (with its origin) before it creates the workflow's directory, so a
 *  workflow just being created is already attributed; its `session` (like `allWorkflows`) shows once `created` lands.
 *  A directory under `w/` the ledger knows nothing of (given the order below, only a hand-made or damaged home has one)
 *  is attributed by its journal's first entry (see firstOrigin). `started`: only those `own` started itself (origin `own`),
 *  not runs of other senders that named its session. */
export function ownWorkflows(home: string, own: string, options: { started?: boolean } = {}): WorkflowSnapshot[] {
  // Order matters: list `w/` first, then read the ledger used for attribution. The engine appends a workflow's
  // create-intent before it creates the directory, so every directory listed here already has its intent in a ledger
  // read afterwards; a workflow another session creates in between is attributed without opening its journal. (Read
  // the other way round, such a workflow would look unknown to the ledger and its journal would be read.)
  const { record, names, checked: listed } = readerWorkflowListing(home), ix = record.state, mark = readerLedgerIdentity(record), now = Date.now();
  let passes = ownPasses.get(home);
  if (!passes) ownPasses.set(home, passes = new Map());
  const key = JSON.stringify([own, !!options.started]), prior = passes.get(key);
  const current = prior && prior.names === names && !prior.retryUnknown && prior.mark === mark && prior.appends === journalAppends() && now >= prior.checked && now - prior.checked < SETTLED_RECHECK_MS;
  const includes = (w: WorkflowSnapshot) => options.started ? w.origin === own : ownedBy(w, own);
  if (current && !prior.pending.length) {
    // Another explicit reader may have loaded these journals since the preceding pass.
    releaseLoadedSettledJournals();
    return prior.result;
  }
  const candidates = current ? prior.candidates : names.filter(wid => !wid.startsWith(".") && !ix.pruned.has(wid)).filter(wid => {
    const known = ix.intents.has(wid) || ix.created.has(wid), session = ix.sessions.get(wid);
    const origin = known ? ix.intents.get(wid) ?? ix.created.get(wid)?.origin : firstOrigin(home, wid);
    return origin === own || (!options.started && session !== undefined && `main:${session}` === own);
  }).sort().reverse();
  try {
    const changed = new Map((current ? prior.pending : candidates).map(wid => [wid, snapshotWithLedger(home, wid, ix, mark)]));
    const old = new Map(prior?.result.map(w => [w.wid, w]));
    const result = candidates.map(wid => changed.get(wid) ?? old.get(wid)!).filter(w => w && includes(w));
    const same = prior && prior.result.length === result.length && result.every((w, i) => w === prior.result[i]);
    // A rescan can reuse digests checked earlier: the outer pass inherits the oldest dependency check.
    let checked = current ? prior.checked : Math.min(now, listed);
    const pending = candidates.filter(wid => {
      const memo = digests.get(pathsOf(home, wid).journal), digest = memo?.digest;
      if (digest?.settled) checked = Math.min(checked, memo!.checked);
      return !digest?.settled || (ix.revisions.get(wid) ?? 0) > digest.snapshot.rev;
    });
    passes.set(key, { mark, checked, appends: journalAppends(), names, retryUnknown: names.some(wid => !ix.intents.has(wid) && !ix.created.has(wid) && !ix.pruned.has(wid)), candidates, pending, result: same ? prior.result : result });
    return same ? prior.result : result;
  } finally { releaseSettledJournals(); }

}

/** P10/P11: Per-workflow script console log written by the orchestrator (bounded, human-readable). */
export function scriptLogPath(home: string, wid: string): string { return join(workflowDir(home, wid), "script.log"); }

/** P31: Human-readable usage total, e.g. "1.2M in / 15.0K out, $0.42". */
export function formatUsage(u: Usage): string {
  const n = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
  return `${n(u.input)} in / ${n(u.output)} out${u.costUsd > 0 ? `, $${u.costUsd.toFixed(u.costUsd < 0.01 ? 4 : 2)}` : ""}`;
}

/** A command call's line facts in status: its clipped command, the pid while it runs, its exit after the seal. */
export interface CommandStatus {
  /** The command, clipped to one line (a command call has no model). */
  command?: string;
  /** The running attempt's process, its attempt when it is the rerun (2), and the time since it started. */
  pid?: number; attempt?: number; for?: string;
  /** After the seal: the exit status, or the signal that ended it (result data). */
  exitCode?: number; signal?: string;
}
/** The CommandStatus of a command call (empty for an agent call): pid only while it is live. */
export function commandStatus(c: Pick<CallSnapshot, "command" | "commandRun" | "phase" | "result" | "startedAt">, now = Date.now()): CommandStatus {
  if (c.command === undefined) return {};
  const run = c.commandRun, data = c.result?.data as { exitCode?: unknown; signal?: unknown } | undefined, live = c.phase !== "sealed" && run !== undefined;
  return { command: commandLine(c.command),
    ...(live && run.pid !== undefined ? { pid: run.pid } : {}), ...(live && (run.attempt ?? 1) > 1 ? { attempt: run.attempt } : {}),
    ...(live && c.startedAt !== undefined ? { for: age(now - c.startedAt) } : {}),
    ...(typeof data?.exitCode === "number" ? { exitCode: data.exitCode } : {}), ...(typeof data?.signal === "string" ? { signal: data.signal } : {}) };
}
/** "pid 123" / "exit 3" / "SIGKILL" of a command call's status line (empty for an agent call or before the start). */
export function commandFacts(c: CommandStatus): string {
  return [c.pid !== undefined ? `pid ${c.pid}` : "", c.attempt ? `attempt ${c.attempt}` : "", c.for ?? "", c.exitCode !== undefined ? `exit ${c.exitCode}` : "", c.signal ?? ""].filter(Boolean).join(", ");
}
export interface StatusCall extends ModelStatus, CommandStatus {
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
  /** Hibernated: no provider slot is held while it waits (P28). */
  hibernated?: true;
  /** Bound question id, until the next execution starts running. */
  answered?: string;
  answerForwarded?: AnswerForwarded;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
  /** Resource leases (`pi-durable-subagents hold`): "holds lease machine" / "waiting for lease machine 3m". */
  lease?: string;
  /** Notes (send kind "notify") recorded while the call was not running; its next follow-up carries them. */
  notesPending?: number;
  /** Why this queued call does not start, when known: "orchestrator starting (12s)", "waiting for the writer lock of
   *  <root>", "<provider> usage window used up", "waiting for a free slot (<provider> n/n)". */
  queued?: string;
}
export interface StatusWorkflow {
  wid: string; name?: string; origin?: string;
  /** The run's result; follow-ups leave a final status unchanged. */
  status: WorkflowSnapshot["status"];
  /** Work is still going in a latest-generation call (a follow-up when the run has finished). */
  active?: true;
  rev: number;
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
  /** The run's labels. */
  labels?: Record<string, string>;
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
  /** What the running orchestrator costs (see stats.ts), when it published it. */
  orchestratorStats?: OrchestratorStats;
}
export type StatusDetail = WorkflowSnapshot & { scriptLog?: string };

/** P25, T10: Compact one workflow snapshot: per-call one-line facts, usage, open attention; no outputs or entries. */
export function compactWorkflow(wf: WorkflowSnapshot, leases?: Map<string, string>): StatusWorkflow {
  const progress = progressOf(wf); // v12 §4
  return {
    wid: wf.wid, ...(wf.name ? { name: wf.name } : {}), ...(wf.origin ? { origin: wf.origin } : {}), status: wf.status,
    ...(wf.active ? { active: true as const } : {}), rev: wf.rev,
    ...(wf.startedAt !== undefined ? { startedAt: wf.startedAt } : {}), ...(wf.endedAt !== undefined ? { endedAt: wf.endedAt } : {}),
    ...(wf.error ? { error: clip(wf.error, 500) } : {}), usage: wf.usage ?? zero(), counts: wf.counts,
    ...(wf.planned !== undefined ? { planned: wf.planned } : {}), done: progress.done,
    calls: wf.calls.map(c => {
      const r = c.result, last = r?.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
      return { key: c.key, gen: c.gen, callId: c.callId, phase: c.phase, ...modelStatus(c), ...commandStatus(c), ...(r ? { status: r.status, ok: r.ok } : {}),
        ...(c.sharedWorktree ? { sharedWorktree: c.sharedWorktree } : {}),
        ...(c.model ? { model: c.model } : {}), ...(c.tools ? { tools: c.tools } : {}), ...(c.pending ? { pending: c.pending } : {}), ...(c.switching ? { switching: c.switching } : {}), ...(c.switchFailed ? { switchFailed: c.switchFailed } : {}), ...(nonzero(c.usage) ? { usage: c.usage } : {}),
        ...(last ? { lastLine: clip(last, 200) } : {}), ...(r?.error ? { error: clip(r.error, 300) } : {}), ...(c.hibernated ? { hibernated: true as const } : {}),
        ...(c.answered ? { answered: c.answered } : {}), ...(c.answerForwarded ? { answerForwarded: c.answerForwarded } : {}), ...(c.writerWait && !r ? { writerWait: c.writerWait } : {}), ...(!r && leases?.get(c.callId) ? { lease: leases.get(c.callId) } : {}),
        ...(c.notesPending ? { notesPending: c.notesPending } : {}), ...(c.queuedFor && !r && !wf.paused ? { queued: queuedText(c.queuedFor) } : {}) };
    }),
    attention: wf.attention.map(a => ({ id: a.id, rev: a.rev, kind: a.kind, text: clip(a.text, 300), ...(a.call ? { call: a.call } : {}), ...(a.qid ? { qid: a.qid } : {}) })),
    ...(wf.paused ? { paused: true } : {}), ...(wf.followUps ? { followUps: wf.followUps } : {}), ...(wf.labels ? { labels: wf.labels } : {}),
  };
}

function origins(home: string): Map<string, string | undefined> {
  const ids = new Map<string, string | undefined>();
  const pruned = prunedIds(home);
  for (const [wid, origin] of readerLedger(home).state.origins) if (!pruned.has(wid)) ids.set(wid, origin as string | undefined);
  for (const wid of workflowIds(home)) if (!ids.has(wid)) ids.set(wid, undefined);
  return ids;
}

/** Every workflow with its origin and hold, own session first, then newest first. */
function snapshots(home: string, origin?: string): { all: WorkflowSnapshot[]; since?: number } {
  const own = (w: WorkflowSnapshot) => Number(!!origin && ownedBy(w, origin));
  const { since, held, labels, session } = heldWorkflows(home);
  const all = [...origins(home)].sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0).map(([wid, origin]) => {
    const wf = labelled(workflowSnapshot(home, wid), labels(wid), session(wid)), withOrigin = wf.origin === undefined && origin !== undefined ? { ...wf, origin } : wf;
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
    ...slotsView(home), ...(leases.length ? { leases: leaseLines(leases) } : {}), ...runningStats(home) };
}
/** The stats the running orchestrator published (none when no orchestrator runs). */
export function runningStats(home: string): { orchestratorStats?: OrchestratorStats } {
  const state = readerLedger(home).state.state;
  const o = state.orchestrator, stats = o && !o.exited && processAlive(o.pid, o.start) ? readStats(home, o.pid) : undefined;
  return stats ? { orchestratorStats: stats } : {};
}

const FINAL = ["done", "failed", "stopped"];
/** Finished with nothing left running (a follow-up on a finished workflow is live work). */
const settled = (w: WorkflowSnapshot) => FINAL.includes(w.status) && !w.followUps;
const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const tokens = (u?: Usage) => { const n = u ? u.input + u.output : 0; return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n); };
/** The latest generation of every key, in first-call order. */
const latestCalls = (wf: Pick<WorkflowSnapshot, "calls">) => [...new Map(wf.calls.map(c => [c.key, c] as const)).values()];

export interface BriefCall extends ModelStatus, CommandStatus {
  key: string; agent: string; phase: CallPhase; model?: string;
  sharedWorktree?: string[];
  /** Since the call started, and since its last activity (shown when quiet for a minute or more). */
  for?: string; quiet?: string;
  /** Input + output tokens so far: a running call at 0 has done nothing yet. */
  tokens?: string; status?: CallResult["status"]; error?: string;
  /** Hibernated: it holds no provider slot while it waits (P28). */
  hibernated?: true;
  /** Bound question id, until the next execution starts running. */
  answered?: string;
  answerForwarded?: AnswerForwarded;
  /** Writer lock: the worktree root this queued call waits for and the call that holds it ("<wid>/<key>"). */
  writerWait?: { root: string; holder: string };
  /** Resource leases (`pi-durable-subagents hold`): "holds lease machine" / "waiting for lease machine 3m". */
  lease?: string;
  /** `model` is the model in use; `switching` one requested and not answering yet; `switchFailed` a refused request. */
  switching?: string; switchFailed?: string;
  /** Notes (send kind "notify") recorded while the call was not running; its next follow-up carries them. */
  notesPending?: number;
  /** Why this queued call does not start, when known: "orchestrator starting (12s)", "waiting for the writer lock of
   *  <root>", "<provider> usage window used up", "waiting for a free slot (<provider> n/n)". */
  queued?: string;
}
export interface BriefWorkflow {
  wid: string; name?: string;
  /** The run's result; follow-ups leave a final status unchanged. */
  status: WorkflowSnapshot["status"];
  /** Work is still going in a latest-generation call (a follow-up when the run has finished). */
  active?: true;
  paused?: true;
  /** The run's labels on one clipped line, e.g. "[node=A3 attempt=2]" (the full labels: status wid=<wid>, describe). */
  labels?: string;
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
// Pi readers share the compact incremental fold in reader-ledger.ts.
/** The orchestrator running now (its last `orchestrator` record, without an exit, whose process lives), and a note when
 *  its version is not the one this process loaded: running work stays on the version it started with. */
export function orchestratorView(state: LedgerState, loaded = packageVersion(), now = Date.now()): { orchestrator?: string; versionNote?: string } {
  const o = state.orchestrator;
  if (!o || o.exited || !processAlive(o.pid, o.start)) return {};
  const r = o.forceRestart, note = r && now - r.ts < 24 * 60 * 60_000
    ? `; restarted by force ${age(now - r.ts)} ago by ${initiatorSummary(r.initiator, r.from)}: ${restartLine(r.reason ?? "no reason recorded")}` : "";
  // Still recovering the home's workflows: nothing is dispatched yet, whatever the slots say.
  const starting = orchestratorStarting(state), phase = starting ? `, starting ${age(now - starting.since)}` : "";
  return { orchestrator: `${o.version} (pid ${o.pid}${phase})${note}`, ...(o.version === loaded ? {} : { versionNote: versionNote(o.version, loaded) }) };
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

/** The first version whose orchestrator and child know send kind "notify". */
export const NOTIFY_SINCE = "1.0.28";
/** A refusal when the orchestrator running now predates `since` and is older than the version this process loaded (an
 *  older orchestrator would accept the request and its child would drop it); none when none runs (the next one starts
 *  on the installed version) or it is current. */
export function orchestratorTooOld(home: string, feature: string, since: string, loaded = packageVersion()): string | undefined {
  const state = readerLedger(home).state.state;
  const o = state.orchestrator;
  if (!o || o.exited || !processAlive(o.pid, o.start) || !newer(since, o.version) || !newer(loaded, o.version)) return undefined;
  return `the running orchestrator ${o.version} predates ${feature} (new in ${since}); restart it to the installed version ${loaded} first ` +
    `(\`pi-durable-subagents restart\` or the subagents tool's restart action), then send again`;
}
/** orchestratorView of the home's orchestrator ledger. */
export function runningOrchestrator(home: string): { orchestrator?: string; versionNote?: string } {
  const state = readerLedger(home).state.state;
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
/** A workflow origin as one short holder name: a pi session "main:<id>" as "session <first 8 of id>"; others as is. */
export function originLabel(origin: string | undefined): string {
  if (origin === undefined) return "unknown";
  return origin.startsWith("main:") ? `session ${origin.slice(5, 13)}` : clip(restartLine(origin), 40);
}
export function slotsView(home: string, now = Date.now()): Pick<StatusBrief, "slots" | "config" | "configRejected" | "exhausted" | "orchestrator" | "versionNote"> {
  const ix = readerLedger(home).state, state = ix.state;
  const { held, config, rejected } = state, used = state.exhausted;
  const exhausted = [...used].sort(([a], [b]) => a.localeCompare(b)).map(([p, x]) => exhaustedLine(p, x, now));
  const limits: Record<string, { slots?: number }> = config?.settings.providers ?? {};
  const holders = new Map<string, number>(), byOrigin = new Map<string, Map<string, number>>();
  const created = ix.created;
  for (const e of held.values()) if (e.pool !== "memory") {
    holders.set(e.pool, (holders.get(e.pool) ?? 0) + 1);
    // exec "<wid>@<rev>/<key>@<gen>#<n>" -> the origin of its workflow
    const origin = originLabel(created.get(e.exec.slice(0, e.exec.indexOf("@")))?.origin as string | undefined);
    const counts = byOrigin.get(e.pool) ?? new Map<string, number>(); byOrigin.set(e.pool, counts);
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  // Who holds a provider's slots, when more than one workflow origin does: "(3 cli:alice@host, 2 session 01a11a3b)".
  const who = (p: string) => {
    const counts = byOrigin.get(p);
    if (!counts || counts.size < 2) return "";
    return ` (${[...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([o, n]) => `${n} ${o}`).join(", ")})`;
  };
  const names = [...new Set([...Object.keys(limits), ...holders.keys()])].sort();
  const slots = names.map(p => slotLine(p, holders.get(p) ?? 0, limits[p]?.slots) + who(p));
  return { ...orchestratorView(state, packageVersion(), now), ...(slots.length ? { slots } : {}), ...(config ? { config: `${config.hash} since ${age(now - config.ts)} ago` } : {}),
    ...(exhausted.length ? { exhausted } : {}),
    ...(rejected ? { configRejected: `${clip(rejected.error, 200)} (${age(now - rejected.ts)} ago); ${config ? config.hash : "the start settings"} stay in effect` } : {}) };
}

/** Tool status without a wid: what runs, what waits for an answer and what failed, with finished workflows one line each.
 *  The full view (every call's last line and usage) ran to tens of thousands of tokens on a busy home. */
export function statusBrief(home: string, options: { origin?: string; keep?: number; now?: number } = {}): StatusBrief {
  const keep = options.keep ?? 5, now = options.now ?? Date.now(), origin = options.origin;
  const { all } = snapshots(home, origin), leases = leaseState(home), byCall = leaseCalls(leases, now);
  const mine = (w: WorkflowSnapshot) => !origin || ownedBy(w, origin);
  const line = (w: WorkflowSnapshot) => {
    const p = progressOf(w), notOk = latestCalls(w).filter(c => c.result && !c.result.ok).length;
    const notes = latestCalls(w).reduce((n, c) => n + (c.notesPending ?? 0), 0);
    return [w.wid, labelsText(w.labels), w.name, `${w.paused ? "paused" : w.followUps ? `follow-up running (run ${w.status})` : w.status}`, `${p.done}/${p.total}${p.plus ? "+" : ""} done`, notOk ? `${notOk} not ok` : "",
      notes ? `${notes} note${notes > 1 ? "s" : ""} pending` : "",
      w.endedAt !== undefined ? `ended ${age(now - w.endedAt)} ago` : w.startedAt !== undefined ? `started ${age(now - w.startedAt)} ago` : ""].filter(Boolean).join(" · ");
  };
  const brief = (w: WorkflowSnapshot): BriefWorkflow => {
    const p = progressOf(w), open = w.attention.filter(a => a.kind !== "finished");
    const calls = latestCalls(w).filter(c => c.phase !== "sealed" || (c.result && !c.result.ok) || c.notesPending).map((c): BriefCall => {
      // A command call shows its command, pid and age instead of a model, quiet time and tokens.
      const live = c.phase !== "sealed", quiet = c.lastActivity !== undefined ? now - c.lastActivity : undefined, agent = c.command === undefined;
      return { key: c.key, agent: c.agent, phase: c.phase, ...modelStatus(c), ...(c.model ? { model: c.model } : {}), ...commandStatus(c, now),
        ...(c.sharedWorktree ? { sharedWorktree: c.sharedWorktree } : {}),
        ...(live && c.startedAt !== undefined ? { for: age(now - c.startedAt) } : {}),
        ...(agent && live && c.phase !== "asking" && quiet !== undefined && quiet >= 60_000 ? { quiet: age(quiet) } : {}),
        ...(agent && live && c.startedAt !== undefined ? { tokens: tokens(c.usage) } : {}),
        ...(c.result ? { status: c.result.status, ...(c.result.error ? { error: clip(c.result.error, 200) } : {}) } : {}),
        ...(c.hibernated ? { hibernated: true as const } : {}), ...(c.answered ? { answered: c.answered } : {}), ...(c.answerForwarded ? { answerForwarded: c.answerForwarded } : {}), ...(live && c.writerWait ? { writerWait: c.writerWait } : {}),
        ...(live && byCall.get(c.callId) ? { lease: byCall.get(c.callId) } : {}),
        ...(live && c.switching ? { switching: c.switching } : {}), ...(live && c.switchFailed ? { switchFailed: c.switchFailed } : {}),
        ...(c.notesPending ? { notesPending: c.notesPending } : {}), ...(live && c.queuedFor && !w.paused ? { queued: queuedText(c.queuedFor, now) } : {}) };
    });
    const asking = open.filter(a => a.kind === "question" && a.call).map(a => ({ to: `${w.wid}/${callKey(a.call)}`, ...(a.qid ? { qid: a.qid } : {}),
      ...(w.calls.some(c => c.callId === a.call && c.hibernated) ? { hibernated: true as const } : {}), question: clip(a.text, 300) }));
    const alerts = open.filter(a => a.kind !== "question").map(a => `${a.kind}${a.call ? ` ${w.wid}/${callKey(a.call)}` : ""}: ${clip(a.text, 200)}`);
    return { wid: w.wid, ...(w.labels ? { labels: labelsText(w.labels) } : {}), ...(w.name ? { name: w.name } : {}), status: w.status, ...(w.active ? { active: true as const } : {}), ...(w.paused ? { paused: true as const } : {}), ...(w.followUps ? { followUps: w.followUps } : {}),
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

/** A call of a workflow queued behind a git worktree's writer lock: "<wid>/<key>", the holder "<wid>/<key>" and the
 *  worktree root. */
export interface WriterWaitNote { call: string; heldBy: string; cwd: string }
export const WRITER_WAIT_HINT = "a call waits for its worktree's writer lock (one call that may edit/write runs per worktree); writer:false (when it does not write there) or isolation:'worktree' opts out";
/** The unsealed calls of `wid` that wait for a writer lock now (a read of its journal; nothing waits for one). */
export function writerWaits(home: string, wid: string): WriterWaitNote[] {
  if (!existsSync(journalPath(home, wid))) return [];
  return latestCalls(workflowSnapshot(home, wid)).filter(c => c.writerWait && c.phase !== "sealed")
    .map(c => ({ call: `${wid}/${c.key}`, heldBy: c.writerWait!.holder, cwd: c.writerWait!.root }));
}
/** One line per waiting call: "<wid>/<key> held by <wid>/<key> (<cwd>)". */
export const writerWaitLine = (w: WriterWaitNote) => `${w.call} held by ${w.heldBy} (${w.cwd})`;

export type StatusCallDetail = Omit<CallSnapshot, "sends"> & { wid: string; sends?: CallSend[] };
export type StatusCompactDetail = Omit<StatusWorkflow, "calls"> & { cwd?: string; scriptLog?: string; result?: unknown;
  calls: (StatusCall & { agent: string; output?: string })[]; hint: string };
const OUTPUT = 600;
/** `status <wid>` line selection of each call's output: `grep` keeps the lines matching a JS regular expression
 *  (case-sensitive), then `tail` keeps the last N lines. */
export interface OutputSelect { tail?: number; grep?: string }
/** Most characters of one call's selected lines (the last ones are kept). */
export const SELECT_MAX = 4000;
/** A valid selection (throws a usage error otherwise); undefined when neither is given. */
export function outputSelect(tail: unknown, grep: unknown): (OutputSelect & { regex?: RegExp }) | undefined {
  if (tail === undefined && grep === undefined) return undefined;
  if (tail !== undefined && (!Number.isSafeInteger(tail) || Number(tail) < 1)) throw new Error("tail must be a positive integer (lines)");
  if (grep !== undefined && (typeof grep !== "string" || !grep)) throw new Error("grep must be a non-empty regular expression");
  let regex: RegExp | undefined;
  if (typeof grep === "string") try { regex = new RegExp(grep); } catch (error) { throw new Error(`grep is not a valid regular expression: ${(error as Error).message}`); }
  return { ...(tail !== undefined ? { tail: Number(tail) } : {}), ...(typeof grep === "string" ? { grep } : {}), ...(regex ? { regex } : {}) };
}
/** grep runs the caller's regular expression in this process (the pi session or the CLI): it tests at most the first
 *  GREP_LINE_CHARS characters of a line, and only the last GREP_MAX_LINES lines of each output, to bound its cost. */
export const GREP_LINE_CHARS = 2000, GREP_MAX_LINES = 5000;
/** The selected lines of `output`, unclipped up to SELECT_MAX characters (then its last SELECT_MAX, marked). */
export function selectLines(output: string, select: OutputSelect & { regex?: RegExp }): string {
  const regex = select.regex ?? (select.grep !== undefined ? new RegExp(select.grep) : undefined);
  let lines = output.replace(/\n+$/, "").split("\n"), skipped = 0;
  if (regex) {
    skipped = Math.max(0, lines.length - GREP_MAX_LINES);
    lines = lines.slice(skipped).filter(line => regex.test(line.length > GREP_LINE_CHARS ? line.slice(0, GREP_LINE_CHARS) : line));
  }
  if (select.tail !== undefined) lines = lines.slice(-select.tail);
  const text = lines.join("\n"), note = skipped ? `[${skipped} earlier lines not searched]\n` : "";
  return note + (text.length > SELECT_MAX ? `[${text.length - SELECT_MAX} earlier chars clipped]...${text.slice(-SELECT_MAX)}` : text);
}
/** Tool status with a wid: one workflow with each call's output clipped (the full detail repeated every output twice and
 *  reached ~100K characters); `key` gives one call in full. With `select`, each output is its selected lines instead. */
export function statusCompactDetail(home: string, wid: string, select?: OutputSelect & { regex?: RegExp }): StatusCompactDetail {
  const detail = statusDetail(home, wid), compact = compactWorkflow(detail);
  const byId = new Map(detail.calls.map(c => [c.callId, c]));
  const calls = compact.calls.map(({ lastLine: _l, ...c }) => {
    const full = byId.get(c.callId)!;
    if (select) return { ...c, agent: full.agent, ...(full.result ? { output: selectLines(full.result.output ?? "", select) } : {}) };
    const output = full.result?.output?.trim();
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
  const held = heldWorkflows(home), wf = labelled(workflowSnapshot(home, wid), held.labels(wid), held.session(wid)), log = scriptLogPath(home, wid);
  const calls = wf.calls.map(c => { const awaiting = awaitingRuns(home, wid, c.key, wf.rev); return awaiting ? { ...c, awaiting } : c; });
  return { ...wf, calls, ...(wf.origin === undefined && origin.get(wid) !== undefined ? { origin: origin.get(wid) } : {}), ...(existsSync(log) ? { scriptLog: log } : {}),
    ...(isLive(wf) && held.held(wid) ? { paused: true } : {}) };
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
        // A model switch names its target, and a failover (the executor moved the call off a used-up provider) its source.
        const envelope = e.envelope as { kind?: string; body?: { provider?: string; model?: string } } | undefined;
        const target = envelope?.kind === "model" && envelope.body?.model ? (envelope.body.provider ? `${envelope.body.provider}/${envelope.body.model}` : envelope.body.model) : undefined;
        add(e, "forward", { rid: e.rid, kind: envelope?.kind, dest: e.dest, model: target, failover: typeof e.failover === "string" ? e.failover : undefined }); break;
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
