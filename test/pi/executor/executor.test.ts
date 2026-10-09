import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FAUX, PI_BIN, REPO, script, settled, startPi, tempRoot, detachedSleep } from "../../harness/pi.ts";
import { parseAgent } from "../../../src/compat/agents.ts";
import { binDir, callDir, callInbox, callSession, journalPath, orchLedger, outboxRoot } from "../../../src/paths.ts";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { scanInbox } from "../../../src/kernel/mailbox.ts";
import { contentHash, forwardRid, ulid } from "../../../src/kernel/ids.ts";
import { CT, JT, type Containment, type JournalHandle, type Request } from "../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { writeShim } from "../../../src/platform/lease.ts";
import createExecutor, { modelRid, requestedModel } from "../../../src/orchestrator/executor/index.ts";
import { availableMemory } from "../../../src/orchestrator/executor/memory.ts";
import { evidence } from "../../../src/orchestrator/executor/session.ts";
import { serialContainment } from "../../../src/orchestrator/executor/sweep.ts";
import { snapshotFromEntries } from "../../../src/orchestrator/snapshot.ts";
/** Status of one call as the engine's journal would show it (the executor alone writes no `call` entry). */
function statusOf(journal: JournalHandle, wid: string, key = "a") {
  const call = { type: "call", seq: -1, ts: 0, key, gen: 1, pos: 0, spec: { agent: "test", model: "probe/scripted" } } as unknown as ReturnType<JournalHandle["entries"]>[number];
  return snapshotFromEntries(wid, [call, ...journal.entries()]).calls[0]!;
}

const recorder = fileURLToPath(new URL("recorder.ts", import.meta.url));
const agent = { name: "test", description: "test", body: "Test agent", model: "probe/scripted", tools: ["bash"], systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false, sourcePath: "/fixture/test.md", source: "project" as const };
async function until(predicate: () => boolean | Promise<boolean>, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for durable executor evidence"); await delay(20); }
}
/** A compact journal and session trace for a failure message (CI logs are the only evidence of a flake). */
function trace(entries: readonly Record<string, unknown>[], native: readonly Record<string, unknown>[]): string {
  const j = entries.filter(e => e.type !== "time").map(e => e.type === "observation" ? `obs:${(e.event as { type?: string }).type}` : `${e.type}${e.exec ? `(${String(e.exec).split("#")[1]})` : ""}`);
  const n = native.map(e => e.type === "message" ? `msg:${(e.message as { role?: string }).role}/${(e.message as { stopReason?: string }).stopReason ?? ""}${(e.message as { errorMessage?: string }).errorMessage ? `[${(e.message as { errorMessage?: string }).errorMessage}]` : ""}${(e.message as { model?: string }).model ? `@${(e.message as { model?: string }).model}` : ""}` : e.type === "model_change" ? `model_change:${String(e.modelId)}` : `${e.type}${e.customType ? `:${e.customType}` : ""}`);
  return `journal: ${j.join(" ")}\nsession: ${n.join(" ")}`;
}
async function setup(t: TestContext, config: OrchestratorConfig = {}, options: Parameters<typeof createExecutor>[1] = {}) {
  const root = tempRoot("dsa-executor-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_DIR: process.env.PROBE_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PROBE_DIR = root;
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  const orch = await openJournal(orchLedger(home));
  const wid = ulid();
  let journal = await openJournal(journalPath(home, wid));
  const executor = createExecutor({ home, orch, config }, options);
  const ticket = (key = "a", task = script([{ text: "full\nLEAF: final" }])): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd, journal, spec: { agent: "test", task }, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      await journal.close(); await orch.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true });
    }
  });
  return { wid, root, home, cwd, orch, executor, ticket, get journal() { return journal; }, async reopen() { journal = await openJournal(journal.path); } };
}
async function nativeSession(t: TestContext, f: Awaited<ReturnType<typeof setup>>, opts: { report?: unknown; text?: string; exec?: string; question?: boolean } = {}) {
  const ticket = f.ticket(), exec = opts.exec ?? `${ticket.callId}#1.1`;
  await mkdir(callDir(f.home, f.wid, "a", 1), { recursive: true });
  await f.journal.append(JT.exec, { exec, call: ticket.callId });
  const pi = startPi({ root: f.root, name: "native", extensions: [recorder], args: ["--session", callSession(f.home, f.wid, "a", 1)], env: { TEST_EXEC: exec, ...(opts.question ? { TEST_QUESTION: "1" } : {}), ...(opts.report !== undefined ? { TEST_REPORT: JSON.stringify(opts.report) } : {}) } });
  t.after(() => pi.stop());
  pi.send({ type: "prompt", message: script([{ text: opts.text ?? "full\nLEAF: final" }]) });
  await pi.waitFor(settled);
  return { pi, exec, ticket };
}
/** Every envelope the orchestrator sent, from its durable outbox (inbox files are deleted once resolved, E2). */
const sent = (home: string) => readJournalSnapshot(join(outboxRoot(home), "outbox", "orch.jsonl")).filter(e => e.type === "sent").map(e => e.request as Request);
const inboxFiles = async (f: { home: string; wid: string }, key = "a", gen = 1) => (await readdir(callInbox(f.home, f.wid, key, gen)).catch(() => [] as string[])).filter(n => !n.startsWith("."));
function assertSealed(journal: JournalHandle, call: string, status: string) {
  const seals = journal.entries().filter(e => e.type === JT.sealed && e.call === call);
  assert.equal(seals.length, 1); assert.equal((seals[0]!.result as { status: string }).status, status);
  assert.ok(journal.entries().some(e => e.type === JT.fenced && e.exec === seals[0]!.exec && e.seq < seals[0]!.seq));
}

test("writer lock: a real writer that hibernates keeps its worktree; the next writer runs once it ends", { timeout: 60000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 40, trackerMs: 20 } }, { memory: async () => 1e6 });
  execFileSync("git", ["init", "--quiet", f.cwd], { timeout: 5000 });
  const writer = (key: string) => {
    const ticket = f.ticket(key, script([{ tool: "write", args: { path: `${key}.txt`, content: key } }, { tool: "ask", args: { question: "Keep working?" } }, { text: "done" }]));
    ticket.spec.tools = ["read", "write"];
    return ticket;
  };
  const a = writer("a"), b = writer("b"), pa = f.executor.run(a);
  await until(() => f.journal.entries().some(e => e.type === "hibernated" && e.call === a.callId));
  const pb = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === "writer-wait" && e.call === b.callId));
  await delay(300);
  assert.ok(!f.journal.entries().some(e => e.type === "selected" && String(e.exec).startsWith(`${b.callId}#`)), "b waits while a hibernates");
  assert.equal(existsSync(join(f.cwd, "b.txt")), false);
  assert.equal(statusOf(f.journal, f.wid, "b").writerWait?.holder, `${f.wid}/a`);
  await f.executor.stop({ wid: f.wid, callId: a.callId }); await pa;
  await until(() => f.journal.entries().some(e => e.type === "hibernated" && e.call === b.callId));
  assert.equal(await readFile(join(f.cwd, "b.txt"), "utf8"), "b");
  await f.executor.stop({ wid: f.wid, callId: b.callId }); await pb;
  assert.ok(!f.orch.entries().some(e => e.type === "writer-hold" && !f.orch.entries().some(r => r.type === "writer-release" && r.call === e.call)));
});

test("shared worktree reminder (writerLock off) observes real pi writes without blocking either call", { timeout: 60000 }, async t => {
  const f = await setup(t, { writerLock: "off", k: { hibernateMs: 40, trackerMs: 20 } }, { memory: async () => 1e6 });
  execFileSync("git", ["init", "--quiet", f.cwd], { timeout: 5000 });
  const writer = (key: string) => {
    const ticket = f.ticket(key, script([{ tool: "write", args: { path: `${key}.txt`, content: key } }, { tool: "ask", args: { question: "Keep working?" } }, { text: "done" }]));
    ticket.spec.tools = ["write"];
    return ticket;
  };
  const a = writer("a"), b = writer("b"), pa = f.executor.run(a);
  await until(() => f.journal.entries().some(e => e.type === "hibernated" && e.call === a.callId));
  const conflicts = () => f.journal.entries().filter(e => e.type === JT.attention && (e.item as { kind: string }).kind === "conflict");
  assert.equal(conflicts().length, 0, "a call writing alone has no reminder");
  const pb = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === "hibernated" && e.call === b.callId));
  assert.equal(conflicts().length, 1);
  assert.equal((conflicts()[0]!.item as { call: string }).call, b.callId);
  assert.equal(await readFile(join(f.cwd, "a.txt"), "utf8"), "a");
  assert.equal(await readFile(join(f.cwd, "b.txt"), "utf8"), "b");
  assert.deepEqual(f.journal.entries().filter(e => e.type === "wrote").map(e => e.root), [f.cwd, f.cwd]);
  await f.executor.stop({ wid: f.wid, callId: b.callId }); await pb;
  const id = (conflicts()[0]!.item as { id: string }).id;
  assert.equal(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === id).length, 1);
  await f.executor.stop({ wid: f.wid, callId: a.callId }); await pa;
  assert.equal(conflicts().length, 1);
});

test("P28 hibernates without loss, binds once, resumes with one receipt", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 40, trackerMs: 20 } });
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Choose?" } }, { text: "answered" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  const h = f.journal.entries().find(e => e.type === "hibernated")!;
  await until(() => f.orch.entries().filter(e => e.type === "release").length >= 2);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  const req: Request = { rid: "answer", from: "main:test", to: "orch", sseq: 1, kind: "send", cond: { qid: String(h.qid), rev: Number(h.rev) }, body: { to: ticket.callId, kind: "answer", message: "yes " + script([{ text: "resumed" }]) } };
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: ticket.gen };
  assert.deepEqual(await f.executor.forward({ ...req, rid: "stale", cond: { qid: String(h.qid), rev: 9 } }, ctx), { action: "reject", reason: "stale-rev" });
  assert.deepEqual(await f.executor.forward(req, ctx), { action: "apply" });
  assert.deepEqual(await f.executor.forward(req, ctx), { action: "apply" });
  assert.deepEqual(await f.executor.forward({ ...req, rid: "duplicate" }, ctx), { action: "reject", reason: "already-answered" });
  const result = await pending;
  assert.equal(result.status, "ok");
  const bound = f.journal.entries().find(e => e.type === "answer-bound")!;
  const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === bound.rid2).length, 1);
  // The resumed asker is told its execution (and its processes) stopped while it waited.
  assert.match(String(rows.find(e => e.type === "custom_message" && e.details?.rid === bound.rid2)?.content), /^While you waited for the answer below your execution was stopped;[^]*\nQuestion: Choose\?\nAnswer: yes /);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "resumed").length, 1);
  assert.deepEqual(await f.executor.forward({ ...req, rid: "retired" }, ctx), { action: "reject", reason: "retired" });
});

for (const once of [true, false]) test(`P28 a${once ? " once" : "n"} asker cut off before it hibernated hibernates on recovery (no loss${once ? ", not unknown" : ""}) and resumes with the answer`, { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 600000, trackerMs: 20 } });
  const base = f.ticket("a", script([{ tool: "ask", args: { question: "Choose?" } }, { text: "answered" }]));
  const ticket: CallTicket = { ...base, spec: { ...base.spec, once } };
  const pending = f.executor.run(ticket);
  const question = () => f.journal.entries().find(e => e.type === JT.attention && (e.item as { qid?: string }).qid)?.item as { qid: string; rev: number } | undefined;
  await until(() => !!question());
  // An orchestrator restart (or a crash) cuts the asker off before its planned hibernation.
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.suspend(); await rejected;
  const resumed = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  const h = f.journal.entries().find(e => e.type === "hibernated")!;
  assert.equal(h.qid, question()!.qid);
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0, "not sealed unknown");
  const req: Request = { rid: "answer", from: "main:test", to: "orch", sseq: 1, kind: "send", cond: { qid: String(h.qid), rev: Number(h.rev) }, body: { to: ticket.callId, kind: "answer", message: "yes " + script([{ text: "resumed" }]) } };
  assert.deepEqual(await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: ticket.gen }), { action: "apply" });
  const result = await resumed;
  assert.equal(result.status, "ok");
  assert.equal(result.output, "resumed");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec && e.call === ticket.callId).length, 2, "one execution asked, one resumed with the answer");
});

test("P28/P12 a model send to a hibernated asker is recorded and its resumed execution launches on that model", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 40, trackerMs: 20 } });
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Choose?" } }, { text: "answered" }]));
  const pending = f.executor.run(ticket), first = `${ticket.callId}#1.1`;
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  await until(() => f.journal.entries().some(e => e.type === JT.fenced && e.exec === first));
  const h = f.journal.entries().find(e => e.type === "hibernated")!;
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: ticket.gen };
  const model: Request = { rid: "to-scripted2", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "probe/scripted2" } };
  assert.deepEqual(await f.executor.forward(model, ctx), { action: "apply" });
  assert.deepEqual(f.orch.entries().filter(e => e.type === "send-note").map(e => [e.rid, e.model, e.effect]), [["to-scripted2", "probe/scripted2", "next-execution"]]);
  const waiting = statusOf(f.journal, f.wid);
  assert.equal(waiting.model, "probe/scripted"); assert.equal(waiting.switching, "probe/scripted2");
  const answer: Request = { rid: "answer", from: "main:test", to: "orch", sseq: 2, cond: { qid: String(h.qid), rev: Number(h.rev) }, kind: "send", body: { to: ticket.callId, kind: "answer", message: "yes " + script([{ text: "resumed" }]) } };
  assert.deepEqual(await f.executor.forward(answer, ctx), { action: "apply" });
  const result = await pending; assert.equal(result.status, "ok");
  const selected = f.journal.entries().filter(e => e.type === "selected").map(e => (e.model as { id: string }).id);
  assert.deepEqual(selected, ["scripted", "scripted2"]);
  const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.findLast(e => e.type === "message" && e.message.role === "assistant").message.model, "scripted2");
  const done = statusOf(f.journal, f.wid);
  assert.equal(done.model, "probe/scripted2"); assert.equal(done.switching, undefined);
});

test("P12 a model send to a call still waiting for a slot applies when it launches", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 } } });
  const a = f.ticket("a", script([{ delayMs: 1500, text: "a done" }])), b = f.ticket("b", script([{ text: "b done" }]));
  const runA = f.executor.run(a);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const runB = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === JT.exec && e.call === b.callId));
  const req: Request = { rid: "b-model", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: b.callId, kind: "model", model: "probe/scripted2" } };
  assert.deepEqual(await f.executor.forward(req, { journal: f.journal, widRev: b.widRev, key: "b", gen: 1 }), { action: "apply" });
  assert.equal(f.orch.entries().find(e => e.type === "send-note" && e.rid === "b-model")?.effect, "next-execution");
  assert.equal((await runA).status, "ok"); assert.equal((await runB).status, "ok");
  const selectedB = f.journal.entries().find(e => e.type === "selected" && String(e.exec).startsWith(b.callId))!;
  assert.equal((selectedB.model as { id: string }).id, "scripted2");
  assert.equal(statusOf(f.journal, f.wid, "b").model, "probe/scripted2");
});

test("P12 a follow-up naming a model records model and message together; withdrawing it withdraws both; a sealed call takes neither", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 } } });
  const a = f.ticket("a", script([{ delayMs: 1500, text: "a done" }])), b = f.ticket("b", script([{ text: "b done" }]));
  const runA = f.executor.run(a);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const runB = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === JT.exec && e.call === b.callId));
  const ctx = { journal: f.journal, widRev: b.widRev, key: "b", gen: 1 };
  const followUp: Request = { rid: "b-follow", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: b.callId, kind: "follow-up", message: "then this", model: "probe/scripted2" } };
  assert.deepEqual(await f.executor.forward(followUp, ctx), { action: "apply" });
  assert.deepEqual(await f.executor.forward(followUp, ctx), { action: "apply" }, "a replay records nothing twice");
  const forwards = () => f.journal.entries().filter(e => e.type === "forward" && e.dest === b.callId);
  assert.deepEqual(forwards().map(e => [e.rid, (e.envelope as { kind: string }).kind]), [[modelRid("b-follow"), "model"], ["b-follow", "follow-up"]]);
  assert.equal(f.orch.entries().find(e => e.type === "send-note" && e.rid === "b-follow")?.effect, "next-execution");
  assert.equal(requestedModel(f.journal, b.callId)?.id, "scripted2");
  const withdraw: Request = { rid: "b-withdraw", from: "main:test", to: "orch", sseq: 2, kind: "withdraw", body: { rids: ["b-follow"] } };
  assert.deepEqual(await f.executor.forward(withdraw, ctx), { action: "apply" });
  assert.equal(requestedModel(f.journal, b.callId), undefined, "the model request is withdrawn with the follow-up");
  assert.equal((await runA).status, "ok"); assert.equal((await runB).status, "ok");
  const selectedB = f.journal.entries().find(e => e.type === "selected" && String(e.exec).startsWith(b.callId))!;
  assert.equal((selectedB.model as { id: string }).id, "scripted");
  const late: Request = { ...followUp, rid: "b-late" };
  assert.deepEqual(await f.executor.forward(late, ctx), { action: "reject", reason: "call-sealed" });
  assert.equal(forwards().filter(e => e.rid === modelRid("b-late")).length, 0, "a sealed call takes no model request either");
});

test("P12 a provider refusal of the content fails the call at once instead of retrying it as lost", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { lossBound: 5, trackerMs: 25 } });
  const refusal = "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering";
  const ticket = f.ticket("a", script([{ error: refusal }, { error: refusal }, { error: refusal }]));
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /^Refused by the provider \(not retried\): This request was blocked/);
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
});

test("P28 recovery after answer-bound before delivery preserves the answer identity", { timeout: 30000 }, async t => {
  const config = { k: { hibernateMs: 20, trackerMs: 20 } };
  const f = await setup(t, config), ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Crash?" } }]));
  const pending = f.executor.run(ticket); void pending.catch(() => {});
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  await f.executor.suspend(); await assert.rejects(pending, { name: "ExecutorShutdown" });
  const h = f.journal.entries().find(e => e.type === "hibernated")!;
  const req: Request = { rid: "recover-answer", from: "main:test", to: "orch", sseq: 1, kind: "send", cond: { qid: String(h.qid), rev: Number(h.rev) }, body: { to: ticket.callId, kind: "answer", message: script([{ text: "recovered" }]) } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 });
  assert.equal(f.journal.entries().filter(e => e.type === "resumed").length, 0);
  await f.executor.shutdown();
  const fresh = createExecutor({ home: f.home, orch: f.orch, config });
  try {
    await fresh.recover(f.wid, f.journal);
    assert.equal((await fresh.run(ticket)).output, "recovered");
    const bound = f.journal.entries().find(e => e.type === "answer-bound")!;
    const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === bound.rid2).length, 1);
    assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  } finally { await fresh.shutdown(); }
});

test("P28 stop while hibernated settles without a loss", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 20, trackerMs: 20 } });
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Wait?" } }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  await f.executor.stop({ wid: f.wid });
  assert.equal((await pending).status, "stopped");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
});

for (const reason of ["timeout", "budget", "retire"] as const) test(`P28 ${reason} while hibernated settles or retires`, { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { hibernateMs: 20, trackerMs: 20 } });
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Wait?" } }]));
  if (reason === "budget") ticket.spec.budget = { tokens: 1000000 };
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  if (reason === "timeout") await f.journal.append("timeout-intent", { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  if (reason === "budget") await f.journal.append("usage", { call: ticket.callId, id: "budget-observation", usage: { input: 1000000, output: 0, costUsd: 0 } });
  if (reason === "retire") await f.executor.retire(ticket.widRev);
  const result = await pending;
  assert.equal(result.status, reason === "retire" ? "stopped" : reason);
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  if (reason === "retire") assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
});

test("P28 receipt-before-crash does not redeliver the answer", { timeout: 30000 }, async t => {
  const config = { k: { hibernateMs: 20, trackerMs: 20 } }, f = await setup(t, config);
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Receipt?" } }]));
  const pending = f.executor.run(ticket); void pending.catch(() => {});
  await until(() => f.journal.entries().some(e => e.type === "hibernated"));
  const h = f.journal.entries().find(e => e.type === "hibernated")!;
  const req: Request = { rid: "answer-before-crash", from: "main:test", to: "orch", sseq: 1, kind: "send", cond: { qid: String(h.qid), rev: Number(h.rev) }, body: { to: ticket.callId, kind: "answer", message: script([{ delayMs: 1000, text: "after receipt" }]) } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 });
  const bound = f.journal.entries().find(e => e.type === "answer-bound")!;
  const rows = async () => (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await rows()).some(e => e.type === "custom_message" && e.details?.rid === bound.rid2));
  await f.executor.shutdown(); await assert.rejects(pending, { name: "ExecutorShutdown" });
  const fresh = createExecutor({ home: f.home, orch: f.orch, config });
  try {
    await fresh.recover(f.wid, f.journal); assert.equal((await fresh.run(ticket)).status, "ok");
    assert.equal((await rows()).filter(e => e.type === "custom_message" && e.details?.rid === bound.rid2).length, 1);
    assert.equal(f.journal.entries().filter(e => e.type === "resumed").length, 1);
  } finally { await fresh.shutdown(); }
});

test("P30 stop during beforeSeal aborts the effect and wins the seal", { timeout: 30000 }, async t => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await setup(t, {}, { effects: {
    prepare: async ticket => ({ cwd: ticket.cwd }), recover: async () => {}, afterSeal: async () => {},
    beforeSeal: async (_ticket, _exec, result, ctl) => { entered(); await new Promise<void>(resolve => { if (ctl.signal.aborted) resolve(); else ctl.signal.addEventListener("abort", () => resolve(), { once: true }); }); return result; },
  } });
  const ticket = f.ticket(), pending = f.executor.run(ticket);
  await ready; await f.executor.stop({ wid: f.wid }); assert.equal((await pending).status, "stopped");
});

test("P19 P30 effects prepare, fence, beforeSeal, seal, afterSeal order", { timeout: 30000 }, async t => {
  const order: string[] = [];
  const f = await setup(t, {}, { effects: {
    prepare: async ticket => { order.push("prepare"); return { cwd: ticket.cwd }; },
    beforeSeal: async (ticket, exec, result) => { assert.ok(ticket.journal.entries().some(e => e.type === JT.fenced && e.exec === exec)); assert.ok(!ticket.journal.entries().some(e => e.type === JT.sealed)); order.push("before"); return result; },
    afterSeal: async ticket => { assert.ok(ticket.journal.entries().some(e => e.type === JT.sealed)); order.push("after"); },
    recover: async () => { order.push("recover"); },
  } });
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(f.ticket())).status, "ok");
  assert.deepEqual(order, ["recover", "prepare", "before", "after"]);
});

test("P9 recovery reads full last text from real pi after durable settled and fence", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, exec, ticket } = await nativeSession(t, f);
  await pi.stop(); await f.journal.append("settled", { exec });
  await f.executor.recover(f.wid, f.journal);
  const promise = f.executor.run(ticket); assert.equal(f.executor.run(ticket), promise);
  const result = await promise;
  assert.equal(result.status, "ok"); assert.equal(result.output, "full\nLEAF: final");
  assert.equal(f.executor.run(ticket), promise); assertSealed(f.journal, ticket.callId, "ok");
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 1);
});

test("P9 report takes precedence without a settled event; recovery makes no provider call", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, exec, ticket } = await nativeSession(t, f, { report: { verdict: "retained" } });
  const identity = (await new ProcessTable().list()).find(p => p.pid === pi.child.pid)!;
  assert.ok(identity.start); assert.equal(identity.tag, undefined);
  await f.journal.append("tracked", { exec, pid: identity.pid, start: identity.start });
  const log = await readFile(join(pi.dir, "ext.log"), "utf8");
  await f.executor.recover(f.wid, f.journal);
  const result = await f.executor.run(ticket);
  assert.deepEqual(result.data, { verdict: "retained" });
  assert.equal(result.output, '{"verdict":"retained"}\nfull\nLEAF: final');
  assert.equal(await readFile(join(pi.dir, "ext.log"), "utf8"), log);
  assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
  assertSealed(f.journal, ticket.callId, "ok");
});

test("P22 executor SIGKILL after fence preserves a real session report across recovery", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, exec, ticket } = await nativeSession(t, f, { report: { recovered: true } });
  await pi.stop();
  await f.orch.append("hold", { pool: "probe", slot: 0, exec });
  await f.journal.close();
  const worker = fork(fileURLToPath(new URL("crash-worker.ts", import.meta.url)), [], { env: { ...process.env, DSA_HOME: f.home, TEST_WID: f.wid }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { worker.kill("SIGKILL"); });
  const [message] = await once(worker, "message", { signal: AbortSignal.timeout(10000) }); assert.equal(message, "fenced");
  const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
  await f.reopen(); ticket.journal = f.journal;
  await f.executor.recover(f.wid, f.journal);
  assert.deepEqual((await f.executor.run(ticket)).data, { recovered: true });
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 1);
  assert.ok(f.orch.entries().some(e => e.type === "release" && e.exec === exec));
});

test("P7 deterministic steer, idempotent replay, withdrawal and sealed rejection", { timeout: 10000 }, async t => {
  const f = await setup(t), ticket = f.ticket();
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 };
  const req: Request = { rid: "steer-1", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "change" } };
  assert.deepEqual(await f.executor.forward(req, ctx), { action: "apply" });
  const rid2 = forwardRid(req.rid, ticket.widRev, ticket.key, contentHash(req));
  const first = await scanInbox(callInbox(f.home, f.wid, "a", 1)); assert.equal(first[0]!.rid, rid2);
  assert.deepEqual(first[0]!.body, { message: "change" });
  await rm(join(callInbox(f.home, f.wid, "a", 1), `${rid2}.json`));
  await f.executor.recover(f.wid, f.journal);
  assert.deepEqual(await scanInbox(callInbox(f.home, f.wid, "a", 1)), first);
  await f.executor.forward(req, ctx); assert.equal(f.journal.entries().filter(e => e.type === "forward").length, 1);
  assert.deepEqual(await f.executor.forward({ ...req, body: { changed: true } }, ctx), { action: "reject", reason: "identity-conflict" });
  const withdrawal: Request = { rid: "withdraw-1", from: req.from, to: "orch", sseq: 2, kind: "withdraw", body: { rids: [req.rid] } };
  await f.executor.forward(withdrawal, ctx);
  const requests = await scanInbox(callInbox(f.home, f.wid, "a", 1));
  assert.deepEqual(requests.find(r => r.kind === "withdraw")!.body, { rids: [rid2] });
  const next = { ...req, rid: "steer-2", sseq: 3, cond: { after: withdrawal.rid, epoch: ticket.widRev } };
  await f.executor.forward(next, ctx);
  const all = await scanInbox(callInbox(f.home, f.wid, "a", 1));
  assert.equal(all.find(r => r.sseq === 3)!.cond!.after, all.find(r => r.kind === "withdraw")!.rid);
  assert.equal(all.find(r => r.sseq === 3)!.cond!.epoch, undefined);
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await f.executor.stop({ wid: f.wid, callId: ticket.callId });
  assert.deepEqual(await f.executor.forward({ ...req, rid: "late" }, ctx), { action: "reject", reason: "call-sealed" });
});

test("P9/K2 empty recovered session at the loss bound seals failed without spawning", { timeout: 10000 }, async t => {
  const f = await setup(t, { k: { lossBound: 2 } }), ticket = f.ticket();
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await f.journal.append(JT.fenced, { exec: `${ticket.callId}#1.1` });
  await f.journal.append("loss", { exec: `${ticket.callId}#1.1` });
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.2` });
  await f.executor.recover(f.wid, f.journal);
  const result = await f.executor.run(ticket); assert.equal(result.status, "failed"); assert.equal(result.error, "lost ×2");
  assertSealed(f.journal, ticket.callId, "failed");
});

test("P9 current-segment evidence excludes earlier reports, aborted text and dangling tools", () => {
  const entries = [
    { type: "custom", customType: CT.exec, data: { exec: "old" } },
    { type: "custom", customType: CT.report, data: { exec: "old", outcome: "ok" } },
    { type: "custom", customType: CT.exec, data: { exec: "new" } },
    { type: "message", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "invalid" }] } },
    { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1", name: "bash" }] } },
  ];
  const result = evidence(entries, "new"); assert.equal(result.report, undefined); assert.equal(result.text, ""); assert.deepEqual(result.dangling, ["bash (tool-1)"]);
  assert.deepEqual(evidence(entries, "missing").dangling, []);
});

test("V1 real pi processes serialize provider slots; stop fences and seals exactly once", { timeout: 90000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 } }, k: { trackerMs: 25 } });
  const a = f.ticket("a", script([{ delayMs: 60000, text: "late" }])), b = f.ticket("b", a.spec.task);
  const pa = f.executor.run(a), pb = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === "tracked" && e.exec === `${a.callId}#1.1`));
  assert.equal(f.orch.entries().filter(e => e.type === "hold" && e.pool === "probe").length, 1);
  await f.executor.stop({ wid: f.wid, callId: a.callId }); assert.equal((await pa).status, "stopped");
  await until(() => f.journal.entries().some(e => e.type === "tracked" && e.exec === `${b.callId}#1.1`));
  await f.executor.stop({ wid: f.wid, callId: b.callId }); assert.equal((await pb).status, "stopped");
  await f.executor.stop({ wid: f.wid });
  assertSealed(f.journal, a.callId, "stopped"); assertSealed(f.journal, b.callId, "stopped");
  const holders = new Set<string>();
  for (const e of f.orch.entries()) { if (e.type === "hold") holders.add(String(e.exec)); if (e.type === "release") holders.delete(String(e.exec)); assert.ok(holders.size <= 1); }
  assert.equal(holders.size, 0); assert.equal(f.executor.busy(), false);
});

test("V1 pool chooses first free candidate without holding another provider", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { blocked: { slots: 0 }, probe: { slots: 1 } }, pools: { pool: ["blocked/id", "probe/scripted"] } });
  const ticket = f.ticket(); ticket.spec.model = "pool";
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  assert.deepEqual(f.orch.entries().filter(e => e.type === "hold").map(e => e.pool), ["memory", "probe"]);
  await f.executor.stop({ wid: f.wid }); assert.equal((await pending).status, "stopped");
});

test("V1 pending X to Y switch rejects a return to held X before Y is observed", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, "switch-probe": { slots: 1 } } });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ extensions: [FAUX, fileURLToPath(new URL("switch-provider.ts", import.meta.url))] }));
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 2" } }, { text: "must switch" }]));
  const pending = f.executor.run(ticket), exec = `${ticket.callId}#1.1`;
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 };
  const toY: Request = { rid: "switch-to-y", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "switch-probe/target" } };
  assert.deepEqual(await f.executor.forward(toY, ctx), { action: "apply" });
  assert.ok(f.orch.entries().some(e => e.type === "hold" && e.exec === exec && e.pool === "switch-probe" && e.reserved));
  assert.ok(!f.orch.entries().some(e => e.type === "switch-observed"));
  const toX: Request = { ...toY, rid: "switch-back-x", sseq: 2, body: { to: ticket.callId, kind: "model", model: "probe/scripted" } };
  assert.deepEqual(await f.executor.forward(toX, ctx), { action: "reject", reason: "switch-pending" });
  assert.equal(f.journal.entries().filter(e => e.type === "forward").length, 1);
  assert.equal((await scanInbox(callInbox(f.home, f.wid, "a", 1))).filter(r => r.kind === "model").length, 1);
  const result = await pending; assert.equal(result.output, "switched to Y");
  // Status shows the model the call answers with, not the one it launched with.
  assert.deepEqual(f.journal.entries().filter(e => e.type === "model-used").map(e => [e.exec, e.model]), [[exec, { provider: "switch-probe", id: "target" }]]);
  assert.equal(statusOf(f.journal, f.wid).model, "switch-probe/target");
  const observed = f.orch.entries().find(e => e.type === "switch-observed" && e.exec === exec)!;
  assert.ok(observed, "real Y message_start must activate the reservation");
  assert.ok(f.orch.entries().some(e => e.type === "release" && e.exec === exec && e.pool === "probe" && e.seq > observed.seq));
  const held = new Map<string, Set<string>>();
  for (const e of f.orch.entries()) {
    const pool = String(e.pool), holders = held.get(pool) ?? new Set<string>(); held.set(pool, holders);
    if (e.type === "hold") holders.add(String(e.exec));
    if (e.type === "release") holders.delete(String(e.exec));
    assert.ok(holders.size <= 1, `provider ${pool} exceeded capacity`);
  }
  assert.ok([...held.values()].every(holders => holders.size === 0));
});

test("V1 model forwarding reserves a target before publishing and rejects a full provider", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, full: { slots: 0 }, other: { slots: 1 } } });
  const ticket = f.ticket(), pending = f.executor.run(ticket), exec = `${ticket.callId}#1.1`;
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 };
  const req: Request = { rid: "model-1", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "full/id" } };
  assert.deepEqual(await f.executor.forward(req, ctx), { action: "reject", reason: "provider-full" });
  assert.equal(f.journal.entries().filter(e => e.type === "forward").length, 0);
  assert.deepEqual(await f.executor.forward({ ...req, body: { to: ticket.callId, kind: "model", model: "other/id:high" } }, ctx), { action: "apply" });
  assert.ok(f.orch.entries().some(e => e.type === "hold" && e.pool === "other" && e.reserved && e.exec === exec));
  const forwarded = (await scanInbox(callInbox(f.home, f.wid, "a", 1))).find(r => r.kind === "model")!;
  assert.deepEqual(forwarded.body, { provider: "other", model: "id", thinking: "high" });
  await f.executor.stop({ wid: f.wid }); await pending;
  assert.deepEqual(f.orch.entries().filter(e => e.type === "release").map(e => e.pool).sort(), ["memory", "other", "probe"]);
});

test("V1 an expired switch reservation is fenced before its slots are released", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, other: { slots: 1 } }, k: { trackerMs: 25, switchTimeoutMs: 20, lossBound: 1 } });
  const ticket = f.ticket(), pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const req: Request = { rid: "expired-switch", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "other/id" } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 });
  assert.equal((await pending).status, "failed");
  assertSealed(f.journal, ticket.callId, "failed");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "release").map(e => e.pool).sort(), ["memory", "other", "probe"]);
});

test("V1 missing model uses isolated Pi settings before acquiring a provider slot", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket(); ticket.agent = { ...ticket.agent, model: undefined };
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  assert.equal(f.orch.entries().find(e => e.type === "hold" && e.pool === "probe")!.pool, "probe");
  await f.executor.stop({ wid: f.wid }); await pending;
});

test("P9 stop wins over a durable report and repeated stop never creates a second seal", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, ticket } = await nativeSession(t, f, { report: { done: true } }); await pi.stop();
  await f.executor.recover(f.wid, f.journal);
  await f.executor.stop({ wid: f.wid, callId: ticket.callId });
  assert.equal((await f.executor.run(ticket)).status, "stopped");
  await f.executor.stop({ wid: f.wid }); assertSealed(f.journal, ticket.callId, "stopped");
});

test("V1 stopping a call waiting on zero capacity acquires nothing and spawns nothing", { timeout: 10000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 0 } } }), ticket = f.ticket();
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  const switchRequest: Request = { rid: "waiting-switch", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "probe/scripted2" } };
  // P12: recorded for its launch; that model's provider has no capacity either, so the call keeps waiting.
  assert.deepEqual(await f.executor.forward(switchRequest, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 }), { action: "apply" });
  await delay(100);
  await f.executor.stop({ wid: f.wid }); assert.equal((await pending).status, "stopped");
  assert.equal(f.orch.entries().filter(e => e.type === "hold").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "tracked").length, 0);
});

test("P9 schema-bearing calls do not accept plain text instead of a report", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { lossBound: 1 } }), { pi, exec, ticket } = await nativeSession(t, f); await pi.stop();
  ticket.spec.schema = { type: "object" }; await f.journal.append("settled", { exec });
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(ticket)).status, "failed");
});

test("P15 recovered native questions are recorded once and close when the call seals", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, ticket } = await nativeSession(t, f, { report: { done: true }, question: true }); await pi.stop();
  await f.executor.recover(f.wid, f.journal); await f.executor.run(ticket); await f.executor.run(ticket);
  const attention = f.journal.entries().filter(e => e.type === JT.attention);
  assert.equal(attention.length, 1);
  assert.deepEqual(attention[0]!.item, { id: `q:${ticket.callId}:q1`, rev: 1, kind: "question", text: "Need input", wid: f.wid, call: ticket.callId, qid: "q1", session: callSession(f.home, f.wid, "a", 1) });
  assert.equal(f.journal.entries().filter(e => e.type === JT.attentionResolved && e.resolution === "retired").length, 1);
});

test("C1 two successful calls obey provider capacity through normal model completion", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 } } });
  const a = f.ticket("a", script([{ delayMs: 200, text: "first" }])), b = f.ticket("b", script([{ text: "second" }]));
  const results = await Promise.all([f.executor.run(a), f.executor.run(b)]);
  assert.deepEqual(results.map(r => r.output), ["first", "second"]);
  const holders = new Set<string>();
  for (const e of f.orch.entries()) { if (e.type === "hold") holders.add(String(e.exec)); if (e.type === "release") holders.delete(String(e.exec)); assert.ok(holders.size <= 1); }
  assert.equal(holders.size, 0);
});

test("C1 spawn and plain-text settle preserve the complete final text", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket();
  const result = await f.executor.run(ticket); assert.equal(result.output, "full\nLEAF: final"); assertSealed(f.journal, ticket.callId, "ok");
  assert.ok(f.journal.entries().some(e => e.type === "tracked"));
});

test("P9 a restart while the first execution waits for a slot delivers the task, never a bare continue", { timeout: 45000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 0 } } }), ticket = f.ticket();
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.shutdown(); await rejected;
  assert.equal(f.journal.entries().filter(e => e.type === "tracked").length, 0, "the first execution never launched");
  const restarted = createExecutor({ home: f.home, orch: f.orch, config: {} });
  t.after(() => restarted.shutdown());
  await restarted.recover(f.wid, f.journal);
  const result = await restarted.run(ticket);
  assert.equal(result.status, "ok", JSON.stringify(result)); assert.equal(result.output, "full\nLEAF: final");
  assert.ok(f.journal.entries().filter(e => e.type === JT.exec).length >= 2, "a second execution ran");
  const requests = sent(f.home).filter(r => r.to === ticket.callId);
  assert.deepEqual(requests.map(r => r.kind), ["task"]);
  assert.equal((requests[0]!.body as { message: string }).message, ticket.spec.task);
  const entries = readFileSync(callSession(f.home, f.wid, "a", 1), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.type === "custom_message" && e.details?.rid === requests[0]!.rid).length, 1, "the session holds the task once");
});

test("C1 empty reply loses once, then continues in the same native session", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ empty: true }, { text: "continued" }]));
  const result = await f.executor.run(ticket); assert.equal(result.output, "continued");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 1);
  const entries = readFileSync(callSession(f.home, f.wid, "a", 1), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.type === "session").length, 1);
  assert.equal(entries.filter(e => e.customType === CT.exec).length, 2);
  assert.equal(entries.filter(e => e.type === "model_change").length, 1);
  const requests = sent(f.home).filter(r => r.to === ticket.callId);
  assert.deepEqual(requests.map(r => r.kind), ["task", "continue"]);
  for (const r of requests) assert.equal(entries.filter(e => e.type === "custom_message" && e.details?.rid === r.rid).length, 1, "each request is applied exactly once");
  assert.deepEqual(await inboxFiles(f), [], "resolved inbox envelopes are deleted");
});

test("C1 K2 consecutive empty responses seal failed", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { lossBound: 2 } }), ticket = f.ticket("a", script([{ empty: true }, { empty: true }]));
  const result = await f.executor.run(ticket); assert.equal(result.status, "failed"); assert.equal(result.error, "lost ×2");
});

test("C1 report tool produces a structured authoritative seal", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ tool: "report", args: { outcome: "ok", data: { done: true } } }]));
  ticket.spec.schema = { type: "object", required: ["done"], properties: { done: { type: "boolean" } }, additionalProperties: false };
  const result = await f.executor.run(ticket);
  if (result.status !== "ok") await writeFile(`/tmp/dsa-executor-report-failure-${f.wid}.json`, JSON.stringify({ result, journal: f.journal.entries(), session: await readFile(callSession(f.home, f.wid, "a", 1), "utf8") }, null, 2));
  assert.equal(result.status, "ok"); assert.deepEqual(result.data, { done: true });
});

test("C1 protocol report survives an empty tool allowlist and continuation", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ empty: true }, { tool: "report", args: { outcome: "ok", data: { done: true } } }]));
  ticket.spec.tools = [];
  ticket.spec.schema = { type: "object", required: ["done"], properties: { done: { type: "boolean" } } };
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "ok", JSON.stringify({ result, journal: f.journal.entries(), session: await readFile(callSession(f.home, f.wid, "a", 1), "utf8") })); assert.deepEqual(result.data, { done: true });
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 2);
});

test("C1 protocol ask remains available with an empty agent tool allowlist", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } }), ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Proceed?" } }, { text: "answered" }]));
  ticket.spec.tools = [];
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.attention));
  const item = f.journal.entries().find(e => e.type === JT.attention)!.item as { qid: string; rev: number };
  const answer: Request = { rid: "protocol-answer", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "answer", message: "Proceed" }, cond: { qid: item.qid, rev: item.rev } };
  assert.deepEqual(await f.executor.forward(answer, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 }), { action: "apply" });
  assert.equal((await pending).output, "answered");
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.resolution === "answered"));
});

test("C1 SIGKILL during a tool fences its detached orphan and continues", { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } }), pidfile = join(f.cwd, "orphan.pid");
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: `${detachedSleep(60)} > '${pidfile}'; sleep 60` } }, { text: "recovered" }]));
  const pending = f.executor.run(ticket);
  await until(() => existsSync(pidfile) && /\d\n/.test(readFileSync(pidfile, "utf8")));
  const orphan = Number((await readFile(pidfile, "utf8")).trim());
  const direct = f.journal.entries().find(e => e.type === "tracked" && e.exec === `${ticket.callId}#1.1`)!;
  process.kill(Number(direct.pid), "SIGKILL");
  assert.equal((await pending).status, "ok");
  // Gone, or a zombie (Linux /proc shows "Z") awaiting its reaper.
  const alive = (() => { try { process.kill(orphan, 0); return true; } catch { return false; } })();
  const state = await readFile(`/proc/${orphan}/stat`, "utf8").catch(() => "");
  assert.ok(!alive || /\) Z /.test(state), `the detached orphan ${orphan} was fenced`);
  const continuation = sent(f.home).find(r => r.kind === "continue")!;
  assert.match((continuation.body as { message: string }).message, /unknown.*bash/);
  // Restart feedback: the continued model is told its processes are gone, so it does not wait for them.
  assert.match((continuation.body as { message: string }).message, /^Your previous execution was interrupted.*background ones included\) were stopped with it: do not wait for them/);
});

test("leases: a child reaches `pi-durable-subagents hold` through the shim on its PATH, tagged with its call", { timeout: 30000 }, async t => {
  const f = await setup(t);
  writeShim(binDir(f.home), process.execPath, join(REPO, "src/cli/main.ts"));
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: `pi-durable-subagents hold machine -- sh -c 'echo "leased $DSA_CALL"'` } }, { text: "done" }]));
  await f.executor.run(ticket);
  assertSealed(f.journal, ticket.callId, "ok");
  assert.match(await readFile(callSession(f.home, f.wid, "a", 1), "utf8"), new RegExp(`leased ${ticket.callId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("C1 forwarded steer then withdraw is consumed with child receipts", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 1" } }, { text: "done" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const ctx = { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: ticket.gen };
  const req: Request = { rid: "live-steer", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "ignore this steer" } };
  await f.executor.forward(req, ctx);
  await f.executor.forward({ rid: "live-withdraw", from: req.from, to: "orch", sseq: 2, kind: "withdraw", body: { rids: [req.rid] } }, ctx);
  await pending;
  const session = await readFile(callSession(f.home, f.wid, "a", 1), "utf8"); assert.match(session, new RegExp(CT.withdrawn));
});

test("P7 a live steer is recorded delivered exactly once on its child receipt; a restart never duplicates it", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } }), ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 2" } }, { text: "done" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const req: Request = { rid: "seen-steer", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "also check the docs" } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: "a", gen: 1 });
  const rid2 = f.journal.entries().find(e => e.type === "forward")!.rid2;
  const delivered = () => f.journal.entries().filter(e => e.type === "forward-delivered");
  assert.equal(delivered().length, 0, "the child applies a steer only at its next turn boundary");
  await until(() => delivered().length > 0);
  assert.ok(!f.journal.entries().some(e => e.type === JT.sealed), "delivery is visible while the call still runs");
  assert.equal((await pending).status, "ok");
  const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === rid2).length, 1);
  assert.deepEqual(delivered().map(e => [e.rid, e.rid2, e.call, e.reason]), [[req.rid, rid2, ticket.callId, undefined]]);
  assert.ok(!f.journal.entries().some(e => e.type === "forward-retired"));
  await f.executor.shutdown();
  const restarted = createExecutor({ home: f.home, orch: f.orch, config: {} });
  try { await restarted.recover(f.wid, f.journal); await restarted.recover(f.wid, f.journal); } finally { await restarted.shutdown(); }
  assert.equal(delivered().length, 1); assert.ok(!f.journal.entries().some(e => e.type === "forward-retired"));
});

test("P7 a receipt observed before a crash but not yet recorded is recorded once by the recovery scan", { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } });
  // Fault injection: the first incarnation dies before any forward-delivered append becomes durable.
  const real = f.journal, lossy: JournalHandle = { path: real.path, entries: () => real.entries(), close: () => real.close(),
    append: (type, fields) => type === "forward-delivered" ? Promise.resolve({ seq: -1, ts: Date.now(), type, ...fields }) : real.append(type, fields) };
  const ticket = { ...f.ticket("a", script([{ tool: "bash", args: { command: "sleep 1" } }, { tool: "bash", args: { command: "sleep 60" } }, { text: "resumed" }])), journal: lossy };
  const pending = f.executor.run(ticket);
  const started = () => real.entries().filter(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start").length;
  await until(() => started() >= 1);
  const req: Request = { rid: "crash-steer", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "keep going" } };
  await f.executor.forward(req, { journal: lossy, widRev: ticket.widRev, key: "a", gen: 1 });
  const rid2 = real.entries().find(e => e.type === "forward")!.rid2;
  const receipts = async () => (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(e => e.type === "custom_message" && e.details?.rid === rid2).length;
  await until(async () => started() >= 2 && await receipts() === 1);
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.shutdown(); await rejected;
  const delivered = () => real.entries().filter(e => e.type === "forward-delivered");
  assert.equal(delivered().length, 0);
  const restarted = createExecutor({ home: f.home, orch: f.orch, config: { k: { trackerMs: 25 } } });
  t.after(() => restarted.shutdown());
  const execs = real.entries().filter(e => e.type === JT.exec).length;
  await restarted.recover(f.wid, real);
  assert.deepEqual(delivered().map(e => [e.rid, e.rid2, e.call]), [[req.rid, rid2, ticket.callId]], "recorded by the recovery scan");
  assert.equal(real.entries().filter(e => e.type === JT.exec).length, execs, "before any new execution");
  const result = await restarted.run({ ...ticket, journal: real });
  assert.equal(result.output, "resumed"); assert.equal(await receipts(), 1);
  await restarted.recover(f.wid, real);
  assert.equal(delivered().length, 1); assert.ok(!real.entries().some(e => e.type === "forward-retired"));
});

test("X1 shutdown fences without sealing; restart continues and retires unused forwards", { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 50 } });
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 60" } }, { text: "resumed" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.shutdown(); await rejected;
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "stop-intent").length, 0);
  const restarted = createExecutor({ home: f.home, orch: f.orch, config: {} });
  t.after(() => restarted.shutdown());
  await restarted.recover(f.wid, f.journal);
  const result = await restarted.run(ticket);
  assert.equal(result.status, "ok", JSON.stringify({ result, journal: f.journal.entries(), session: await readFile(callSession(f.home, f.wid, "a", 1), "utf8") })); assert.equal(result.output, "resumed");
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 2);
});

test("X1 silent CPU tool advances tracker evidence and seals timeout", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 50, checkpointMs: 50 } });
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: "while :; do :; done" } }, { text: "never" }]));
  ticket.spec.timeoutMs = 3500;
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "timeout"); assertSealed(f.journal, ticket.callId, "timeout");
  const checkpoints = f.journal.entries().filter(e => e.type === "time");
  assert.ok(Number(checkpoints.at(-1)!.active) >= 3500);
  assert.ok(checkpoints.length > 1);
  const observations = f.journal.entries().filter(e => e.type === "observation").map(e => e.event as Record<string, unknown>);
  assert.ok(observations.some(e => e.type === "tool_execution_start"));
  assert.ok(observations.every(e => e.type !== "tool_execution_update" && !e.result && !e.args && !e.message));
});

test("X1 blocked ask is not charged and does not stall", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 40, checkpointMs: 40, stallMs: 150 } });
  const ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Wait?" } }, { text: "answered" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.attention && (e.item as { kind: string }).kind === "question"));
  await delay(150);
  const before = Number(f.journal.entries().findLast(e => e.type === "time")!.active);
  await delay(500);
  const after = Number(f.journal.entries().findLast(e => e.type === "time")!.active);
  assert.equal(after, before);
  const question = f.journal.entries().find(e => e.type === JT.attention && (e.item as { kind: string }).kind === "question")!;
  assert.ok(!f.journal.entries().some(e => e.seq > question.seq && e.type === JT.attention && (e.item as { kind: string }).kind === "stall"));
  await f.executor.stop({ wid: f.wid }); await pending;
});

test("X1 stall resolves on activity and re-arms with the next revision", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 40, stallMs: 200 } });
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 0.7; echo activity; sleep 0.7" } }, { text: "done" }]));
  await f.executor.run(ticket);
  const items = f.journal.entries().filter(e => e.type === JT.attention && (e.item as { kind: string }).kind === "stall");
  assert.ok(items.length >= 2);
  assert.deepEqual(items.map(e => (e.item as { rev: number }).rev), items.map((_, i) => i + 1));
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.resolution === "activity"));
});

test("X1 call budget seals budget with truthful usage; workflow budget refuses dispatch", { timeout: 30000 }, async t => {
  const f = await setup(t);
  const first = f.ticket("a"); first.spec.budget = { tokens: 1 }; first.workflowBudget = { tokens: 1 };
  const result = await f.executor.run(first);
  assert.equal(result.status, "budget"); assert.ok(result.usage!.input + result.usage!.output >= 1);
  const second = f.ticket("b"); second.workflowBudget = { tokens: 1 };
  const refused = await f.executor.run(second);
  assert.equal(refused.status, "failed"); assert.equal(refused.error, "workflow budget reached");
  assert.ok(!f.journal.entries().some(e => e.type === "tracked" && String(e.exec).startsWith(second.callId)));
  assert.equal(f.journal.entries().filter(e => e.type === JT.attention && (e.item as { kind: string }).kind === "budget").length, 1);
});

test("X1 memory refusal holds nothing and rechecks headroom before spawn", { timeout: 30000 }, async t => {
  let available = 0;
  const f = await setup(t, { k: { trackerMs: 30 } }, { memory: async () => available });
  const pending = f.executor.run(f.ticket());
  await until(() => f.orch.entries().some(e => e.type === "mem"));
  assert.equal(f.orch.entries().filter(e => e.type === "hold").length, 0);
  available = 4096;
  assert.equal((await pending).status, "ok");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "hold").map(e => e.pool), ["memory", "probe"]);
  assert.ok(await availableMemory() > 0);
});

test("P29 a burst of dispatches cannot over-commit memory: children admitted in the last 30 s are reserved", { timeout: 60000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 30 }, memory: { reserveMb: 1000, perChildMb: 300 } }, { memory: async () => 1000 + 600 + 1 });
  const runs = ["a", "b", "c"].map(key => f.executor.run(f.ticket(key, script([{ delayMs: 1500, text: key }]))));
  let peak = 0;
  const watch = setInterval(() => { const held = new Map<string, string>(); for (const e of f.orch.entries()) if (e.pool === "memory") { if (e.type === "hold") held.set(String(e.slot), String(e.exec)); else if (e.type === "release") held.delete(String(e.slot)); } peak = Math.max(peak, held.size); }, 20);
  try { assert.deepEqual((await Promise.all(runs)).map(r => r.status), ["ok", "ok", "ok"]); } finally { clearInterval(watch); }
  assert.equal(peak, 2, "the measured headroom fits two children; the third waits for a release instead of over-committing");
  assert.ok(f.orch.entries().some(e => e.type === "mem" && e.admitted === false && Number(e.warming) === 2));
});

test("X1 retire fences without seals, retires question attention and rejects stale forwards", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ tool: "ask", args: { question: "Retire me?" } }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.attention && (e.item as { kind: string }).kind === "question"));
  await f.executor.retire(ticket.widRev);
  const result = await pending; assert.equal(result.status, "stopped"); assert.equal(result.error, "retired");
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
  assert.ok(f.journal.entries().some(e => e.type === JT.fenced));
  await f.executor.retire(ticket.widRev);
  assert.equal(f.journal.entries().filter(e => e.type === "retired").length, 1);
  const item = f.journal.entries().find(e => e.type === JT.attention)!.item as { id: string; rev: number };
  const resolutions = f.journal.entries().filter(e => e.type === JT.attentionResolved && e.id === item.id && e.rev === item.rev);
  assert.equal(resolutions.length, 1); assert.equal(resolutions[0]!.resolution, "retired");
  const req: Request = { rid: "retired-send", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "late" } };
  assert.deepEqual(await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 }), { action: "reject", reason: "stale-revision" });
});

test("P27 recovery completes interrupted retirement attention cleanup exactly once", { timeout: 10000 }, async t => {
  const f = await setup(t), ticket = f.ticket(), exec = `${ticket.callId}#1.1`;
  await f.journal.append(JT.exec, { exec, call: ticket.callId });
  await f.journal.append(JT.attention, { item: { id: `q:${ticket.callId}:q`, rev: 1, kind: "question", call: ticket.callId, wid: f.wid, text: "Pending" } });
  await f.journal.append("retired", { call: ticket.callId });
  await f.executor.recover(f.wid, f.journal);
  await f.executor.recover(f.wid, f.journal);
  const resolutions = f.journal.entries().filter(e => e.type === JT.attentionResolved);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0]!.resolution, "retired");
  assert.equal(resolutions[0]!.id, `q:${ticket.callId}:q`);
  assert.ok(f.journal.entries().some(e => e.type === JT.fenced && e.seq < resolutions[0]!.seq));
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
});

test("X1 seal retires forwards lacking child receipts and recovery never republishes them", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket();
  const req: Request = { rid: "unseen", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "answer", message: "no question" }, cond: { qid: "absent", rev: 1 } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 });
  await f.journal.append(JT.exec, { exec: `${ticket.callId}#1.1`, call: ticket.callId });
  await f.executor.stop({ wid: f.wid });
  const retired = f.journal.entries().find(e => e.type === "forward-retired")!;
  assert.equal(retired.rid, req.rid); assert.equal(retired.reason, "retired-without-child-receipt");
  assert.ok(!f.journal.entries().some(e => e.type === "forward-delivered"), "a retired forward is never also delivered");
  const file = join(callInbox(f.home, f.wid, "a", 1), `${retired.rid2}.json`);
  assert.equal(existsSync(file), false, "the seal resolves and deletes the envelope");
  await f.executor.recover(f.wid, f.journal);
  assert.equal(existsSync(file), false);
});

test("X1 suspend preserves the open executor and resumes the same native session", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 60" } }, { text: "continued after suspend" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.suspend(); await rejected;
  assert.equal(f.executor.busy(), false);
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
  assert.equal((await f.executor.run(ticket)).output, "continued after suspend");
  const native = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(native.filter(e => e.type === "session").length, 1);
  assert.equal(native.filter(e => e.customType === CT.exec).length, 2, trace(f.journal.entries(), native));
});

test("P9 P15 AC4 a once call whose tool was cut off seals unknown, raises one unknown item and never re-runs the tool", { timeout: 30000 }, async t => {
  const f = await setup(t), marker = join(f.root, "ran");
  const base = f.ticket("a", script([{ tool: "bash", args: { command: `echo ran >> '${marker}'; sleep 60` } }, { text: "must not continue" }]));
  const ticket: CallTicket = { ...base, spec: { ...base.spec, once: true } };
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  await until(() => existsSync(marker));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.suspend(); await rejected;
  assert.equal(f.journal.entries().filter(e => e.type === JT.sealed).length, 0);
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "unknown");
  assert.match(String(result.error), /Unknown tool outcomes: bash/);
  assertSealed(f.journal, ticket.callId, "unknown");
  const items = () => f.journal.entries().filter(e => e.type === JT.attention).map(e => e.item as { id: string; rev: number; kind: string; text: string; wid: string; call: string });
  assert.equal(items().length, 1);
  assert.deepEqual({ ...items()[0]!, text: "" }, { id: `unknown:${ticket.callId}`, rev: 1, kind: "unknown", text: "", wid: f.wid, call: ticket.callId });
  assert.match(items()[0]!.text, new RegExp(`${ticket.callId.replace(/[@/]/g, ".")}.*unknown outcome.*Unknown tool outcomes: bash`));
  assert.ok(!f.journal.entries().some(e => e.type === JT.attentionResolved));
  // The tool ran once and no execution was relaunched after the cut-off one.
  await delay(200);
  assert.equal(readFileSync(marker, "utf8"), "ran\n");
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec && e.call === ticket.callId).length, 1);
  const native = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(native.filter(e => e.customType === CT.exec).length, 1);
  assert.ok(!JSON.stringify(native.filter(e => e.message?.role === "assistant")).includes("must not continue"));
  // Recovery is idempotent: neither the item nor the seal is repeated, and the item is not retired.
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(ticket)).status, "unknown");
  assert.equal(items().length, 1);
  assert.ok(!f.journal.entries().some(e => e.type === JT.attentionResolved));
  assertSealed(f.journal, ticket.callId, "unknown");
});

test("P15 AC4 recovery raises the unknown item for a seal committed before its attention", { timeout: 10000 }, async t => {
  const f = await setup(t), ticket = f.ticket(), exec = `${ticket.callId}#1.1`;
  await f.journal.append(JT.exec, { exec, call: ticket.callId });
  await f.journal.append(JT.fenced, { exec });
  await f.journal.append(JT.sealed, { call: ticket.callId, exec, result: { key: "a", gen: 1, status: "unknown", ok: false, output: "", error: "Gate outcome unknown after recovery" } });
  await f.executor.recover(f.wid, f.journal);
  await f.executor.recover(f.wid, f.journal);
  const items = f.journal.entries().filter(e => e.type === JT.attention).map(e => e.item as { id: string; text: string });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, `unknown:${ticket.callId}`);
  assert.match(items[0]!.text, /Gate outcome unknown after recovery/);
});

test("X1 K7 skips the third-loss candidate and changes the continuation's model", { timeout: 30000 }, async t => {
  const f = await setup(t, { pools: { pool: ["probe/scripted", "probe/scripted2"] } });
  const ticket = f.ticket("a", script([{ empty: true }, { empty: true }, { empty: true }, { text: "new candidate" }]));
  ticket.spec.model = "pool";
  assert.equal((await f.executor.run(ticket)).output, "new candidate");
  assert.equal(f.orch.entries().filter(e => e.type === "skip").length, 1);
  const selected = f.journal.entries().filter(e => e.type === "selected").map(e => (e.model as { id: string }).id);
  if (process.env.DSA_TRACE) console.log("TRACE", trace(f.journal.entries(), await readFile(callSession(f.home, f.wid, "a", 1), "utf8").then(s => s.trim().split("\n").map(l => JSON.parse(l)))));
  assert.deepEqual(selected, ["scripted", "scripted", "scripted", "scripted2"], trace(f.journal.entries(), await readFile(callSession(f.home, f.wid, "a", 1), "utf8").then(s => s.trim().split("\n").map(l => JSON.parse(l)))));
  assert.ok(f.journal.entries().some(e => e.type === "observation" && (e.event as { model?: string }).model === "scripted2"));
});

test("X1 durable child budget receipt outranks a report on recovery", { timeout: 10000 }, async t => {
  const f = await setup(t), ticket = f.ticket(), exec = `${ticket.callId}#1.1`;
  await f.journal.append(JT.exec, { exec, call: ticket.callId });
  await mkdir(callDir(f.home, f.wid, "a", 1), { recursive: true });
  await writeFile(callSession(f.home, f.wid, "a", 1), [
    { type: "custom", customType: CT.exec, data: { exec } },
    { type: "custom", customType: CT.report, data: { exec, outcome: "ok", data: { ignored: true } } },
    { type: "custom", customType: CT.budget, data: { exec, usage: { tokens: 1 } } },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(ticket)).status, "budget");
  assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 1);
});

test("X1 workflow budget refuses loss continuation but does not stop a running sibling", { timeout: 30000 }, async t => {
  const f = await setup(t);
  const a = f.ticket("a", script([{ empty: true }, { text: "should not continue" }])); a.workflowBudget = { tokens: 1 };
  const b = f.ticket("b", script([{ delayMs: 1000, text: "running sibling survives" }])); b.workflowBudget = { tokens: 1 };
  const [first, sibling] = await Promise.all([f.executor.run(a), f.executor.run(b)]);
  assert.equal(first.status, "failed"); assert.equal(first.error, "workflow budget reached");
  assert.equal(sibling.status, "ok"); assert.equal(sibling.output, "running sibling survives");
  assert.equal(f.journal.entries().filter(e => e.type === "tracked" && String(e.exec).startsWith(`${a.callId}#1.2`)).length, 0);
});

test("X2 generation inherits the switched provider and charges only its own messages", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, "switch-probe": { slots: 1 } } });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ extensions: [FAUX, fileURLToPath(new URL("switch-provider.ts", import.meta.url))] }));
  const first = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 1" } }, { text: "switch" }]));
  const pending = f.executor.run(first);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  await f.executor.forward({ rid: "switch-generation", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: first.callId, kind: "model", model: "switch-probe/target" } }, { journal: f.journal, widRev: first.widRev, key: first.key, gen: 1 });
  assert.equal((await pending).status, "ok");
  const next: CallTicket = { ...first, gen: 2, callId: `${f.wid}@1/a@2`, continueFrom: first.callId, opening: { rid: "next", kind: "follow-up", message: "next turn" } };
  const result = await f.executor.run(next);
  assert.equal(result.status, "ok");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "hold" && String(e.exec).startsWith(`${next.callId}#`)).map(e => e.pool), ["memory", "switch-probe"]);
  const rows = (await readFile(callSession(f.home, f.wid, "a", 2), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const start = rows.findIndex(e => e.customType === CT.exec && String(e.data?.exec).startsWith(`${next.callId}#`));
  const own = rows.slice(start + 1).filter(e => e.message?.role === "assistant");
  assert.deepEqual([...new Set(own.map(e => `${e.message.provider}/${e.message.model}`))], ["switch-probe/target"]);
  assert.equal(f.journal.entries().filter(e => e.type === "usage" && e.call === next.callId).length, own.length);
  assert.equal(result.usage!.input, own.reduce((n, e) => n + e.message.usage.input + e.message.usage.cacheRead + e.message.usage.cacheWrite, 0));
  await f.executor.recover(f.wid, f.journal);
  assert.equal(f.journal.entries().filter(e => e.type === "usage" && e.call === next.callId).length, own.length);
});

test("X2 fresh fork selects and holds its own model and excludes origin usage", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, "switch-probe": { slots: 0 } } });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ extensions: [FAUX, fileURLToPath(new URL("switch-provider.ts", import.meta.url))] }));
  const originSession = join(f.root, "origin.jsonl");
  await writeFile(originSession, [
    { type: "session", version: 3, id: "origin", cwd: f.cwd, timestamp: new Date().toISOString() },
    { type: "model_change", id: "model", parentId: null, provider: "switch-probe", modelId: "target" },
    { type: "message", id: "inherited", parentId: "model", message: { role: "assistant", content: [{ type: "text", text: "origin" }], provider: "switch-probe", model: "target", api: "switch-probe-faux", stopReason: "stop", timestamp: 1, usage: { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 } } } },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  const ticket = f.ticket(); ticket.spec.context = "fork"; ticket.originSession = originSession; ticket.workflowBudget = { tokens: 100000 };
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "ok"); assert.ok(result.usage!.input < 1000000); assert.ok(result.usage!.costUsd < 100);
  assert.deepEqual(f.orch.entries().filter(e => e.type === "hold").map(e => e.pool), ["memory", "probe"]);
  const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.message?.role === "assistant").at(-1).message.provider, "probe");
  assert.equal(f.journal.entries().filter(e => e.type === "usage").length, 1);
  await f.executor.recover(f.wid, f.journal);
  assert.equal(f.journal.entries().filter(e => e.type === "usage").length, 1);
});

test("X2 native g+1 follow-up receipt resolves outbox before seal and is never retired", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 20 } }), first = f.ticket();
  assert.equal((await f.executor.run(first)).status, "ok");
  const next: CallTicket = { ...first, gen: 2, callId: `${f.wid}@1/a@2`, continueFrom: first.callId, opening: { rid: "opening", kind: "follow-up", message: script([{ delayMs: 1200, text: "second" }]) } };
  const pending = f.executor.run(next);
  await until(() => f.journal.entries().some(e => e.type === "tracked" && String(e.exec).startsWith(`${next.callId}#`)));
  const req: Request = { rid: "follow", from: "main:test", to: "orch", sseq: 2, kind: "send", body: { to: next.callId, kind: "follow-up", message: script([{ delayMs: 1200, text: "followed" }]) } };
  await f.executor.forward(req, { journal: f.journal, widRev: next.widRev, key: "a", gen: 2 });
  const forwarded = f.journal.entries().find(e => e.type === "forward" && e.rid === req.rid)!;
  await until(() => readJournalSnapshot(join(outboxRoot(f.home), "outbox", "orch.jsonl")).some(e => e.type === "resolved" && e.rid === forwarded.rid2));
  assert.ok(!f.journal.entries().some(e => e.type === JT.sealed && e.call === next.callId), "receipt resolves while the follow-up is still running");
  assert.equal((await pending).status, "ok");
  const rows = (await readFile(callSession(f.home, f.wid, "a", 2), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === forwarded.rid2).length, 1);
  assert.ok(!f.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === forwarded.rid2));
  await f.executor.recover(f.wid, f.journal);
  assert.ok(!f.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === forwarded.rid2));
});

test("C5/C8 an execution fenced before pi persisted its session restarts with the selected model, not pi's default", { timeout: 30000 }, async t => {
  // The agent's model differs from the isolated settings default, so a missing --model would be visible.
  const f = await setup(t), ticket = { ...f.ticket("a", script([{ delayMs: 3000, text: "slow" }, { text: "on the selected model" }])), agent: { ...agent, model: "probe/scripted2" } };
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.suspend(); await rejected;
  assert.equal(existsSync(callSession(f.home, f.wid, "a", 1)), false, "fenced before the first assistant message: no session file yet");
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "ok");
  const native = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const models = native.filter(e => e.type === "message" && e.message.role === "assistant").map(e => `${e.message.provider}/${e.message.model}`);
  assert.ok(models.length >= 1); assert.deepEqual([...new Set(models)], ["probe/scripted2"]);
});

test("E2 a receipted envelope is deleted while its call runs; the next execution never re-applies it", { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } }), ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 1.5" } }, { empty: true }, { text: "finished" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const req: Request = { rid: "gc-steer", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "steer", message: "steered once" } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: "a", gen: 1 });
  const rid2 = f.journal.entries().find(e => e.type === "forward")!.rid2 as string, file = join(callInbox(f.home, f.wid, "a", 1), `${rid2}.json`);
  assert.ok(existsSync(file));
  await until(() => !existsSync(file) || f.journal.entries().some(e => e.type === JT.sealed));
  assert.ok(!f.journal.entries().some(e => e.type === JT.sealed), "deleted on the child receipt, before the seal");
  const result = await pending;
  assert.equal(result.output, "finished"); assert.equal(f.journal.entries().filter(e => e.type === JT.exec).length, 2);
  const rows = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === rid2).length, 1);
  assert.ok(readJournalSnapshot(join(outboxRoot(f.home), "outbox", "orch.jsonl")).some(e => e.type === "resolved" && e.rid === rid2));
  assert.ok(!f.journal.entries().some(e => e.type === "forward-retired"));
  assert.deepEqual(await inboxFiles(f), []);
});

test("E4 a torn session line terminated by pi's next load is skipped once; entries after it stay visible", { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 50 } }), ticket = f.ticket("a", script([{ tool: "bash", args: { command: "sleep 60" } }, { text: "after repair" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const rejected = assert.rejects(pending, { name: "ExecutorShutdown" });
  await f.executor.suspend(); await rejected;
  const file = callSession(f.home, f.wid, "a", 1);
  await appendFile(file, `{"type":"custom","customType":"${CT.report}","data":{"exe`);
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "ok"); assert.equal(result.output, "after repair");
  const lines = (await readFile(file, "utf8")).split("\n");
  const bad = lines.findIndex(l => { try { JSON.parse(l); return false; } catch { return l !== ""; } }) + 1;
  assert.ok(bad > 0 && lines.slice(bad).filter(Boolean).length > 3, "pi terminated the torn line and appended after it");
  assert.ok(lines.slice(bad).some(l => l.includes(`${ticket.callId}#1.2`)));
  const corrupt = () => f.journal.entries().filter(e => e.type === "session-corrupt").map(e => [e.call, e.line]);
  assert.deepEqual(corrupt(), [[ticket.callId, bad]]);
  const fresh = createExecutor({ home: f.home, orch: f.orch, config: {} });
  try { await fresh.recover(f.wid, f.journal); } finally { await fresh.shutdown(); }
  assert.deepEqual(corrupt(), [[ticket.callId, bad]]);
});

test("F1 a stuck fence of a real child parks only its call with attention; a sibling completes; the sweep then seals it", { timeout: 45000 }, async t => {
  const real = serialContainment();
  let stuck: string | undefined;
  const containment: Containment = { spawn: spec => real.spawn(spec), scan: known => real.scan(known),
    fence: async (exec, tracked, opts) => { if (exec === stuck) throw new Error(`Fence timeout: ${exec}`); return real.fence(exec, tracked, opts); } };
  const f = await setup(t, { k: { trackerMs: 25 } }, { containment, sweepMs: 100 });
  // pi exits when its stdin ends (rpc-mode.js:642) and kills its bash tree (shell.js killProcessTree), so only a
  // detached (setsid) descendant outlives the child: it plays the process the stuck fence cannot retire.
  const pidfile = join(f.cwd, "detached.pid");
  const a = f.ticket("a", script([{ tool: "bash", args: { command: `${detachedSleep(60)} > '${pidfile}'; sleep 60` } }, { text: "never" }])), b = f.ticket("b", script([{ delayMs: 300, text: "sibling done" }]));
  const ea = `${a.callId}#1.1`, tagged = async () => (await new ProcessTable().list(new Set([ea]))).filter(p => p.tag === ea); // macOS reads tags only for known ids
  t.mock.method(console, "error", () => {});
  stuck = ea;
  try {
    const pa = f.executor.run(a);
    await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
    // Stop only once the detached descendant exists (starting it takes a moment on a loaded runner).
    await until(() => existsSync(pidfile) && /\d\n/.test(readFileSync(pidfile, "utf8")));
    const pb = f.executor.run(b);
    await Promise.race([f.executor.stop({ wid: f.wid, callId: a.callId }), delay(10000).then(() => { throw new Error("stop waited on a stuck fence"); })]);
    assert.equal(f.journal.entries().filter(e => e.type === "fence-failed" && e.exec === ea).length, 1);
    assert.ok(f.journal.entries().some(e => e.type === JT.attention && (e.item as { id: string; kind: string }).id === `fence:${ea}` && (e.item as { kind: string }).kind === "unknown"));
    assert.equal((await pb).output, "sibling done");
    assert.ok((await tagged()).length > 0, "the detached descendant of the stuck execution is still alive");
    await delay(400);
    assert.equal(f.journal.entries().filter(e => e.type === "fence-failed" && e.exec === ea).length, 1);
    assert.equal(f.journal.entries().filter(e => e.type === JT.exec && e.call === a.callId).length, 1);
    assert.ok(!f.journal.entries().some(e => e.type === JT.sealed && e.call === a.callId));
    stuck = undefined;
    assert.equal((await pa).status, "stopped");
    assertSealed(f.journal, a.callId, "stopped");
    assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${ea}` && e.resolution === "fenced"));
    assert.deepEqual(await tagged(), []);
  } finally { stuck = undefined; await real.fence(ea, []).catch(() => {}); }
});

test("builtin researcher uses a web tool registered by another installed extension", { timeout: 30000 }, async t => {
  const f = await setup(t);
  await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ extensions: [FAUX, join(REPO, "test/harness/web-tool-ext.ts")], defaultProvider: "probe", defaultModel: "scripted" }));
  const researcher = parseAgent(readFileSync(join(REPO, "agents/researcher.md"), "utf8"), join(REPO, "agents/researcher.md"), "builtin")!;
  const base = f.ticket("a", script([{ tool: "web_search", args: { query: "durable" } }, { text: "brief done" }]));
  const result = await f.executor.run({ ...base, agent: { ...researcher, model: "probe/scripted" } });
  assert.equal(result.output, "brief done");
  const native = (await readFile(callSession(f.home, f.wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const toolResult = native.find(e => e.message?.role === "toolResult" && e.message.toolName === "web_search")?.message;
  assert.ok(toolResult && !toolResult.isError, JSON.stringify(toolResult));
  assert.match(JSON.stringify(toolResult.content), /WEB-RESULT for durable/);
});
