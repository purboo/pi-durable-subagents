import { test } from "node:test";
import assert from "node:assert/strict";
import { ActiveTime, activeTotal } from "../../../../src/orchestrator/executor/time.ts";
import { observation, messageUsage, totalUsage, reached } from "../../../../src/orchestrator/executor/usage.ts";
import { evidence } from "../../../../src/orchestrator/executor/session.ts";
import { CT, type Entry } from "../../../../src/types.ts";

test("P18 CPU progress advances an open silent tool; ask and unobserved tail never charge", () => {
  const clock = new ActiveTime(0);
  clock.event({ type: "tool_execution_start", toolCallId: "bash", toolName: "bash" }, 10);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 10 }], 100);
  assert.equal(clock.active, 100);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 10 }], 1000);
  assert.equal(clock.active, 100);
  clock.event({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask" }, 1100);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 500 }], 2000);
  clock.evidence(3000);
  clock.event({ type: "tool_execution_end", toolCallId: "ask" }, 4000);
  assert.equal(clock.active, 1100);
  clock.evidence(4100); assert.equal(clock.active, 1200);
  clock.evidence(4000); assert.equal(clock.active, 1200);
});

test("P18 recovery sums only last durable checkpoint of each execution", () => {
  const entries = [
    { exec: "c#1.1", active: 100 }, { exec: "c#1.1", active: 200 }, { exec: "c#1.2", active: 40 }, { exec: "other#1.1", active: 999 },
  ].map((e, seq) => ({ ...e, seq, ts: 0, type: "time" }));
  assert.equal(activeTotal(entries, "c"), 240);
});

test("P31 observations discard updates, arguments, text and tool results", () => {
  assert.equal(observation({ type: "tool_execution_update", partialResult: "secret" }), undefined);
  assert.deepEqual(observation({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: "secret" }), { type: "tool_execution_end", toolCallId: "t", toolName: "bash" });
  assert.deepEqual(observation({ type: "message_start", message: { provider: "p", model: "m", content: "secret" } }), { type: "message_start", provider: "p", model: "m" });
  const m = { role: "assistant", id: "one", content: "secret", usage: { input: 1, output: 2, cacheRead: 3, cost: { total: 0.5 } } };
  assert.deepEqual(observation({ type: "message_end", message: m }), { type: "message_end", id: "one", usage: { input: 4, output: 2, costUsd: 0.5 } });
  const u = messageUsage(m)!;
  const entries = ["a", "a", "b"].map((call, seq) => ({ seq, ts: 0, type: "usage", call, ...u }));
  assert.equal(totalUsage(entries).input, 8);
  assert.equal(totalUsage(entries, "a").output, 2);
  assert.ok(reached(totalUsage(entries), { tokens: 12 }));
  assert.ok(!reached(totalUsage(entries), { tokens: 13 }));
  assert.ok(reached(totalUsage(entries), { costUsd: 1 }));
});

test("P31 child budget receipt belongs only to the current execution", () => {
  const entries = [{ type: "custom", customType: CT.exec, data: { exec: "old" } },
    { type: "custom", customType: CT.budget, data: { exec: "old" } },
    { type: "custom", customType: CT.exec, data: { exec: "new" } }];
  assert.equal(evidence(entries, "new").budget, false);
  entries.push({ type: "custom", customType: CT.budget, data: { exec: "new" } });
  assert.equal(evidence(entries, "new").budget, true);
});
