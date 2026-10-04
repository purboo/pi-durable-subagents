import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startPi, tempRoot, REPO, script } from "../../harness/pi.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { OsLock } from "../../../src/platform/lock.ts";
import { orchInbox, orchLedger, orchLock, journalPath } from "../../../src/paths.ts";
import { CT, JT } from "../../../src/types.ts";

const sessionId = "d1d608f2-ef7f-46e4-b51b-9ff8888f3cdb";
const extension = join(REPO, "src/agent/extension.ts"), fake = join(REPO, "test/pi/main/fixtures/orchestrator.ts");
async function append(path: string, entries: [string, Record<string, unknown>][]) {
  const journal = await openJournal(path); try { for (const [type, data] of entries) await journal.append(type, data); } finally { await journal.close(); }
}

test("boot attention excludes resolved revisions and final boundary injects newly arrived items", { timeout: 20000 }, async t => {
  const root = tempRoot("dsa-main-boundary-"), home = join(root, "state"); mkdirSync(home);
  await append(orchLedger(home), [[JT.created, { rid: "create", wid: "owned", origin: `main:${sessionId}` }]]);
  const item = { id: "boot", rev: 1, kind: "finished", wid: "owned", text: "BOOT-MSG" };
  await append(journalPath(home, "owned"), [[JT.done, { status: "done" }], [JT.attention, { item }],
    [JT.attention, { item: { ...item, id: "closed" } }], [JT.attentionResolved, { id: "closed", rev: 1, resolution: "closed" }]]);
  const pi = startPi({ root, name: "main", extensions: [extension, join(REPO, "test/pi/main/fixtures/observe.ts")], args: ["--session-id", sessionId],
    env: { DSA_HOME: home, DSA_EXEC: "", DSA_ORCHESTRATOR_ENTRY: fake } });
  t.after(async () => { await pi.stop(); console.log(`M1 boundary evidence: ${root}`); });
  await pi.waitFor(e => e.type === "agent_settled");
  let receipts = pi.sessionEntries().filter(e => e.type === "custom_message" && e.customType === CT.attention);
  assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].details.items.map((v: any) => v.id), ["boot"]);
  writeFileSync(join(home, "late-attention.json"), JSON.stringify({ ...item, id: "late", text: "final boundary item" }));
  const from = pi.events.length;
  pi.send({ type: "prompt", message: script([{ text: "first" }, { text: "continued" }]) });
  await pi.waitFor(e => pi.events.indexOf(e) >= from && e.type === "agent_settled");
  receipts = pi.sessionEntries().filter(e => e.type === "custom_message" && e.customType === CT.attention);
  assert.equal(receipts.length, 2);
  const observations = readFileSync(join(pi.dir, "observed.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(observations.some(e => e.kind === "agent_before_settle" && e.value.some((entry: any) => entry.customType === CT.attention)));
  assert.equal(pi.events.slice(from).filter(e => e.type === "message_start" && (e.message as any).role === "assistant").length, 2);
});

test("K1 starter retries pending inbox after a held lock becomes free", { timeout: 42000 }, async t => {
  const root = tempRoot("dsa-main-starter-"), home = join(root, "state"); mkdirSync(home);
  const lock = await new OsLock().tryAcquire(orchLock(home)); assert.ok(lock);
  await publishRequest(orchInbox(home), { rid: "pending", from: "cli:test", to: "orch", sseq: 1, kind: "drain", body: {} });
  const pi = startPi({ root, name: "main", extensions: [extension], env: { DSA_HOME: home, DSA_EXEC: "", DSA_ORCHESTRATOR_ENTRY: fake } });
  t.after(async () => {
    await lock.release(); await pi.stop(); writeFileSync(join(home, "stop-fake"), "stop");
    const deadline = Date.now() + 3000;
    while (existsSync(join(home, "spawn.log")) && !existsSync(join(home, "exited.log")) && Date.now() < deadline) await delay(30);
    assert.ok(!existsSync(join(home, "spawn.log")) || existsSync(join(home, "exited.log")));
    console.log(`M1 starter evidence: ${root}`);
  });
  pi.send({ type: "prompt", message: script([{ text: "ready" }]) }); await pi.waitFor(e => e.type === "agent_settled");
  assert.equal(existsSync(join(home, "spawn.log")), false); await lock.release();
  const deadline = Date.now() + 33000;
  while (!existsSync(join(home, "spawn.log")) && Date.now() < deadline) await delay(100);
  assert.ok(existsSync(join(home, "spawn.log")));
  assert.equal(readFileSync(join(home, "spawn.log"), "utf8").trim().split("\n").length, 1);
});
