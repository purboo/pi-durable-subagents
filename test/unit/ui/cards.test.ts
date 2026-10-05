import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { card, digestLines, registerCards } from "../../../src/ui/cards.ts";
import { CT } from "../../../src/types.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const ansiTheme = { fg: (c: string, t: string) => c === "dim" ? `\u001b[2m${t}\u001b[22m` : t, bold: (t: string) => t } as never;
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
  assert.ok(out.includes("demo (w) done: 3 ok."), "old single-line finished items read exactly as before");
  assert.match(renderers.get(CT.note)!({ content: '[user] steered writer: "stop"' }, { expanded: false }, theme)!.render(60).join("\n"), /you, in the subagent view/);
});
test("v12 §3: the finished digest renders compactly — first line prominent, per-agent lines dim and clipped", () => {
  const renderers = new Map<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[] } | undefined>();
  registerCards({ registerMessageRenderer: (type: string, r: never) => renderers.set(type, r) } as never, "/nonexistent");
  const digest = ["demo (w) stopped: 3 done · 1 stopped. Usage: 1.2K in / 15.0K out, $0.42. Details: subagents status.",
    "- a: ok — fixed the lease test", "- b: stopped — by user", `- c: failed — ${"x".repeat(90)}`].join("\n");
  const render = (width: number, expanded = false) => renderers.get(CT.attention)!({ details: { items: [{ id: "finished:w", rev: 1, kind: "finished", text: digest, wid: "w" }] } }, { expanded }, ansiTheme)!.render(width);
  const lines = render(60);
  for (const line of lines) assert.equal(visibleWidth(line), 60, `width: ${line}`);
  const body = lines.slice(1, -1);
  assert.match(body[0]!, /demo \(w\) stopped: 3 done · 1 stopped\./);
  assert.ok(!body[0]!.includes("\u001b[2m"), "the first line is prominent, not dim");
  assert.ok(body[1]!.includes("\u001b[2m- a: ok — fixed the lease test"), "per-agent lines are dim");
  assert.ok(body[2]!.includes("\u001b[2m- b: stopped — by user"), "a stopped agent is named stopped");
  assert.ok(body[3]!.includes("\u001b[2m- c: failed — xxxx"), "agent lines are clipped to the card width, not wrapped");
  assert.equal(lines.length, 6, "one card line per digest line: clipped, never wrapped");
  // the compact card still caps and expands like any card
  const many = ["head", ...Array.from({ length: 12 }, (_, i) => `- a${i}`)].join("\n");
  const capped = renderers.get(CT.attention)!({ details: { items: [{ id: "finished:w", rev: 1, kind: "finished", text: many, wid: "w" }] } }, { expanded: false }, theme)!.render(40);
  assert.ok(capped.some(l => l.includes("more lines")));
  assert.ok(renderers.get(CT.attention)!({ details: { items: [{ id: "finished:w", rev: 1, kind: "finished", text: many, wid: "w" }] } }, { expanded: true }, theme)!.render(40).length > capped.length);
});
test("v12 §3: digestLines clips each line and dims only the per-agent tail", () => {
  const lines = digestLines(["first", "", "- a: ok", "- b: failed"].join("\n"), s => `<d>${s}</d>`, 8);
  assert.deepEqual(lines.slice(0, 2), ["first", "<d>- a: ok</d>"]);
  assert.ok(lines[2]!.startsWith("<d>- b: "), "the tail is clipped to the width, empty lines dropped");
  assert.ok(visibleWidth(lines[2]!.replace(/<\/?d>/g, "")) <= 8, "the clipped text fits the width");
});
