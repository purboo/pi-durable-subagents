// Command lifetime recovery at the executor, narrowly: the cut between a recorded `command-intent` and its
// `command-started` record. A successor finds the intent, the attempt (or the job helper that will run it) is still live,
// and nothing may start a second attempt -- not when the helper is still compiling, not when the process table fails for
// a moment. Distinct from the crash-cut checks of command.test.ts, which run with the start record's identity.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { commandEnvironment } from "../../../src/orchestrator/executor/command.ts";
import { spawnCommand, type SpawnedCommand } from "../../../src/platform/command.ts";
import { captureStart } from "../../../src/platform/proctable.ts";

const agent = { name: "", description: "", body: "", sourcePath: "", source: "project" as const, systemPromptMode: "append" as const, inheritProjectContext: false, inheritSkills: false };
/** An executor over one workflow journal; `containment` may wrap the real one (to fail a scan on purpose). */
async function setup(t: TestContext, containment?: (real: Containment) => Containment) {
  const root = tempRoot("dsa-cmd-recovery-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const orch = await openJournal(orchLedger(home)), wid = ulid(), journal: JournalHandle = await openJournal(journalPath(home, wid));
  const real = serialContainment();
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 100 } } }, { containment: containment?.(real) ?? real });
  const ticket = (spec: Partial<CallSpec>): CallTicket => ({ wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd, journal, spec: spec as CallSpec, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      for (const e of journal.entries().filter(e => e.type === "command-intent")) await new PlatformContainment().fence(String(e.id), []).catch(() => {});
      await journal.close(); await orch.close();
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });
  return { home, wid, cwd, journal, executor, ticket };
}
async function until<T>(get: () => Promise<T | undefined> | T | undefined, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (v !== undefined) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(25); }
}
/** A command that records that it acted, then runs long enough for the executor to adopt it while it is live. */
function acting(marker: string): string[] {
  return [process.execPath, "-e",
    `const { appendFileSync } = require("node:fs"); appendFileSync(${JSON.stringify(marker)}, "run\\n"); setTimeout(() => {}, 1200);`];
}
const runs = (marker: string) => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;

/** The cut: the intent is durable, the attempt is live, and `command-started` was never written (the orchestrator died in
 *  between). Nothing records the wrapper's identity, so only the attempt's tag can prove that it may still act. */
async function cut(f: Awaited<ReturnType<typeof setup>>, command: string[], key = "a"): Promise<{ call: string; id: string; dir: string; spawned: SpawnedCommand }> {
  const call = f.ticket({ command, rerun: true }), id = `command:${call.callId}#1`, dir = join(callDir(f.home, f.wid, key, 1), "command-1");
  await f.journal.append("command-intent", { call: call.callId, id, n: 1 });
  const spawned = await spawnCommand({ command, cwd: f.cwd, dir, env: commandEnvironment(f.home, id, call.callId), exec: id });
  return { call: call.callId, id, dir, spawned };
}

test("recovery before command-started: a live intent-only attempt runs once and is never started over", { timeout: 90_000 }, async t => {
  const f = await setup(t);
  const marker = join(f.cwd, "ran.log"), command = acting(marker);
  const { id, spawned } = await cut(f, command);
  await until(() => runs(marker) > 0, "the first attempt acts");
  // The successor adopts the call with `rerun: true`: a loss found here would start attempt 2 next to a live attempt 1.
  const result: CallResult = await f.executor.run(f.ticket({ command, rerun: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  const entries = f.journal.entries();
  assert.deepEqual(entries.filter(e => e.type === "command-intent").map(e => e.n), [1], "no attempt 2 (the first attempt was not called gone)");
  assert.ok(!entries.some(e => e.type === "command-started"), "the adopted attempt stays identified by its intent and tag");
  assert.equal(runs(marker), 1, "the command acted exactly once");
  assert.ok(spawned.pid > 0, "the adopted attempt had a live wrapper");
  assert.equal(entries.filter(e => e.type === "sealed").length, 1);
  assert.deepEqual(entries.find(e => e.type === "sealed")?.result, result);
});

test("a transient scan failure is not a loss: the attempt is watched again, not restarted", { timeout: 90_000 }, async t => {
  let failures = 3;
  const f = await setup(t, real => ({
    spawn: spec => real.spawn(spec), fence: (exec, tracked, opts) => real.fence(exec, tracked, opts),
    async scan(known, options) {
      // The observer fails for the adopted attempt only; the failure must never read as "no process left".
      if ([...known.keys()].some(id => id.endsWith("#1")) && failures > 0) { failures--; throw new Error("cim unavailable"); }
      return real.scan(known, options);
    },
  }));
  const marker = join(f.cwd, "ran.log"), command = acting(marker);
  await cut(f, command);
  await until(() => runs(marker) > 0, "the first attempt acts");
  const result: CallResult = await f.executor.run(f.ticket({ command, rerun: true }));
  assert.equal(failures, 0, "the scan failed while the attempt was watched");
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(f.journal.entries().filter(e => e.type === "command-intent").map(e => e.n), [1], "no attempt 2");
  assert.equal(runs(marker), 1, "the command acted exactly once");
});

test("a stop during an unobserved attempt ends it and seals stopped, with no second start", { timeout: 90_000 }, async t => {
  // The scan cannot answer for the attempt at all: a stop must still end the tag-identified tree, and the call must never
  // reach the rerun decision (which a scan could not justify either).
  let broken = true;
  const f = await setup(t, real => ({
    spawn: spec => real.spawn(spec), fence: (exec, tracked, opts) => real.fence(exec, tracked, opts),
    async scan(known, options) {
      if (broken && [...known.keys()].some(id => id.endsWith("#1"))) throw new Error("cim unavailable");
      return real.scan(known, options);
    },
  }));
  const marker = join(f.cwd, "ran.log"), command = acting(marker);
  const { call } = await cut(f, command);
  await until(() => runs(marker) > 0, "the first attempt acts");
  const run = f.executor.run(f.ticket({ command, rerun: true }));
  await delay(300);
  await f.journal.append("stop-intent", { call });
  broken = false;
  const result: CallResult = await run;
  assert.equal(result.status, "stopped", JSON.stringify(result));
  assert.deepEqual(f.journal.entries().filter(e => e.type === "command-intent").map(e => e.n), [1], "no attempt 2");
  assert.equal(runs(marker), 1, "the command acted exactly once");
});

test("recovery before command-started: the compile window (a tag, no group record, no exit record) is watched, not raced", { timeout: 90_000 }, async t => {
  const f = await setup(t);
  const marker = join(f.cwd, "ran.log"), command = acting(marker);
  const call = f.ticket({ command, rerun: true }), id = `command:${call.callId}#1`, dir = join(callDir(f.home, f.wid, "a", 1), "command-1");
  await mkdirSync(dir, { recursive: true });
  await f.journal.append("command-intent", { call: call.callId, id, n: 1 });
  // The shape a successor sees while the Windows helper is still compiling: one process carrying the attempt's tag, no
  // group record, no wrapper, no exit record. Its end is what may let another start; its life must never overlap one.
  const helper = join(f.cwd, "helper.mjs");
  writeFileSync(helper, `import { appendFileSync } from "node:fs";\nsetTimeout(() => appendFileSync(${JSON.stringify(marker)}, "helper-end\\n"), 700);\n`);
  const run = spawn(process.execPath, [helper, `DSA_EXEC=${id}`], { stdio: "ignore", env: { ...process.env, DSA_EXEC: id } });
  t.after(() => { try { process.kill(run.pid!, "SIGKILL"); } catch { /* ended */ } });
  await until(async () => (await captureStart(run.pid!)) !== "", "the tagged attempt to start");
  const result: CallResult = await f.executor.run(f.ticket({ command, rerun: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  // The rerun is allowed only after the tagged attempt ended: its action must not interleave with the first one's.
  assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), ["helper-end", "run"], "attempt 2 acted before attempt 1 ended");
  assert.deepEqual(f.journal.entries().filter(e => e.type === "command-intent").map(e => e.n), [1, 2], "exactly one rerun, after the first attempt retired");
});
