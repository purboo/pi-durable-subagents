import { test } from "node:test";
import assert from "node:assert/strict";
import { startPi, tempRoot, script, settled } from "../harness/pi.ts";

test("faux provider drives an isolated pi rpc session", async () => {
  const p = startPi({ root: tempRoot(), name: "h1" });
  try {
    p.send({ type: "prompt", message: script([{ text: "HELLO-FAUX" }]) });
    await p.waitFor(settled);
    const texts = p.sessionEntries().filter(e => e.type === "message" && e.message?.role === "assistant").map(e => JSON.stringify(e.message.content));
    assert.ok(texts.some(t => t.includes("HELLO-FAUX")), texts.join("\n"));
  } finally { await p.stop(); }
});
