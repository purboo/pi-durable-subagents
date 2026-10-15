// An answer bound to a question (`answer-bound`) whose resolution was not appended (a crash between the two appends)
// is repaired when the call executes again: exactly one `attention-resolved{answered}` for that question.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { contentHash, forwardRid, ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type ProcInfo, type Request, type SpawnSpec } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { snapshotFromEntries } from "../../../../src/orchestrator/snapshot.ts";

const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };

test("an answer-bound without its resolution is repaired once when the call executes again", { timeout: 15000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-answer-repair-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  t.mock.method(console, "error", () => {});
  const call = `${wid}@1/a@1`, first = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  const lines = (rows: unknown[]) => rows.map(l => JSON.stringify(l)).join("\n") + "\n";
  // The first execution asked q1 and was cut off; the answer was bound, its resolution never appended.
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec: first } }, { type: "custom", customType: CT.question, data: { qid: "q1", rev: 1, question: "Choose?" } }]));
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "task" } });
  await journal.append(JT.exec, { call, exec: first });
  const id = `q:${call}:q1`;
  await journal.append(JT.attention, { item: { id, rev: 1, kind: "question", text: "Choose?", wid, call, qid: "q1" } });
  await journal.append("answer-bound", { call, qid: "q1", rev: 1, rid: "answer", rid2: "bound-answer", hash: "h", message: "Answer: yes" });
  const containment: Containment & { launches: SpawnSpec[] } = {
    launches: [],
    async spawn(spec: SpawnSpec) {
      this.launches.push(spec);
      // The child receives the bound answer (its receipt) and reports.
      await writeFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec: spec.exec } }, { type: "custom_message", details: { rid: "bound-answer", qid: "q1", rev: 1 } }, { type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok", data: {} } }]));
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
    async fence() {},
  };
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 }, writerLock: "off" } }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  await executor.recover(wid, journal);
  const result = await executor.run(ticket);
  assert.equal(result.status, "ok");
  assert.equal(containment.launches.length, 1);
  const resolved = journal.entries().filter(e => e.type === JT.attentionResolved && e.id === id);
  assert.deepEqual(resolved.map(e => [e.rev, e.resolution]), [[1, "answered"]]);
  // Repaired before the next execution was launched with the answer.
  const next = journal.entries().findIndex(e => e.type === JT.exec && e.exec !== first);
  assert.ok(journal.entries().indexOf(resolved[0]!) < next);
});

const lines = (rows: unknown[]) => rows.map(l => JSON.stringify(l)).join("\n") + "\n";
async function until(predicate: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= end) throw new Error("timed out waiting for answer repair"); await delay(5); }
}
async function answerFixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-answer-race-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, first = `${call}#1.1`, session = callSession(home, wid, "a", 1), id = `q:${call}:q1`;
  const question = [{ type: "custom", customType: CT.exec, data: { exec: first } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask", id: "ask-1" }] } },
    { type: "custom", customType: CT.question, data: { qid: "q1", rev: 1, question: "Choose?" } }];
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(session, lines(question));
  await journal.append("call", { key: "a", gen: 1, spec: { agent: "test", task: "task" } });
  const request: Request = { rid: "answer", from: "main:test", to: "orch", sseq: 1, kind: "send",
    cond: { qid: "q1", rev: 1 }, body: { to: call, kind: "answer", message: "yes" } };
  const hash = contentHash(request), rid2 = forwardRid(request.rid, `${wid}@1`, "a", hash);
  const forward = () => journal.append("forward", { rid: request.rid, rid2, hash, dest: call,
    envelope: { to: call, kind: "answer", body: { message: "yes" }, cond: request.cond } });
  const receipt = { type: "message", message: { role: "toolResult", toolCallId: "ask-1", toolName: "ask", content: "yes", details: { rid: rid2, qid: "q1", rev: 1 } } };
  const launches: SpawnSpec[] = [];
  const containment: Containment = {
    async spawn(spec) {
      launches.push(spec);
      await appendFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec: spec.exec } },
        { type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok", data: {} } }]));
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
    async fence() {},
  };
  const config = { k: { trackerMs: 10, hibernateMs: 600000 }, writerLock: "off" as const };
  const make = () => createExecutor({ home, orch, config }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  let executor = make();
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  const ctx = { journal, widRev: ticket.widRev, key: "a", gen: 1 };
  return { home, wid, orch, journal, call, first, session, id, question, receipt, request, rid2, forward, launches, containment, config, ticket, ctx,
    get executor() { return executor; }, async restart() { await executor.shutdown(); executor = make(); await executor.recover(wid, journal); },
    attention: () => journal.append(JT.attention, { item: { id, rev: 1, kind: "question", text: "Choose?", wid, call, qid: "q1" } }) };
}

for (const target of ["q1", "earlier"]) test(`a forwarded answer to ${target} wins the planned hibernation compare-and-set`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t), stdout = new PassThrough();
  t.mock.method(f.containment, "spawn", async (spec: SpawnSpec) => {
    f.launches.push(spec);
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise<{ code: number; signal: null }>(() => {}) };
  });
  if (target === "earlier") await writeFile(f.session, lines([f.question[0],
    { type: "custom", customType: CT.question, data: { qid: "earlier", rev: 1, question: "Earlier?" } }, ...f.question.slice(1)]));
  const pending = f.executor.run(f.ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.attention && (e.item as { qid?: string }).qid === "q1"));
  const req = { ...f.request, cond: { qid: target, rev: 1 } };
  // The answer is durably forwarded and sent while the session still shows the blocked ask. Make hibernation
  // due before the fake child consumes it: the decision must check the current journal, not just that session.
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  const forwarded = f.journal.entries().find(e => e.type === "forward" && e.rid === req.rid)!;
  await f.executor.reconfigure!(async () => { f.config.k.hibernateMs = 0; });
  await delay(60);
  assert.equal(f.journal.entries().filter(e => e.type === "hibernated").length, 0);
  // The child consumes the answer only after the planned hibernation was due.
  await appendFile(f.session, lines([{ ...f.receipt, message: { ...f.receipt.message, details: { rid: String(forwarded.rid2), qid: target, rev: 1, ...(target === "earlier" ? { superseded: [{ qid: "q1", rev: 1 }] } : {}) } } },
    { type: "custom", customType: CT.report, data: { exec: f.first, outcome: "ok", data: {} } }]));
  stdout.write('{"type":"tool_execution_end","toolName":"ask","toolCallId":"ask-1"}\n{"type":"message_start"}\n{"type":"agent_settled"}\n');
  assert.equal((await pending).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "hibernated").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered" && e.rid2 === forwarded.rid2).length, 1);
});

test("an answer queued after the session scan wins the serialized hibernation decision", { timeout: 10000 }, async t => {
  const f = await answerFixture(t), stdout = new PassThrough(); f.config.k.hibernateMs = 0;
  t.mock.method(f.containment, "spawn", async (spec: SpawnSpec) => {
    f.launches.push(spec);
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise<{ code: number; signal: null }>(() => {}) };
  });
  const append = f.journal.append.bind(f.journal);
  let forwarded: Promise<unknown> | undefined;
  t.mock.method(f.journal, "append", async (type: string, fields: Record<string, unknown>) => {
    const entry = await append(type, fields);
    if (type === JT.attention && !forwarded) {
      // Observation already read the unanswered session. Enqueue forwarding behind questions(), but ahead of
      // the hibernation CAS: only the decision's fresh journal state can see this answer.
      forwarded = f.executor.forward(f.request, f.ctx);
    }
    return entry;
  });
  const pending = f.executor.run(f.ticket);
  await until(() => !!forwarded); await forwarded; await delay(60);
  assert.equal(f.journal.entries().filter(e => e.type === "hibernated").length, 0);
  await appendFile(f.session, lines([f.receipt, { type: "custom", customType: CT.report, data: { exec: f.first, outcome: "ok", data: {} } }]));
  stdout.write('{"type":"agent_settled"}\n');
  assert.equal((await pending).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered" && e.rid2 === f.rid2).length, 1);
});

for (const mode of ["live", "restart", "fenced-asking"] as const) test(`a consumed answer stranded by ${mode} continues without a second answer`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  if (mode !== "fenced-asking") await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first });
  await appendFile(f.session, lines([f.receipt]));
  if (mode === "live") {
    assert.equal((await f.executor.run(f.ticket)).status, "ok");
  } else {
    await f.restart();
    assert.equal(snapshotFromEntries(f.wid, f.journal.entries()).calls[0]!.phase, "queued");
    assert.equal((await f.executor.run(f.ticket)).status, "ok");
  }
  assert.deepEqual(f.launches.map(s => s.exec), [`${f.call}#1.2`]);
  assert.equal(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === f.id && e.resolution === "answered").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered" && e.rid2 === f.rid2).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
});

test("a consumed earlier answer closes the reminder it superseded before recovery", { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  const reminder = `q:${f.call}:reminder`;
  await f.journal.append(JT.attention, { item: { id: reminder, rev: 1, kind: "question", text: "Reminder?", wid: f.wid, call: f.call, qid: "reminder" } });
  await appendFile(f.session, lines([{ type: "custom", customType: CT.question, data: { qid: "reminder", rev: 1, question: "Reminder?" } },
    { ...f.receipt, message: { ...f.receipt.message, details: { ...f.receipt.message.details, superseded: [{ qid: "reminder", rev: 1 }] } } }]));
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "reminder", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first }); await f.restart();
  assert.equal(snapshotFromEntries(f.wid, f.journal.entries()).calls[0]!.phase, "queued");
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.deepEqual(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === reminder).map(e => e.resolution), ["superseded"]);
  assert.equal(f.launches.length, 1);
});

test("a receipt appended during the hibernation fence is repaired before adoption", { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  t.mock.method(f.containment, "fence", async (exec: string) => { if (exec === f.first) await appendFile(f.session, lines([f.receipt])); });
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered" && e.rid2 === f.rid2).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-retired" && e.rid2 === f.rid2).length, 0);
});

for (const retry of ["same", "new"] as const) test(`a ${retry} answer retry repairs a stranded call before run`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first }); await appendFile(f.session, lines([f.receipt]));
  assert.deepEqual(await f.executor.forward({ ...f.request, rid: retry === "same" ? "answer" : "new" }, f.ctx),
    retry === "same" ? { action: "apply" } : { action: "reject", reason: "already-answered" });
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "answer-bound").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered").length, 1);
});

for (const boundary of ["answer-bound", JT.attentionResolved, "forward-retired", JT.exec]) test(`unconsumed-answer adoption retries after a crash before ${boundary}`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first });
  const spawn = f.containment.spawn.bind(f.containment);
  t.mock.method(f.containment, "spawn", async (spec: SpawnSpec) => {
    await appendFile(f.session, lines([{ ...f.receipt, message: { ...f.receipt.message, details: { ...f.receipt.message.details, rid: contentHash([f.rid2, "hibernated"]) } } }]));
    return spawn(spec);
  });
  const append = f.journal.append.bind(f.journal); let crash = true;
  const mock = t.mock.method(f.journal, "append", async (type: string, fields: Record<string, unknown>) => {
    if (crash && type === boundary) { crash = false; throw new Error("injected crash"); }
    return append(type, fields);
  });
  await assert.rejects(f.executor.run(f.ticket), /injected crash/); mock.mock.restore();
  await f.restart();
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "answer-bound").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-retired" && e.rid2 === f.rid2).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === f.id).length, 1);
});

for (const boundary of [JT.exec, "resumed"]) test(`consumed-answer continuation retries after a crash after ${boundary}`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first }); await appendFile(f.session, lines([f.receipt]));
  const append = f.journal.append.bind(f.journal); let crash = true;
  const mock = t.mock.method(f.journal, "append", async (type: string, fields: Record<string, unknown>) => {
    const entry = await append(type, fields);
    if (crash && type === boundary) { crash = false; throw new Error("injected crash after append"); }
    return entry;
  });
  await assert.rejects(f.executor.run(f.ticket), /injected crash/); mock.mock.restore();
  await f.restart();
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.equal(f.launches.length, 1, "only one continuation reaches the child");
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "answer-bound").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
});

test("recovery of a selected continuation cut off before spawn does not lose or bind its answer again", { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first }); await appendFile(f.session, lines([f.receipt]));
  await f.executor.recover(f.wid, f.journal);
  await f.journal.append(JT.exec, { call: f.call, exec: `${f.call}#1.2` });
  await f.journal.append("selected", { exec: `${f.call}#1.2`, model: { provider: "probe", id: "scripted" } });
  await f.restart();
  assert.equal((await f.executor.run(f.ticket)).status, "ok");
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "answer-bound").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered").length, 1);
});

for (const boundary of ["answer-bound", JT.attentionResolved, "forward-delivered", JT.exec]) test(`consumed-answer repair retries after a crash before ${boundary}`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first }); await appendFile(f.session, lines([f.receipt]));
  const append = f.journal.append.bind(f.journal); let crash = true;
  const mock = t.mock.method(f.journal, "append", async (type: string, fields: Record<string, unknown>) => {
    if (crash && type === boundary) { crash = false; throw new Error("injected crash"); }
    return append(type, fields);
  });
  await assert.rejects(f.executor.run(f.ticket), /injected crash/); mock.mock.restore();
  await f.restart(); await f.executor.recover(f.wid, f.journal);
  assert.deepEqual(await f.executor.forward(f.request, f.ctx), { action: "apply" });
  assert.deepEqual(await f.executor.forward({ ...f.request, rid: "new-answer" }, f.ctx), { action: "reject", reason: "already-answered" });
  const pending = f.executor.run(f.ticket);
  assert.equal(f.executor.run(f.ticket), pending);
  assert.equal((await pending).status, "ok");
  assert.equal(f.launches.length, 1);
  for (const type of ["answer-bound", "forward-delivered"]) assert.equal(f.journal.entries().filter(e => e.type === type && e.rid2 === f.rid2).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === f.id).length, 1);
});

// An answer consumed earlier in an execution that then kept working is no reason to resume it: a restart fences
// running children, and their own evidence decides (as on 1.0.40).
for (const work of ["report", "once-dangling"] as const) test(`an answer consumed before further work (${work}) keeps the evidence path`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t);
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append(JT.fenced, { exec: f.first });
  await appendFile(f.session, lines([f.receipt, work === "report"
    ? { type: "custom", customType: CT.report, data: { exec: f.first, outcome: "ok", data: {} } }
    : { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", id: "deploy-1" }] } }]));
  const ticket = work === "report" ? f.ticket : { ...f.ticket, spec: { ...f.ticket.spec, once: true } };
  const result = await f.executor.run(ticket);
  assert.equal(result.status, work === "report" ? "ok" : "unknown", JSON.stringify(result));
  assert.equal(f.launches.length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "answer-bound").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "forward-delivered" && e.rid2 === f.rid2).length, 1);
});

// A binding excuses only the launch that delivers it: a child that dies before its exec marker counts as a loss.
for (const kind of ["consumed", "unconsumed"] as const) test(`a ${kind} bound answer whose relaunch never starts stops at lossBound`, { timeout: 10000 }, async t => {
  const f = await answerFixture(t); (f.config.k as { lossBound?: number }).lossBound = 3;
  t.mock.method(f.containment, "spawn", async (spec: SpawnSpec) => {
    f.launches.push(spec);
    const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end(); stderr.end();
    // A real child that exits 1 before pi loads the session: tracked, but no exec marker.
    return { pid: 424242, start: `s-${f.launches.length}`, stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 1, signal: null }) };
  });
  await f.journal.append(JT.exec, { call: f.call, exec: f.first }); await f.attention(); await f.forward();
  await f.journal.append("hibernated", { call: f.call, exec: f.first, qid: "q1", rev: 1 });
  await f.journal.append(JT.fenced, { exec: f.first });
  if (kind === "consumed") await appendFile(f.session, lines([f.receipt]));
  const result = await Promise.race([f.executor.run(f.ticket), delay(8000).then(() => undefined)]);
  assert.ok(result, `relaunched without bound: ${f.launches.length} launches`);
  assert.equal(result.status, "failed", JSON.stringify(result)); assert.match(String(result.error), /lost/);
  assert.equal(f.launches.length, 3);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 3);
});
