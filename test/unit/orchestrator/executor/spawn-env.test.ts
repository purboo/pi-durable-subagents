// A launch that fails because of the environment (pi missing or not executable) keeps the call queued with one alert
// and launches it again later; other launch failures stay terminal.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { contentHash, ulid } from "../../../../src/kernel/ids.ts";
import { scanInbox } from "../../../../src/kernel/mailbox.ts";
import { binDir, callDir, callInbox, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type Entry, type ProcInfo, type SpawnSpec } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { snapshotFromEntries } from "../../../../src/orchestrator/snapshot.ts";

const enoent = () => Object.assign(new Error("spawn /missing/pi ENOENT"), { code: "ENOENT", errno: -2, syscall: "spawn /missing/pi" });
/** No processes: `fail` decides each launch's error; otherwise the child "runs" by writing its report to the session. */
class FakeContainment implements Containment {
  launches: SpawnSpec[] = [];
  fail: (n: number) => Error | undefined = () => undefined;
  session?: (exec: string) => Promise<void>;
  async spawn(spec: SpawnSpec) {
    this.launches.push(spec);
    const error = this.fail(this.launches.length);
    if (error) throw error;
    await this.session?.(spec.exec);
    const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
    return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
  }
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); }
  async fence() {}
}
const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };

async function fixture(t: TestContext, options: { spawnRetryMs?: number; pi?: string } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-spawn-env-"))), wid = ulid(), containment = new FakeContainment();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const consoleError = t.mock.method(console, "error", () => {});
  const ledgers = { home, orch, config: { k: { trackerMs: 20 }, writerLock: "off" as const } };
  const make = () => createExecutor(ledgers, { effects, containment, memory: async () => 1e6, sweepMs: 40, ...options });
  let executor = make();
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "task" } });
  containment.session = async exec => {
    await mkdir(callDir(home, wid, "a", 1), { recursive: true });
    await writeFile(callSession(home, wid, "a", 1), [{ type: "custom", customType: CT.exec, data: { exec } }, { type: "custom", customType: CT.report, data: { exec, outcome: "ok", data: { exec } } }]
      .map(l => JSON.stringify(l)).join("\n") + "\n");
  };
  return { home, wid, orch, journal, containment, ticket, consoleError, get executor() { return executor; },
    async restart() { await executor.shutdown(); executor = make(); return executor; } };
}
const alerts = (entries: readonly Entry[]) => entries.filter(e => e.type === JT.attention && (e.item as { kind: string }).kind === "environment");
async function until(predicate: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await delay(10); }
}

test("an ENOENT launch keeps the call queued with one alert, releases its slots and succeeds on a later attempt", { timeout: 15000 }, async t => {
  const f = await fixture(t, { spawnRetryMs: 50, pi: "/missing/pi" });
  f.containment.fail = n => n <= 3 ? enoent() : undefined;
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  assert.equal(f.containment.launches.length, 4);
  assert.equal(f.containment.launches[0]!.command, "/missing/pi", "the resolved pi is launched, not a bare name");
  const entries = f.journal.entries();
  assert.equal(entries.filter(e => e.type === "spawn-env-failed").length, 3);
  assert.equal(entries.filter(e => e.type === "loss").length, 0, "a child that never started lost nothing");
  const raised = alerts(entries);
  assert.equal(raised.length, 1, "one alert for the call, not one per attempt");
  const text = String((raised[0]!.item as { text: string }).text);
  assert.match(text, /ENOENT/); assert.match(text, /\/missing\/pi/); assert.match(text, /retries every minute/); assert.match(text, /stop it to give up/);
  assert.ok(entries.some(e => e.type === JT.attentionResolved && e.id === `environment:${f.ticket.callId}` && e.resolution === "launched"));
  // Every failed execution gave back its slots: only the sealed one held any, and it released them too.
  const held = new Map<string, string>();
  for (const e of f.orch.entries()) {
    if (e.type === "hold") held.set(`${e.pool}:${e.slot}`, String(e.exec));
    if (e.type === "release" && held.get(`${e.pool}:${e.slot}`) === e.exec) held.delete(`${e.pool}:${e.slot}`);
  }
  assert.deepEqual([...held], []);
});

test("an environment failure waits queued; a restart retries at once; a stop gives up and resolves the alert", { timeout: 15000 }, async t => {
  const f = await fixture(t, { spawnRetryMs: 600_000 });
  f.containment.fail = () => Object.assign(new Error("spawn pi EACCES"), { code: "EACCES" });
  const first = f.executor.run(f.ticket);
  await until(() => alerts(f.journal.entries()).length > 0);
  // Its memory and provider slots are free while it waits.
  assert.ok(f.journal.entries().some(e => e.type === "spawn-env-failed"));
  assert.equal(f.orch.entries().filter(e => e.type === "release").length, 2);
  const snap = snapshotFromEntries(f.wid, f.journal.entries());
  assert.equal(snap.calls.find(c => c.key === "a")?.phase, "queued");
  assert.equal(alerts(f.journal.entries()).length, 1);
  assert.match(String((alerts(f.journal.entries())[0]!.item as { text: string }).text), /DSA_PI_BIN/, "a bare pi names the setting that fixes it");
  // A restart launches again at once (not after the 10-minute wait).
  const settled = first.catch(error => error as Error);
  await f.restart(); assert.equal((await settled as Error).name, "ExecutorShutdown");
  await f.executor.recover(f.wid, f.journal);
  const second = f.executor.run(f.ticket);
  await until(() => f.containment.launches.length >= 2, 3000);
  assert.equal(alerts(f.journal.entries()).length, 1, "still one alert across the restart");
  await f.executor.stop({ wid: f.wid, callId: f.ticket.callId });
  const result = await second;
  assert.equal(result.status, "stopped");
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === `environment:${f.ticket.callId}`));
});

test("other launch errors stay terminal", { timeout: 10000 }, async t => {
  const f = await fixture(t, { spawnRetryMs: 50 });
  f.containment.fail = () => Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "failed"); assert.match(String(result.error), /Spawn failed: .*E2BIG/);
  assert.equal(f.containment.launches.length, 1);
  assert.equal(alerts(f.journal.entries()).length, 0);
});

const launchLines = (f: { consoleError: { mock: { calls: { arguments: unknown[] }[] } } }) =>
  f.consoleError.mock.calls.filter(c => /launching .* failed/.test(String(c.arguments[0]))).length;

test("environment retries of a call that ran before leave exactly one pending dispatch, the first retry's", { timeout: 15000 }, async t => {
  const f = await fixture(t, { spawnRetryMs: 30, pi: "/missing/pi" });
  // The call ran before: its session holds the task (received), and its execution #1.1 ended without a report.
  const taskRid = contentHash([`${f.ticket.callId}#1.1`, "dispatch"]);
  await mkdir(callDir(f.home, f.wid, "a", 1), { recursive: true });
  await writeFile(callSession(f.home, f.wid, "a", 1), [{ type: "custom", customType: CT.exec, data: { exec: `${f.ticket.callId}#1.1` } },
    { type: "message", message: { role: "user", content: "task", details: { rid: taskRid } } }].map(l => JSON.stringify(l)).join("\n") + "\n");
  await f.journal.append(JT.exec, { call: f.ticket.callId, exec: `${f.ticket.callId}#1.1` });
  const inbox = callInbox(f.home, f.wid, "a", 1);
  let pending: { kind: string; rid: string }[] | undefined;
  const write = f.containment.session!;
  f.containment.session = async exec => { pending = (await scanInbox(inbox)).filter(r => r.kind === "task" || r.kind === "continue"); await write(exec); };
  f.containment.fail = n => n <= 4 ? enoent() : undefined;
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  assert.equal(f.containment.launches.length, 5);
  assert.deepEqual(pending?.map(r => [r.kind, r.rid]), [["continue", contentHash([`${f.ticket.callId}#1.2`, "dispatch"])]],
    "one continue (the first retry's), not one per failed launch");
  // Logged once for the run of failures, not once per attempt.
  assert.equal(launchLines(f), 1);
});

test("a launch failure is recorded before its execution is fenced", { timeout: 15000 }, async t => {
  const f = await fixture(t, { spawnRetryMs: 30 });
  f.containment.fail = n => n <= 2 ? enoent() : undefined;
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  const entries = f.journal.entries(), first = `${f.ticket.callId}#1.1`;
  const failed = entries.findIndex(e => e.type === "spawn-env-failed" && e.exec === first);
  const fenced = entries.findIndex(e => e.type === JT.fenced && e.exec === first);
  assert.ok(failed >= 0 && fenced >= 0 && failed < fenced, "spawn-env-failed precedes the fence: a crash in between loses nothing");
});

test("the child's PATH: binDir, then the orchestrator's node, then the inherited PATH", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  const PATH = String(f.containment.launches[0]!.env.PATH).split(delimiter);
  assert.deepEqual(PATH.slice(0, 2), [binDir(f.home), dirname(process.execPath)]);
  if (process.env.PATH) assert.deepEqual(PATH.slice(2), process.env.PATH.split(delimiter));
});
