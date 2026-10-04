import type { CallSnapshot, WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import type { sessionFacts } from "./session.ts";

export type Facts = ReturnType<typeof sessionFacts>;
export interface ViewState {
  folded: Set<string>; done: Map<string, number>; viewed: Set<string>; finished: boolean;
  observed?: Map<string, { working: number; failures: Set<string> }>;
}
export interface ListRow { id: string; kind: "workflow" | "call" | "done" | "more" | "finished"; text: string; workflow?: WorkflowSnapshot; call?: CallSnapshot; failed?: boolean }
export type ModelName = (model: string | undefined) => string;

/** UI §2: Render compact wall-clock durations; never present these as charged active time. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
/** UI §2: Resolve human model names and suppress repeated provider family suffixes. */
export function modelLabel(model: string | undefined, find: (provider: string, id: string) => { name: string } | undefined, aliases: Record<string, string> = {}): string {
  if (!model) return "—";
  const slash = model.indexOf("/"), provider = model.slice(0, slash), id = model.slice(slash + 1).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
  if (slash < 0) return aliases[model] ?? model;
  const name = aliases[`${provider}/${id}`] ?? find(provider, id)?.name ?? id;
  const matched = /claude|gpt|gemini|deepseek|glm|opus|sonnet|haiku/i.exec(`${id} ${name}`)?.[0]?.toLowerCase();
  const family = matched && ["opus", "sonnet", "haiku"].includes(matched) ? "claude" : matched;
  const suffix = family && provider.toLowerCase().endsWith(`-${family}`) ? provider.slice(0, -family.length - 1) : provider;
  return suffix.toLowerCase() === family ? name : `${name} (${suffix})`;
}
/** UI §2: Prefer report phrases while retaining truthful terminal status and failure reasons. */
export function resultPhrase(call: CallSnapshot): string {
  const r = call.result;
  if (!r) return "done";
  const data = r.data as { summary?: unknown; phrase?: unknown } | undefined;
  const phrase = typeof data?.summary === "string" ? data.summary : typeof data?.phrase === "string" ? data.phrase : undefined;
  if (phrase) return phrase;
  if (r.status === "ok") return "done";
  if (r.status === "skipped") return r.error ? `skipped (${r.error})` : "skipped";
  if (r.status === "parked") return r.error ? `parked: ${r.error}` : "parked";
  return `failed: ${r.error ?? r.status}`;
}
/** UI §2: Explain durable state in ordinary phrases without inventing retry or queue evidence. */
export function statusPhrase(call: CallSnapshot, workflow: WorkflowSnapshot, facts: Facts | undefined, now: number): string {
  if (call.phase === "sealed") return resultPhrase(call);
  const question = workflow.attention.find(a => a.kind === "question" && a.call === call.callId);
  if (question) return `asking main agent: ${question.text}`;
  if (workflow.attention.some(a => a.kind === "stall" && a.call === call.callId)) return `no activity for ${duration(now - Math.max(call.lastActivity ?? call.startedAt ?? now, facts?.lastActivity ?? 0))}`;
  if (call.phase === "queued") return "queued: waiting for capacity";
  return facts?.activity ?? "thinking";
}
function failed(c: CallSnapshot) { return c.phase === "sealed" && c.result && !c.result.ok && c.result.status !== "skipped"; }

/** UI §1,4: One working sentence, or a completion sentence naming only exceptions. */
export function mainLine(workflows: readonly WorkflowSnapshot[]): string | undefined {
  if (!workflows.length) return undefined;
  const working = workflows.flatMap(w => w.calls).filter(c => c.phase !== "sealed").length;
  if (working) return `${working} subagent${working === 1 ? "" : "s"} working  ↓`;
  const w = workflows.filter(w => w.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (!w) return undefined;
  const good = w.calls.filter(c => c.result?.ok).length;
  const bad = w.calls.filter(c => failed(c)).map(c => c.key);
  const skipped = w.calls.filter(c => c.result?.status === "skipped").map(c => c.key);
  return `${w.name ?? w.wid} finished: ${[good ? `${good} done` : "", bad.length ? `${bad.join(", ")} failed` : "", skipped.length ? `${skipped.join(", ")} skipped` : ""].filter(Boolean).join("; ") || w.status}.  ↓`;
}

/** UI §2: Group workflows, keep unviewed failures visible, and page newest done rows eight at a time. */
export function listRows(workflows: readonly WorkflowSnapshot[], state: ViewState, facts: ReadonlyMap<string, Facts>, name: ModelName, width: number, now = Date.now()): ListRow[] {
  const rows: ListRow[] = [];
  state.observed ??= new Map();
  for (const w of workflows) {
    const previous = state.observed.get(w.wid);
    const working = w.calls.filter(c => c.phase !== "sealed").length;
    const failures = new Set(w.calls.filter(c => failed(c)).map(c => c.callId));
    const newFailure = [...failures].some(id => !state.viewed.has(id) && !previous?.failures.has(id));
    if (newFailure || (!working && previous?.working !== 0)) {
      state.done.set(w.wid, Math.max(8, state.done.get(w.wid) ?? 0));
      state.folded.delete(w.wid);
    }
    state.observed.set(w.wid, { working, failures });
  }
  const unviewed = (w: WorkflowSnapshot) => w.calls.some(c => failed(c) && !state.viewed.has(c.callId));
  const finished = workflows.filter(w => w.status !== "running" && !unviewed(w));
  const visible = workflows.filter(w => w.status === "running" || unviewed(w));
  visible.sort((a, b) => Number(unviewed(b)) - Number(unviewed(a)) || Number(a.calls.length === 1) - Number(b.calls.length === 1));
  if (state.finished) visible.push(...finished);
  const callRow = (w: WorkflowSnapshot, c: CallSnapshot, indent: string) => {
    const f = facts.get(c.callId), age = c.phase === "sealed" ? `${duration(now - (c.endedAt ?? now))} ago` : c.startedAt ? duration(now - c.startedAt) : "";
    rows.push({ id: c.callId, kind: "call", workflow: w, call: c, failed: Boolean(failed(c)), text: `${indent}${c.key}  ${width >= 60 ? `${name(f?.model ?? c.model)}  ` : ""}${statusPhrase(c, w, f, now)}${age ? `  ${age}` : ""}` });
  };
  for (const w of visible) {
    if (w.calls.length === 1) { callRow(w, w.calls[0]!, "  "); continue; }
    const done = w.calls.filter(c => c.phase === "sealed").sort((a, b) => Number(Boolean(failed(b) && !state.viewed.has(b.callId))) - Number(Boolean(failed(a) && !state.viewed.has(a.callId))) || (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const active = w.calls.filter(c => c.phase !== "sealed").sort((a, b) => Math.max(b.lastActivity ?? 0, facts.get(b.callId)?.lastActivity ?? 0) - Math.max(a.lastActivity ?? 0, facts.get(a.callId)?.lastActivity ?? 0));
    rows.push({ id: w.wid, kind: "workflow", workflow: w, text: `  ${w.name ?? w.wid} · ${done.length}/${w.calls.length} · ${duration((w.endedAt ?? now) - (w.startedAt ?? now))}` });
    if (state.folded.has(w.wid)) continue;
    for (const c of active) callRow(w, c, "    ");
    if (!done.length) continue;
    const count = state.done.get(w.wid) ?? (!active.length || unviewed(w) ? 8 : 0);
    rows.push({ id: `${w.wid}:done`, kind: "done", workflow: w, text: `    ${done.length} done` });
    for (const c of done.slice(0, count)) callRow(w, c, "    ");
    if (count && done.length > count) rows.push({ id: `${w.wid}:more`, kind: "more", workflow: w, text: `    ${done.length - count} more` });
  }
  if (finished.length) rows.push({ id: "finished", kind: "finished", text: `  ${finished.length} finished workflow${finished.length === 1 ? "" : "s"}` });
  return rows;
}
