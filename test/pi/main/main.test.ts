import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startPi, tempRoot, REPO, script, type PiInstance } from "../../harness/pi.ts";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { Outbox, scanInbox } from "../../../src/kernel/mailbox.ts";
import { OsLock } from "../../../src/platform/lock.ts";
import { orchInbox, orchLedger, orchLock, journalPath } from "../../../src/paths.ts";
import { CT, JT, type AttentionItem, type RunBody } from "../../../src/types.ts";

const extension = join(REPO, "src/agent/extension.ts"), observer = join(REPO, "test/pi/main/fixtures/observe.ts");
const fake = join(REPO, "test/pi/main/fixtures/orchestrator.ts");
const sessionId = "a6d963c0-0fef-4d3c-a229-1b367514a526", sender = `main:${sessionId}`;
async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  do { const result = await fn(); if (result) return result as NonNullable<T>; await delay(30); } while (Date.now() < deadline);
  throw new Error("Timed out waiting for evidence");
}
async function append(path: string, type: string, fields: Record<string, unknown>) {
  const journal = await openJournal(path); try { await journal.append(type, fields); } finally { await journal.close(); }
}
function setup(t: { after(fn: () => Promise<void>): void }, receipt = true) {
  const root = tempRoot("dsa-main-"), home = join(root, "state"), instances: PiInstance[] = [];
  mkdirSync(home);
  function launch(name = "main", args: string[] = [], mainExtension = extension) {
    const pi = startPi({ root, name, extensions: [mainExtension, observer], args: [...(args.includes("--session") ? [] : ["--session-id", sessionId]), ...args],
      env: { HOME: root, DSA_HOME: home, DSA_ORCHESTRATOR_ENTRY: fake, DSA_FAKE_RECEIPT: receipt ? "yes" : "no", DSA_EXEC: "" } });
    instances.push(pi); return pi;
  }
  t.after(async () => {
    for (const pi of instances) await pi.stop();
    writeFileSync(join(home, "stop-fake"), "stop");
    if (existsSync(join(home, "spawn.log"))) await until(() => existsSync(join(home, "exited.log")));
    // Keep the isolated root as durable evidence; no user pi paths are used.
    console.log(`M1 evidence: ${root}`);
  });
  return { root, home, launch };
}
async function prompt(pi: PiInstance, steps: unknown[], ms = 20000) {
  const from = pi.events.length;
  pi.send({ type: "prompt", message: script(steps) });
  await pi.waitFor(e => pi.events.indexOf(e) >= from && e.type === "agent_settled", ms);
}
function result(pi: PiInstance) {
  return pi.events.filter(e => e.type === "tool_execution_end" && e.toolName === "subagents").at(-1) as any;
}
function items(pi: PiInstance) { return pi.sessionEntries().filter(e => e.type === "custom_message" && e.customType === CT.attention); }
function observed(pi: PiInstance): any[] {
  const path = join(pi.dir, "observed.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function created(home: string, wid = "owned", origin = sender) {
  await append(orchLedger(home), JT.created, { rid: `create-${wid}`, wid, origin });
  await append(journalPath(home, wid), JT.done, { status: "done" });
}
async function attention(home: string, fields: Partial<AttentionItem> = {}) {
  const item: AttentionItem = { id: "question", rev: 1, kind: "question", text: "Choose a branch", wid: "owned", qid: "q1", ...fields };
  await append(journalPath(home, item.wid), JT.attention, { item }); return item;
}

test("run publishes pinned call body through the durable outbox and returns created wid", { timeout: 30000 }, async t => {
  const { home, launch } = setup(t), pi = launch();
  await prompt(pi, [{ tool: "subagents", args: { agent: "worker", task: "Implement", model: "probe/scripted", timeoutMs: 1234 } }, { text: "done" }]);
  const [req] = await scanInbox(orchInbox(home));
  assert.ok(req); assert.equal(req.kind, "run"); assert.equal(req.from, sender); assert.equal(req.to, "orch"); assert.equal(req.sseq, 1);
  const { origin, ...body } = req.body as RunBody;
  assert.deepEqual(body, { cwd: join(pi.dir, "work"), call: { agent: "worker", task: "Implement", model: "probe/scripted", timeoutMs: 1234 } });
  // P33: the origin branch is offered for pinning: the live session file and its current leaf.
  assert.ok(origin && existsSync(origin.sessionFile) && typeof origin.leafId === "string");
  assert.equal(result(pi).isError, false); assert.deepEqual(result(pi).result.details, { wid: `w-${req.rid}` });
  const entries = readJournalSnapshot(join(home, "outbox", `${sender}.jsonl`));
  assert.deepEqual(entries.find(e => e.type === "sent")?.request, req);
  assert.ok(entries.some(e => e.type === "resolved" && e.rid === req.rid));
  assert.equal(readFileSync(join(home, "spawn.log"), "utf8").trim().split("\n").length, 1);
});

test("v12 §2/§6 agents lists cwd-scoped definitions without publishing, and rejects unknown calls before creation", { timeout: 30000 }, async t => {
  const { home, launch } = setup(t), pi = launch();
  const dir = join(pi.dir, "work/.pi/agents"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local.md"), "---\nname: local\ndescription: Project-only agent\nmodel: probe/scripted\n---\nLocal instructions\n");
  await prompt(pi, [{ tool: "subagents", args: { action: "agents" } }, { text: "done" }]);
  const agents = result(pi).result.details as { name: string; description: string; model?: string; source: string }[];
  assert.ok(agents.some(a => a.name === "worker" && a.source === "builtin"));
  assert.deepEqual(agents.find(a => a.name === "local"), { name: "local", description: "Project-only agent", model: "probe/scripted", source: "project" });
  for (const args of [
    { agent: "absent", task: "work" },
    { tasks: [{ agent: "local", task: "ok" }, { agent: "absent", task: "bad" }] },
    { chain: [{ agent: "absent", task: "bad" }, { agent: "missing", task: "bad" }] },
  ]) {
    await prompt(pi, [{ tool: "subagents", args }, { text: "done" }]);
    assert.equal(result(pi).isError, true);
    const text = JSON.stringify(result(pi).result);
    assert.match(text, /absent/); assert.match(text, /Available agents:.*local/);
    if ("chain" in args) assert.match(text, /missing/);
  }
  assert.deepEqual(await scanInbox(orchInbox(home)), []);
  assert.deepEqual(readJournalSnapshot(orchLedger(home)), []);
  assert.deepEqual(readJournalSnapshot(join(home, "outbox", `${sender}.jsonl`)), []);
  assert.equal(existsSync(join(home, "spawn.log")), false);
});

test("run returns submitted after 10 seconds, including an absolute workflow path", { timeout: 30000 }, async t => {
  const { home, launch } = setup(t, false), pi = launch();
  const start = performance.now();
  await prompt(pi, [{ tool: "subagents", args: { action: "run", workflow: "./flow.js", args: { value: 3 } } }, { text: "done" }]);
  assert.ok(performance.now() - start >= 10000);
  const [req] = await scanInbox(orchInbox(home)); assert.ok(req);
  const { origin: _origin, ...body } = req.body as RunBody;
  assert.deepEqual(body, { cwd: join(pi.dir, "work"), workflow: join(pi.dir, "work/flow.js"), args: { value: 3 } });
  assert.deepEqual(result(pi).result.details, { submitted: { rid: req.rid } });
});

// No orchestrator decides here (the test holds its lock), so every control action waits its full 10 s and replies {submitted}.
test("send replaces publishes withdrawal first; all other actions use correct wire bodies", { timeout: 120000 }, async t => {
  const { home, launch } = setup(t), lock = await new OsLock().tryAcquire(orchLock(home)); assert.ok(lock);
  t.after(() => lock.release());
  const pi = launch();
  const actions = [
    { action: "send", to: "owned/work", kind: "answer", message: "yes", qid: "q", rev: 2, replaces: ["old"] },
    { action: "stop", target: "owned" }, { action: "revise", wid: "owned", workflow: "new.js", args: [1] },
    { action: "resume", wid: "owned" }, { action: "drain" },
  ];
  await prompt(pi, [...actions.map(args => ({ tool: "subagents", args })), { text: "done" }], 80000);
  const reqs = (await scanInbox(orchInbox(home))).sort((a, b) => a.sseq - b.sseq);
  assert.deepEqual(result(pi).result.details, { submitted: { rid: reqs.at(-1)!.rid } });
  assert.deepEqual(reqs.map(r => r.kind), ["withdraw", "send", "stop", "revise", "resume", "drain"]);
  assert.deepEqual(reqs.map(r => r.sseq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(reqs[0]!.body, { rids: ["old"] });
  assert.deepEqual(reqs[1]!.body, { to: "owned/work", kind: "answer", message: "yes" });
  assert.deepEqual(reqs[1]!.cond, { qid: "q", rev: 2, after: reqs[0]!.rid });
  assert.deepEqual(reqs.slice(2).map(r => r.body), [{ target: "owned" }, { wid: "owned", workflow: join(pi.dir, "work/new.js"), args: [1] }, { wid: "owned" }, {}]);
  assert.equal(existsSync(join(home, "spawn.log")), false);
  await prompt(pi, [{ tool: "subagents", args: { action: "send", to: "owned/work", kind: "answer", message: "missing revision" } }, { text: "done" }]);
  assert.equal(result(pi).isError, true); assert.equal((await scanInbox(orchInbox(home))).length, 6);
  const session = pi.sessionFile()!; await pi.stop();
  await append(orchLedger(home), JT.applied, { rid: reqs[0]!.rid });
  await append(orchLedger(home), JT.rejected, { rid: reqs[1]!.rid, reason: "already-answered" });
  await append(orchLedger(home), JT.rejected, { rid: reqs[2]!.rid, reason: "identity-conflict" });
  const restarted = launch("restarted", ["--session", session]);
  await prompt(restarted, [{ tool: "subagents", args: { action: "resume" } }, { text: "done" }], 30000);
  const entries = readJournalSnapshot(join(home, "outbox", `${sender}.jsonl`));
  assert.deepEqual(entries.filter(e => e.type === "resolved").map(e => e.rid), [reqs[0]!.rid, reqs[1]!.rid]);
  const current = (await scanInbox(orchInbox(home))).sort((a, b) => a.sseq - b.sseq);
  assert.equal(current.at(-1)!.sseq, 7); assert.deepEqual(current.at(-1)!.body, {});
  assert.equal(existsSync(join(home, "spawn.log")), false);
});

test("idle attention wakes once, survives restart, and status orders origin first", { timeout: 30000 }, async t => {
  const { home, launch } = setup(t);
  await created(home, "aaa-foreign", "main:other"); await created(home);
  const pi = launch(); await prompt(pi, [{ text: "ready" }]);
  const before = pi.events.length;
  await attention(home); await attention(home); await attention(home, { id: "foreign", wid: "aaa-foreign" });
  await pi.waitFor(e => pi.events.indexOf(e) >= before && e.type === "agent_settled");
  assert.equal(items(pi).length, 1); assert.equal(items(pi)[0].display, true);
  assert.deepEqual(items(pi)[0].details.items.map((i: AttentionItem) => i.id), ["question"]);
  const file = pi.sessionFile()!; await pi.stop();
  const resumed = launch("restart", ["--session", file]);
  await prompt(resumed, [{ tool: "subagents", args: { action: "status" } }, { text: "done" }]);
  const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.type === "custom_message" && e.customType === CT.attention).length, 1);
  const view = result(resumed).result.details;
  assert.deepEqual(view.workflows.map((w: { wid: string }) => w.wid), ["owned", "aaa-foreign"]);
  assert.ok(view.workflows.every((w: object) => !("entries" in w)));
  assert.equal(resumed.events.filter(e => e.type === "agent_start").length, 1);
});

test("busy attention appends at turn_end and refreshes child and journal resolutions", { timeout: 30000 }, async t => {
  const { root, home, launch } = setup(t); await created(home);
  const childSession = join(root, "child.jsonl"), pi = launch();
  pi.send({ type: "prompt", message: script([{ tool: "bash", args: { command: "sleep 1" } }, { text: "after boundary" }]) });
  await pi.waitFor(e => e.type === "tool_execution_start" && e.toolName === "bash");
  await attention(home, { session: childSession });
  await pi.waitFor(e => e.type === "agent_settled");
  assert.equal(items(pi).length, 1);
  assert.ok(observed(pi).some(e => e.kind === "turn_end" && e.value.some((v: any) => v.customType === CT.attention)));
  writeFileSync(childSession, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "ask", details: { qid: "q1", rev: 1 } } }) + "\n");
  await prompt(pi, [{ text: "refreshed" }]);
  let contexts = observed(pi).filter(e => e.kind === "context");
  assert.ok(contexts.at(-1).value.some((m: any) => m.customType === CT.attention && m.content === "(resolved: Choose a branch)"));
  writeFileSync(childSession, "");
  await append(journalPath(home, "owned"), JT.attentionResolved, { id: "question", rev: 1, resolution: "answered" });
  await prompt(pi, [{ text: "journal refreshed" }]);
  contexts = observed(pi).filter(e => e.kind === "context");
  assert.ok(contexts.at(-1).value.some((m: any) => m.customType === CT.attention && m.content === "(resolved: Choose a branch)"));
  assert.equal(items(pi)[0].content, "Choose a branch");
});

test("starter replays pending outbox at boot and notes never request continuation", { timeout: 30000 }, async t => {
  const { home, launch } = setup(t);
  const outbox = await Outbox.open(home, sender, () => join(home, "unpublished"));
  const req = await outbox.send("orch", "drain", {}); await outbox.close();
  const pi = launch("main", [], join(REPO, "test/pi/main/fixtures/notes.ts"));
  await until(async () => (await scanInbox(orchInbox(home))).find(r => r.rid === req.rid));
  await until(() => existsSync(join(home, "spawn.log")));
  await prompt(pi, [{ text: "QUEUE-NOTE" }]);
  const note = pi.sessionEntries().filter(e => e.type === "custom_message" && e.customType === CT.note);
  assert.equal(note.length, 1); assert.equal(note[0].content, "UI action recorded");
  assert.equal(pi.events.filter(e => e.type === "message_start" && (e.message as any).role === "assistant").length, 1);
  assert.equal(readFileSync(join(home, "spawn.log"), "utf8").trim().split("\n").length, 1);
});

test("T6/T10 real orchestrator: control actions report applied or the rejection reason; status is compact", { timeout: 90000 }, async t => {
  const root = tempRoot("dsa-main-real-"), home = join(root, "state");
  mkdirSync(home); writeFileSync(join(home, "config.json"), JSON.stringify({ k: { idleExitMs: 500 } }));
  // Real orchestrator (no DSA_ORCHESTRATOR_ENTRY); HOME is the temp root so agent discovery never reads the user's ~/.pi.
  const pi = startPi({ root, name: "main", extensions: [extension], args: ["--session-id", sessionId], env: { DSA_HOME: home, HOME: root, DSA_EXEC: "" } });
  t.after(async () => {
    await pi.stop();
    const lock = await until(() => new OsLock().tryAcquire(orchLock(home)), 20000); await lock.release();
    console.log(`M1 evidence: ${root}`);
  });
  await prompt(pi, [{ tool: "subagents", args: { action: "run", name: "probe", source: "console.log('from script', 7); return 1;" } }, { text: "done" }]);
  const wid = String(result(pi).result.details.wid);
  assert.ok(wid && wid !== "undefined", JSON.stringify(result(pi).result.details));
  await until(() => readJournalSnapshot(journalPath(home, wid)).some(e => e.type === JT.done), 20000);
  await prompt(pi, [{ tool: "subagents", args: { action: "resume", wid } }, { text: "done" }]);
  { const { rid, ...rest } = result(pi).result.details; assert.ok(rid); assert.deepEqual(rest, { applied: false, reason: "terminal:done \u2014 start a new run" }); }
  await prompt(pi, [{ tool: "subagents", args: { action: "stop", target: wid } }, { text: "done" }]);
  { const { rid, ...rest } = result(pi).result.details; assert.ok(rid); assert.deepEqual(rest, { applied: false, reason: "terminal:done" }); }
  await prompt(pi, [{ tool: "subagents", args: { action: "status" } }, { text: "done" }]);
  const view = result(pi).result.details;
  assert.deepEqual(view.workflows.map((w: any) => [w.wid, w.name, w.status, w.origin]), [[wid, "probe", "done", sender]]);
  assert.ok(!("entries" in view.workflows[0]) && view.workflows[0].usage);
  await prompt(pi, [{ tool: "subagents", args: { action: "status", wid } }, { text: "done" }]);
  const detail = result(pi).result.details;
  assert.equal(detail.result, 1); assert.ok(!("entries" in detail));
  assert.match(readFileSync(detail.scriptLog, "utf8"), /ev=1 log: from script 7\n/);
  // Every resolved control request is retired from the session outbox.
  const outbox = readJournalSnapshot(join(home, "outbox", `${sender}.jsonl`));
  const sent = outbox.filter(e => e.type === "sent").map(e => (e.request as { rid: string }).rid);
  assert.deepEqual(outbox.filter(e => e.type === "resolved").map(e => e.rid).sort(), [...sent].sort());
});

test("v12 §2: an answer finds its open question from the qid, the call, or nothing; a send without a target names addresses", { timeout: 60000 }, async t => {
  const { home, launch } = setup(t), lock = await new OsLock().tryAcquire(orchLock(home)); assert.ok(lock);
  t.after(() => lock.release());
  const pi = launch();
  await append(orchLedger(home), JT.created, { rid: "r", wid: "owned", origin: sender });
  await append(journalPath(home, "owned"), JT.created, { rid: "r", origin: sender });
  await append(journalPath(home, "owned"), "call", { pos: 0, key: "work", gen: 1, spec: { agent: "worker", task: "t" } });
  await append(journalPath(home, "owned"), JT.attention, { item: { id: "q:owned@1/work@1:x", rev: 3, kind: "question", wid: "owned", call: "owned@1/work@1", qid: "qx", text: "Which?", origin: sender } });
  await prompt(pi, [{ tool: "subagents", args: { action: "send", kind: "answer", message: "the first" } }, { tool: "subagents", args: { action: "send", kind: "steer", message: "x" } }, { text: "done" }], 40000);
  const [req] = await scanInbox(orchInbox(home));
  assert.deepEqual(req!.body, { to: "owned@1/work@1", kind: "answer", message: "the first" }); assert.deepEqual(req!.cond, { qid: "qx", rev: 3 });
  assert.equal(result(pi).isError, true);
  assert.match(JSON.stringify(result(pi).result.content), /to is required: '<wid>\/<key>'; running: owned\/work/);
});
