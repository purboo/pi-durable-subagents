// Read-only status snapshots (P25: `status` is always a fresh snapshot). Pure readers of committed journals:
// never depend on orchestrator memory, so the UI, the CLI and the main agent see the same durable state.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath, orchLedger, workflowDir } from "../paths.ts";
import { JT, type AttentionItem, type CallResult, type Entry } from "../types.ts";

export type CallPhase = "queued" | "running" | "asking" | "sealed";
export type Usage = { input: number; output: number; costUsd: number };
/** P7, P27: A request forwarded to a call: pending until the child's receipt is observed, or retired by the seal. */
export interface CallSend {
  rid: string; kind: string; state: "pending" | "delivered" | "retired";
  /** Wall-clock ms of the latest state change. */
  at: number;
  /** The child resolved it by rejecting it (e.g. `withdrawn`). */
  reason?: string;
}
export interface CallSnapshot {
  key: string; gen: number; callId: string; agent: string; phase: CallPhase;
  result?: CallResult; model?: string; exec?: string;
  pos?: number; refused?: string; reused?: string;
  /** Wall-clock ms of the latest durable evidence for this call (display only). */
  lastActivity?: number; startedAt?: number; endedAt?: number;
  /** P31: the sealed result's usage, else the committed usage entries so far. */
  usage?: Usage;
  /** Tool executions observed across the call's executions. */
  tools?: number;
  /** Forwarded requests in forward order; `pending` counts pending messages (steer, follow-up, answer). */
  sends?: CallSend[]; pending?: number;
}
export interface WorkflowSnapshot {
  wid: string; rev: number; name?: string; origin?: string; cwd?: string;
  status: "running" | "done" | "failed" | "parked" | "stopped";
  error?: string; result?: unknown;
  calls: CallSnapshot[];
  counts: Record<CallPhase, number>;
  attention: AttentionItem[];
  startedAt?: number; endedAt?: number;
  /** P31: every call ever charged to this workflow, across revisions (always set by snapshotFromEntries). */
  usage?: Usage;
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
export function snapshotFromEntries(wid: string, entries: readonly Entry[]): WorkflowSnapshot {
  const created = entries.find(e => e.type === "wf-created");
  const rev = Math.max(1, ...entries.filter(e => e.type === "wf-created" || e.type === "revised").map(e => Number(e.revision) || 1));
  const boundary = entries.findLastIndex(e => e.type === "revised");
  const current = entries.slice(Math.max(0, boundary));
  const terminal = current.findLast(e => e.type === JT.done || (e.type === "resumed" && !e.call));
  const done = terminal?.type === JT.done ? terminal : undefined;
  const calls = new Map<string, CallSnapshot>();
  const byExec = new Map<string, CallSnapshot>();
  const resolved = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => `${e.id}@${e.rev}`));
  const attention: AttentionItem[] = [];
  // P31: usage per call id, deduplicated by message id; a seal carries the authoritative total.
  const live = new Map<string, Usage>(), sealedUsage = new Map<string, Usage>(), seen = new Set<string>();
  const tools = new Map<string, number>();
  // P7, P27: forward / forward-delivered / forward-retired, by destination call; retirements carry only rid2.
  const sends = new Map<string, CallSend[]>(), byRid2 = new Map<string, CallSend>();
  for (const e of entries) {
    if (["call", "generation", "refused", "reused"].includes(e.type)) {
      if (boundary >= 0 && e.seq < entries[boundary]!.seq) continue;
      const key = String(e.key), gen = Number(e.gen) || (e.type === "refused" ? 0 : 1);
      const callId = e.type === "reused" ? String(e.from) : `${wid}@${rev}/${key}@${gen}`;
      const result = e.type === "refused" ? refusedResult(key, e.reason) :
        e.type === "reused" ? entries.find(s => s.type === JT.sealed && s.call === e.from)?.result as CallResult | undefined : undefined;
      calls.set(callId, { key, gen, callId, pos: Number(e.pos), agent: String((e.spec as { agent?: string } | undefined)?.agent ?? ""),
        phase: result ? "sealed" : "queued", ...(result ? { result, endedAt: e.ts } : {}),
        ...(e.type === "refused" ? { refused: String(e.reason) } : {}), ...(e.type === "reused" ? { reused: String(e.from) } : {}) });
    } else if (e.type === JT.exec) {
      const call = calls.get(String(e.call)); if (!call) continue;
      call.exec = String(e.exec); call.phase = "running"; call.startedAt ??= e.ts; call.lastActivity = e.ts; byExec.set(call.exec, call);
    } else if (e.type === "selected") {
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
      call.phase = "sealed"; call.result = e.result as CallResult; call.endedAt = e.ts;
    } else if (e.type === JT.attention) {
      const item = e.item as AttentionItem;
      if (!resolved.has(`${item.id}@${item.rev}`)) attention.push(item);
    } else if (e.type === "forward") {
      const send: CallSend = { rid: String(e.rid), kind: String((e.envelope as { kind?: string } | undefined)?.kind ?? ""), state: "pending", at: e.ts };
      const list = sends.get(String(e.dest)) ?? []; list.push(send); sends.set(String(e.dest), list);
      byRid2.set(`${e.dest}\n${e.rid2}`, send); byRid2.set(String(e.rid2), send);
    } else if (e.type === "forward-delivered" || e.type === "forward-retired") {
      const send = byRid2.get(e.type === "forward-delivered" ? `${e.call}\n${e.rid2}` : String(e.rid2));
      if (!send || send.state !== "pending") continue;
      send.state = e.type === "forward-delivered" ? "delivered" : "retired"; send.at = e.ts;
      if (e.type === "forward-delivered" && e.reason !== undefined) send.reason = String(e.reason);
    }
  }
  for (const item of attention) {
    const call = item.kind === "question" ? [...calls.values()].find(c => item.id.startsWith(`q:${c.callId}:`)) : undefined;
    if (call && call.phase === "running") call.phase = "asking";
  }
  const usageOf = (callId: string) => sealedUsage.get(callId) ?? live.get(callId);
  const list = [...calls.values()];
  const counts: Record<CallPhase, number> = { queued: 0, running: 0, asking: 0, sealed: 0 };
  for (const c of list) {
    counts[c.phase]++;
    const usage = usageOf(c.callId); if (usage) c.usage = { ...usage };
    const n = tools.get(c.callId); if (n) c.tools = n;
    const forwarded = sends.get(c.callId);
    if (forwarded) { c.sends = forwarded; const pending = forwarded.filter(pendingMessage).length; if (pending) c.pending = pending; }
  }
  const usage = zero();
  for (const id of new Set([...live.keys(), ...sealedUsage.keys()])) {
    const u = usageOf(id)!; usage.input += u.input; usage.output += u.output; usage.costUsd += u.costUsd;
  }
  return {
    wid, rev, ...(typeof created?.name === "string" ? { name: created.name } : {}),
    ...(created ? { origin: String(created.origin), cwd: String(created.cwd), startedAt: created.ts } : {}),
    status: done ? done.status as WorkflowSnapshot["status"] : "running",
    ...(done?.error ? { error: String(done.error) } : {}), ...(done && "result" in done ? { result: done.result } : {}),
    ...(done ? { endedAt: done.ts } : {}),
    calls: list, counts, attention, usage,
  };
}

/** P25: Snapshot one workflow from its durable journal. */
export function workflowSnapshot(home: string, wid: string): WorkflowSnapshot {
  return snapshotFromEntries(wid, readJournalSnapshot(journalPath(home, wid)));
}

/** Ops: wids archived by `prune` (orchestrator ledger `pruned{wid}`); they no longer exist for any reader. */
function prunedIds(home: string): Set<string> {
  return new Set(readJournalSnapshot(orchLedger(home)).filter(e => e.type === "pruned").map(e => String(e.wid)));
}

function workflowIds(home: string): string[] {
  let wids: string[] = [];
  try { wids = readdirSync(join(home, "w")).filter(n => !n.startsWith(".")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pruned = prunedIds(home);
  return wids.filter(wid => !pruned.has(wid));
}

/** P25: Snapshot every workflow under DSA_HOME (newest first by wid, which is a ULID). */
export function allWorkflows(home: string): WorkflowSnapshot[] {
  return workflowIds(home).sort().reverse().map(wid => workflowSnapshot(home, wid));
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
  status?: CallResult["status"]; ok?: boolean; model?: string; tools?: number; usage?: Usage;
  /** Messages forwarded to the call whose child receipt has not been observed yet (P7). */
  pending?: number;
  /** Last non-empty output line (clipped); the full output is in `status wid=<wid>`. */
  lastLine?: string; error?: string;
}
export interface StatusWorkflow {
  wid: string; name?: string; origin?: string; status: WorkflowSnapshot["status"]; rev: number;
  startedAt?: number; endedAt?: number; error?: string; usage: Usage; counts: Record<CallPhase, number>;
  calls: StatusCall[]; attention: Pick<AttentionItem, "id" | "rev" | "kind" | "text" | "call" | "qid">[];
}
export interface StatusView {
  workflows: StatusWorkflow[];
  /** Finished workflows older than the newest `keep` finished ones, collapsed (T10). */
  olderFinished?: number;
  hint?: string;
}
export type StatusDetail = WorkflowSnapshot & { scriptLog?: string };

/** P25, T10: Compact one workflow snapshot: per-call one-line facts, usage, open attention; no outputs or entries. */
export function compactWorkflow(wf: WorkflowSnapshot): StatusWorkflow {
  return {
    wid: wf.wid, ...(wf.name ? { name: wf.name } : {}), ...(wf.origin ? { origin: wf.origin } : {}), status: wf.status, rev: wf.rev,
    ...(wf.startedAt !== undefined ? { startedAt: wf.startedAt } : {}), ...(wf.endedAt !== undefined ? { endedAt: wf.endedAt } : {}),
    ...(wf.error ? { error: clip(wf.error, 500) } : {}), usage: wf.usage ?? zero(), counts: wf.counts,
    calls: wf.calls.map(c => {
      const r = c.result, last = r?.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
      return { key: c.key, gen: c.gen, callId: c.callId, phase: c.phase, ...(r ? { status: r.status, ok: r.ok } : {}),
        ...(c.model ? { model: c.model } : {}), ...(c.tools ? { tools: c.tools } : {}), ...(c.pending ? { pending: c.pending } : {}), ...(nonzero(c.usage) ? { usage: c.usage } : {}),
        ...(last ? { lastLine: clip(last, 200) } : {}), ...(r?.error ? { error: clip(r.error, 300) } : {}) };
    }),
    attention: wf.attention.map(a => ({ id: a.id, rev: a.rev, kind: a.kind, text: clip(a.text, 300), ...(a.call ? { call: a.call } : {}), ...(a.qid ? { qid: a.qid } : {}) })),
  };
}

function origins(home: string): Map<string, string | undefined> {
  const ids = new Map<string, string | undefined>();
  const pruned = prunedIds(home);
  for (const e of readJournalSnapshot(orchLedger(home))) if (e.type === JT.created && !pruned.has(String(e.wid))) ids.set(String(e.wid), e.origin as string | undefined);
  for (const wid of workflowIds(home)) if (!ids.has(wid)) ids.set(wid, undefined);
  return ids;
}

/** P25, T10: Compact status of all workflows: own session first, then newest first; finished ones beyond the first `keep` collapse into a count. */
export function statusView(home: string, options: { origin?: string; keep?: number } = {}): StatusView {
  const keep = options.keep ?? 10, own = (w: WorkflowSnapshot) => Number(!!options.origin && w.origin === options.origin);
  const all = [...origins(home)].sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0).map(([wid, origin]) => {
    const wf = workflowSnapshot(home, wid);
    return wf.origin === undefined && origin !== undefined ? { ...wf, origin } : wf;
  }).sort((a, b) => own(b) - own(a));
  let finished = 0;
  const shown = all.filter(w => !["done", "failed", "stopped"].includes(w.status) || ++finished <= keep);
  const hidden = all.length - shown.length;
  return { workflows: shown.map(compactWorkflow), ...(hidden ? { olderFinished: hidden, hint: "status wid=<wid> shows any workflow in detail" } : {}) };
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
      case JT.attention: { const a = e.item as AttentionItem; add(e, "attention", { kind: a.kind, id: a.id, rev: a.rev, text: clip(a.text, 300) }); break; }
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
