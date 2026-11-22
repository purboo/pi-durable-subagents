// Command starts at the executor, narrowly: the expensive part of a Windows start (compiling the job host) is staged
// BEFORE the attempt's durable intent. A cut inside that preparation therefore left no intent and nothing that can act --
// it is unambiguously prelaunch: a stop seals stopped, a retirement or the orchestrator's exit records nothing at all, and
// a later run starts attempt 1 as if nothing had happened. An interrupted preparation is never a failure of the attempt
// (no command-spawn-failed, no failed seal), while a preparation that fails for its own reason stays fail-closed.
// The preparation is exercised through the executor's seam: no Windows compiler exists on this host, and a real
// compilation would not be interruptible deterministically. Real processes, an isolated home per test, no pi.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tempRoot } from "../../harness/pi.ts";
import { callDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { type CallResult, type CallSpec, type Containment, type JournalHandle } from "../../../src/types.ts";
import type { CallTicket } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { serialContainment } from "../../../src/orchestrator/executor/sweep.ts";
import { Containment as PlatformContainment } from "../../../src/platform/containment.ts";
import type { CommandPrep, CommandSpawn } from "../../../src/platform/command.ts";
import { JobPrepareCancelled } from "../../../src/platform/job.ts";

const agent = { name: "", description: "", body: "", sourcePath: "", source: "project" as const, systemPromptMode: "append" as const, inheritProjectContext: false, inheritSkills: false };

/** A start's pre-intent preparation, held open: the journal can be read while it runs, and what cancels a real compilation
 *  (the start's `signal`) cancels it here too. `cancels: false` is a compilation that rides through the abort and finishes
 *  anyway, so only the check after it can refuse the intent. */
function heldPrepare(options: { cancels?: boolean } = {}) {
  const cancels = options.cancels ?? true;
  const state = { started: 0, released: 0, aborted: 0, finishes: [] as (() => void)[] };
  const prepare = async (spec: CommandSpawn): Promise<CommandPrep | undefined> => {
    state.started += 1;
    await new Promise<void>((resolve, reject) => {
      const signal = spec.signal;
      const onAbort = () => {
        state.aborted += 1;
        if (cancels) { state.released += 1; reject(new JobPrepareCancelled()); } // a cancelled compiler is removed by itself
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      state.finishes.push(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
    });
    return { host: { dir: join(spec.dir, "stub-host"), exe: join(spec.dir, "stub-host", "DsaJob.exe"), source: "" },
      dir: spec.dir, release: async () => { state.released += 1; } };
  };
  return { prepare, state, finish: () => { for (const fn of state.finishes.splice(0)) fn(); } };
}

async function setup(t: TestContext, prepareCommand?: (spec: CommandSpawn) => Promise<CommandPrep | undefined>) {
  const root = tempRoot("dsa-exec-cmd-stage-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const orch = await openJournal(orchLedger(home)), wid = ulid(), journal: JournalHandle = await openJournal(journalPath(home, wid));
  const containment: Containment = serialContainment();
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 100 } } },
    { containment, ...(prepareCommand ? { prepareCommand } : {}) });
  const ticket = (spec: Partial<CallSpec>, key = "a"): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd, journal, spec: spec as CallSpec, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      for (const e of journal.entries().filter(e => e.type === "command-intent")) await new PlatformContainment().fence(String(e.id), []).catch(() => {});
      await journal.close(); await orch.close();
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });
  return { root, home, orch, wid, cwd, journal, executor, ticket };
}
async function until<T>(get: () => T | false | undefined | Promise<T | false | undefined>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await get(); if (value) return value; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(25); }
}
/** A command that records that it acted: it must never act when its start was refused before the intent. */
const acting = (marker: string) => [process.execPath, "-e",
  `const { appendFileSync } = require("node:fs"); appendFileSync(${JSON.stringify(marker)}, "run\\n"); setTimeout(() => {}, 300);`];
const runs = (marker: string) => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
const intents = (journal: JournalHandle) => journal.entries().filter(e => e.type === "command-intent").map(e => Number(e.n));

test("the preparation runs before the durable intent: the journal shows no attempt while it is in flight", { timeout: 60_000 }, async t => {
  const held = heldPrepare();
  const f = await setup(t, held.prepare);
  const marker = join(f.cwd, "ran.log");
  const run = f.executor.run(f.ticket({ command: acting(marker) }));
  await until(() => held.state.started > 0, "the preparation to run");
  const during = f.journal.entries();
  assert.ok(!during.some(e => e.type === "command-intent"), "no intent is recorded while the start is prepared");
  assert.ok(!during.some(e => e.type === "command-started"), "no process exists while the start is prepared");
  assert.ok(!existsSync(join(callDir(f.home, f.wid, "a", 1), "command-1", "output.log")), "nothing of the attempt was opened");
  held.finish();
  const result = await run;
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(intents(f.journal), [1], "the intent follows the preparation, once");
  assert.equal(f.journal.entries().filter(e => e.type === "command-started").length, 1);
  assert.equal(runs(marker), 1, "the command acted exactly once");
});

test("a stop during the preparation starts nothing, seals stopped and never records a spawn failure", { timeout: 60_000 }, async t => {
  const held = heldPrepare();
  const f = await setup(t, held.prepare);
  const marker = join(f.cwd, "ran.log");
  const call = f.ticket({ command: acting(marker) });
  const run = f.executor.run(call);
  await until(() => held.state.started > 0, "the preparation to run");
  await f.executor.stop({ wid: f.wid, callId: call.callId });
  const result = await run;
  assert.equal(result.status, "stopped", JSON.stringify(result));
  const entries = f.journal.entries();
  assert.deepEqual(intents(f.journal), [], "a stopped start records no intent");
  assert.ok(!entries.some(e => e.type === "command-started" || e.type === "command-spawn-failed"), "no process, no spawn failure");
  assert.equal(held.state.aborted, 1, "the compilation was cancelled, not left running");
  assert.equal(held.state.released, 1, "what the cancelled compilation wrote is released");
  await delay(300);
  assert.equal(runs(marker), 0, "the command never acted");
  assert.equal(entries.filter(e => e.type === "sealed").length, 1, "the call is sealed once, stopped");
});

test("a stop that arrives while the preparation's last step runs is honoured before the intent, and the stage is released", { timeout: 60_000 }, async t => {
  // A compilation that finishes anyway (its abort cannot cut it short): only the check after it can keep the intent
  // unrecorded, and what it staged must not be left behind.
  const held = heldPrepare({ cancels: false });
  const f = await setup(t, held.prepare);
  const marker = join(f.cwd, "ran.log");
  const call = f.ticket({ command: acting(marker) });
  const run = f.executor.run(call);
  await until(() => held.state.started > 0, "the preparation to run");
  // The stop is decided while the compilation still runs on; its promise settles only with the call itself.
  const stopping = f.executor.stop({ wid: f.wid, callId: call.callId });
  await until(() => held.state.aborted > 0, "the stop to reach the preparation");
  held.finish();
  const result = await run;
  await stopping;
  assert.equal(result.status, "stopped", JSON.stringify(result));
  assert.deepEqual(intents(f.journal), [], "no intent follows a stop decided before it");
  assert.equal(held.state.released, 1, "the completed stage is released (nothing started with it)");
  await delay(300);
  assert.equal(runs(marker), 0, "the command never acted");
});

test("the orchestrator's exit during the preparation records nothing, and recovery starts attempt 1 exactly once", { timeout: 90_000 }, async t => {
  const held = heldPrepare();
  const f = await setup(t, held.prepare);
  const marker = join(f.cwd, "ran.log");
  const call = f.ticket({ command: acting(marker), rerun: true });
  const run = f.executor.run(call);
  await until(() => held.state.started > 0, "the preparation to run");
  await f.executor.shutdown(); // the orchestrator ends while the compiler runs
  await assert.rejects(run, (error: Error) => error.name === "ExecutorShutdown");
  assert.equal(held.state.released, 1, "the cancelled compilation is released");
  let entries = f.journal.entries();
  assert.deepEqual(intents(f.journal), [], "the cut recorded no attempt");
  assert.ok(!entries.some(e => e.type === "sealed" || e.type === "command-spawn-failed" || e.type === "command-withdrawn"),
    "an interrupted preparation seals nothing: it is not a permanent failure");
  // The successor finds a call that never started -- unambiguously prelaunch, so attempt 1, not a rerun and not unknown.
  const successor = createExecutor({ home: f.home, orch: f.orch, config: { k: { trackerMs: 100 } } }, { containment: serialContainment() });
  t.after(() => successor.shutdown());
  const result = await successor.run(f.ticket({ command: acting(marker), rerun: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  entries = f.journal.entries();
  assert.deepEqual(intents(f.journal), [1], "attempt 1, once");
  assert.equal(entries.filter(e => e.type === "command-started").length, 1);
  assert.equal(entries.filter(e => e.type === "sealed").length, 1);
  assert.equal(runs(marker), 1, "the command acted exactly once");
});

test("a retirement during the preparation ends the run with nothing of the attempt recorded", { timeout: 60_000 }, async t => {
  const held = heldPrepare();
  const f = await setup(t, held.prepare);
  const marker = join(f.cwd, "ran.log");
  const call = f.ticket({ command: acting(marker) });
  const run = f.executor.run(call);
  await until(() => held.state.started > 0, "the preparation to run");
  await f.executor.retire(`${f.wid}@1`);
  const result: CallResult = await run;
  assert.equal(result.status, "stopped", JSON.stringify(result));
  assert.equal(result.error, "retired");
  const entries = f.journal.entries();
  assert.deepEqual(intents(f.journal), [], "a retired start records no intent");
  assert.ok(!entries.some(e => e.type === "command-started" || e.type === "command-spawn-failed"), "nothing started, nothing failed");
  assert.equal(held.state.released, 1, "the cancelled compilation is released");
  await delay(300);
  assert.equal(runs(marker), 0, "the command never acted");
});

test("a preparation that fails for its own reason stays fail-closed: the attempt seals failed and records no intent", { timeout: 60_000 }, async t => {
  const f = await setup(t, async () => { throw new Error("the Windows .NET Framework C# compiler is unavailable (searched C:\\Windows)"); });
  const marker = join(f.cwd, "ran.log");
  const result = await f.executor.run(f.ticket({ command: acting(marker) }));
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.match(String(result.error), /^Command could not start: the Windows \.NET Framework C# compiler is unavailable/);
  assert.deepEqual(intents(f.journal), [], "a failure before the intent records none");
  await delay(300);
  assert.equal(runs(marker), 0, "the command never acted");
});

test("an intent an earlier version wrote while it compiled keeps its ambiguous handling: unknown, never silently rerun", { timeout: 60_000 }, async t => {
  // Before the preparation moved ahead of the intent, the compilation ran after `command-intent`: a journal cut there has
  // an intent, no start record and no process. That cut stays ambiguous (it cannot be told from one whose process ran and
  // left no record), so it is watched, found lost and sealed unknown -- never reinterpreted as prelaunch and rerun.
  const f = await setup(t);
  const marker = join(f.cwd, "ran.log");
  const call = f.ticket({ command: acting(marker) }), id = `command:${call.callId}#1`;
  await mkdir(join(callDir(f.home, f.wid, "a", 1), "command-1"), { recursive: true });
  await f.journal.append("command-intent", { call: call.callId, id, n: 1 });
  const result = await f.executor.run(f.ticket({ command: acting(marker) }));
  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.deepEqual(intents(f.journal), [1], "no attempt was started over it");
  assert.ok(!f.journal.entries().some(e => e.type === "command-started"), "nothing was started");
  assert.equal(runs(marker), 0, "nothing ran");
});
