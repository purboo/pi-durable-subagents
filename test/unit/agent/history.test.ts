import { test } from "node:test";
import assert from "node:assert/strict";
import { recover } from "../../../src/agent/child/history.ts";
import { CT } from "../../../src/types.ts";

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data }) as never;
const msg = (rid: string, extra = {}) => ({ type: "custom_message", customType: CT.msg, details: { rid, ...extra } }) as never;

test("P37, P5: a later generation ignores lifecycle records of the generation whose session it continues", () => {
  const entries = [
    custom(CT.exec, { exec: "w@1/k@1#1.1" }), custom(CT.admitted, { rid: "a", from: "orch", sseq: 1, hash: "h", kind: "task" }), msg("a"),
    custom(CT.question, { qid: "q", rev: 1, question: "?" }),
    custom(CT.exec, { exec: "w@1/k@2#1.1" }), custom(CT.admitted, { rid: "b", from: "orch", sseq: 1, hash: "h2", kind: "task" }), msg("b"),
  ];
  const g2 = recover(entries, "w@1/k@2");
  assert.deepEqual(g2.records.map(r => (r as { rid?: string }).rid), ["b", "b"]);
  assert.equal(g2.questions.size, 0);
  const g1 = recover(entries.slice(0, 4), "w@1/k@1");
  assert.deepEqual(g1.records.map(r => (r as { rid?: string }).rid), ["a", "a"]);
  assert.equal(recover(entries.slice(0, 4), "w@1/k@2").records.length, 0, "a fresh generation starts with an empty lifecycle");
});

test("P28: a continue receipt bound to qid@rev is recovered as an answer", () => {
  const state = recover([custom(CT.exec, { exec: "c#1.1" }), custom(CT.question, { qid: "q", rev: 2, question: "?" }), msg("r", { qid: "q", rev: 2 })], "c");
  assert.ok(state.answered.has("q@2"));
});

test("P31, P33, P37: per-call usage excludes inherited context and earlier generations", async () => {
  const { usage } = await import("../../../src/agent/child.ts");
  const assistant = (id: string, tokens: number) => ({ id, type: "message", message: { role: "assistant", usage: { totalTokens: tokens, cost: { total: tokens / 100 } } } });
  const entries = [
    assistant("fork-origin", 1000),
    custom(CT.exec, { exec: "w@1/k@1#1.1" }), assistant("g1", 10),
    custom(CT.exec, { exec: "w@1/k@2#1.1" }), assistant("g2a", 5),
    custom(CT.exec, { exec: "w@1/k@2#1.2" }), assistant("g2b", 7), assistant("g2b", 7),
  ];
  const g2 = usage(entries as never, "w@1/k@2"), g1 = usage(entries as never, "w@1/k@1");
  assert.equal(g2.tokens, 12); assert.ok(Math.abs(g2.costUsd - 0.12) < 1e-9);
  assert.equal(g1.tokens, 10); assert.ok(Math.abs(g1.costUsd - 0.1) < 1e-9);
  assert.equal(usage(entries as never).tokens, 1022, "without a call identity everything counts (legacy/test use)");
});
