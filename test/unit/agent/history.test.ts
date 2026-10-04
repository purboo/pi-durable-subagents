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
