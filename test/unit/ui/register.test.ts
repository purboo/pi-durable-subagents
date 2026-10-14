import { after, test } from "node:test";
import assert from "node:assert/strict";
import { clean, root } from "./fixture.ts";
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
const { registerUi } = await import("../../../src/ui/index.ts");
after(clean);

test("RPC, print, missing surfaces register no widgets, shortcuts or input handlers", () => {
  for (const mode of ["rpc", "print", "json", "tui"]) {
    const hooks = new Map<string, Function>();
    const pi = { on: (name: string, fn: Function) => hooks.set(name, fn) } as unknown as ExtensionAPI;
    registerUi(pi, { home: root, submit: async () => { throw new Error("must not send"); }, presentNote() {} });
    const ui = new Proxy({}, { get() { throw new Error("UI must not be accessed"); } });
    assert.doesNotThrow(() => hooks.get("session_start")!({}, { mode, hasUI: mode !== "tui", ui }));
    hooks.get("session_shutdown")!();
  }
});

test("interactive registration and cleanup are idempotent; empty-editor gesture stays guarded", () => {
  const hooks = new Map<string, Function>(); let listener: TerminalInputHandler | undefined, removed = 0;
  const pi = { on: (name: string, fn: Function) => hooks.set(name, fn) } as unknown as ExtensionAPI;
  registerUi(pi, { home: root, submit: async () => {}, presentNote() {} });
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "test" }, ui: {
    custom: async () => { throw new Error("should not open when no workflows exist"); },
    setWidget() {}, getEditorText: () => "", onTerminalInput: (fn: TerminalInputHandler) => { listener = fn; return () => { removed++; }; },
  } } as unknown as ExtensionContext;
  hooks.get("session_start")!({}, ctx); assert.equal(listener!("\x1b[B"), undefined);
  hooks.get("session_start")!({}, ctx); assert.equal(removed, 1);
  hooks.get("session_shutdown")!(); hooks.get("session_shutdown")!(); assert.equal(removed, 2);
});

for (const dock of ["line", "off"]) test(`resolved cards request a repaint with an unchanged ${dock} dock`, async t => {
  const { join } = await import("node:path");
  const { writeFileSync } = await import("node:fs");
  const { openJournal } = await import("../../../src/kernel/journal.ts");
  const { journalPath } = await import("../../../src/paths.ts");
  const { CT, JT } = await import("../../../src/types.ts");
  const home = join(root, `repaint-${dock}`), journal = await openJournal(journalPath(home, "run"));
  t.after(() => journal.close());
  writeFileSync(join(home, "config.json"), JSON.stringify({ ui: { dock } }));
  let now = Date.now(), refresh = () => {}, paints = 0;
  t.mock.method(Date, "now", () => now);
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (fn: () => void) => { refresh = fn; return interval(fn, 1_000_000); });
  const hooks = new Map<string, Function>(), renderers = new Map<string, Function>();
  const pi = { on: (name: string, fn: Function) => hooks.set(name, fn), registerMessageRenderer: (name: string, fn: Function) => renderers.set(name, fn) } as unknown as ExtensionAPI;
  registerUi(pi, { home, submit: async () => {}, presentNote() {} });
  t.after(() => hooks.get("session_shutdown")!());
  const tui = { requestRender() { paints++; } }, theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "test" }, modelRegistry: { find: () => undefined }, ui: {
    custom: async () => {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factory(tui, theme); },
    getEditorText: () => "", onTerminalInput: () => () => {},
  } } as unknown as ExtensionContext;
  hooks.get("session_start")!({}, ctx);
  const item = { id: "noprogress:run@1/a@1", rev: 1, kind: "stall", wid: "run", call: "run@1/a@1", text: "no output" };
  const component = renderers.get(CT.attention)!({ details: { items: [item] } }, { expanded: false }, theme);
  assert.match(component.render(60).join("\n"), /awaiting progress/);
  refresh(); const before = paints;
  await journal.append(JT.attentionResolved, { id: item.id, rev: 1, resolution: "progress" });
  now += 1001; refresh();
  assert.equal(paints, before + 1);
  assert.match(component.render(60).join("\n"), /— recovered/);
  refresh(); assert.equal(paints, before + 1, "no redundant repaint after recovery");
});

test("an unchanged settled UI poll does not request a render, including an open list", async t => {
  const { join } = await import("node:path");
  const { openJournal } = await import("../../../src/kernel/journal.ts");
  const { journalPath, orchLedger } = await import("../../../src/paths.ts");
  const home = join(root, "quiet-ui"), journal = await openJournal(journalPath(home, "wf"));
  await journal.append("wf-created", { origin: "main:test", revision: 1 });
  await journal.append("workflow-done", { status: "done" });
  await journal.append("attention", { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } });
  await journal.close();
  const ledger = await openJournal(orchLedger(home)); await ledger.append("created", { wid: "wf", origin: "main:test" }); await ledger.close();
  const clock = Date.now() + 60_000; t.mock.method(Date, "now", () => clock);
  let refresh = () => {}, paints = 0, resolve: (() => void) | undefined;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (fn: () => void) => { refresh = fn; return interval(fn, 1_000_000); });
  const hooks = new Map<string, Function>(), commands = new Map<string, { handler: Function }>();
  const pi = { on: (name: string, fn: Function) => hooks.set(name, fn), registerCommand: (name: string, spec: { handler: Function }) => commands.set(name, spec) } as unknown as ExtensionAPI;
  registerUi(pi, { home, submit: async () => {}, presentNote() {} });
  const tui = { requestRender() { paints++; } }, theme = { fg: (_c: string, s: string) => s };
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "test" }, modelRegistry: { find: () => undefined }, ui: {
    custom: (factory: Function) => new Promise<void>(done => { resolve = done; factory(tui, theme, {}, done); }),
    setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factory(tui, theme); },
    getEditorText: () => "", onTerminalInput: () => () => {},
  } } as unknown as ExtensionContext;
  hooks.get("session_start")!({}, ctx); t.after(() => { hooks.get("session_shutdown")!(); resolve?.(); });
  commands.get("subagents")!.handler("", ctx);
  const before = paints; refresh(); refresh();
  assert.equal(paints, before, "neither dock nor open list repaints an unchanged view");
});

test("\u2193 opens the list only from pi's input editor, not from /model's selector or another overlay", async () => {
  const { join } = await import("node:path");
  const { openJournal } = await import("../../../src/kernel/journal.ts");
  const { journalPath } = await import("../../../src/paths.ts");
  for (const dock of ["auto", "off"]) {
    const home = join(root, `focus-${dock}`), j = await openJournal(journalPath(home, "run"));
    await j.append("wf-created", { origin: "main:test", cwd: root, revision: 1 });
    await j.append("call", { key: "E02", gen: 1, spec: { agent: "worker" } }); await j.close();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "config.json"), JSON.stringify({ ui: { dock } }));
    const hooks = new Map<string, Function>(); let listener: TerminalInputHandler | undefined, opened = 0;
    const editor = { actionHandlers: new Map() }, selector = { handleInput() {} };
    let focused: object | null = editor;
    const tui = { getFocusedComponent: () => focused, requestRender() {} };
    const pi = { on: (name: string, fn: Function) => hooks.set(name, fn) } as unknown as ExtensionAPI;
    registerUi(pi, { home, submit: async () => {}, presentNote() {} });
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "test" }, modelRegistry: { find: () => undefined }, ui: {
      custom: () => { opened++; return new Promise(() => {}); },
      setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factory(tui, { fg: (_c: string, s: string) => s }); },
      getEditorText: () => "", onTerminalInput: (fn: TerminalInputHandler) => { listener = fn; return () => {}; },
    } } as unknown as ExtensionContext;
    hooks.get("session_start")!({}, ctx);
    focused = selector; assert.equal(listener!("\x1b[B"), undefined, `${dock}: /model's selector keeps its \u2193`); assert.equal(opened, 0);
    focused = null; assert.equal(listener!("\x1b[B"), undefined, `${dock}: nothing focused, nothing opens`);
    focused = editor; assert.deepEqual(listener!("\x1b[B"), { consume: true }, `${dock}: the empty input editor opens the list`); assert.equal(opened, 1);
    hooks.get("session_shutdown")!();
  }
});
