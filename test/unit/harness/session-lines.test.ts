import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionRows } from "../../harness/session-lines.ts";

test("P28: a polled session ignores every partial tail and keeps all complete records", () => {
  const first = { type: "custom_message", details: { rid: "answer" } }, second = { type: "message", content: "continued" };
  const prefix = JSON.stringify(first) + "\n", tail = JSON.stringify(second) + "\n";
  for (let i = 0; i < tail.length; i++) assert.deepEqual(sessionRows(prefix + tail.slice(0, i)), [first]);
  assert.deepEqual(sessionRows(prefix + tail), [first, second]);
  assert.deepEqual(sessionRows('{"type":"message"'), []);
});

test("P28: a complete malformed session record still throws", () => {
  assert.throws(() => sessionRows('{"type": broken}\n{"partial":'), SyntaxError);
});
