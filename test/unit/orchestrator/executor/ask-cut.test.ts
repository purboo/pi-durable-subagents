import { test } from "node:test";
import assert from "node:assert/strict";
import { evidence, type SessionEntry } from "../../../../src/orchestrator/executor/session.ts";
import { openQuestion } from "../../../../src/orchestrator/executor/hibernate.ts";
import { ASK_CUT, CT } from "../../../../src/types.ts";

// Session entries in the shape pi and the child write them.
const exec = (id: string): SessionEntry => ({ type: "custom", customType: CT.exec, data: { exec: id } });
const ask = (id: string): SessionEntry => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask" }] } });
const bash = (id: string): SessionEntry => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash" }] } });
const question = (qid: string): SessionEntry => ({ type: "custom", customType: CT.question, data: { qid, rev: 1, question: qid + "?" } });
const result = (id: string, text: string, isError = false, details?: Record<string, unknown>): SessionEntry =>
  ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }], ...(details ? { details } : {}) } });
const continued = (rid: string, details: Record<string, unknown>): SessionEntry => ({ type: "custom_message", customType: CT.msg, details: { rid, kind: "continue", from: "orch", ...details } } as SessionEntry);

for (const cut of [ASK_CUT.shutdown, ASK_CUT.aborted]) test(`P28 an ask that wrote its question and ended "${cut}" is still blocked (no answer)`, () => {
  const entries = [exec("c#1.1"), ask("A"), question("q1"), result("A", cut, true)];
  assert.deepEqual(openQuestion(entries), { qid: "q1", rev: 1, question: "q1?" });
  assert.deepEqual(evidence(entries, "c#1.1").dangling, ["ask (A)"]);
});

test("P28 an answer to a cut-off question is a receipt: the question is not open again", () => {
  const entries = [exec("c#1.1"), ask("A"), question("q1"), result("A", ASK_CUT.shutdown, true), exec("c#1.2"), continued("r1", { qid: "q1", rev: 1 })];
  assert.equal(openQuestion(entries), undefined);
});

test("P28 an earlier cut-off ask does not keep a later question that a steer ended open", () => {
  // exec 1.1 asked q1 and was cut off by a graceful restart; it resumed with the answer in exec 1.2, which asked q2;
  // a steer ended that ask (its result carries the steer's receipt, not q2).
  const entries = [exec("c#1.1"), ask("A"), question("q1"), result("A", ASK_CUT.shutdown, true), exec("c#1.2"), continued("r1", { qid: "q1", rev: 1 }),
    ask("B"), question("q2"), result("B", "do something else", false, { rid: "s1", kind: "steer" })];
  assert.equal(openQuestion(entries), undefined);
  assert.deepEqual(evidence(entries, "c#1.2").dangling, []);
});

test("P28 an ask aborted before it wrote a question is an ordinary result, not an unknown outcome", () => {
  const entries = [exec("c#1.1"), ask("A"), result("A", ASK_CUT.aborted, true)];
  assert.equal(openQuestion(entries), undefined);
  assert.deepEqual(evidence(entries, "c#1.1").dangling, []);
});

test("P28 a cut-off ask next to another unfinished tool still leaves that tool unknown", () => {
  const entries = [exec("c#1.1"), bash("X"), ask("A"), question("q1"), result("A", ASK_CUT.shutdown, true)];
  assert.deepEqual(evidence(entries, "c#1.1").dangling, ["bash (X)", "ask (A)"]);
});

test("P28 with several asks in one message, the question belongs to the first ask without a result before it", () => {
  const two = (a: string, b: string): SessionEntry => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: a, name: "ask" }, { type: "toolCall", id: b, name: "ask" }] } });
  // X wrote qX and a steer ended it; Y has not run yet: qX is not open, and Y wrote no question.
  const steered = [exec("c#1.1"), two("X", "Y"), question("qX"), result("X", "do something else", false, { rid: "s1", kind: "steer" })];
  assert.equal(openQuestion(steered), undefined);
  // X wrote qX and was cut off; Y was aborted without a question: qX is open and X (not Y) is the unknown ask.
  const cut = [exec("c#1.1"), two("X", "Y"), question("qX"), result("X", ASK_CUT.shutdown, true), result("Y", ASK_CUT.aborted, true)];
  assert.deepEqual(openQuestion(cut), { qid: "qX", rev: 1, question: "qX?" });
  assert.deepEqual(evidence(cut, "c#1.1").dangling, ["ask (X)"]);
  // X answered by a steer, then Y wrote qY: qY belongs to Y.
  const second = [exec("c#1.1"), two("X", "Y"), question("qX"), result("X", "steered", false, { rid: "s1", kind: "steer" }), question("qY")];
  assert.deepEqual(openQuestion(second), { qid: "qY", rev: 1, question: "qY?" });
});
