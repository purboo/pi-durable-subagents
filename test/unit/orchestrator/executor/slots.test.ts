// Who gets a freed provider slot (resume before fresh, the origin holding fewer slots first) and pool entries that
// wait (afterMs) before a call spills over to them. Spawning fails at once, so each admitted call seals failed and
// frees its slot; the order of the provider `hold` entries in the orchestrator ledger (one ordered journal) is the
// order of admission.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type JournalHandle, type ProcInfo } from "../../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../../src/orchestrator/contract.ts";
import { compactWorkflow, snapshotFromEntries, workflowSnapshot, statusView, ownWorkflows } from "../../../../src/orchestrator/snapshot.ts";
import { renderStatus, renderView } from "../../../../src/cli/main.ts";
import { parseModel, resolveModel } from "../../../../src/compat/model.ts";
import { spillCandidates } from "../../../../src/orchestrator/executor/pool.ts";
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
  await orch.append("config", { hash: "fixture", config: { writerLock: "off", ...config } });
  t.mock.method(console, "error", () => {});
  /** Every slot attempt that admitted nothing, in order: [exec, providers found full]. */
  const attempts: [string, string[]][] = [];
  const ledgers = { home, orch, config: { writerLock: "off" as const, ...config } };
  const executor = createExecutor(ledgers, { effects, containment, memory: async () => 1e6, sweepMs: 60000, attempted: (exec, full) => { attempts.push([exec, [...full]]); } });
  t.after(async () => { try { await executor.shutdown(); } finally { for (const j of journals) await j.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const workflow = async (origin: string) => {
    const wid = ulid(), journal = await openJournal(journalPath(home, wid)); journals.push(journal);
    await orch.append(JT.created, { rid: ulid(), wid, origin });
    await journal.append("wf-created", { revision: 1, origin });
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

async function resumed(home: string, journal: JournalHandle, ticket: CallTicket, model = { provider: "p", id: "strong" }) {
  await journal.append("call", { key: ticket.key, gen: 1, spec: ticket.spec });
  await ranBefore(journal, ticket);
  await mkdir(callDir(home, ticket.wid, ticket.key, 1), { recursive: true });
  await writeFile(callSession(home, ticket.wid, ticket.key, 1), [
    { type: "custom", customType: CT.exec, data: { exec: `${ticket.callId}#1.1` } },
    { type: "model_change", provider: model.provider, modelId: model.id },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
}

for (const mode of ["delay", "immediate", "same-id", "path-prefix", "afterMs"] as const) test(`resumed pool spills: ${mode}`, { timeout: 10000 }, async t => {
  const spillMs = mode === "immediate" ? 0 : 160;
  const f = await fixture(t, { pools: { pool: mode === "path-prefix" ? ["r/claude-opus-5-5", "p/ide/strong", "q/strong:high"] : mode === "same-id" ? ["p/strong", "r/other", "q/strong:high"] : ["p/strong", { model: "q/strong:high", ...(mode === "afterMs" ? { afterMs: 300 } : {}) }] },
    providers: { p: { slots: 0 }, q: { slots: 1 }, r: { slots: 1 } }, k: { trackerMs: 10, resumeSpillMs: spillMs } });
  const w = await f.workflow("main:resume"), ticket = w.ticket("a"); ticket.spec.model = "pool";
  await resumed(f.home, w.journal, ticket, { provider: "p", id: mode === "path-prefix" ? "ide/strong" : "strong" });
  const run = f.executor.run(ticket);
  if (mode !== "immediate") {
    await until(() => w.journal.entries().some(e => e.type === "slot-wait"));
    const snap = workflowSnapshot(f.home, w.wid), c = snap.calls[0]!;
    assert.deepEqual(c.poolWait?.free, mode === "same-id" || mode === "path-prefix" ? ["r", "q"] : ["q"]);
    assert.match(renderStatus(snap), /queued .* on p \(full\); pool has free slots:/);
    assert.match(renderView({ workflows: [compactWorkflow(snap)] }), /pool has free slots:/);
    assert.equal(w.journal.entries().some(e => e.type === "selected"), false);
  }
  await run;
  const spill = w.journal.entries().find(e => e.type === "spilled")!;
  assert.ok(spill, "the resumed call moved without waiting for p");
  assert.ok(Number(spill.waitedMs) >= spillMs);
  const selected = w.journal.entries().find(e => e.type === "selected")!;
  assert.deepEqual(selected.model, { provider: "q", id: "strong", thinking: "high" });
  assert.equal(selected.pool, "pool");
  if (mode === "afterMs") assert.ok(Number(spill.waitedMs) >= 290);
  const snap = snapshotFromEntries(w.wid, w.journal.entries());
  assert.match(renderStatus(snap), /spilled after .*p full -> q\/strong/);
  assert.deepEqual(compactWorkflow(snap).calls[0]!.spill, snap.calls[0]!.spill);
});

for (const mode of ["explicit", "parent-pinned", "follow-up-pin", "null", "negative"] as const) test(`resumed calls never spill: ${mode}`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { pools: { pool: ["p/strong", "q/strong"] }, providers: { p: { slots: 0 }, q: { slots: 1 } },
    k: { trackerMs: 10, resumeSpillMs: mode === "null" ? null : mode === "negative" ? -1 : 0 } });
  const w = await f.workflow("main:resume"), ticket = w.ticket("a"); ticket.spec.model = mode === "explicit" ? "p/strong" : "pool";
  if (mode === "follow-up-pin") ticket.model = "p/strong";
  await resumed(f.home, w.journal, ticket);
  if (mode === "parent-pinned") {
    await w.journal.append("forward", { rid: "pin", rid2: "pin", dest: ticket.callId, envelope: { kind: "model", body: { provider: "p", model: "strong" } } });
    await w.journal.append("forward-delivered", { call: ticket.callId, rid2: "pin" });
  }
  const run = f.executor.run(ticket);
  await until(() => f.attempted(`${ticket.callId}#1.2`) >= 3);
  assert.equal(w.journal.entries().some(e => e.type === "selected"), false);
  assert.equal(w.journal.entries().some(e => e.type === "spilled"), false);
  await f.executor.stop({ wid: w.wid, callId: ticket.callId }); await run;
});

test("same-id spill preference uses the last path segment of real pool identifiers", () => {
  const pinned = parseModel("mccodex/ide/gpt-6.1-sol:high");
  const pool = resolveModel("writer", { writer: ["s2a-claude/claude-opus-5-5:medium", "mccodex/ide/gpt-6.1-sol:high", "sota/GPT-6.1-SOL:high"] });
  assert.deepEqual(spillCandidates(pinned, pool).map(m => m.provider), ["sota", "s2a-claude"]);
  assert.equal(spillCandidates({ provider: "mccodex", id: "ide/gpt-6.1-sol:high" }, pool)[0]!.thinking, "high");
});

test("slot wait journals stay bounded while live status follows free-provider changes", { timeout: 10000 }, async t => {
  const config: OrchestratorConfig = { pools: { pool: ["p/strong", "q/strong", "r/other"] }, providers: { p: { slots: 0 }, q: { slots: 1 }, r: { slots: 1 } }, k: { trackerMs: 10, resumeSpillMs: null } };
  const f = await fixture(t, config), w = await f.workflow("main:resume"), ticket = w.ticket("a"); ticket.spec.model = "pool";
  await resumed(f.home, w.journal, ticket);
  const run = f.executor.run(ticket);
  await until(() => w.journal.entries().some(e => e.type === "slot-wait"));
  const start = w.journal.entries().find(e => e.type === "slot-wait")!;
  assert.equal(start.free, undefined, "free slots are not persisted in workflow journals");
  assert.deepEqual(workflowSnapshot(f.home, w.wid).calls[0]!.poolWait?.free, ["q", "r"]);
  for (let i = 0; i < 8; i++) {
    const provider = i % 2 ? "r" : "q";
    await f.executor.reconfigure!(async () => { await f.orch.append("hold", { pool: provider, slot: 0, exec: "fixture-busy" }); });
    await until(() => f.attempted(`${ticket.callId}#1.2`) >= i * 2 + 2);
    const free = ["q", "r"].filter(p => p !== provider);
    assert.deepEqual(statusView(f.home).workflows[0]!.calls[0]!.poolWait?.free, free);
    assert.deepEqual(ownWorkflows(f.home, "main:resume")[0]!.calls[0]!.poolWait?.free, free);
    assert.equal(workflowSnapshot(f.home, w.wid).calls[0]!.poolWait?.since, start.since);
    await f.executor.reconfigure!(async () => { await f.orch.append("release", { pool: provider, slot: 0, exec: "fixture-busy" }); });
    assert.deepEqual(workflowSnapshot(f.home, w.wid).calls[0]!.poolWait?.free, ["q", "r"]);
  }
  assert.equal(w.journal.entries().filter(e => e.type === "slot-wait").length, 1);
  await f.executor.reconfigure!(async () => { await f.orch.append("config", { hash: "free", config: { ...config, writerLock: "off", providers: { ...config.providers, p: { slots: 1 } } } }); });
  await run;
  assert.equal(w.journal.entries().filter(e => e.type === "slot-wait").length, 2, "only start and end are recorded");
  assert.equal(workflowSnapshot(f.home, w.wid).calls[0]!.poolWait, undefined);
});

test("resumed pool keeps its wait timer only for this execution; recovery restarts the wait", { timeout: 10000 }, async t => {
  const config: OrchestratorConfig = { pools: { pool: ["p/strong", "q/strong"] }, providers: { p: { slots: 0 }, q: { slots: 1 } }, k: { trackerMs: 10, resumeSpillMs: 300 } };
  const f = await fixture(t, config), w = await f.workflow("main:resume"), ticket = w.ticket("a"); ticket.spec.model = "pool";
  await resumed(f.home, w.journal, ticket);
  const first = f.executor.run(ticket); void first.catch(() => {});
  await until(() => w.journal.entries().some(e => e.type === "slot-wait"));
  await delay(160); await f.executor.shutdown(); await assert.rejects(first, { name: "ExecutorShutdown" });
  const recovered = createExecutor({ home: f.home, orch: f.orch, config: { ...config, writerLock: "off" } }, { effects, containment, memory: async () => 1e6 });
  t.after(() => recovered.shutdown());
  await recovered.recover(w.wid, w.journal);
  await recovered.run(ticket);
  const waits = w.journal.entries().filter(e => e.type === "slot-wait" && e.model);
  assert.equal(waits.length, 2);
  const spill = w.journal.entries().find(e => e.type === "spilled")!;
  assert.ok(spill.ts - waits[1]!.ts >= 300, "the new execution waits a full interval");
});
