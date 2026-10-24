// Per-model slots inside a provider (providers.<p>.models): a call on p/id holds a slot of p and, when models[id]
// exists, a slot of that model on p. Spawning fails at once, so an admitted call seals failed and frees its slots;
// slots the tests hold themselves belong to executions that do not exist ("x", "y", "z").
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { workflowSnapshot } from "../../../../src/orchestrator/snapshot.ts";
import { renderStatus } from "../../../../src/cli/main.ts";
import { CT, JT, type Containment, type JournalHandle, type ProcInfo } from "../../../../src/types.ts";
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
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-model-slots-")));
  const orch = await openJournal(orchLedger(home)), journals: JournalHandle[] = [];
  await orch.append("config", { hash: "fixture", config: { writerLock: "off", ...config } });
  t.mock.method(console, "error", () => {});
  const attempts: [string, string[]][] = [];
  const executor = createExecutor({ home, orch, config: { writerLock: "off" as const, ...config } },
    { effects, containment, memory: async () => 1e6, sweepMs: 60000, attempted: (exec, full) => { attempts.push([exec, [...full]]); } });
  t.after(async () => { try { await executor.shutdown(); } finally { for (const j of journals) await j.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const wid = ulid(), journal = await openJournal(journalPath(home, wid)); journals.push(journal);
  await orch.append(JT.created, { rid: ulid(), wid, origin: "main:session-a" });
  await journal.append("wf-created", { revision: 1, origin: "main:session-a" });
  const ticket = (key: string, model: string): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd: home, journal, spec: { agent: "test", task: "task", model }, agent });
  const attempted = (exec: string) => attempts.filter(([e]) => e === exec).length;
  const selected = (exec: string) => journal.entries().find(e => e.type === "selected" && e.exec === exec)?.model;
  /** The pools an execution took a slot of, in order. */
  const holds = (exec: string) => orch.entries().filter(e => e.type === "hold" && e.exec === exec && e.pool !== "memory").map(e => String(e.pool));
  const hold = (pool: string, slot: number, exec: string) => executor.reconfigure!(async () => { await orch.append("hold", { pool, slot, exec }); });
  const release = (pool: string, slot: number, exec: string) => executor.reconfigure!(async () => { await orch.append("release", { pool, slot, exec }); });
  return { home, wid, orch, executor, journal, ticket, attempts, attempted, selected, holds, hold, release };
}
const execOf = (t: CallTicket, n = 1) => `${t.callId}#1.${n}`;
/** A call that ran before: its first execution was fenced without a result (a loss), so its next one resumes. */
async function ranBefore(journal: JournalHandle, ticket: CallTicket) {
  await journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  await journal.append(JT.fenced, { exec: `${ticket.callId}#1.1` });
}

test("a model at its limit waits while another model of the same provider starts, and the provider limit still caps all", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { slots: 3, models: { a: { slots: 1 }, b: { slots: 2 } } } }, k: { trackerMs: 20 } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const a = f.ticket("a", "c/a"), b = f.ticket("b", "c/b");
  const runA = f.executor.run(a);
  await until(() => f.attempted(execOf(a)) > 0);
  assert.deepEqual(f.attempts.find(([e]) => e === execOf(a))![1], ["c/a"], "the model, not the provider, is full");
  // The provider has room: another model of it starts at once and holds a slot of the provider and one of its model.
  await f.executor.run(b);
  assert.deepEqual(f.holds(execOf(b)), ["c", "c/b"]);
  assert.equal(f.selected(execOf(a)), undefined, "a still waits for its model");
  // A model without an entry is limited by the provider only; the provider's slots cap every model.
  await f.hold("c", 1, "y"); await f.hold("c", 2, "z");
  const other = f.ticket("o", "c/other");
  const runOther = f.executor.run(other);
  await until(() => f.attempted(execOf(other)) > 0);
  assert.deepEqual(f.attempts.find(([e]) => e === execOf(other))![1], ["c"]);
  // a's model frees, the provider is still full: a waits on; then the provider frees too.
  await f.release("c/a", 0, "x");
  await delay(80);
  assert.equal(f.selected(execOf(a)), undefined, "the provider is full");
  await f.release("c", 1, "y"); await f.release("c", 2, "z");
  await Promise.all([runA, runOther]);
  assert.deepEqual(f.holds(execOf(a)), ["c", "c/a"]);
  assert.deepEqual(f.holds(execOf(other)), ["c"], "a model without an entry takes no model slot");
});

test("concurrent calls of one model never exceed its slots", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { slots: 10, models: { a: { slots: 2 } } } }, k: { trackerMs: 20 } });
  // Two other executions hold a's slots; four calls of a wait, none admitted until one frees.
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x"); await f.hold("c", 1, "y"); await f.hold("c/a", 1, "y");
  const calls = [1, 2, 3, 4].map(n => f.ticket(`a${n}`, "c/a"));
  const runs = calls.map(c => f.executor.run(c));
  await until(() => calls.every(c => f.attempted(execOf(c)) > 1));
  assert.equal(calls.filter(c => f.selected(execOf(c))).length, 0);
  await f.release("c/a", 0, "x"); await f.release("c", 0, "x");
  await Promise.all(runs);
  // One model slot was free at a time (y kept the other): each admission is followed by its release before the next.
  let held = 1, max = 1;
  for (const e of f.orch.entries()) if (e.pool === "c/a" && String(e.exec).includes("/a")) {
    held += e.type === "hold" ? 1 : e.type === "release" ? -1 : 0; max = Math.max(max, held);
  }
  assert.equal(max, 2, "never more than models.a.slots");
});

test("pool selection moves to the next candidate when the model (not the provider) is full", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { same: ["c/a", "c/b"], cross: ["c/a", "d/a"] }, providers: { c: { slots: 5, models: { a: { slots: 0 } } } }, k: { trackerMs: 20 } });
  const same = f.ticket("s", "same"), cross = f.ticket("x", "cross");
  await f.executor.run(same);
  assert.deepEqual(f.selected(execOf(same)), { provider: "c", id: "b" });
  await f.executor.run(cross);
  assert.deepEqual(f.selected(execOf(cross)), { provider: "d", id: "a" });
});

test("model ids are compared exactly, including ids with '/' and without the thinking suffix", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { p: ["c/catpaw-cli/gemini:high", "d/x"] }, providers: { c: { slots: 5, models: { "catpaw-cli/gemini": { slots: 0 }, "Other": { slots: 0 } } } }, k: { trackerMs: 20 } });
  const pooled = f.ticket("p", "p"), cased = f.ticket("o", "c/other");
  await f.executor.run(pooled);
  assert.deepEqual(f.selected(execOf(pooled)), { provider: "d", id: "x" });
  await f.executor.run(cased);
  assert.deepEqual(f.holds(execOf(cased)), ["c"], "\"other\" is not \"Other\"");
});

test("a provider with models and no slots has only the model limits", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { models: { a: { slots: 1 } } } }, k: { trackerMs: 20 } });
  for (let i = 0; i < 20; i++) await f.hold("c", i, `x${i}`);
  const b = f.ticket("b", "c/b");
  await f.executor.run(b);
  assert.deepEqual(f.holds(execOf(b)), ["c"]);
});

test("a freed provider slot is not held back for a waiter (with precedence) whose own model is still full", { timeout: 15000 }, async t => {
  // A long tracker period: waiters attempt again only when woken, so a wrong yield would stall the fresh call.
  const f = await fixture(t, { providers: { c: { slots: 2, models: { b: { slots: 1 } } } }, k: { trackerMs: 60000 } });
  await f.hold("c", 0, "x"); await f.hold("c/b", 0, "x"); await f.hold("c", 1, "y");
  const resume = f.ticket("r", "c/b"), fresh = f.ticket("f", "c/a");
  await ranBefore(f.journal, resume);
  const runs = [f.executor.run(resume)];
  await until(() => f.attempted(execOf(resume, 2)) > 0);
  assert.deepEqual(f.attempts.find(([e]) => e === execOf(resume, 2))![1], ["c", "c/b"]);
  runs.push(f.executor.run(fresh));
  await until(() => f.attempted(execOf(fresh)) > 0);
  await f.release("c", 1, "y");
  await runs[1];
  assert.deepEqual(f.holds(execOf(fresh)), ["c"], "the fresh call took the freed provider slot");
  assert.equal(f.selected(execOf(resume, 2)), undefined, "the resumed call still waits for its model");
  await f.executor.stop({ wid: resume.wid, callId: resume.callId });
  await runs[0];
});

test("a freed model slot is not given to a waiter of a different model blocked by its own limit", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { slots: 5, models: { a: { slots: 1 }, b: { slots: 1 } } } }, k: { trackerMs: 60000 } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x"); await f.hold("c", 1, "z"); await f.hold("c/b", 0, "z");
  const resume = f.ticket("r", "c/b"), fresh = f.ticket("f", "c/a");
  await ranBefore(f.journal, resume);
  const runs = [f.executor.run(resume)];
  await until(() => f.attempted(execOf(resume, 2)) > 0);
  runs.push(f.executor.run(fresh));
  await until(() => f.attempted(execOf(fresh)) > 0);
  assert.deepEqual(f.attempts.find(([e]) => e === execOf(fresh))![1], ["c/a"]);
  await f.release("c/a", 0, "x"); await f.release("c", 0, "x");
  await runs[1];
  assert.deepEqual(f.holds(execOf(fresh)), ["c", "c/a"]);
  assert.equal(f.selected(execOf(resume, 2)), undefined);
  await f.executor.stop({ wid: resume.wid, callId: resume.callId });
  await runs[0];
});

test("among waiters of the same model the existing precedence decides: the resumed call takes the freed model slot", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { slots: 5, models: { a: { slots: 1 } } } }, k: { trackerMs: 60000 } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const fresh = f.ticket("f", "c/a"), resume = f.ticket("r", "c/a");
  await ranBefore(f.journal, resume);
  // The fresh call waits longer and attempts first.
  const runs = [f.executor.run(fresh)];
  await until(() => f.attempted(execOf(fresh)) > 0);
  runs.push(f.executor.run(resume));
  await until(() => f.attempted(execOf(resume, 2)) > 0);
  await f.release("c/a", 0, "x");
  await Promise.all(runs);
  const order = f.orch.entries().filter(e => e.type === "hold" && e.pool === "c/a" && e.exec !== "x").map(e => String(e.exec));
  assert.deepEqual(order, [execOf(resume, 2), execOf(fresh)]);
});

test("a call's model slot is released with its provider slot when it ends", { timeout: 15000 }, async t => {
  const f = await fixture(t, { providers: { c: { slots: 5, models: { a: { slots: 1 } } } }, k: { trackerMs: 20 } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const call = f.ticket("q", "c/a");
  const run = f.executor.run(call);
  await until(() => f.attempted(execOf(call)) > 0);
  await f.release("c/a", 0, "x");
  await run;
  assert.deepEqual(f.holds(execOf(call)), ["c", "c/a"]);
  const mine = f.orch.entries().filter(e => e.exec === execOf(call) && e.pool !== "memory");
  assert.deepEqual(mine.filter(e => e.type === "release").map(e => e.pool).sort(), ["c", "c/a"]);
});

test("a resumed pool call held back by its model: status names the model; free lists providers whose candidate has room", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { pool: ["c/a", "d/a", "e/a"] }, providers: { c: { slots: 5, models: { a: { slots: 1 } } }, d: { slots: 5, models: { a: { slots: 0 } } }, e: { slots: 1 } },
    k: { trackerMs: 20, resumeSpillMs: null } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const ticket = f.ticket("a", "pool");
  await f.journal.append("call", { key: ticket.key, gen: 1, spec: ticket.spec });
  await ranBefore(f.journal, ticket);
  await mkdir(callDir(f.home, ticket.wid, ticket.key, 1), { recursive: true });
  await writeFile(callSession(f.home, ticket.wid, ticket.key, 1), [
    { type: "custom", customType: CT.exec, data: { exec: `${ticket.callId}#1.1` } },
    { type: "model_change", provider: "c", modelId: "a" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  const run = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "slot-wait" && e.model));
  const snap = workflowSnapshot(f.home, f.wid), wait = snap.calls[0]!.poolWait!;
  assert.equal(wait.blocker, "c/a");
  assert.deepEqual(wait.free, ["e"], "d has room but its candidate model does not");
  assert.match(renderStatus(snap), /queued .* on c\/a \(full\); pool has free slots: e/);
  await f.release("c/a", 0, "x");
  await run;
  assert.deepEqual(f.selected(execOf(ticket, 2)), { provider: "c", id: "a" });
});

test("a resumed pool call whose model is full spills to the same model id on another provider with room", { timeout: 15000 }, async t => {
  const f = await fixture(t, { pools: { pool: ["c/a", "d/b", "d/a"] }, providers: { c: { slots: 5, models: { a: { slots: 1 } } }, d: { slots: 5 } }, k: { trackerMs: 10, resumeSpillMs: 0 } });
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const ticket = f.ticket("a", "pool");
  await f.journal.append("call", { key: ticket.key, gen: 1, spec: ticket.spec });
  await ranBefore(f.journal, ticket);
  await mkdir(callDir(f.home, ticket.wid, ticket.key, 1), { recursive: true });
  await writeFile(callSession(f.home, ticket.wid, ticket.key, 1), [
    { type: "custom", customType: CT.exec, data: { exec: `${ticket.callId}#1.1` } },
    { type: "model_change", provider: "c", modelId: "a" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  await f.executor.run(ticket);
  assert.ok(f.journal.entries().some(e => e.type === "spilled"));
  assert.deepEqual(f.selected(execOf(ticket, 2)), { provider: "d", id: "a" });
});

test("a reloaded model limit applies at the next acquisition; slots held over a lowered limit are kept", { timeout: 15000 }, async t => {
  const config: OrchestratorConfig = { providers: { c: { slots: 5, models: { a: { slots: 0 } } } }, k: { trackerMs: 20 } };
  const f = await fixture(t, config);
  await f.hold("c", 0, "x"); await f.hold("c/a", 0, "x");
  const call = f.ticket("a", "c/a");
  const run = f.executor.run(call);
  await until(() => f.attempted(execOf(call)) > 1);
  await f.executor.reconfigure!(async () => { await f.orch.append("config", { hash: "up", config: { writerLock: "off", providers: { c: { slots: 5, models: { a: { slots: 2 } } } } } }); });
  await run;
  assert.deepEqual(f.holds(execOf(call)), ["c", "c/a"]);
  assert.ok(!f.orch.entries().some(e => e.type === "release" && e.exec === "x"), "x keeps the slot it held over the old limit");
});
