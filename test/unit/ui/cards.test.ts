import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { card, registerCards } from "../../../src/ui/cards.ts";
import { CT } from "../../../src/types.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
test("UI §1: interaction cards are framed to the exact width and cap long bodies", () => {
  const lines = card(theme, "accent", "? Subagent writer asks the main agent", ["Is docs/ in the write set?", "x ".repeat(200)], 60);
  assert.match(lines[0]!, /^╭─ \? Subagent writer asks the main agent/); assert.match(lines.at(-1)!, /^╰─+╯$/);
  for (const line of lines) assert.equal(visibleWidth(line), 60);
  assert.ok(card(theme, "accent", "h", Array.from({ length: 20 }, (_, i) => `line ${i}`), 30).some(l => l.includes("more lines")));
  assert.equal(card(theme, "accent", "h", Array.from({ length: 20 }, (_, i) => `line ${i}`), 30, true).length, 22);
});
test("P15, P16: renderers registered for attention and notes; questions, finished and notes get distinct headings", () => {
  const renderers = new Map<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[] } | undefined>();
  registerCards({ registerMessageRenderer: (type: string, r: never) => renderers.set(type, r) } as never, "/nonexistent");
  const items = [{ id: "q:w@1/writer@1:q", rev: 1, kind: "question", text: "Which schema?", wid: "w", call: "w@1/writer@1" }, { id: "finished:w", rev: 1, kind: "finished", text: "demo (w) done: 3 ok.", wid: "w" }];
  const out = renderers.get(CT.attention)!({ details: { items } }, { expanded: false }, theme)!.render(60).join("\n");
  assert.match(out, /\? Subagent writer asks the main agent/); assert.match(out, /Which schema\?/); assert.match(out, /✓ Workflow finished/);
  assert.match(renderers.get(CT.note)!({ content: '[user] steered writer: "stop"' }, { expanded: false }, theme)!.render(60).join("\n"), /you, in the subagent view/);
});
