import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession, readSessionState, evidence, sessionModel } from "../../../src/orchestrator/executor/session.ts";
import { CT } from "../../../src/types.ts";
import { tempRoot } from "../../harness/pi.ts";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

test("C5 E4 snapshot ignores a torn trailing line and skips (reports) interior corruption like pi", async t => {
  const root = tempRoot("dsa-session-"), file = join(root, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, '{"type":"session"}\n{"type":');
  assert.deepEqual(await readSession(file), [{ type: "session" }]);
  await writeFile(file, '{oops}\n{"type":"session"}\n');
  assert.deepEqual(await readSessionState(file), { entries: [{ type: "session" }], corrupt: [1] });
});

test("P9 current report correlation and tool results close only matching calls", () => {
  const entries = [
    { type: "custom", customType: CT.exec, data: { exec: "current" } },
    { type: "custom", customType: CT.report, data: { exec: "stale", outcome: "ok", data: "stale" } },
    { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "a", name: "bash" }, { type: "toolCall", id: "b", name: "read" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "a" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "last\nline" }], usage: { input: 3, output: 4, cost: { total: 0.5 } } } },
  ];
  const result = evidence(entries, "current");
  assert.equal(result.report, undefined); assert.equal(result.text, "last\nline");
  assert.deepEqual(result.dangling, ["read (b)"]); assert.deepEqual(result.usage, { input: 3, output: 4, costUsd: 0.5 });
});

test("P13 restored native model follows the last model change", () => {
  assert.deepEqual(sessionModel([{ type: "model_change", provider: "a", modelId: "first" }, { type: "model_change", provider: "b", modelId: "second" }]), { provider: "b", id: "second" });
});
