import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPi, tempRoot, script, settled } from "../../harness/pi.ts";
import { scanInbox } from "../../../src/kernel/mailbox.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";

test("real isolated RPC pi degrades quietly and durable UI deps record user provenance plus a non-waking note", { timeout: 30_000 }, async () => {
  const root = tempRoot("dsa-ui-rpc-"), home = join(root, "dsa"), starter = join(root, "starter.mjs");
  writeFileSync(starter, "process.exit(0);\n");
  const pi = startPi({ root, name: "main", extensions: [fileURLToPath(new URL("./extension.ts", import.meta.url))], env: { HOME: root, DSA_HOME: home, DSA_ORCHESTRATOR_ENTRY: starter } });
  try {
    const id = pi.send({ type: "get_state" }); await pi.waitFor(e => e.type === "response" && e.id === id);
    const requests = await scanInbox(join(home, "inbox")); assert.equal(requests.length, 1);
    assert.equal(requests[0]!.kind, "send");
    assert.deepEqual(requests[0]!.body, { to: "workflow@1/E02@1", kind: "steer", message: "keep tests", by: "user" });
    const outbox = readJournalSnapshot(join(home, "outbox", `${requests[0]!.from}.jsonl`));
    assert(outbox.some(e => e.type === "sent"));
    assert(!pi.events.some(e => e.type === "agent_start" || e.type === "extension_ui_request"));
    pi.send({ type: "prompt", message: script([{ text: "main response" }]) }); await pi.waitFor(settled);
    assert(pi.sessionEntries().some(e => e.type === "custom_message" && e.customType === "dsa-note" && e.content.includes("steered E02")));
    assert(!pi.events.some(e => e.type === "extension_error"));
  } finally { await pi.stop(); rmSync(root, { recursive: true, force: true }); }
});
