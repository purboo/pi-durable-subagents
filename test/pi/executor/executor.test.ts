import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FAUX, PI_BIN, REPO, script, settled, startPi, tempRoot } from "../../harness/pi.ts";
import { callDir, callInbox, callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { scanInbox } from "../../../src/kernel/mailbox.ts";
import { contentHash, forwardRid } from "../../../src/kernel/ids.ts";
import { CT, JT, type JournalHandle, type Request } from "../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { evidence } from "../../../src/orchestrator/executor/session.ts";

const recorder = fileURLToPath(new URL("recorder.ts", import.meta.url));
const agent = { name: "test", description: "test", body: "Test agent", model: "probe/scripted", tools: ["bash"], systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false, sourcePath: "/fixture/test.md", source: "project" as const };
async function until(predicate: () => boolean | Promise<boolean>, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for durable executor evidence"); await delay(20); }
}
async function setup(t: TestContext, config: OrchestratorConfig = {}) {
  const root = tempRoot("dsa-executor-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_DIR: process.env.PROBE_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PROBE_DIR = root;
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  const orch = await openJournal(orchLedger(home));
  let journal = await openJournal(journalPath(home, "wf"));
  const executor = createExecutor({ home, orch, config });
  const ticket = (key = "a", task = script([{ text: "full\nLEAF: final" }])): CallTicket => ({ wid: "wf", widRev: "wf@1", key, gen: 1, callId: `wf@1/${key}@1`, cwd, journal, spec: { agent: "test", task }, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      await journal.close(); await orch.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, home, cwd, orch, executor, ticket, get journal() { return journal; }, async reopen() { journal = await openJournal(journal.path); } };
}
async function nativeSession(t: TestContext, f: Awaited<ReturnType<typeof setup>>, opts: { report?: unknown; text?: string; exec?: string; question?: boolean } = {}) {
  const ticket = f.ticket(), exec = opts.exec ?? `${ticket.callId}#1.1`;
  await mkdir(callDir(f.home, "wf", "a", 1), { recursive: true });
  await f.journal.append(JT.exec, { exec, call: ticket.callId });
  const pi = startPi({ root: f.root, name: "native", extensions: [recorder], args: ["--session", callSession(f.home, "wf", "a", 1)], env: { TEST_EXEC: exec, ...(opts.question ? { TEST_QUESTION: "1" } : {}), ...(opts.report !== undefined ? { TEST_REPORT: JSON.stringify(opts.report) } : {}) } });
  t.after(() => pi.stop());
  pi.send({ type: "prompt", message: script([{ text: opts.text ?? "full\nLEAF: final" }]) });
  await pi.waitFor(settled);
  return { pi, exec, ticket };
}
function assertSealed(journal: JournalHandle, call: string, status: string) {
  const seals = journal.entries().filter(e => e.type === JT.sealed && e.call === call);
  assert.equal(seals.length, 1); assert.equal((seals[0]!.result as { status: string }).status, status);
  assert.ok(journal.entries().some(e => e.type === JT.fenced && e.exec === seals[0]!.exec && e.seq < seals[0]!.seq));
}

test("P9 recovery reads full last text from real pi after durable settled and fence", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, exec, ticket } = await nativeSession(t, f);
  await pi.stop(); await f.journal.append("settled", { exec });
  await f.executor.recover("wf", f.journal);
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
  await f.executor.recover("wf", f.journal);
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
  const worker = fork(fileURLToPath(new URL("crash-worker.ts", import.meta.url)), [], { env: { ...process.env, DSA_HOME: f.home }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { worker.kill("SIGKILL"); });
  const [message] = await once(worker, "message", { signal: AbortSignal.timeout(10000) }); assert.equal(message, "fenced");
  const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
  await f.reopen(); ticket.journal = f.journal;
  await f.executor.recover("wf", f.journal);
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
  const first = await scanInbox(callInbox(f.home, "wf", "a", 1)); assert.equal(first[0]!.rid, rid2);
  assert.deepEqual(first[0]!.body, { message: "change" });
  await rm(join(callInbox(f.home, "wf", "a", 1), `${rid2}.json`));
  await f.executor.recover("wf", f.journal);
  assert.deepEqual(await scanInbox(callInbox(f.home, "wf", "a", 1)), first);
  await f.executor.forward(req, ctx); assert.equal(f.journal.entries().filter(e => e.type === "forward").length, 1);
  assert.deepEqual(await f.executor.forward({ ...req, body: { changed: true } }, ctx), { action: "reject", reason: "identity-conflict" });
  const withdrawal: Request = { rid: "withdraw-1", from: req.from, to: "orch", sseq: 2, kind: "withdraw", body: { rids: [req.rid] } };
  await f.executor.forward(withdrawal, ctx);
  const requests = await scanInbox(callInbox(f.home, "wf", "a", 1));
  assert.deepEqual(requests.find(r => r.kind === "withdraw")!.body, { rids: [rid2] });
  const next = { ...req, rid: "steer-2", sseq: 3, cond: { after: withdrawal.rid, epoch: "wf@1" } };
  await f.executor.forward(next, ctx);
  const all = await scanInbox(callInbox(f.home, "wf", "a", 1));
  assert.equal(all.find(r => r.sseq === 3)!.cond!.after, all.find(r => r.kind === "withdraw")!.rid);
  assert.equal(all.find(r => r.sseq === 3)!.cond!.epoch, undefined);
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await f.executor.stop({ wid: "wf", callId: ticket.callId });
  assert.deepEqual(await f.executor.forward({ ...req, rid: "late" }, ctx), { action: "reject", reason: "call-sealed" });
});

test("P9/K2 empty recovered session at the loss bound seals failed without spawning", { timeout: 10000 }, async t => {
  const f = await setup(t, { k: { lossBound: 2 } }), ticket = f.ticket();
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await f.journal.append(JT.fenced, { exec: `${ticket.callId}#1.1` });
  await f.journal.append("loss", { exec: `${ticket.callId}#1.1` });
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.2` });
  await f.executor.recover("wf", f.journal);
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

test("V1 real pi processes serialize provider slots; stop fences and seals exactly once", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 } }, k: { trackerMs: 25 } });
  const a = f.ticket("a", script([{ delayMs: 60000, text: "late" }])), b = f.ticket("b", a.spec.task);
  const pa = f.executor.run(a), pb = f.executor.run(b);
  await until(() => f.journal.entries().some(e => e.type === "tracked" && e.exec === `${a.callId}#1.1`));
  assert.equal(f.orch.entries().filter(e => e.type === "hold").length, 1);
  await f.executor.stop({ wid: "wf", callId: a.callId }); assert.equal((await pa).status, "stopped");
  await until(() => f.journal.entries().some(e => e.type === "tracked" && e.exec === `${b.callId}#1.1`));
  await f.executor.stop({ wid: "wf", callId: b.callId }); assert.equal((await pb).status, "stopped");
  await f.executor.stop({ wid: "wf" });
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
  assert.deepEqual(f.orch.entries().filter(e => e.type === "hold").map(e => e.pool), ["probe"]);
  await f.executor.stop({ wid: "wf" }); assert.equal((await pending).status, "stopped");
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
  assert.equal((await scanInbox(callInbox(f.home, "wf", "a", 1))).filter(r => r.kind === "model").length, 1);
  const result = await pending; assert.equal(result.output, "switched to Y");
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
  const forwarded = (await scanInbox(callInbox(f.home, "wf", "a", 1))).find(r => r.kind === "model")!;
  assert.deepEqual(forwarded.body, { provider: "other", model: "id", thinking: "high" });
  await f.executor.stop({ wid: "wf" }); await pending;
  assert.deepEqual(f.orch.entries().filter(e => e.type === "release").map(e => e.pool).sort(), ["other", "probe"]);
});

test("V1 an expired switch reservation is fenced before its slots are released", { timeout: 30000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 1 }, other: { slots: 1 } }, k: { trackerMs: 25, switchTimeoutMs: 20, lossBound: 1 } });
  const ticket = f.ticket(), pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  const req: Request = { rid: "expired-switch", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "other/id" } };
  await f.executor.forward(req, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 });
  assert.equal((await pending).status, "failed");
  assertSealed(f.journal, ticket.callId, "failed");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "release").map(e => e.pool).sort(), ["other", "probe"]);
});

test("V1 missing model uses isolated Pi settings before acquiring a provider slot", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket(); ticket.agent = { ...ticket.agent, model: undefined };
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "tracked"));
  assert.equal(f.orch.entries().find(e => e.type === "hold")!.pool, "probe");
  await f.executor.stop({ wid: "wf" }); await pending;
});

test("P9 stop wins over a durable report and repeated stop never creates a second seal", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, ticket } = await nativeSession(t, f, { report: { done: true } }); await pi.stop();
  await f.executor.recover("wf", f.journal);
  await f.executor.stop({ wid: "wf", callId: ticket.callId });
  assert.equal((await f.executor.run(ticket)).status, "stopped");
  await f.executor.stop({ wid: "wf" }); assertSealed(f.journal, ticket.callId, "stopped");
});

test("V1 stopping a call waiting on zero capacity acquires nothing and spawns nothing", { timeout: 10000 }, async t => {
  const f = await setup(t, { providers: { probe: { slots: 0 } } }), ticket = f.ticket();
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  const switchRequest: Request = { rid: "waiting-switch", from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: ticket.callId, kind: "model", model: "other/id" } };
  assert.deepEqual(await f.executor.forward(switchRequest, { journal: f.journal, widRev: ticket.widRev, key: ticket.key, gen: 1 }), { action: "reject", reason: "call-not-running" });
  await f.executor.stop({ wid: "wf" }); assert.equal((await pending).status, "stopped");
  assert.equal(f.orch.entries().filter(e => e.type === "hold").length, 0);
  assert.equal(f.journal.entries().filter(e => e.type === "tracked").length, 0);
});

test("P9 schema-bearing calls do not accept plain text instead of a report", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { lossBound: 1 } }), { pi, exec, ticket } = await nativeSession(t, f); await pi.stop();
  ticket.spec.schema = { type: "object" }; await f.journal.append("settled", { exec });
  await f.executor.recover("wf", f.journal);
  assert.equal((await f.executor.run(ticket)).status, "failed");
});

test("P15 recovered native questions are recorded once and close when the call seals", { timeout: 30000 }, async t => {
  const f = await setup(t), { pi, ticket } = await nativeSession(t, f, { report: { done: true }, question: true }); await pi.stop();
  await f.executor.recover("wf", f.journal); await f.executor.run(ticket); await f.executor.run(ticket);
  const attention = f.journal.entries().filter(e => e.type === JT.attention);
  assert.equal(attention.length, 1);
  assert.deepEqual(attention[0]!.item, { id: `q:${ticket.callId}:q1`, rev: 1, kind: "question", text: "Need input", wid: "wf", call: ticket.callId, qid: "q1", session: callSession(f.home, "wf", "a", 1) });
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

test("C1 empty reply loses once, then continues in the same native session", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ empty: true }, { text: "continued" }]));
  const result = await f.executor.run(ticket); assert.equal(result.output, "continued");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 1);
  const entries = readFileSync(callSession(f.home, "wf", "a", 1), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.type === "session").length, 1);
  assert.equal(entries.filter(e => e.customType === CT.exec).length, 2);
  assert.equal(entries.filter(e => e.type === "model_change").length, 1);
  assert.ok((await scanInbox(callInbox(f.home, "wf", "a", 1))).some(r => r.kind === "continue"));
});

test("C1 K2 consecutive empty responses seal failed", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { lossBound: 2 } }), ticket = f.ticket("a", script([{ empty: true }, { empty: true }]));
  const result = await f.executor.run(ticket); assert.equal(result.status, "failed"); assert.equal(result.error, "lost ×2");
});

test("C1 report tool produces a structured authoritative seal", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ tool: "report", args: { outcome: "ok", data: { done: true } } }]));
  ticket.spec.schema = { type: "object", required: ["done"], properties: { done: { type: "boolean" } }, additionalProperties: false };
  const result = await f.executor.run(ticket);
  if (result.status !== "ok") await writeFile("/tmp/dsa-executor-report-failure.json", JSON.stringify({ result, journal: f.journal.entries(), session: await readFile(callSession(f.home, "wf", "a", 1), "utf8") }, null, 2));
  assert.equal(result.status, "ok"); assert.deepEqual(result.data, { done: true });
});

test("C1 protocol report survives an empty tool allowlist and continuation", { timeout: 30000 }, async t => {
  const f = await setup(t), ticket = f.ticket("a", script([{ empty: true }, { tool: "report", args: { outcome: "ok", data: { done: true } } }]));
  ticket.spec.tools = [];
  ticket.spec.schema = { type: "object", required: ["done"], properties: { done: { type: "boolean" } } };
  const result = await f.executor.run(ticket);
  assert.equal(result.status, "ok"); assert.deepEqual(result.data, { done: true });
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
  const ticket = f.ticket("a", script([{ tool: "bash", args: { command: `setsid sleep 60 & echo $! > '${pidfile}'; sleep 60` } }, { text: "recovered" }]));
  const pending = f.executor.run(ticket);
  await until(() => existsSync(pidfile));
  const orphan = Number((await readFile(pidfile, "utf8")).trim());
  const direct = f.journal.entries().find(e => e.type === "tracked" && e.exec === `${ticket.callId}#1.1`)!;
  process.kill(Number(direct.pid), "SIGKILL");
  assert.equal((await pending).status, "ok");
  const state = await readFile(`/proc/${orphan}/stat`, "utf8").catch(() => "");
  assert.ok(!state || /\) Z /.test(state));
  const continuation = (await scanInbox(callInbox(f.home, "wf", "a", 1))).find(r => r.kind === "continue")!;
  assert.match((continuation.body as { message: string }).message, /unknown.*bash/);
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
  const session = await readFile(callSession(f.home, "wf", "a", 1), "utf8"); assert.match(session, new RegExp(CT.withdrawn));
});
