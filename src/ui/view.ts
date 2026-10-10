import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isLive, labelsText, liveCalls, ownedBy, progressOf, type CallSnapshot, type WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import type { CallStatus } from "../types.ts";
import type { sessionFacts } from "./session.ts";
import { oneLine } from "./frame.ts";

export type Facts = ReturnType<typeof sessionFacts>;
export interface ViewState {
  folded: Set<string>; done: Map<string, number>; viewed: Set<string>; finished: boolean;
  observed?: Map<string, { working: number; failures: Set<string> }>;
}
export interface ListRow { id: string; kind: "workflow" | "call" | "preview" | "done" | "more" | "finished"; text: string; workflow?: WorkflowSnapshot; call?: CallSnapshot; failed?: boolean; /** v12 §5: rows of finished workflows are dimmed, never hidden. */ dim?: boolean }
export type ModelName = (model: string | undefined) => string;

/** UI §2: Render compact wall-clock durations; never present these as charged active time. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  // Seconds keep ticking under an hour, so a running age never looks frozen (UI §2 liveness).
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
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
/** UI §3, P7: Messages sent to a call whose delivery the child has not confirmed yet; zero is not shown. */
export const pendingText = (n: number | undefined) => n ? `${n} message${n === 1 ? "" : "s"} pending` : "";
/** UI §2, P7: The list row's small pending marker (the watch header spells it out). */
export const pendingMarker = (n: number | undefined) => n ? `${n} pending` : "";
/** UI §2: Sessions are independent: only this session's workflows (it started them, or a run started from it named it
 *  as its session, e.g. a CLI driver launched from this pi). Working ones come first, newest start first; finished ones
 *  follow, most recently ended first. A workflow moves once, when it finishes (or a follow-up reopens it); the list
 *  keeps the selection on the same row id, so the cursor follows it. */
export function orderWorkflows<T extends Pick<WorkflowSnapshot, "wid" | "origin" | "session" | "startedAt" | "endedAt" | "status" | "followUps">>(workflows: readonly T[], own?: string): T[] {
  const tie = (a: T, b: T) => (a.wid < b.wid ? 1 : a.wid > b.wid ? -1 : 0);
  return workflows.filter(w => own === undefined || ownedBy(w, own))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a))
      || (isLive(a) ? (b.startedAt ?? 0) - (a.startedAt ?? 0) : (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
      || tie(a, b));
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
export function rowText(indent: string, key: string, model: string, phrase: string, tail: readonly string[], width: number, cols = { key: 0, model: 0 }): string {
  phrase = oneLine(phrase).replace(/ {2,}/g, " "); key = oneLine(key); // measured widths must be single-line widths
  const short = width < 70 ? model.replace(/\s*\([^)]*\)$/, "") : model; // narrow: drop the provider, keep the model
  const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - visibleWidth(text)));
  const end = tail.filter(Boolean).join(" · ");
  // A long phrase (a long command) is clipped; the tail (tools, age) stays. Under pressure the model column goes first.
  for (const showModel of width >= 40 ? [true, false] : [false]) {
    const head = `${indent}${pad(cols.key ? truncateToWidth(key, cols.key).replaceAll("\x1b[0m", "") : key, cols.key)}  ${showModel ? `${pad(short, width < 70 ? 0 : cols.model)}  ` : ""}`;
    const room = width - visibleWidth(head) - (end ? visibleWidth(end) + 2 : 0);
    // truncateToWidth closes its ellipsis with an SGR reset; drop it so a dimmed row stays dim to its end (tools, age).
    if (end && room >= 8) return `${head}${pad(truncateToWidth(phrase, room).replaceAll("\x1b[0m", ""), room)}  ${end}`;
    if (!end && showModel) return truncateToWidth(head + phrase, Math.max(1, width)).replaceAll("\x1b[0m", "");
  }
  return truncateToWidth(`${indent}${key}  ${phrase}`, Math.max(1, width)).replaceAll("\x1b[0m", "");
}
/** UI §5: A control's rejection in plain words for people; the model keeps the exact machine reason. */
export function plainReason(reason: string | undefined): string {
  const r = reason ?? "rejected", colon = r.indexOf(":"), code = colon < 0 ? r : r.slice(0, colon);
  const detail = colon < 0 ? "" : ` (${r.slice(colon + 1).split(" — ")[0]!.trim()})`;
  if (code === "terminal") return `the workflow already ended${detail}; start a new run instead`;
  if (code === "already-sealed") return `that subagent already finished${detail}`;
  if (code === "finished") return `that subagent already finished${detail}; use f to follow up`;
  if (code === "nothing-to-resume") return `nothing of this session is paused, so there is nothing to resume${r.includes("other sessions") ? `; ${r.slice(r.indexOf("paused in other sessions")).split(" — ")[0]}` : ""}`;
  if (code === "not-parked") return "it is already running";
  if (r === "already-answered" || r === "stale-question") return "that question was already answered";
  if (r === "switch-pending") return "a model switch is already on its way; it takes effect when the current step ends";
  if (r === "provider-full") return "that model's provider has no free slot right now";
  if (r === "call-not-running") return "the subagent is not running right now (waiting for a slot, paused or finished)";
  if (r === "unknown-model") return "unknown model";
  if (code === "unknown-call") return r.includes("use one of") ? `no such subagent; ${r.slice(r.indexOf("use one of"))}` : "no such subagent";
  return r;
}
/** UI §2: Prefer report phrases while retaining truthful terminal status and failure reasons. */
export function resultPhrase(call: CallSnapshot): string {
  const r = call.result;
  if (!r) return "done";
  const data = r.data as { summary?: unknown; phrase?: unknown } | undefined;
  const phrase = typeof data?.summary === "string" ? data.summary : typeof data?.phrase === "string" ? data.phrase : undefined;
  if (phrase) return phrase;
  // The overview shows what each finished agent concluded: its final line (legacy LEAF:/REVIEW: lines included).
  const last = r.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
  if (r.status === "ok") return last ? `done · ${last}` : "done";
  if (r.status === "skipped") return r.error ? `skipped (${r.error})` : "skipped";
  if (r.status === "parked") return r.error ? `parked: ${r.error}` : "parked";
  const word = resultWord(r.status); // v12 §4: stopped/timeout/budget/unknown keep their own word, never "failed"
  return r.error ? `${word}: ${r.error}` : word;
}
/** UI §2: Explain durable state in ordinary phrases without inventing retry or queue evidence. */
export function statusPhrase(call: CallSnapshot, workflow: WorkflowSnapshot, facts: Facts | undefined, now: number): string {
  if (call.phase === "sealed") return resultPhrase(call);
  const question = workflow.attention.find(a => a.kind === "question" && a.call === call.callId);
  if (question) return `asking main agent: ${question.text}`;
  const noProgress = workflow.attention.find(a => a.kind === "stall" && a.call === call.callId && a.id.startsWith("noprogress:"));
  // The alert's duration measures progress, whereas lastActivity also advances on provider retries.
  if (noProgress) return /no progress for [^(;]+/.exec(noProgress.text)?.[0].trim() ?? "no progress";
  if (workflow.attention.some(a => a.kind === "stall" && a.call === call.callId)) return `no activity for ${duration(now - Math.max(call.lastActivity ?? call.startedAt ?? now, facts?.lastActivity ?? 0))}`;
  if (call.phase === "queued") return workflow.paused ? "paused · r resumes" : "queued: waiting for a free slot";
  // Liveness (UI §2): the age of the newest evidence ticks, and resets whenever the agent does anything.
  const since = duration(Math.max(0, now - Math.max(call.lastActivity ?? 0, facts?.lastActivity ?? 0, call.startedAt ?? 0)));
  if (facts?.activity) return `${facts.activity} · ${since}`;
  // UI §3 "be pi": say what the model is really doing, from the child's live state, rather than guessing "thinking".
  const live = facts?.live, age = live ? duration(Math.max(0, now - live.since)) : "";
  if (live?.phase === "waiting") return `waiting for the model · ${age}`;
  if (live?.phase === "streaming") return live.tool ? `writing a ${live.tool} call · ${age}` : live.text ? `writing · ${age}` : `thinking · ${age}`;
  return `thinking · ${since}`;
}
function failed(c: CallSnapshot) { return c.phase === "sealed" && c.result && !c.result.ok && c.result.status !== "skipped"; }

/** UI §2, P37: Calls are named by key; later generations of a key carry their generation. */
export const label = (c: { key: string; gen: number }) => c.gen > 1 ? `${c.key}@${c.gen}` : c.key;
/** A key the spec did not name: generated from the launch form's position (tasks:0, chain:1). */
const GENERATED = /^(?:tasks|chain):(\d+)$/;
/** UI §2: How a person knows a call. A workflow's only agent goes by the workflow's name; a generated key (tasks:0) by
 *  its agent, numbered when the workflow runs that agent more than once; a named key as is. "@2" marks a later
 *  generation. The key stays the address for tools and the CLI; only the UI shows this name. */
export function callName(w: Pick<WorkflowSnapshot, "name" | "calls">, c: Pick<CallSnapshot, "key" | "gen" | "agent">): string {
  const keys = [...new Set(w.calls.map(x => x.key))], gen = c.gen > 1 ? `@${c.gen}` : "";
  if (keys.length === 1 && w.name) return `${w.name}${gen}`;
  if (!GENERATED.test(c.key)) return `${c.key}${gen}`;
  const peers = keys.filter(k => GENERATED.test(k) && w.calls.find(x => x.key === k)?.agent === c.agent)
    .sort((a, b) => Number(GENERATED.exec(a)![1]) - Number(GENERATED.exec(b)![1]));
  return `${c.agent}${peers.length > 1 ? ` ${peers.indexOf(c.key) + 1}` : ""}${gen}`;
}

const WORDS: Record<CallStatus, string> = { ok: "done", stopped: "stopped", failed: "failed", "gate-failed": "failed", timeout: "timeout", budget: "budget", unknown: "unknown", skipped: "skipped", parked: "parked" };
/** v12 §4: The result word of a sealed status — a stopped call is never called failed; timeout/budget/unknown are named as such. */
export const resultWord = (status: CallStatus): string => WORDS[status] ?? "failed";
const WORD_ORDER = ["done", "stopped", "failed", "timeout", "budget", "unknown", "skipped", "parked"];

/** UI §1,4, v12 §4: One working sentence; done/total uses planned totals, `n+` while a script workflow keeps proposing. */
export function summary(workflows: readonly WorkflowSnapshot[]): { working: number; asking: number; queued: number; paused: number; done: number; total: number; plus: boolean } {
  const running = workflows.filter(isLive), open = (w: WorkflowSnapshot) => liveCalls(w).length;
  const asking = running.reduce((n, w) => n + liveCalls(w).filter(c => w.attention.some(a => a.kind === "question" && a.call === c.callId)).length, 0);
  const paused = running.filter(w => w.paused).reduce((n, w) => n + open(w), 0); // held work is not working: it burns nothing
  // Waiting for a slot is not working either: nothing is spent until it launches.
  const queued = running.filter(w => !w.paused).reduce((n, w) => n + liveCalls(w).filter(c => c.phase === "queued" && !w.attention.some(a => a.kind === "question" && a.call === c.callId)).length, 0);
  const progress = running.map(progressOf);
  return { working: running.reduce((n, w) => n + open(w), 0) - asking - paused - queued, asking, queued, paused,
    done: progress.reduce((n, p) => n + p.done, 0), total: progress.reduce((n, p) => n + p.total, 0), plus: progress.some(p => p.plus) };
}
/** UI §1, v12 §4: What needs you first, then what is running, then progress — e.g. "1 asking · 3 working · 12/40 done". */
export function summaryText(workflows: readonly WorkflowSnapshot[]): string {
  const s = summary(workflows), finished = workflows.filter(w => !isLive(w)).length;
  if (!s.total) return finished ? `${finished} finished` : "nothing running";
  return [s.asking ? `${s.asking} asking` : "", s.working ? `${s.working} working` : "", s.queued ? `${s.queued} queued` : "", s.paused ? `${s.paused} paused` : "", `${s.done}/${s.total}${s.plus ? "+" : ""} done`].filter(Boolean).join(" · ");
}
export function mainLine(workflows: readonly WorkflowSnapshot[]): string | undefined {
  if (!workflows.length) return undefined;
  const s = summary(workflows);
  // The key that opens the list is spelled out: a bare arrow is easy to miss.
  if (s.working || s.asking || s.queued || s.paused) return `${summaryText(workflows)} · ↓ subagents`;
  const w = workflows.filter(w => !isLive(w)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (!w) return undefined;
  const latest = [...new Map(w.calls.map(c => [c.key, c])).values()]; // the newest generation of each key (P37)
  // v12 §4: the completion sentence uses result words, e.g. "3 done · 1 stopped · 1 failed".
  const words = new Map<string, number>();
  for (const c of latest) { const r = c.result; if (r) words.set(resultWord(r.status), (words.get(resultWord(r.status)) ?? 0) + 1); }
  const parts = WORD_ORDER.filter(word => words.has(word)).map(word => `${words.get(word)} ${word}`);
  return `${w.name ?? w.wid} finished: ${parts.join(" · ") || w.status} · ↓ subagents`;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** UI §1: The dock above the editor. While agents work: one row per active agent (questions first, at most `rows`),
 *  then one summary line; afterwards only the completion sentence for ten minutes; otherwise nothing. Activity spins
 *  only while there is fresh evidence, so a quiet agent visibly stops moving. */
export function dockLines(workflows: readonly WorkflowSnapshot[], facts: ReadonlyMap<string, Facts>, name: ModelName, width: number, now = Date.now(), rows = 3): string[] {
  const live = workflows.filter(isLive);
  const active = live.flatMap(w => {
    const latest = new Map<string, CallSnapshot>(); for (const c of w.calls) latest.set(c.key, c);
    const open = new Set(liveCalls(w));
    return [...latest.values()].filter(c => open.has(c)).map(c => ({ w, c, asking: w.attention.some(a => a.kind === "question" && a.call === c.callId) }));
  }).sort((a, b) => Number(b.asking) - Number(a.asking));
  if (!active.length) {
    const ended = workflows.filter(w => !isLive(w)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    const line = ended && now - (ended.endedAt ?? 0) < 10 * 60_000 ? mainLine(workflows) : undefined;
    return line ? [truncateToWidth(line, Math.max(1, width))] : [];
  }
  const cols = { key: Math.min(20, Math.max(...active.map(a => visibleWidth(callName(a.w, a.c))))), model: Math.min(20, Math.max(...active.map(a => visibleWidth(name(facts.get(a.c.callId)?.model ?? a.c.model))))) };
  const shown = active.slice(0, rows);
  const lines = shown.map(({ w, c, asking }) => {
    // A running tool is activity; otherwise a minute without new evidence (no message, no tool) stops the spinner.
    const f = facts.get(c.callId), fresh = Boolean(f?.activity) || now - Math.max(c.lastActivity ?? 0, f?.lastActivity ?? 0, c.startedAt ?? 0) < 60_000;
    const mark = asking ? "?" : c.phase === "queued" ? "·" : fresh ? SPIN[Math.floor(now / 500) % SPIN.length]! : "…";
    const phrase = asking ? `asks: ${w.attention.find(a => a.kind === "question" && a.call === c.callId)!.text}` : statusPhrase(c, w, f, now);
    return rowText(`${mark} `, callName(w, c), name(f?.model ?? c.model), phrase, [], width, cols);
  });
  const more = active.length - shown.length;
  lines.push(truncateToWidth(`${more ? `+${more} more · ` : ""}${summaryText(workflows)} · ↓ subagents`, Math.max(1, width)));
  return lines;
}

/** UI §2, v12 §5: Group workflows (finished ones stay listed, dimmed and expandable — never hidden behind a toggle),
 *  keep unviewed failures visible, and page newest done rows eight at a time. */
/** v12 §5: Whether a workflow shows its agents: running ones unless folded; finished ones once opened (Enter, or on completion). */
export function isOpen(w: WorkflowSnapshot, state: ViewState): boolean {
  return !state.folded.has(w.wid) && (isLive(w) || (state.done.get(w.wid) ?? 0) > 0);
}
/** v12 §5: Enter on a workflow row opens or closes it. */
export function toggleOpen(w: WorkflowSnapshot, state: ViewState): void {
  if (isOpen(w, state)) state.folded.add(w.wid);
  else { state.folded.delete(w.wid); if (!isLive(w)) state.done.set(w.wid, Math.max(8, state.done.get(w.wid) ?? 0)); }
}
export function listRows(workflows: readonly WorkflowSnapshot[], state: ViewState, facts: ReadonlyMap<string, Facts>, name: ModelName, width: number, now = Date.now()): ListRow[] {
  const rows: ListRow[] = [];
  state.observed ??= new Map();
  for (const w of workflows) {
    const previous = state.observed.get(w.wid);
    const working = w.calls.filter(c => c.phase !== "sealed").length;
    const failures = new Set(w.calls.filter(c => failed(c)).map(c => c.callId));
    const newFailure = [...failures].some(id => !state.viewed.has(id) && !previous?.failures.has(id));
    // Reopen only on an observed transition, so workflows first seen already finished stay compact.
    const completed = previous !== undefined && previous.working > 0 && working === 0;
    if (newFailure || completed) {
      state.done.set(w.wid, Math.max(8, state.done.get(w.wid) ?? 0));
      state.folded.delete(w.wid);
    }
    state.observed.set(w.wid, { working, failures });
  }
  const unviewed = (w: WorkflowSnapshot) => w.calls.some(c => failed(c) && !state.viewed.has(c.callId));
  const visible = workflows; // caller order: working first, then finished (orderWorkflows)
  // Aligned columns across the whole list (UI §2): key and model start at the same column on every row.
  const shownCalls = visible.flatMap(w => w.calls.map(c => ({ w, c })));
  const cols = { key: Math.min(24, Math.max(0, ...shownCalls.map(({ w, c }) => visibleWidth(callName(w, c))))),
    model: Math.min(26, Math.max(0, ...shownCalls.map(({ c }) => visibleWidth(name(facts.get(c.callId)?.model ?? c.model))))) };
  const callRow = (w: WorkflowSnapshot, c: CallSnapshot, indent: string, preview?: string, dim = false) => {
    const f = facts.get(c.callId), age = c.phase === "sealed" ? `${duration(now - (c.endedAt ?? now))} ago` : c.startedAt ? duration(now - c.startedAt) : "";
    // A requested switch shows at once (it applies when the current step ends; until then it would look as if it had failed).
    const shown = c.switching ? `${name(f?.model ?? c.model)} → ${name(c.switching)}` : name(f?.model ?? c.model);
    const text = rowText(indent, callName(w, c), shown, statusPhrase(c, w, f, now), [pendingMarker(c.pending), toolCount(f?.tools), age], width, cols);
    rows.push({ id: c.callId, kind: "call", workflow: w, call: c, failed: Boolean(failed(c)), dim, text });
    // Overview (UI §2): every active agent shows what it last said, thought or saw, without opening it.
    if (preview !== undefined && c.phase !== "sealed" && f?.latest) rows.push({ id: `${c.callId}:preview`, kind: "preview", workflow: w, call: c, dim, text: truncateToWidth(`${preview}${f.latest}`, Math.max(1, width)).replaceAll("\x1b[0m", "") });
  };
  for (const v of visible) {
    // One row per key: the newest generation (key@2) stands for the agent; older ones open from its watch view (← →).
    const latest = new Map<string, CallSnapshot>(); for (const c of v.calls) latest.set(c.key, c);
    const w = latest.size === v.calls.length ? v : { ...v, calls: v.calls.filter(c => latest.get(c.key) === c) };
    const dim = !isLive(w); // v12 §5: finished workflows are dimmed, not hidden; an open follow-up keeps one live
    if (w.calls.length === 1) { callRow(w, w.calls[0]!, "  ", "    ", dim); continue; }
    // Stable order (UI §2): active rows keep proposal (snapshot) order; done rows by immutable end time.
    const done = doneOrder(w.calls), active = liveCalls(w), folded = !isOpen(w, state);
    const progress = progressOf(w); // v12 §4: done/planned, `n+` while a script workflow keeps proposing
    const head = `${folded ? "▸" : "▾"} ${w.name ?? w.wid} · ${progress.done}/${progress.total}${progress.plus ? "+" : ""} · ${duration((w.endedAt ?? now) - (w.startedAt ?? now))}`;
    // The run's labels follow when the row has room for a useful part of them (clipped to at most 60 characters).
    const room = Math.min(60, width - visibleWidth(head) - 3);
    rows.push({ id: w.wid, kind: "workflow", workflow: w, dim, text: w.labels && room >= 12 ? `${head} · ${labelsText(w.labels, room)}` : head });
    if (folded) continue;
    if (dim) { // a finished workflow lists its agents directly (no nested "done" node)
      done.forEach((c, i) => callRow(w, c, i === done.length - 1 ? "  └ " : "  ├ ", undefined, dim));
      continue;
    }
    active.forEach((c, i) => { const last = i === active.length - 1 && !done.length; callRow(w, c, last ? "  └ " : "  ├ ", last ? "      " : "  │   ", dim); });
    if (!done.length) continue;
    const count = state.done.get(w.wid) ?? (isLive(w) && !active.length || unviewed(w) ? 8 : 0), shown = done.slice(0, count);
    rows.push({ id: `${w.wid}:done`, kind: "done", workflow: w, dim, text: `  └ ${count ? "▾" : "▸"} ${progress.done} done` });
    const more = count && done.length > count;
    shown.forEach((c, i) => callRow(w, c, i === shown.length - 1 && !more ? "      └ " : "      ├ ", undefined, dim));
    if (more) rows.push({ id: `${w.wid}:more`, kind: "more", workflow: w, dim, text: `      └ … ${done.length - count} more` });
  }
  return rows;
}
