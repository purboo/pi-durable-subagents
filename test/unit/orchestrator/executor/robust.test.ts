import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { openJournal, readJournalSnapshot } from "../../../../src/kernel/journal.ts";
import { contentHash, forwardRid, ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callInbox, callSession, journalPath, orchLedger, outboxRoot } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type Entry, type ProcInfo, type Request } from "../../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import createEffects from "../../../../src/orchestrator/executor/effects/index.ts";
import { serialContainment } from "../../../../src/orchestrator/executor/sweep.ts";
import { compactWorkflow, snapshotFromEntries, statusBrief } from "../../../../src/orchestrator/snapshot.ts";
import { renderStatus, renderView } from "../../../../src/cli/main.ts";

// A containment without processes: spawning fails (or, with `exits`, yields a child that exits at once), fences of
// `stuck` execs time out, scans may fail transiently.
class FakeContainment implements Containment {
  stuck = new Set<string>(); scanError?: Error; scans = 0; exits = false;
  async spawn() {
    if (!this.exits) throw new Error("no processes in unit tests");
    const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end(); stderr.end();
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
  }
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) {
    this.scans++;
    if (this.scanError) throw this.scanError;
    return new Map([...known.keys()].map(exec => [exec, []]));
  }
  async fence(exec: string) { if (this.stuck.has(exec)) throw new Error(`Fence timeout: ${exec}`); }
}
const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };

async function fixture(t: TestContext, config: OrchestratorConfig = {}, options: { sweepMs?: number; memory?: () => Promise<number>; realEffects?: boolean; containment?: Containment } = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsa-robust-")), wid = ulid(), fake = new FakeContainment();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const ledgers = { home, orch, config: { k: { trackerMs: 20 }, ...config } }, { realEffects, containment = fake, ...rest } = options;
  const make = () => createExecutor(ledgers, { effects: realEffects ? createEffects(ledgers, containment) : effects, containment, memory: async () => 1e6, sweepMs: 40, ...rest });
  let executor = make();
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket = (key: string): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd: home, journal, spec: { agent: "test", task: "task" }, agent });
  const session = async (key: string, lines: (object | string)[]) => {
    await mkdir(callDir(home, wid, key, 1), { recursive: true });
    await writeFile(callSession(home, wid, key, 1), lines.map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n");
  };
  return { home, wid, orch, journal, config: ledgers.config as OrchestratorConfig, containment: fake, errors, ticket, session, get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = make(); return executor; } };
}
const execLine = (exec: string) => ({ type: "custom", customType: CT.exec, data: { exec } });
const report = (exec: string) => ({ type: "custom", customType: CT.report, data: { exec, outcome: "ok", data: { exec } } });
const count = (entries: readonly Entry[], pred: (e: Entry) => boolean) => entries.filter(pred).length;
const item = (e: Entry) => e.item as { id: string; kind: string; call?: string; rev: number };
async function until(predicate: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await delay(10); }
}
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([promise, delay(ms).then(() => { throw new Error(`not settled within ${ms} ms`); })]);
}

async function writingChildren(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const streams = new Map<string, PassThrough>();
  t.mock.method(f.containment, "spawn", async (spec: { exec: string }) => {
    const stdout = new PassThrough(); streams.set(spec.exec.split("#")[0]!, stdout);
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise<{ code: number; signal: null }>(() => {}) };
  });
  return async (ticket: CallTicket, toolName = "write", path: unknown = "nested/new.txt") => {
    await until(() => streams.has(ticket.callId));
    streams.get(ticket.callId)!.write(JSON.stringify({ type: "tool_execution_start", toolCallId: ulid(), toolName, args: { path } }) + "\n");
  };
}

test("shared worktree: observed writes remind once, survive recovery, and either seal resolves status", { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), b = f.ticket("b");
  await mkdir(join(f.home, ".git"));
  for (const ticket of [a, b]) await f.journal.append("call", { key: ticket.key, gen: 1, spec: ticket.spec });
  let send = await writingChildren(t, f);
  const pa = f.executor.run(a), pb = f.executor.run(b);
  const conflicts = () => f.journal.entries().filter(e => e.type === JT.attention && item(e).kind === "conflict");
  await send(a, "read"); await send(b, "bash"); await send(b, "edit", 123);
  await until(() => count(f.journal.entries(), e => e.type === "observation") >= 3);
  assert.equal(count(f.journal.entries(), e => e.type === "wrote"), 0);
  await send(a); await until(() => count(f.journal.entries(), e => e.type === "wrote") === 1);
  assert.equal(conflicts().length, 0, "one writer has no conflict");
  await send(b, "edit"); await until(() => conflicts().length === 1);
  await send(b); await send(a, "edit");
  await until(() => count(f.journal.entries(), e => e.type === "observation") >= 7);
  assert.equal(count(f.journal.entries(), e => e.type === "wrote"), 2);
  assert.equal(conflicts().length, 1);
  const id = `worktree:${[a.callId, b.callId].sort().join("|")}`;
  assert.equal(item(conflicts()[0]!).id, id); assert.equal(item(conflicts()[0]!).call, b.callId);
  const snap = snapshotFromEntries(f.wid, f.journal.entries()), compact = compactWorkflow(snap);
  assert.deepEqual(snap.calls.map(c => c.sharedWorktree), [[`${f.wid}/b`], [`${f.wid}/a`]]);
  assert.deepEqual(compact.calls.map(c => c.sharedWorktree), snap.calls.map(c => c.sharedWorktree));
  assert.match(renderStatus(snap), /\(shares worktree with /);
  assert.match(renderView({ workflows: [compact] }), /\(shares worktree with /);
  assert.deepEqual(statusBrief(f.home).active[0]!.calls.map(c => c.sharedWorktree), snap.calls.map(c => c.sharedWorktree));
  const pending = Promise.allSettled([pa, pb]);
  await f.restart(); await pending;
  await f.executor.recover(f.wid, f.journal);
  send = await writingChildren(t, f);
  const ra = f.executor.run(a), rb = f.executor.run(b);
  await send(a); await send(b);
  await until(() => count(f.journal.entries(), e => e.type === "wrote") === 4);
  assert.equal(conflicts().length, 1, "recovery and new execs do not repeat the pair");
  await f.executor.stop({ wid: f.wid, callId: a.callId }); await ra;
  assert.equal(count(f.journal.entries(), e => e.type === JT.attentionResolved && e.id === id), 1, "first writer sealing also resolves");
  assert.ok(snapshotFromEntries(f.wid, f.journal.entries()).calls.every(c => c.sharedWorktree === undefined));
  await send(b); await f.executor.stop({ wid: f.wid, callId: b.callId }); await rb;
  assert.equal(conflicts().length, 1);
});

for (const sameOrigin of [true, false]) test(`shared worktree across workflows: ${sameOrigin ? "same" : "different"} origins and recovery cleanup`, { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), wid = ulid();
  const other = await openJournal(journalPath(f.home, wid));
  t.after(() => other.close());
  const b: CallTicket = { ...f.ticket("b"), wid, widRev: `${wid}@1`, callId: `${wid}@1/b@1`, journal: other };
  await f.journal.append("wf-created", { origin: "main:one" });
  await other.append("wf-created", { origin: sameOrigin ? "main:one" : "main:two" });
  await mkdir(join(f.home, ".git"));
  const send = await writingChildren(t, f), pa = f.executor.run(a), pb = f.executor.run(b);
  await send(a); await until(() => f.journal.entries().some(e => e.type === "wrote"));
  await send(b); await until(() => other.entries().some(e => e.type === JT.attention));
  assert.equal(count(f.journal.entries(), e => e.type === JT.attention), sameOrigin ? 0 : 1);
  const id = item(other.entries().find(e => e.type === JT.attention)!).id;
  const pending = Promise.allSettled([pa, pb]); await f.restart(); await pending;
  // A crash after the seal but before reminder retirement; load the sealed workflow first.
  await f.journal.append(JT.sealed, { call: a.callId, exec: `${a.callId}#1.1`, result: { key: "a", gen: 1, status: "ok", ok: true, output: "" } });
  await f.executor.recover(f.wid, f.journal); await f.executor.recover(wid, other);
  await f.executor.recover(wid, other);
  assert.equal(count(other.entries(), e => e.type === JT.attentionResolved && e.id === id), 1);
  assert.equal(count(f.journal.entries(), e => e.type === JT.attentionResolved && e.id === id), sameOrigin ? 0 : 1);
});

test("shared worktree recovery repairs a partial cross-origin reminder without changing its writer", { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), wid = ulid(), other = await openJournal(journalPath(f.home, wid));
  t.after(() => other.close());
  const b: CallTicket = { ...f.ticket("b"), wid, widRev: `${wid}@1`, callId: `${wid}@1/b@1`, journal: other };
  for (const ticket of [a, b]) {
    await ticket.journal.append("wf-created", { origin: ticket.wid });
    await ticket.journal.append("wrote", { exec: `${ticket.callId}#1.1`, root: f.home });
  }
  const id = `worktree:${[a.callId, b.callId].sort().join("|")}`;
  await other.append(JT.attention, { item: { id, rev: 1, kind: "conflict", call: b.callId, wid, text: "original reminder" } });
  await f.executor.recover(wid, other);
  const send = await writingChildren(t, f), pa = f.executor.run(a), pb = f.executor.run(b);
  await send(a, "read"); await send(b, "read");
  for (const journal of [f.journal, other]) {
    const alerts = journal.entries().filter(e => e.type === JT.attention && item(e).kind === "conflict");
    assert.equal(alerts.length, 1); assert.equal(item(alerts[0]!).call, b.callId);
  }
  await f.executor.stop({ wid: f.wid, callId: a.callId }); await pa;
  assert.equal(count(other.entries(), e => e.type === JT.attentionResolved && e.id === id), 1);
  await f.executor.stop({ wid, callId: b.callId }); await pb;
});

test("shared worktree ignores non-git writes, distinct roots and already sealed writers", { timeout: 15000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), b = f.ticket("b");
  a.cwd = join(f.home, "one"); b.cwd = join(f.home, "two");
  await mkdir(join(a.cwd, ".git"), { recursive: true }); await mkdir(join(b.cwd, ".git"), { recursive: true });
  const send = await writingChildren(t, f), pa = f.executor.run(a), pb = f.executor.run(b);
  await send(a, "write", join(f.home, "outside.txt"));
  await until(() => count(f.journal.entries(), e => e.type === "observation") === 1);
  assert.equal(count(f.journal.entries(), e => e.type === "wrote"), 0);
  await send(a); await send(b);
  await until(() => count(f.journal.entries(), e => e.type === "wrote") === 2);
  assert.deepEqual(new Set(f.journal.entries().filter(e => e.type === "wrote").map(e => e.root)), new Set([a.cwd, b.cwd]));
  assert.equal(count(f.journal.entries(), e => e.type === JT.attention), 0);
  await f.executor.stop({ wid: f.wid, callId: a.callId }); await pa;
  await send(b, "edit", join(a.cwd, "after.txt"));
  await until(() => count(f.journal.entries(), e => e.type === "wrote") === 3);
  assert.equal(count(f.journal.entries(), e => e.type === JT.attention && item(e).kind === "conflict"), 0);
  await f.executor.stop({ wid: f.wid, callId: b.callId }); await pb;
});

test("settled quota errors seal failed without loss or relaunch", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a");
  let launches = 0;
  t.mock.method(f.containment, "spawn", async () => {
    const exec = `${a.callId}#1.${++launches}`;
    await f.session("a", [execLine(exec), { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "402 insufficient_quota" } }]);
    const stdout = new PassThrough(), stderr = new PassThrough();
    stdout.end('{"type":"agent_settled"}\n'); stderr.end();
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
  });
  const result = await f.executor.run(a);
  assert.equal(result.error, "Provider error: 402 insufficient_quota");
  assert.equal(result.status, "failed"); assert.equal(launches, 1);
  assert.equal(count(f.journal.entries(), e => e.type === "loss"), 0);
  const sealed = f.journal.entries().find(e => e.type === JT.sealed)!;
  assert.ok(f.journal.entries().some(e => e.type === JT.fenced && e.exec === sealed.exec && e.seq < sealed.seq));
});

test("nonfatal provider errors relaunch and include the clipped final error at loss bound", { timeout: 10000 }, async t => {
  const f = await fixture(t, { k: { trackerMs: 20, lossBound: 2 } }), a = f.ticket("a");
  let launches = 0;
  const error = "529 overloaded " + "x".repeat(400);
  t.mock.method(f.containment, "spawn", async () => {
    const exec = `${a.callId}#1.${++launches}`;
    await f.session("a", [execLine(exec), { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: error } }]);
    const stdout = new PassThrough(), stderr = new PassThrough();
    stdout.end('{"type":"agent_settled"}\n'); stderr.end();
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
  });
  const result = await f.executor.run(a);
  assert.equal(result.error, `lost ×2; last error: ${error.slice(0, 300)}`);
  assert.equal(result.status, "failed"); assert.equal(launches, 2);
  assert.equal(count(f.journal.entries(), e => e.type === "loss"), 2);
});

test("F2 a failing sweep is logged and retried; it never poisons later dispatch", { timeout: 10000 }, async t => {
  const f = await fixture(t), old = f.ticket("old"), oldExec = `${old.callId}#1.1`;
  await f.journal.append(JT.exec, { call: old.callId, exec: oldExec }); await f.journal.append(JT.fenced, { exec: oldExec });
  f.containment.scanError = Object.assign(new Error("EIO: /proc read"), { code: "EIO" });
  await f.executor.recover(f.wid, f.journal);
  await until(() => f.containment.scans >= 3);
  assert.ok(f.errors.some(e => /sweep failed, retrying in K1: .*EIO/.test(e)));
  const result = await f.executor.run(f.ticket("fresh"));
  assert.equal(result.status, "failed"); assert.match(String(result.error), /Spawn failed: .*no processes/);
});

test("F1 a stuck fence parks only its call with one unknown attention; a later sweep resumes it", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), b = f.ticket("b"), ea = `${a.callId}#1.1`, eb = `${b.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea }); await f.journal.append(JT.exec, { call: b.callId, exec: eb });
  await f.session("a", [execLine(ea), report(ea)]); await f.session("b", [execLine(eb), report(eb)]);
  await f.orch.append("hold", { pool: "probe", slot: 0, exec: ea });
  f.containment.stuck.add(ea);
  await f.executor.recover(f.wid, f.journal);
  const failed = () => count(f.journal.entries(), e => e.type === "fence-failed" && e.exec === ea);
  const attention = () => f.journal.entries().filter(e => e.type === JT.attention && item(e).id === `fence:${ea}`);
  assert.equal(failed(), 1); assert.equal(attention().length, 1);
  assert.deepEqual({ kind: item(attention()[0]!).kind, call: item(attention()[0]!).call }, { kind: "unknown", call: a.callId });
  assert.match(String((attention()[0]!.item as { text: string }).text), /did not exit/);
  assert.equal(count(f.journal.entries(), e => e.type === JT.fenced && e.exec === ea), 0);
  assert.equal(count(f.orch.entries(), e => e.type === "release" && e.exec === ea), 0, "an unproven exec keeps its slots");
  const pa = f.executor.run(a);
  assert.equal((await f.executor.run(b)).status, "ok", "other calls keep running");
  await until(() => f.containment.scans >= 4);
  assert.equal(failed(), 1); assert.equal(attention().length, 1);
  assert.equal(count(f.journal.entries(), e => e.type === JT.sealed && e.call === a.callId), 0);
  assert.equal(count(f.journal.entries(), e => e.type === JT.exec && e.call === a.callId), 1, "no new execution while parked");
  assert.equal(f.executor.busy(), true);
  assert.equal(f.errors.filter(e => e.includes(`fence of ${ea} failed`)).length, 1, "a repeated failure is logged once");
  f.containment.stuck.delete(ea);
  const result = await pa;
  assert.equal(result.status, "ok"); assert.deepEqual(result.data, { exec: ea });
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${ea}` && e.resolution === "fenced"));
  assert.ok(f.orch.entries().some(e => e.type === "release" && e.exec === ea));
  assert.equal(count(f.journal.entries(), e => e.type === JT.exec && e.call === a.callId), 1);
});

test("F1 stop never waits on a stuck fence; the parked call seals stopped once the sweep fences it", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), ea = `${a.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea }); await f.session("a", [execLine(ea), report(ea)]);
  f.containment.stuck.add(ea);
  await f.executor.recover(f.wid, f.journal);
  const pa = f.executor.run(a);
  await within(f.executor.stop({ wid: f.wid, callId: a.callId }));
  assert.equal(count(f.journal.entries(), e => e.type === JT.sealed), 0);
  f.containment.stuck.delete(ea);
  assert.equal((await pa).status, "stopped");
});

test("F1 stopping an inactive call with a stuck fence returns; the sweep seals it stopped later", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), ea = `${a.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea });
  f.containment.stuck.add(ea);
  await f.executor.recover(f.wid, f.journal);
  await within(f.executor.stop({ wid: f.wid, callId: a.callId }));
  assert.equal(count(f.journal.entries(), e => e.type === JT.sealed), 0);
  f.containment.stuck.delete(ea);
  await until(() => f.journal.entries().some(e => e.type === JT.sealed && e.call === a.callId));
  assert.equal((f.journal.entries().find(e => e.type === JT.sealed)!.result as { status: string }).status, "stopped");
});

test("F1 suspend interrupts a parked call without sealing it", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), ea = `${a.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea });
  f.containment.stuck.add(ea);
  await f.executor.recover(f.wid, f.journal);
  const pa = f.executor.run(a);
  await until(() => f.errors.length > 0);
  await within(f.executor.suspend());
  await assert.rejects(pa, { name: "ExecutorShutdown" });
  assert.equal(count(f.journal.entries(), e => e.type === JT.sealed), 0);
});

test("E4 a malformed interior session line is skipped like pi does and recorded once", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), ea = `${a.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea });
  await f.session("a", [execLine(ea), '{"type":"custom","customType":"dsa-rep', report(ea)]);
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(a)).status, "ok");
  await (await f.restart()).recover(f.wid, f.journal);
  const corrupt = f.journal.entries().filter(e => e.type === "session-corrupt");
  assert.deepEqual(corrupt.map(e => [e.call, e.line]), [[a.callId, 2]]);
});

test("E4 a report lost on the malformed line falls through to normal loss handling", { timeout: 10000 }, async t => {
  const f = await fixture(t, { k: { trackerMs: 20, lossBound: 1 } }), a = f.ticket("a"), ea = `${a.callId}#1.1`;
  await f.journal.append(JT.exec, { call: a.callId, exec: ea });
  await f.session("a", [execLine(ea), JSON.stringify(report(ea)).slice(0, 30), { type: "message", message: { role: "user", content: "after" } }]);
  await f.executor.recover(f.wid, f.journal);
  const result = await f.executor.run(a);
  assert.equal(result.status, "failed"); assert.equal(result.error, "lost ×1");
  assert.equal(count(f.journal.entries(), e => e.type === "session-corrupt" && e.line === 2), 1);
});

test("E2 receipted and sealed inbox envelopes are deleted and resolved; unreceipted ones retire", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = f.ticket("a"), ea = `${a.callId}#1.1`, ctx = { journal: f.journal, widRev: a.widRev, key: "a", gen: 1 };
  const steer = (rid: string, sseq: number): Request => ({ rid, from: "main:test", to: "orch", sseq, kind: "send", body: { to: a.callId, kind: "steer", message: rid } });
  await f.executor.forward(steer("seen", 1), ctx); await f.executor.forward(steer("unseen", 2), ctx);
  const seen = forwardRid("seen", a.widRev, "a", contentHash(steer("seen", 1)));
  const inbox = callInbox(f.home, f.wid, "a", 1);
  assert.equal((await readdir(inbox)).length, 2);
  await f.journal.append(JT.exec, { call: a.callId, exec: ea });
  await f.session("a", [execLine(ea), { type: "custom_message", customType: CT.msg, content: "seen", details: { rid: seen, kind: "steer" } }, report(ea)]);
  await f.executor.recover(f.wid, f.journal);
  assert.equal((await f.executor.run(a)).status, "ok");
  assert.deepEqual(await readdir(inbox), []);
  const outbox = readJournalSnapshot(join(outboxRoot(f.home), "outbox", "orch.jsonl"));
  const sent = outbox.filter(e => e.type === "sent").map(e => (e.request as Request).rid);
  assert.ok(sent.every(rid => outbox.some(e => e.type === "resolved" && e.rid === rid)), "every envelope of the sealed call is resolved");
  assert.equal(f.journal.entries().filter(e => e.type === "forward-retired").map(e => e.rid).join(), "unseen");
  await (await f.restart()).recover(f.wid, f.journal);
  assert.deepEqual(await readdir(inbox), [], "recovery never republishes resolved envelopes");
});

test("F3 memory admission throttles repeated refusals and records every admission", { timeout: 10000 }, async t => {
  let available = 0;
  const f = await fixture(t, {}, { memory: async () => available });
  const pending = f.executor.run(f.ticket("a"));
  await until(() => f.orch.entries().some(e => e.type === "mem"));
  await delay(300);
  assert.deepEqual(f.orch.entries().filter(e => e.type === "mem").map(e => e.admitted), [false]);
  available = 1e6;
  assert.equal((await pending).status, "failed");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "mem").map(e => e.admitted), [false, true]);
});

test("F3 every admitted execution of one call records mem", { timeout: 10000 }, async t => {
  const f = await fixture(t, { k: { trackerMs: 20, lossBound: 2 } });
  f.containment.exits = true;
  const a = f.ticket("a"), result = await f.executor.run(a);
  assert.equal(result.status, "failed"); assert.equal(result.error, "lost ×2");
  assert.deepEqual(f.orch.entries().filter(e => e.type === "mem").map(e => [e.exec, e.admitted]), [[`${a.callId}#1.1`, true], [`${a.callId}#1.2`, true]]);
});

test("F3 incremental holdings observe holds and releases appended after an earlier fold", { timeout: 10000 }, async t => {
  const f = await fixture(t, { providers: { probe: { slots: 1 } } });
  await f.orch.append("hold", { pool: "probe", slot: 0, exec: "elsewhere" });
  const pending = f.executor.run(f.ticket("a"));
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  await delay(150);
  assert.equal(count(f.orch.entries(), e => e.type === "hold"), 1, "a full provider admits nobody");
  const released = await f.orch.append("release", { pool: "probe", slot: 0, exec: "elsewhere" });
  assert.equal((await pending).status, "failed");
  const hold = f.orch.entries().find(e => e.type === "hold" && e.pool === "probe" && e.exec !== "elsewhere")!;
  assert.ok(hold.seq > released.seq); assert.equal(hold.slot, 0);
});

test("F1 A2 a gate whose recovery fence times out never fails recovery or re-runs; the call seals only after the sweep fenced it", { timeout: 10000 }, async t => {
  const f = await fixture(t, {}, { realEffects: true }), a = f.ticket("a"), ea = `${a.callId}#1.1`, gid = `gate:${a.callId}#1`;
  a.spec.gate = "echo must-not-run > ran";
  await f.journal.append(JT.exec, { call: a.callId, exec: ea }); await f.journal.append(JT.fenced, { exec: ea });
  await f.journal.append("gate-intent", { call: a.callId, id: gid, exec: ea });
  await f.session("a", [execLine(ea), report(ea)]);
  f.containment.stuck.add(gid);
  await f.executor.recover(f.wid, f.journal); await f.executor.recover(f.wid, f.journal);
  const attention = () => f.journal.entries().filter(e => e.type === JT.attention && item(e).id === `fence:${gid}`);
  assert.equal(count(f.journal.entries(), e => e.type === "fence-failed" && e.exec === gid), 1);
  assert.equal(attention().length, 1); assert.equal(item(attention()[0]!).kind, "unknown"); assert.equal(item(attention()[0]!).call, a.callId);
  assert.equal(count(f.journal.entries(), e => e.type === "gate"), 0);
  const pending = f.executor.run(a);
  await until(() => f.containment.scans >= 4);
  assert.equal(count(f.journal.entries(), e => e.type === JT.sealed), 0, "no seal while the gate's processes may live");
  assert.equal(count(f.journal.entries(), e => e.type === "fence-failed" && e.exec === gid), 1);
  f.containment.stuck.delete(gid);
  const result = await pending;
  assert.equal(result.status, "unknown", "an unfenced gate is never re-run; its outcome is unknown");
  assert.equal(count(f.journal.entries(), e => e.type === "gate-intent"), 1);
  await assert.rejects(readdir(join(a.cwd, "ran")), { code: "ENOENT" });
  const gate = f.journal.entries().find(e => e.type === "gate")!, seal = f.journal.entries().find(e => e.type === JT.sealed)!;
  assert.equal(gate.unknown, true); assert.ok(gate.seq < seal.seq);
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${gid}` && e.resolution === "fenced"));
  await (await f.restart()).recover(f.wid, f.journal);
  assert.equal(count(f.journal.entries(), e => e.type === "gate"), 1);
});

test("F1 A2 stop ends the wait on a parked gate and seals stopped", { timeout: 10000 }, async t => {
  const f = await fixture(t, {}, { realEffects: true }), a = f.ticket("a"), ea = `${a.callId}#1.1`, gid = `gate:${a.callId}#1`;
  a.spec.gate = "true";
  await f.journal.append(JT.exec, { call: a.callId, exec: ea }); await f.journal.append(JT.fenced, { exec: ea });
  await f.journal.append("gate-intent", { call: a.callId, id: gid, exec: ea });
  await f.session("a", [execLine(ea), report(ea)]);
  f.containment.stuck.add(gid);
  await f.executor.recover(f.wid, f.journal);
  const pending = f.executor.run(a);
  await delay(100);
  await within(f.executor.stop({ wid: f.wid, callId: a.callId }));
  assert.equal((await pending).status, "stopped");
});

test("F1 A2 a fence timeout at the end of a normal gate run is isolated; the call seals unknown after the sweep", { timeout: 15000 }, async t => {
  const real = serialContainment(), stuck = new Set<string>();
  const containment: Containment = { spawn: spec => real.spawn(spec), scan: known => real.scan(known),
    fence: async (id, tracked, opts) => { if (stuck.has(id)) throw new Error(`Fence timeout: ${id}`); return real.fence(id, tracked, opts); } };
  const f = await fixture(t, {}, { realEffects: true, containment }), a = f.ticket("a"), ea = `${a.callId}#1.1`, gid = `gate:${a.callId}#1`;
  a.spec.gate = "echo ran >> gate-runs";
  await f.journal.append(JT.exec, { call: a.callId, exec: ea }); await f.journal.append(JT.fenced, { exec: ea });
  await f.session("a", [execLine(ea), report(ea)]);
  stuck.add(gid);
  try {
    const pending = f.executor.run(a);
    await until(() => f.journal.entries().some(e => e.type === "fence-failed" && e.exec === gid));
    await delay(200);
    assert.equal(count(f.journal.entries(), e => e.type === JT.sealed), 0, "a gate that may live never lets the call seal");
    assert.equal(count(f.journal.entries(), e => e.type === "gate"), 0);
    assert.equal(count(f.journal.entries(), e => e.type === JT.attention && item(e).id === `fence:${gid}` && item(e).kind === "unknown"), 1);
    stuck.delete(gid);
    const result = await pending;
    assert.equal(result.status, "unknown");
    assert.equal(f.journal.entries().find(e => e.type === "gate")!.unknown, true);
    assert.equal(count(f.journal.entries(), e => e.type === "fence-failed"), 1);
    assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${gid}`));
    assert.equal((await readFile(join(a.cwd, "gate-runs"), "utf8")), "ran\n", "the gate ran exactly once");
  } finally { stuck.clear(); await real.fence(gid, []).catch(() => {}); }
});

test("a call waiting for a slot follows a reloaded defaultModel and limit", { timeout: 10000 }, async t => {
  const f = await fixture(t, { defaultModel: "p/old", providers: { p: { slots: 0 }, q: { slots: 1 } } });
  const a = { ...f.ticket("a"), agent: { ...agent, model: undefined } };
  const run = f.executor.run(a);
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  await delay(100);
  assert.equal(count(f.journal.entries(), e => e.type === "selected"), 0, "p has no slot");
  await f.executor.reconfigure!(async () => { f.config.defaultModel = "q/new"; });
  await run;
  assert.deepEqual(f.journal.entries().find(e => e.type === "selected")?.model, { provider: "q", id: "new" });
});

test("A4 admission reads the settings recorded in the orchestrator ledger, not the object it was given", { timeout: 10000 }, async t => {
  const f = await fixture(t, { defaultModel: "p/old", providers: { p: { slots: 0 }, q: { slots: 1 } } });
  const run = f.executor.run({ ...f.ticket("a"), agent: { ...agent, model: undefined } });
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  await delay(100);
  assert.equal(count(f.journal.entries(), e => e.type === "selected"), 0, "p has no slot");
  // Recorded only: the given object still names p/old.
  await f.executor.reconfigure!(async () => { await f.orch.append("config", { hash: "recorded", config: { defaultModel: "q/new", providers: { p: { slots: 0 }, q: { slots: 1 } } } }); });
  await run;
  assert.deepEqual(f.journal.entries().find(e => e.type === "selected")?.model, { provider: "q", id: "new" });
  assert.equal(f.config.defaultModel, "p/old");
});

test("a config change waits for an admission in progress instead of changing its limits halfway", { timeout: 10000 }, async t => {
  let measured!: () => void;
  const gate = new Promise<void>(resolve => { measured = resolve; });
  let measuring = false;
  const f = await fixture(t, { providers: { probe: { slots: 1 } } }, { memory: async () => { measuring = true; await gate; return 1e6; } });
  const run = f.executor.run(f.ticket("a"));
  await until(() => measuring);
  let holdsAtApply = -1;
  const change = f.executor.reconfigure!(async () => {
    holdsAtApply = count(f.orch.entries(), e => e.type === "hold" && e.pool === "probe");
    f.config.providers = { probe: { slots: 0 } };
  });
  await delay(50);
  assert.equal(holdsAtApply, -1, "the change waits for the admission");
  measured();
  await change;
  assert.equal(holdsAtApply, 1, "the admission completed under the limits it checked");
  await run;
});
