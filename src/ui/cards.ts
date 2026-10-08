// UI §1, §4, P15, P16: subagent ↔ main-agent interactions render as framed cards in the main transcript, so the
// user sees at a glance that a subagent is asking, has finished, stalled, or that the user acted in the watch view.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CT, type AttentionItem } from "../types.ts";
import { attentionResolution, resolved } from "../agent/main/snapshots.ts";

type Tone = "accent" | "success" | "warning" | "error" | "muted";
const HEAD: Record<AttentionItem["kind"], { icon: string; title: string; tone: Tone }> = {
  question: { icon: "?", title: "asks the main agent", tone: "accent" },
  finished: { icon: "✓", title: "finished", tone: "success" },
  stall: { icon: "…", title: "no activity", tone: "warning" },
  unknown: { icon: "!", title: "outcome unknown", tone: "warning" },
  conflict: { icon: "!", title: "shares a worktree", tone: "warning" },
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
export function registerCards(pi: ExtensionAPI, home: string): () => boolean {
  const pending = new Map<string, AttentionItem>();
  const done = new Map<string, string>(); // resolution is monotone: once resolved, never re-read
  // pi renders every visible message on each frame; open cards re-read receipts at most once a second.
  const checked = new Map<string, number>();
  const resolution = (item: AttentionItem): string | undefined => {
    if (item.kind !== "question" && item.kind !== "stall") return undefined;
    const id = `${item.wid}:${item.id}@${item.rev}`;
    if (done.has(id)) { pending.delete(id); return done.get(id); }
    const now = Date.now();
    if (now - (checked.get(id) ?? -Infinity) < 1000) return undefined;
    checked.set(id, now);
    try {
      const reason = item.kind === "question" ? (resolved(home, item) ? "answered" : undefined) : attentionResolution(home, item);
      if (reason) { done.set(id, reason); checked.delete(id); pending.delete(id); return reason; }
    } catch { /* display only */ }
    return undefined;
  };
  pi.registerMessageRenderer<{ items?: AttentionItem[] }>(CT.attention, (message, options, theme) => {
    const items = message.details?.items;
    if (!items?.length) return undefined;
    for (const item of items) if (item.kind === "stall" || item.kind === "question") pending.set(`${item.wid}:${item.id}@${item.rev}`, item);
    // Reuse lines until width, theme, expansion or an attention resolution changes.
    let last: { key: string; lines: string[] } | undefined;
    const draw = (width: number) => items.flatMap(item => {
      const h = HEAD[item.kind] ?? HEAD.unknown, reason = resolution(item), closed = !!reason;
      const title = item.kind === "stall" && item.id.startsWith("noprogress:") ? "awaiting progress" : h.title;
      const status = item.kind === "question" ? "answered" : reason === "activity" || reason === "progress" ? "recovered" : reason === "ended" || reason === "retired" ? "ended" : "resolved";
      const heading = `${closed ? "✓" : h.icon} ${item.kind === "finished" && !item.call ? "Workflow" : `Subagent ${keyOf(item)}`} ${closed ? `— ${status}` : title}`;
      // v12 §3: a finished digest is first line + dim per-agent lines, clipped; old single-line items read exactly as before.
      const inner = Math.max(1, Math.max(3, Math.floor(width)) - 4);
      const body = item.kind === "finished" && !closed
        ? digestLines(item.text, line => theme.fg("dim", line), inner)
        : [closed ? theme.fg("dim", item.text) : item.text];
      return card(theme, closed ? "muted" : h.tone, heading, body, width, options.expanded);
    });
    return { invalidate() { last = undefined; }, render: (width: number) => {
      const key = `${width}|${items.map(item => resolution(item) ?? "").join("|")}`;
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
  // The existing UI refresh loop repaints receipts even when dock text did not change.
  return () => {
    const before = done.size;
    for (const item of pending.values()) resolution(item);
    return done.size !== before;
  };
}
