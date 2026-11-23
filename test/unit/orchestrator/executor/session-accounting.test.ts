import test from "node:test";
import assert from "node:assert/strict";
import { CT } from "../../../../src/types.ts";
import { receiptId, type SessionEntry } from "../../../../src/orchestrator/executor/session.ts";
import { sessionUsage } from "../../../../src/orchestrator/executor/usage.ts";

test("P31 usage excludes context, predecessor generations and foreign segments across retries", () => {
  const call = "W@1/a@2";
  const segment = (exec: string): SessionEntry => ({ type: "custom", customType: CT.exec, data: { exec } });
  const message: SessionEntry = { type: "message", message: { role: "assistant", usage: { input: 2, output: 3, cost: { total: 0.1 } } } };
  const entries = [message, segment("W@1/a@1#1.1"), message, segment(`${call}#1.1`), message,
    segment("W@1/a@20#1.1"), message, segment(`${call}#1.2`), message];
  assert.equal(sessionUsage(entries, call).length, 2);
  assert.equal(sessionUsage(entries.slice(0, 3), call).length, 0);
});

test("P31 standalone usage entries (e.g. cache_warm) count inside own segments and exclude inherited/foreign ones", () => {
  const call = "W@1/a@2";
  const segment = (exec: string): SessionEntry => ({ type: "custom", customType: CT.exec, data: { exec } });
  const warm = (id: string, cost: number): SessionEntry => ({ type: "usage", id, kind: "cache_warm", usage: { input: 10, cacheRead: 1000, output: 1, cost: { total: cost } } });
  const entries = [warm("inherited", 0.5), segment("W@1/a@1#1.1"), warm("prev", 0.4), segment(`${call}#1.1`), warm("w1", 0.02), segment("W@1/b@1#1.1"), warm("foreign", 0.3), segment(`${call}#1.2`), warm("w2", 0.03)];
  assert.deepEqual(sessionUsage(entries, call), [
    { id: "w1", usage: { input: 1010, output: 1, costUsd: 0.02 } },
    { id: "w2", usage: { input: 1010, output: 1, costUsd: 0.03 } },
  ]);
});

test("P4 receipts cover nested messages, native custom messages and control resolutions only", () => {
  assert.equal(receiptId({ type: "message", message: { details: { rid: "message" } } }), "message");
  assert.equal(receiptId({ type: "custom_message", details: { rid: "native" } }), "native");
  for (const customType of [CT.rejected, CT.withdrawn, CT.model])
    assert.equal(receiptId({ type: "custom", customType, data: { rid: customType } }), customType);
  assert.equal(receiptId({ type: "custom", customType: CT.exec, data: { rid: "not-a-receipt" } }), undefined);
  assert.equal(receiptId({ type: "custom_message", details: { rid: 42 } }), undefined);
});
