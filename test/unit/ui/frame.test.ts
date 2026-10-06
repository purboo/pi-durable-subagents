import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { frame, fitWidth, inner } = await import("../../../src/ui/frame.ts");

// Emits real SGR sequences tagged by token, so widths are measured on styled output.
const codes: Record<string, number> = { borderAccent: 36, accent: 35, dim: 90, error: 31 };
const ansi = { fg: (c: string, s: string) => `\x1b[${codes[c] ?? 37}m${s}\x1b[39m`, bg: (_c: string, s: string) => `\x1b[44m${s}\x1b[49m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` } as Theme;

test("frame draws a heavy-bordered panel in the theme accent colour with title and hints", () => {
  for (const [width, height] of [[8, 3], [20, 6], [61, 10], [120, 40]] as const) {
    const lines = frame(["a", `\x1b[31m${"wide ".repeat(40)}\x1b[39m`, "日本語のテキスト".repeat(10)], width, height, ansi, "exec-0927 › E02", "3m · Esc back");
    assert.equal(lines.length, height);
    for (const line of lines) assert.equal(visibleWidth(line), width, JSON.stringify(line));
    const text = lines.map(line => stripVTControlCharacters(line));
    assert(text[0]!.startsWith("┏") && text[0]!.endsWith("┓") && text.at(-1)!.startsWith("┗") && text.at(-1)!.endsWith("┛"));
    assert(text.slice(1, -1).every(line => line.startsWith("┃ ") && line.endsWith(" ┃")));
    assert.equal(inner(width, height).height, height - 2);
  }
  const [top, , bottom] = frame([], 40, 3, ansi, "Subagents", "Esc back");
  assert(top!.startsWith("\x1b[1m\x1b[35m┏━ ") && top!.includes("\x1b[1m\x1b[35mSubagents"), top); // heavy accent border
  assert(bottom!.includes("\x1b[90mEsc back"), bottom);
  // Too small to frame: degrade to plain truncated lines rather than failing (P21).
  const small = frame(["abcdefgh", "x", "y"], 5, 2, ansi, "t", "h");
  assert.equal(small.length, 2); assert(small.every(line => visibleWidth(line) <= 5 && !line.includes("│")));
  assert.equal(visibleWidth(fitWidth("ab", 6)), 6); assert.equal(visibleWidth(fitWidth("abcdefgh", 4)), 4);
});
