import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChild } from "../../../src/agent/child.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { CT } from "../../../src/types.ts";

async function fixture(t: TestContext, selected: string, activation: "ok" | "refused" | "throws" | "stale", catalog?: { provider: string; id: string; name: string; api?: string }[]) {
  const home = await mkdtemp(join(tmpdir(), "dsa-launch-model-")), inbox = join(home, "inbox"), path = join(home, "journal");
  await mkdir(inbox);
  const log = await openJournal(path); await log.append("exec", { call: "call", exec: "call#1.1" }); await log.close();
  const env = { DSA_EXEC: "call#1.1", DSA_CALL: "call", DSA_INBOX: inbox, DSA_JOURNAL: path, DSA_MODEL: selected };
  const before = { ...process.env };
  Object.assign(process.env, env); delete process.env.DSA_BUDGET; delete process.env.DSA_SCHEMA;
  const hooks = new Map<string, (event: unknown, ctx: any) => Promise<unknown>>(), history: any[] = [], sent: unknown[] = [], rpc: any[] = [];
  const canonical = { provider: "p", id: "canonical", name: "Alias" }, models = catalog ?? [canonical];
  let model = { provider: "default", id: "other", name: "Other" }, shutdown = false, activations = 0, refreshes = 0, fresh = false;
  const ctx = { get model() { return model; }, isIdle: () => true, shutdown() { shutdown = true; },
    modelRegistry: { refresh: async (options: { providers?: string[] }) => { refreshes++; assert.deepEqual(options.providers, ["p"]); fresh = true; return { aborted: false, errors: new Map() }; }, find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAll: () => models },
    sessionManager: { getEntries: () => history } };
  t.mock.method(fs, "writeSync", (_fd: number, chunk: string) => { rpc.push(JSON.parse(chunk)); return chunk.length; });
  t.mock.method(process.stdout, "write", (chunk: string) => { rpc.push(JSON.parse(chunk)); return true; });
  t.mock.method(console, "error", () => {});
  registerChild({
    on: (name: string, fn: any) => hooks.set(name, fn), registerTool() {},
    appendEntry: (customType: string, data: unknown) => history.push({ type: "custom", customType, data }),
    sendMessage: (message: unknown) => sent.push(message),
    setModel: async (next: typeof model) => { activations++; if (activation === "throws") throw new Error("No API key for p/canonical"); if (activation === "refused" || (activation === "stale" && !fresh)) return false; model = next; return true; },
  } as unknown as Parameters<typeof registerChild>[0]);
  t.after(async () => { await hooks.get("session_shutdown")?.({}, ctx); for (const key of Object.keys(env).concat(["DSA_BUDGET", "DSA_SCHEMA"])) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } await rm(home, { recursive: true, force: true }); });
  await publishRequest(inbox, { rid: "task", from: "orch", to: "call", kind: "task", sseq: 1, body: { message: "work" } });
  const start = () => hooks.get("session_start")!({}, ctx);
  return { start, hooks, ctx, history, sent, rpc, get shutdown() { return shutdown; }, get activations() { return activations; }, get refreshes() { return refreshes; }, change: () => { model = { provider: "default", id: "other", name: "Other" }; } };
}

for (const activation of ["refused", "throws"] as const) test(`launch guard refuses default fallback before delivering any work (${activation})`, async t => {
  const f = await fixture(t, "p/canonical", activation); await f.start();
  assert.equal(f.shutdown, true); assert.deepEqual(f.sent, []);
  const failure = f.history.find(e => e.customType === CT.modelUnavailable)?.data;
  assert.deepEqual(failure.selected, { provider: "p", id: "canonical" });
  assert.deepEqual(failure.actual, { provider: "default", id: "other" });
  assert.match(failure.reason, /auth|API key/);
  assert.equal(f.refreshes, activation === "refused" ? 1 : 0, "a refusal is rechecked once against fresh provider availability");
  assert.equal(f.rpc.at(-1).type, CT.modelUnavailable);
  // A later request hook must stop synchronously, since pi swallows extension errors.
  t.mock.method(process, "exit", () => { throw new Error("owned child exited"); });
  await assert.rejects(f.hooks.get("turn_start")!({}, f.ctx), /owned child exited/);
});

test("launch guard rechecks a refusal from a stale availability snapshot and goes on", async t => {
  // pi 1.0.2 on CI after a resume: the provider is registered, but a startup refresh briefly dropped it from the
  // snapshot setModel reads. 1.0.41 before this fix failed such calls as model-unavailable.
  const f = await fixture(t, "p/canonical", "stale"); await f.start();
  assert.equal(f.shutdown, false); assert.equal(f.sent.length, 1);
  assert.equal(f.refreshes, 1); assert.equal(f.activations, 2);
  assert.equal(f.history.some(e => e.customType === CT.modelUnavailable), false);
  assert.deepEqual(f.history.find(e => e.customType === CT.modelReady)?.data.model, { provider: "p", id: "canonical" });
});

test("context guard stops a late model replacement before the captured request can run", async t => {
  const f = await fixture(t, "p/canonical", "ok"); await f.start(); f.change();
  t.mock.method(process, "exit", () => { throw new Error("owned child exited"); });
  await assert.rejects(f.hooks.get("context")!({ type: "context" }, f.ctx), /owned child exited/);
  assert.equal(f.activations, 1, "context is too late to repair a captured turn's model");
  assert.match(f.history.find(e => e.customType === CT.modelUnavailable)?.data.reason, /after turn selection/);
});

for (const [ids, expected] of [
  [["m-20260101", "m-20260202"], "m-20260202"],
  [["m-a", "m-b", "m-20991231"], "m-b"],
] as const) test(`launch guard follows pi's partial-name ordering: ${expected}`, async t => {
  const models: { provider: string; id: string; name: string }[] = ids.map(id => ({ provider: "p", id, name: id }));
  models.push({ provider: "q", id: "m-z", name: "m-z" });
  const f = await fixture(t, "p/m", "ok", models); await f.start();
  assert.equal(f.shutdown, false); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.history.find(e => e.customType === CT.modelReady)?.data.model, { provider: "p", id: expected });
});

for (const activation of ["ok", "refused"] as const) test(`virtual selection still requires launch activation: ${activation}`, async t => {
  const f = await fixture(t, "router/auto", activation, [{ provider: "router", id: "auto", name: "Auto", api: "pi-virtual" }]);
  await f.start();
  assert.equal(f.shutdown, activation !== "ok");
  if (activation === "ok") {
    const ready = f.history.find(e => e.customType === CT.modelReady)?.data;
    assert.equal(ready.virtual, true);
    assert.deepEqual(ready.model, { provider: "router", id: "auto" });
    assert.equal(f.rpc.find(e => e.type === CT.modelReady)?.virtual, true);
    assert.equal(f.sent.length, 1);
  } else {
    assert.equal(f.sent.length, 0); assert.equal(f.history.some(e => e.customType === CT.modelReady), false);
  }
});

for (const selected of ["P/CANONICAL", "p/Alias", "p/canon"]) test(`launch guard accepts catalog normalization: ${selected}`, async t => {
  const f = await fixture(t, selected, "ok"); await f.start();
  assert.equal(f.shutdown, false); assert.equal(f.sent.length, 1); assert.equal(f.activations, 1);
  assert.deepEqual(f.history.find(e => e.customType === CT.modelReady)?.data.model, { provider: "p", id: "canonical" });
  await f.hooks.get("turn_start")!({}, f.ctx); await f.hooks.get("context")!({}, f.ctx);
  assert.equal(f.activations, 1);
});
