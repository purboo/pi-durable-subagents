import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  // A display name that already names its provider ("GLM-5.3 (zhipu)") is never suffixed again.
  const named = (word: string) => Boolean(word) && new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(name);
  return suffix.toLowerCase() === family || named(provider) || named(suffix) ? name : `${name} (${suffix})`;
}
/** UI §2–3: Count committed tool calls compactly; zero is not shown. */
export const toolCount = (n: number | undefined) => n ? `${n} tool${n === 1 ? "" : "s"}` : "";
/** UI §2: Stable workflow order — own session first, then start time (oldest first), never by activity. */
export function orderWorkflows<T extends Pick<WorkflowSnapshot, "wid" | "origin" | "startedAt">>(workflows: readonly T[], own?: string): T[] {
  return [...workflows].sort((a, b) => Number(b.origin === own) - Number(a.origin === own) ||
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (a.wid < b.wid ? -1 : a.wid > b.wid ? 1 : 0));
}
/** UI §2: Done rows newest result first by immutable end time; ties keep snapshot order, so rows never reshuffle. */
export function doneOrder(calls: readonly CallSnapshot[]): CallSnapshot[] {
  return calls.map((c, i) => ({ c, i })).filter(x => x.c.phase === "sealed").sort((a, b) => (b.c.endedAt ?? 0) - (a.c.endedAt ?? 0) || a.i - b.i).map(x => x.c);
}
/** UI §2: Keep the selection on the same row id across refreshes and insertions; fall back to the old position. */
export function keepSelection(rows: readonly { id: string }[], id: string | undefined, fallback: number): number {
  const found = id === undefined ? -1 : rows.findIndex(r => r.id === id);
  return Math.max(0, Math.min(found >= 0 ? found : fallback, rows.length - 1));
}
/** UI §2: Compose a call row within `width`: model column dropped first (<60), then tool/age tail, then the phrase is cut. */
export function rowText(indent: string, key: string, model: string, phrase: string, tail: readonly string[], width: number): string {
  const head = `${indent}${key}  ${width >= 60 ? `${model}  ` : ""}`, end = tail.filter(Boolean).join("  ");
  const room = width - visibleWidth(head) - (end ? visibleWidth(end) + 2 : 0);
  if (!end || room < 12) return truncateToWidth(head + phrase, Math.max(1, width));
  return `${head}${truncateToWidth(phrase, room)}  ${end}`;
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

/** P37: Calls are named by key; later generations of a key carry their generation. */
export const label = (c: { key: string; gen: number }) => c.gen > 1 ? `${c.key}@${c.gen}` : c.key;

/** UI §1,4: One working sentence, or a completion sentence naming only exceptions. */
export function mainLine(workflows: readonly WorkflowSnapshot[]): string | undefined {
  if (!workflows.length) return undefined;
  const working = workflows.flatMap(w => w.calls).filter(c => c.phase !== "sealed").length;
  if (working) return `${working} subagent${working === 1 ? "" : "s"} working  ↓`;
  const w = workflows.filter(w => w.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (!w) return undefined;
  const latest = [...new Map(w.calls.map(c => [c.key, c])).values()]; // the newest generation of each key (P37)
  const good = latest.filter(c => c.result?.ok).length;
  const bad = latest.filter(c => failed(c)).map(c => c.key);
  const skipped = latest.filter(c => c.result?.status === "skipped").map(c => c.key);
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
    const text = rowText(indent, label(c), name(f?.model ?? c.model), statusPhrase(c, w, f, now), [toolCount(f?.tools), age], width);
    rows.push({ id: c.callId, kind: "call", workflow: w, call: c, failed: Boolean(failed(c)), text });
  };
  for (const w of visible) {
    if (w.calls.length === 1) { callRow(w, w.calls[0]!, "  "); continue; }
    // Stable order (UI §2): active rows keep proposal (snapshot) order; done rows by immutable end time.
    const done = doneOrder(w.calls), active = w.calls.filter(c => c.phase !== "sealed");
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
