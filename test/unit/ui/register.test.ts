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
