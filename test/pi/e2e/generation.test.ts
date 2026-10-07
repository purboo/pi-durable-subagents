import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { callSession, journalPath, orchInbox, orchLedger, pinnedDir } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type Request } from "../../../src/types.ts";
import { main } from "../../../src/orchestrator/main.ts";

async function until<T>(fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20000;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() > deadline) throw new Error("Timed out waiting for generation"); await delay(25); }
}

test("P37/P33 E2E: completed workflow opens g+1 once, same session, pinned origin and finished attention", { timeout: 60000 }, async t => {
  const root = tempRoot("dsa-generation-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  Object.assign(process.env, { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX] }));
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: test\nmodel: probe/scripted\n---\nTest.");
  const origin = join(root, "origin.jsonl");
  const rows = [{ type: "session", version: 3, id: "origin", cwd, timestamp: new Date().toISOString() },
    { type: "message", id: "a", parentId: null, message: { role: "user", content: "pinned" } },
    { type: "custom", id: "dsa", parentId: "a", customType: "dsa-msg", data: { rid: "foreign" } },
    { type: "model_change", id: "b", parentId: "dsa", provider: "probe", modelId: "scripted" },
    { type: "message", id: "other", parentId: "a", message: { role: "user", content: "other branch" } }];
  await writeFile(origin, rows.map(e => JSON.stringify(e)).join("\n") + "\n");
  let controller = new AbortController(), running = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => { controller.abort(); await running; for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(root, { recursive: true, force: true }); });
  const req: Request = { rid: "run", from: "main:test", to: "orch", sseq: 1, kind: "run", body: { cwd, source: `return await runs.run('a', {agent:'test', context:'fork', task:${JSON.stringify(script([{ text: "first" }]))}});`, origin: { sessionFile: origin, leafId: "b" } } };
  await publishRequest(orchInbox(home), req);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created));
  const wid = String(created.wid), entries = () => readJournalSnapshot(journalPath(home, wid));
  await until(() => entries().some(e => e.type === JT.done));
  await writeFile(origin, "changed after admission");
  const pinned = (await readFile(join(pinnedDir(home, wid), "origin.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(pinned.map(e => e.id), ["origin", "a", "b"]);
  const send: Request = { rid: "open", from: "main:test", to: "orch", sseq: 2, kind: "send", body: { to: `${wid}/a`, kind: "follow-up", message: script([{ delayMs: 500, text: "second" }]) } };
  await publishRequest(orchInbox(home), send);
  await until(() => entries().some(e => e.type === "generation"));
  // Interrupt an unsealed generation and restart the full engine after workflow-done.
  controller.abort(); await running;
  controller = new AbortController(); running = main({ home, signal: controller.signal, discovery: { home: root } });
  await publishRequest(orchInbox(home), send);
  await until(() => entries().some(e => e.type === JT.attention && (e.item as { call?: string }).call === `${wid}@1/a@2` && (e.item as { kind?: string }).kind === "finished"));
  assert.equal(entries().filter(e => e.type === "generation").length, 1);
  assert.equal(entries().filter(e => e.type === JT.sealed && e.call === `${wid}@1/a@2`).length, 1);
  assert.equal(entries().filter(e => e.type === JT.done).length, 1);
  const sessions = await Promise.all([1, 2].map(gen => readFile(callSession(home, wid, "a", gen), "utf8")));
  assert.equal(JSON.parse(sessions[0]!.split("\n")[0]!).id, JSON.parse(sessions[1]!.split("\n")[0]!).id);
  assert.equal(sessions[1]!.split("\n").filter(line => line.includes('"kind":"task"') && line.includes('second')).length, 1);
});

test("P37/P12 E2E: a follow-up naming a model runs its generation on that model and says so", { timeout: 60000 }, async t => {
  const root = tempRoot("dsa-generation-model-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  Object.assign(process.env, { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX] }));
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: test\nmodel: probe/scripted\n---\nTest.");
  await mkdir(home, { recursive: true }); await writeFile(join(home, "config.json"), JSON.stringify({ pools: { alt: ["probe/scripted"] } }));
  const controller = new AbortController(), running = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => { controller.abort(); await running; for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(root, { recursive: true, force: true }); });
  await publishRequest(orchInbox(home), { rid: "run", from: "main:test", to: "orch", sseq: 1, kind: "run", body: { cwd, source: `return await runs.run('a', {agent:'test', task:${JSON.stringify(script([{ text: "first" }]))}});` } } as Request);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created));
  const wid = String(created.wid), entries = () => readJournalSnapshot(journalPath(home, wid)), orch = () => readJournalSnapshot(orchLedger(home));
  await until(() => entries().some(e => e.type === JT.done));
  await publishRequest(orchInbox(home), { rid: "bad", from: "main:test", to: "orch", sseq: 2, kind: "send", body: { to: `${wid}/a`, kind: "follow-up", model: "no-provider", message: "x" } } as Request);
  assert.equal((await until(() => orch().find(e => e.type === JT.rejected && e.rid === "bad"))).reason, "unknown-model");
  await publishRequest(orchInbox(home), { rid: "open", from: "main:test", to: "orch", sseq: 3, kind: "send", body: { to: `${wid}/a`, kind: "follow-up", model: "probe/scripted2", message: script([{ text: "second" }]) } } as Request);
  await until(() => entries().some(e => e.type === JT.sealed && String(e.call).endsWith("/a@2")));
  const note = orch().find(e => e.type === "send-note" && e.rid === "open")!;
  assert.deepEqual([note.model, note.effect], ["probe/scripted2", "next-generation"]);
  assert.equal(entries().find(e => e.type === "generation")!.model, "probe/scripted2");
  const selected = entries().filter(e => e.type === "selected").map(e => (e.model as { id: string }).id);
  assert.deepEqual(selected, ["scripted", "scripted2"]);
  const rows = (await readFile(callSession(home, wid, "a", 2), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.findLast(e => e.type === "message" && e.message.role === "assistant").message.model, "scripted2");
  // A pool's name: the generation runs from the pool (its order and failover apply), not as one fixed model.
  await publishRequest(orchInbox(home), { rid: "pool", from: "main:test", to: "orch", sseq: 4, kind: "send", body: { to: `${wid}/a`, kind: "follow-up", model: "alt", message: script([{ text: "third" }]) } } as Request);
  await until(() => entries().some(e => e.type === JT.sealed && String(e.call).endsWith("/a@3")));
  const third = entries().findLast(e => e.type === "generation")!;
  assert.equal((third.spec as { model: string }).model, "alt"); assert.equal(third.model, undefined);
  assert.deepEqual(entries().filter(e => e.type === "selected").map(e => [(e.model as { id: string }).id, e.pool]).at(-1), ["scripted", "alt"]);
  assert.equal(orch().find(e => e.type === "send-note" && e.rid === "pool")!.model, "alt");
});
