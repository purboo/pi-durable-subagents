// Read-only status snapshots (P25: `status` is always a fresh snapshot). Pure readers of committed journals:
// never depend on orchestrator memory, so the UI, the CLI and the main agent see the same durable state.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath } from "../paths.ts";
import { JT, type AttentionItem, type CallResult, type Entry } from "../types.ts";

export type CallPhase = "queued" | "running" | "asking" | "sealed";
export interface CallSnapshot {
  key: string; gen: number; callId: string; agent: string; phase: CallPhase;
  result?: CallResult; model?: string; exec?: string;
  pos?: number; refused?: string; reused?: string;
  /** Wall-clock ms of the latest durable evidence for this call (display only). */
  lastActivity?: number; startedAt?: number; endedAt?: number;
}
export interface WorkflowSnapshot {
  wid: string; rev: number; name?: string; origin?: string; cwd?: string;
  status: "running" | "done" | "failed" | "parked" | "stopped";
  error?: string; result?: unknown;
  calls: CallSnapshot[];
  counts: Record<CallPhase, number>;
  attention: AttentionItem[];
  startedAt?: number; endedAt?: number;
}

/** P25: Build a workflow snapshot from its journal entries alone. */
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
  for (const e of entries) {
    if (["call", "generation", "refused", "reused"].includes(e.type)) {
      if (boundary >= 0 && e.seq < entries[boundary]!.seq) continue;
      const key = String(e.key), gen = Number(e.gen) || (e.type === "refused" ? 0 : 1);
      const callId = e.type === "reused" ? String(e.from) : `${wid}@${rev}/${key}@${gen}`;
      const result = e.type === "refused" ? { key, gen, status: "failed" as const, ok: false, error: "spawn budget exceeded", output: "" } :
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
    } else if (e.type === "observation" || e.type === "tracked" || e.type === "time") {
      const call = byExec.get(String(e.exec)); if (call) call.lastActivity = e.ts;
    } else if (e.type === JT.sealed) {
      const call = calls.get(String(e.call)); if (!call) continue;
      call.phase = "sealed"; call.result = e.result as CallResult; call.endedAt = e.ts;
    } else if (e.type === JT.attention) {
      const item = e.item as AttentionItem;
      if (!resolved.has(`${item.id}@${item.rev}`)) attention.push(item);
    }
  }
  for (const item of attention) {
    const call = item.kind === "question" ? [...calls.values()].find(c => item.id.startsWith(`q:${c.callId}:`)) : undefined;
    if (call && call.phase === "running") call.phase = "asking";
  }
  const list = [...calls.values()];
  const counts: Record<CallPhase, number> = { queued: 0, running: 0, asking: 0, sealed: 0 };
  for (const c of list) counts[c.phase]++;
  return {
    wid, rev, ...(typeof created?.name === "string" ? { name: created.name } : {}),
    ...(created ? { origin: String(created.origin), cwd: String(created.cwd), startedAt: created.ts } : {}),
    status: done ? done.status as WorkflowSnapshot["status"] : "running",
    ...(done?.error ? { error: String(done.error) } : {}), ...(done && "result" in done ? { result: done.result } : {}),
    ...(done ? { endedAt: done.ts } : {}),
    calls: list, counts, attention,
  };
}

/** P25: Snapshot one workflow from its durable journal. */
export function workflowSnapshot(home: string, wid: string): WorkflowSnapshot {
  return snapshotFromEntries(wid, readJournalSnapshot(journalPath(home, wid)));
}

/** P25: Snapshot every workflow under DSA_HOME (newest first by wid, which is a ULID). */
export function allWorkflows(home: string): WorkflowSnapshot[] {
  let wids: string[] = [];
  try { wids = readdirSync(join(home, "w")).filter(n => !n.startsWith(".")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return wids.sort().reverse().map(wid => workflowSnapshot(home, wid));
}
