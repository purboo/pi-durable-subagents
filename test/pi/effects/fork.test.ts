import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, crash } from "../../unit/orchestrator/effects/helpers.ts";

for (const window of ["normal", "intent", "effect", "record"]) test(`fork pi session reconciles ${window}`, async ctx => {
  const f = await fixture(ctx), timestamp = new Date().toISOString();
  f.t.spec.context = "fork"; f.t.originSession = join(f.root, "origin.jsonl");
  const origin = [
    { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp, cwd: "/origin" },
    { type: "message", id: "a", parentId: null, timestamp, message: { role: "user", content: "question", timestamp: Date.now() } },
    { type: "custom", id: "receipt", parentId: "a", timestamp, customType: "dsa-exec", data: { exec: "old" } },
    { type: "model_change", id: "model", parentId: "receipt", timestamp, provider: "faux", modelId: "test" },
    { type: "custom_message", id: "attention", parentId: "model", timestamp, customType: "dsa-attention", content: "old" },
    { type: "thinking_level_change", id: "thinking", parentId: "attention", timestamp, thinkingLevel: "high" },
    { type: "message", id: "b", parentId: "thinking", timestamp, message: { role: "user", content: "follow-up", timestamp: Date.now() } },
  ];
  await writeFile(f.t.originSession, origin.map(e => JSON.stringify(e)).join("\n") + "\n");
  if (window !== "normal") {
    const type = window === "intent" ? "fork-intent" : "fork-created";
    await assert.rejects(f.effects().prepare({ ...f.t, journal: crash(f.journal, type, window !== "effect") }, { sessionPath: f.sessionPath }), /crash:/);
  }
  await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  const bytes = await readFile(f.sessionPath, "utf8"), entries = bytes.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0].cwd, f.cwd); assert.equal(entries[0].version, 3); assert.notEqual(entries[0].id, origin[0]!.id);
  assert.deepEqual(entries.slice(1).map(e => [e.type, e.id, e.parentId]), [["message", "a", null], ["model_change", "model", "a"], ["message", "b", "model"]]);
  assert.ok(entries.every(e => !String(e.customType ?? e.message?.customType ?? "").startsWith("dsa-")));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const session = SessionManager.open(f.sessionPath, join(f.root, "sessions"), f.cwd);
  assert.equal(session.getSessionId(), entries[0].id); assert.deepEqual(session.getBranch().map(e => e.id), ["a", "model", "b"]);
  await appendFile(f.sessionPath, JSON.stringify({ type: "custom", id: "child", parentId: "b", timestamp, customType: "dsa-exec", data: { exec: "new" } }) + "\n");
  const advanced = await readFile(f.sessionPath, "utf8");
  await f.effects().prepare(f.t, { sessionPath: f.sessionPath }); assert.equal(await readFile(f.sessionPath, "utf8"), advanced);
  assert.equal(f.journal.entries().filter(e => e.type === "fork-intent").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "fork-created").length, 1);
});
test("fork requires pinned origin and refuses a foreign session without replacing it", async ctx => {
  const f = await fixture(ctx); f.t.spec.context = "fork";
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }), /fork requested but the run has no origin session/);
  f.t.originSession = join(f.root, "origin.jsonl");
  await writeFile(f.t.originSession, JSON.stringify({ type: "session", version: 3, id: "origin" }) + "\n");
  await writeFile(f.sessionPath, "foreign");
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }), /Fork publication conflict/);
  assert.equal(await readFile(f.sessionPath, "utf8"), "foreign");
});
test("continued generation preserves executor-owned session copy instead of re-forking", async ctx => {
  const f = await fixture(ctx); f.t.spec.context = "fork"; f.t.continueFrom = "W@1/task@0";
  await writeFile(f.sessionPath, "executor continuation");
  await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  assert.equal(await readFile(f.sessionPath, "utf8"), "executor continuation"); assert.equal(f.journal.entries().length, 0);
});
