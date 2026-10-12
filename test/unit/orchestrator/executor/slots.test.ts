// Who gets a freed provider slot (resume before fresh, the origin holding fewer slots first) and pool entries that
// wait (afterMs) before a call spills over to them. Spawning fails at once, so each admitted call seals failed and
// frees its slot; the order of the provider `hold` entries in the orchestrator ledger (one ordered journal) is the
// order of admission.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { journalPath, orchLedger } from "../../../../src/paths.ts";
import { JT, type Containment, type JournalHandle, type ProcInfo } from "../../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";

const containment: Containment = {
  async spawn() { throw new Error("no processes in unit tests"); },
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
  async fence() {},
};
const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };

async function until(predicate: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await delay(5); }
}

async function fixture(t: TestContext, config: OrchestratorConfig) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-slots-")));
  const orch = await openJournal(orchLedger(home)), journals: JournalHandle[] = [];
  t.mock.method(console, "error", () => {});
  /** Every slot attempt that admitted nothing, in order: [exec, providers found full]. */
  const attempts: [string, string[]][] = [];
  const ledgers = { home, orch, config: { writerLock: "off" as const, ...config } };
  const executor = createExecutor(ledgers, { effects, containment, memory: async () => 1e6, sweepMs: 60000, attempted: (exec, full) => { attempts.push([exec, [...full]]); } });
  t.after(async () => { try { await executor.shutdown(); } finally { for (const j of journals) await j.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const workflow = async (origin: string) => {
    const wid = ulid(), journal = await openJournal(journalPath(home, wid)); journals.push(journal);
    await orch.append(JT.created, { rid: ulid(), wid, origin });
    const ticket = (key: string): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd: home, journal, spec: { agent: "test", task: "task" }, agent });
    return { wid, journal, ticket };
  };
  const attempted = (exec: string) => attempts.filter(([e]) => e === exec).length;
  const lastAttempt = (exec: string) => attempts.findLastIndex(([e]) => e === exec);
  return { home, orch, executor, workflow, attempts, attempted, lastAttempt };
}
/** A call that ran before: its first execution was fenced without a result (a loss), so its next one resumes. */
async function ranBefore(journal: JournalHandle, ticket: CallTicket) {
  await journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await journal.append(JT.fenced, { exec: `${ticket.callId}#1.1` });
}
/** The executions of these workflows that were admitted, in the order of their provider holds in the orchestrator ledger. */
function admitted(orch: JournalHandle, ...journals: JournalHandle[]): string[] {
  const selected = new Set(journals.flatMap(j => j.entries().filter(e => e.type === "selected").map(e => String(e.exec))));
  return [...new Set(orch.entries().filter(e => e.type === "hold" && e.pool !== "memory" && selected.has(String(e.exec))).map(e => String(e.exec)))];
}

// A long tracker period: waiters attempt again only when woken, in the order they last attempted, so the test decides
// which waiter attempts first after the slot frees.
for (const first of ["fresh", "resume"] as const) {
  test(`a freed slot goes to a call that ran before, ahead of a fresh launch (${first} waiter attempts first)`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { providers: { probe: { slots: 1 } }, k: { trackerMs: 60000 } });
    const w = await f.workflow("main:session-a");
    const fresh = w.ticket("fresh"), resume = w.ticket("resume"), freshExec = `${fresh.callId}#1.1`, resumeExec = `${resume.callId}#1.2`;
    await ranBefore(w.journal, resume);
    await f.orch.append("hold", { pool: "probe", slot: 0, exec: "elsewhere" });
    const runs: Promise<unknown>[] = [];
    if (first === "fresh") {
      runs.push(f.executor.run(fresh)); await until(() => f.attempted(freshExec) > 0);
      // The resumed call's loss frees nothing but wakes every waiter: the fresh call attempts again before it.
      runs.push(f.executor.run(resume)); await until(() => f.attempted(resumeExec) > 0 && f.lastAttempt(freshExec) >= 0);
      assert.ok(f.lastAttempt(freshExec) < f.lastAttempt(resumeExec), "the fresh waiter attempts first when woken");
    } else {
      runs.push(f.executor.run(resume)); await until(() => f.attempted(resumeExec) > 0);
      runs.push(f.executor.run(fresh)); await until(() => f.attempted(freshExec) > 0);
      assert.ok(f.lastAttempt(resumeExec) < f.lastAttempt(freshExec), "the resumed waiter attempts first when woken");
    }
    assert.deepEqual(f.attempts.at(-1)![1], ["probe"]);
    assert.equal(admitted(f.orch, w.journal).length, 0, "a full provider admits nobody");
    await f.executor.reconfigure!(async () => { await f.orch.append("release", { pool: "probe", slot: 0, exec: "elsewhere" }); });
    await Promise.all(runs);
    assert.deepEqual(admitted(f.orch, w.journal), [resumeExec, freshExec]);
  });
}

test("a call whose earlier executions only failed to launch (environment) is no resume: the longer wait decides", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { probe: { slots: 1 } }, k: { trackerMs: 60000 } });
  const w = await f.workflow("main:session-a");
  const fresh = w.ticket("fresh"), retried = w.ticket("retried"), freshExec = `${fresh.callId}#1.1`, retriedExec = `${retried.callId}#1.2`;
  // Its first execution never started: pi could not be launched.
  await w.journal.append(JT.exec, { call: retried.callId, exec: `${retried.callId}#1.1` });
  await w.journal.append("spawn-env-failed", { call: retried.callId, exec: `${retried.callId}#1.1`, command: "pi", error: "spawn pi ENOENT" });
  await w.journal.append(JT.fenced, { exec: `${retried.callId}#1.1` });
  await f.orch.append("hold", { pool: "probe", slot: 0, exec: "elsewhere" });
  const runs = [f.executor.run(fresh)];
  await until(() => f.attempted(freshExec) > 0);
  runs.push(f.executor.run(retried));
  await until(() => f.attempted(retriedExec) > 0 && f.lastAttempt(freshExec) >= 0);
  await f.executor.reconfigure!(async () => { await f.orch.append("release", { pool: "probe", slot: 0, exec: "elsewhere" }); });
  await Promise.all(runs);
  assert.deepEqual(admitted(f.orch, w.journal), [freshExec, retriedExec]);
});

test("a freed slot goes to the workflow origin that holds fewer of the provider's slots", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { probe: { slots: 3 } }, k: { trackerMs: 60000 } });
  const x = await f.workflow("main:busy-session"), y = await f.workflow("cli:bob@host");
  await f.orch.append("hold", { pool: "probe", slot: 0, exec: `${x.wid}@1/h1@1#1.1` });
  await f.orch.append("hold", { pool: "probe", slot: 1, exec: `${x.wid}@1/h2@1#1.1` });
  await f.orch.append("hold", { pool: "probe", slot: 2, exec: "elsewhere" });
  const busy = x.ticket("a"), idle = y.ticket("b"), busyExec = `${busy.callId}#1.1`, idleExec = `${idle.callId}#1.1`;
  // The busy origin's call waits longer and attempts first: only the holdings decide.
  const runs = [f.executor.run(busy)];
  await until(() => f.attempted(busyExec) > 0);
  runs.push(f.executor.run(idle));
  await until(() => f.attempted(idleExec) > 0);
  assert.ok(f.lastAttempt(busyExec) < f.lastAttempt(idleExec));
  await f.executor.reconfigure!(async () => { await f.orch.append("release", { pool: "probe", slot: 2, exec: "elsewhere" }); });
  await Promise.all(runs);
  assert.deepEqual(admitted(f.orch, x.journal, y.journal), [idleExec, busyExec]);
});

test("a waiter with precedence holds back only the providers it found full", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { probe: { slots: 1 }, other: { slots: 0 } }, k: { trackerMs: 20 } });
  const w = await f.workflow("main:session-a");
  const resume = w.ticket("resume"), fresh = w.ticket("fresh");
  await ranBefore(w.journal, resume);
  const runs = [f.executor.run({ ...resume, spec: { ...resume.spec, model: "other/m" } })];
  await until(() => f.attempted(`${resume.callId}#1.2`) > 0);
  runs.push(f.executor.run(fresh));
  await until(() => admitted(f.orch, w.journal).includes(`${fresh.callId}#1.1`));
  assert.deepEqual(f.attempts.filter(([e]) => e === `${fresh.callId}#1.1`), [], "admitted at its first attempt");
  await f.executor.stop({ wid: w.wid, callId: resume.callId });
  await Promise.all(runs);
});

test("a pool entry with afterMs is taken only after the call waited that long for a slot", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { pool: ["p/strong", { model: "q/weak", afterMs: 300 }] }, providers: { p: { slots: 0 }, q: { slots: 1 } }, k: { trackerMs: 20 } });
  const w = await f.workflow("main:session-a"), call = w.ticket("a"), exec = `${call.callId}#1.1`;
  await f.executor.run({ ...call, spec: { ...call.spec, model: "pool" } });
  const started = w.journal.entries().find(e => e.type === JT.exec && e.exec === exec)!;
  const selected = w.journal.entries().find(e => e.type === "selected" && e.exec === exec)!;
  assert.deepEqual(selected.model, { provider: "q", id: "weak" }, "recorded without afterMs");
  assert.equal(selected.pool, "pool");
  assert.ok(selected.ts - started.ts >= 300, `took q after ${selected.ts - started.ts} ms`);
  assert.ok(f.attempts.filter(([e]) => e === exec).length >= 2, "it waited, attempting again");
  assert.ok(f.attempts.every(([, full]) => full.every(p => p === "p")), "q was not refused, only not eligible yet");
});

test("a free first entry is taken at once; afterMs does not delay it", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { pool: ["p/strong", { model: "q/weak", afterMs: 60000 }] }, providers: { p: { slots: 1 }, q: { slots: 1 } }, k: { trackerMs: 20 } });
  const w = await f.workflow("main:session-a"), call = w.ticket("a");
  await f.executor.run({ ...call, spec: { ...call.spec, model: "pool" } });
  assert.deepEqual(w.journal.entries().find(e => e.type === "selected")!.model, { provider: "p", id: "strong" });
});
