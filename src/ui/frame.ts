import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** UI §2: Pad or cut a styled line to exactly `width` columns so highlights and borders align. */
export function fitWidth(line: string, width: number): string {
  const cut = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** UI §2–3: Inner content size of a panel frame (one border column and one space on each side). */
export const inner = (width: number, height: number) => ({ width: Math.max(1, width - 4), height: Math.max(0, height - 2) });

/** UI §2–3, P21: Draw a panel with heavy accent borders (it floats over pi and must stand apart from the chat), a title
 *  and key hints in its borders; degrade unframed when too small. */
export function frame(lines: readonly string[], width: number, height: number, theme: Theme, title: string, hints: string): string[] {
  if (width < 8 || height < 3) return lines.slice(0, Math.max(1, height)).map(line => truncateToWidth(line, Math.max(1, width)));
  const size = inner(width, height), border = (text: string) => theme.bold(theme.fg("accent", text));
  const edge = (left: string, right: string, label: string, style: (text: string) => string) => {
    const text = label ? truncateToWidth(label, width - 6) : "";
    const fill = width - 2 - (text ? visibleWidth(text) + 3 : 0);
    return border(left + (text ? "━ " : "")) + (text ? style(text) + border(" ") : "") + border("━".repeat(Math.max(0, fill)) + right);
  };
  const body = Array.from({ length: size.height }, (_, i) => `${border("┃")} ${fitWidth(lines[i] ?? "", size.width)} ${border("┃")}`);
  return [edge("┏", "┓", title, text => theme.bold(theme.fg("accent", text))), ...body, edge("┗", "┛", hints, text => theme.fg("dim", text))];
}
