import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { plainReason } from "./view.ts";

type Args = Record<string, unknown>;
type Step = { key?: unknown; agent?: unknown };
const short = (id: unknown) => typeof id === "string" ? (id.length > 12 ? `${id.slice(0, 10)}…` : id) : "";
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** UI §5: One line per tool call: what was asked, never the raw arguments (scripts and task prompts stay out of the transcript). */
export function callLine(args: Args): string {
  const steps = (Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.chain) ? args.chain : []) as Step[];
  const agents = (list: Step[]) => {
    const counts = new Map<string, number>();
    for (const s of list) counts.set(String(s.agent ?? "?"), (counts.get(String(s.agent ?? "?")) ?? 0) + 1);
    return [...counts].map(([a, n]) => n > 1 ? `${a}×${n}` : a).join(", ");
  };
  switch (args.action) {
    case "run": {
      const what = Array.isArray(args.tasks) ? `${steps.length} in parallel (${agents(steps)})`
        : Array.isArray(args.chain) ? `chain of ${steps.length} (${steps.map(s => String(s.agent ?? "?")).join(" → ")})`
        : typeof args.source === "string" ? `workflow script (${args.source.split("\n").length} lines)`
        : typeof args.workflow === "string" ? `workflow ${args.workflow}` : `${String(args.agent ?? "?")}: ${clip(String(args.task ?? "").split("\n")[0]!, 70)}`;
      return `run ${typeof args.name === "string" ? `${args.name} · ` : ""}${what}`;
    }
    case "send": return `send ${String(args.kind ?? "")} → ${String(args.to ?? "")}${typeof args.message === "string" ? `: ${clip(args.message.split("\n")[0]!, 70)}` : typeof args.model === "string" ? `: ${args.model}` : ""}`;
    case "stop": return `stop ${String(args.target ?? "")}`;
    case "status": return typeof args.wid === "string" ? `status ${short(args.wid)}` : "status";
    case "resume": return typeof args.wid === "string" ? `resume ${short(args.wid)}` : "resume";
    case "revise": return `revise ${short(args.wid)}`;
    default: return String(args.action ?? "");
  }
}

type StatusRow = { wid: string; name?: string; status: string; calls: { phase: string; status?: string }[]; attention?: { kind: string }[] };
/** UI §5: The collapsed result: started / applied / rejected, or one line per workflow for status. */
export function resultLines(details: unknown): string[] {
  const d = (details ?? {}) as Record<string, unknown>;
  if (typeof d.wid === "string" && typeof d.key === "string" && typeof d.phase === "string") {
    const r = d.result as { status?: string } | undefined;
    return [`${d.key} · ${r?.status ?? d.phase}${typeof d.model === "string" ? ` · ${d.model}` : ""}`];
  }
  if (typeof d.wid === "string" && !Array.isArray(d.calls)) return [`started workflow ${d.wid}`, ...(typeof d.paused === "string" ? [`⚠ ${d.paused}`] : [])];
  if (d.applied === true) return ["✓ applied"];
  if (d.applied === false) return [`✗ not applied: ${plainReason(String(d.reason ?? ""))}`];
  if (d.submitted) return ["submitted; the orchestrator has not decided yet"];
  const row = (w: StatusRow) => {
    const done = w.calls.filter(c => c.phase === "sealed").length, failed = w.calls.filter(c => c.status && c.status !== "ok").length;
    const asks = (w.attention ?? []).filter(a => a.kind === "question").length;
    return `${w.name ?? short(w.wid)} · ${w.status} · ${done}/${w.calls.length} done${failed ? ` · ${failed} not ok` : ""}${asks ? ` · ${asks} asking` : ""}`;
  };
  if (Array.isArray(d.active)) {
    type Brief = { wid: string; name?: string; status: string; paused?: boolean; followUps?: number; progress: string; calls: { status?: string }[]; asking?: unknown[]; alerts?: unknown[] };
    const rows = (d.active as Brief[]).map(w => {
      const failed = w.calls.filter(c => c.status && c.status !== "ok").length, asks = w.asking?.length ?? 0, alerts = w.alerts?.length ?? 0;
      return `${w.name ?? short(w.wid)} · ${w.paused ? "paused" : w.followUps ? `${w.status}, follow-up running` : w.status} · ${w.progress} done${failed ? ` · ${failed} not ok` : ""}${asks ? ` · ${asks} asking` : ""}${alerts ? ` · ${alerts} alert${alerts > 1 ? "s" : ""}` : ""}`;
    });
    const finished = Array.isArray(d.finished) ? d.finished.length + Number(d.olderFinished ?? 0) : 0;
    return [...(typeof d.paused === "string" ? [`⚠ ${d.paused}`] : []), ...(rows.length ? rows.slice(0, 6) : ["nothing running"]),
      ...(rows.length > 6 ? [`… ${rows.length - 6} more`] : []), ...(finished ? [`${finished} finished`] : [])];
  }
  if (Array.isArray(d.workflows)) {
    const rows = (d.workflows as StatusRow[]).map(row);
    return [...(typeof d.paused === "string" ? [`⚠ ${d.paused}`] : []), ...(rows.length ? rows.slice(0, 6) : ["no workflows"]), ...(rows.length > 6 ? [`… ${rows.length - 6} more`] : [])];
  }
  if (Array.isArray(d.calls) && typeof d.wid === "string") return [row(d as unknown as StatusRow)];
  return [];
}

/** UI §5: Renderers for the subagents tool; expanded results keep the full JSON the model saw. */
export const toolRenderers = {
  renderCall(args: Args, theme: Theme) {
    return new Text(theme.fg("toolTitle", theme.bold("subagents ")) + theme.fg("muted", callLine(args)), 0, 0);
  },
  renderResult(result: { content: { type: string; text?: string }[]; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme) {
    const raw = result.content.map(c => c.type === "text" ? c.text ?? "" : "").join("\n");
    const lines = result.details === undefined ? [] : resultLines(result.details);
    if (options.expanded || !lines.length) {
      let text = raw; try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* Errors are plain text. */ }
      return new Text(options.expanded ? text : clip(text.split("\n")[0] ?? "", 200), 0, 0);
    }
    return new Text(lines.map((l, i) => i === 0 ? l : theme.fg("dim", l)).join("\n"), 0, 0);
  },
};
