// UI §1, §4, P15, P16: subagent ↔ main-agent interactions render as framed cards in the main transcript, so the
// user sees at a glance that a subagent is asking, has finished, stalled, or that the user acted in the watch view.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CT, type AttentionItem } from "../types.ts";
import { resolved } from "../agent/main/snapshots.ts";

type Tone = "accent" | "success" | "warning" | "error" | "muted";
const HEAD: Record<AttentionItem["kind"], { icon: string; title: string; tone: Tone }> = {
  question: { icon: "?", title: "asks the main agent", tone: "accent" },
  finished: { icon: "✓", title: "finished", tone: "success" },
  stall: { icon: "…", title: "no activity", tone: "warning" },
  unknown: { icon: "!", title: "outcome unknown", tone: "warning" },
  budget: { icon: "$", title: "budget reached", tone: "warning" },
};
const keyOf = (item: AttentionItem) => item.call ? item.call.split("/").at(-1)!.replace(/@1$/, "") : item.wid;

/** v12 §3: The finished digest body — first line prominent, per-agent lines dim, each clipped to the card's inner width. */
export function digestLines(text: string, dim: (line: string) => string, width: number): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [truncateToWidth(first, Math.max(1, width)), ...rest.filter(line => line.trim()).map(line => dim(truncateToWidth(line, Math.max(1, width))))];
}

/** UI §1: A rounded card in the tone's colour: heading in the top border, wrapped body lines inside. */
export function card(theme: Theme, tone: Tone, heading: string, body: readonly string[], width: number, expanded = false): string[] {
  const w = Math.max(3, Math.floor(width)), inner = w - 4, border = (t: string) => theme.fg(tone, t);
  const head = truncateToWidth(` ${heading} `, w - 3);
  const lines = [border("╭─") + theme.bold(theme.fg(tone, head)) + border("─".repeat(Math.max(0, w - 3 - visibleWidth(head))) + "╮")];
  const wrapped = body.flatMap(line => wrapTextWithAnsi(line, Math.max(1, inner)));
  const shown = expanded ? wrapped : wrapped.slice(0, 6);
  for (const line of shown) lines.push(`${border("│")} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${border("│")}`);
  if (shown.length < wrapped.length) {
    const more = theme.fg("dim", truncateToWidth(`… ${wrapped.length - shown.length} more lines (expand to see all)`, inner));
    lines.push(`${border("│")} ${more}${" ".repeat(Math.max(0, inner - visibleWidth(more)))} ${border("│")}`);
  }
  lines.push(border(`╰${"─".repeat(w - 2)}╯`));
  return lines;
}

/** P15, P16: Register renderers for attention presentations and watch-view notes in the main session. */
export function registerCards(pi: ExtensionAPI, home: string): void {
  const done = new Set<string>(); // resolution is monotone: once resolved, never re-read
  // pi renders every visible message on each frame; an open question re-reads its child session at most once a second.
  const checked = new Map<string, number>();
  const isResolved = (item: AttentionItem) => {
    const id = `${item.id}@${item.rev}`;
    if (done.has(id)) return true;
    const now = Date.now();
    if (now - (checked.get(id) ?? -Infinity) < 1000) return false;
    checked.set(id, now);
    try { if (resolved(home, item)) { done.add(id); checked.delete(id); return true; } } catch { /* display only */ }
    return false;
  };
  pi.registerMessageRenderer<{ items?: AttentionItem[] }>(CT.attention, (message, options, theme) => {
    const items = message.details?.items;
    if (!items?.length) return undefined;
    // The lines depend only on width, expansion, theme and which questions are answered: reuse them across frames.
    let last: { key: string; lines: string[] } | undefined;
    const draw = (width: number) => items.flatMap(item => {
      const h = HEAD[item.kind] ?? HEAD.unknown, closed = item.kind === "question" && isResolved(item);
      const title = item.kind === "stall" && item.id.startsWith("noprogress:") ? "no progress" : h.title;
      const heading = `${h.icon} ${item.kind === "finished" && !item.call ? "Workflow" : `Subagent ${keyOf(item)}`} ${closed ? "— answered" : title}`;
      // v12 §3: a finished digest is first line + dim per-agent lines, clipped; old single-line items read exactly as before.
      const inner = Math.max(1, Math.max(3, Math.floor(width)) - 4);
      const body = item.kind === "finished" && !closed
        ? digestLines(item.text, line => theme.fg("dim", line), inner)
        : [closed ? theme.fg("dim", item.text) : item.text];
      return card(theme, closed ? "muted" : h.tone, heading, body, width, options.expanded);
    });
    return { invalidate() { last = undefined; }, render: (width: number) => {
      const key = `${width}|${items.map(item => item.kind === "question" && isResolved(item) ? 1 : 0).join("")}`;
      if (last?.key !== key) last = { key, lines: draw(width) };
      return last.lines;
    } };
  });
  pi.registerMessageRenderer(CT.note, (message, options, theme) => {
    const text = typeof message.content === "string" ? message.content : "";
    let last: { width: number; lines: string[] } | undefined;
    return { invalidate() { last = undefined; }, render: (width: number) => {
      if (last?.width !== width) last = { width, lines: card(theme, "muted", "you, in the subagent view", text.split("\n"), width, options.expanded) };
      return last.lines;
    } };
  });
}
