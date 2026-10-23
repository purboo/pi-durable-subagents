// Command calls at the executor (constructed cuts): a stop during the loss scan, an exit seen after the deadline, and an
// attempt whose started record is missing. Real processes, an isolated home per test, no pi.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tempRoot } from "../../harness/pi.ts";
import { callDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { JT, type CallResult, type CallSpec, type Containment, type JournalHandle } from "../../../src/types.ts";
import type { CallTicket } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { serialContainment } from "../../../src/orchestrator/executor/sweep.ts";
import { Containment as PlatformContainment } from "../../../src/platform/containment.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { spawnCommand } from "../../../src/platform/command.ts";

const agent = { name: "", description: "", body: "", sourcePath: "", source: "project" as const, systemPromptMode: "append" as const, inheritProjectContext: false, inheritSkills: false };
async function setup(t: TestContext, onScan?: (ids: string[], found: number) => Promise<void>) {
  const root = tempRoot("dsa-exec-cmd-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const orch = await openJournal(orchLedger(home)), wid = ulid(), journal: JournalHandle = await openJournal(journalPath(home, wid));
  const real = serialContainment();
  const containment: Containment = {
    spawn: spec => real.spawn(spec), fence: (exec, tracked, opts) => real.fence(exec, tracked, opts),
    async scan(known, options) {
      const result = await real.scan(known, options);
      await onScan?.([...known.keys()], [...known.keys()].reduce((n, id) => n + (result.get(id)?.length ?? 0), 0));
      return result;
    },
  };
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 100 } } }, { containment });
  const ticket = (spec: Partial<CallSpec>, key = "a"): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd, journal, spec: spec as CallSpec, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      for (const e of journal.entries().filter(e => e.type === "command-intent")) await new PlatformContainment().fence(String(e.id), []).catch(() => {});
      await journal.close(); await orch.close();
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });
  return { home, wid, cwd, journal, executor, ticket };
}
const tagged = async (id: string) => (await new ProcessTable().list(new Set([id]), { fresh: true })).filter(p => p.tag === id);
async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(25); }
}

test("C-stop-rerun: a stop recorded during attempt 1's loss scan starts no rerun and seals stopped", { timeout: 60_000 }, async t => {
  let armed = false, stopped = false;
  const f = await setup(t, async (ids, found) => {
    // The scan that finds attempt 1 gone: the stop is recorded while it runs (before the rerun's intent).
    if (armed && !stopped && found === 0 && ids.some(id => id.endsWith("#1"))) { stopped = true; await f.journal.append("stop-intent", { call: call.callId }); }
  });
  const call = f.ticket({ command: "sleep 30", rerun: true });
  const run = f.executor.run(call);
  const started = await until(() => f.journal.entries().find(e => e.type === "command-started"), "started");
  await until(async () => (await tagged(String(started.id))).length > 0, "tagged");
  armed = true;
  await new PlatformContainment().fence(String(started.id), []);
  const result = await run;
  assert.ok(stopped, "the hook ran");
  assert.equal(result.status, "stopped", JSON.stringify(result));
  const entries = f.journal.entries();
  assert.deepEqual(entries.filter(e => e.type === "command-intent").map(e => e.n), [1], "no attempt-2 intent");
  assert.equal(entries.filter(e => e.type === "command-started").length, 1, "no second process");
  assert.deepEqual(await tagged(String(started.id).replace(/#1$/, "#2")), []);
});

test("C-late-exit: an exit recorded after the deadline seals timeout (data from the record); one before it seals ok", { timeout: 60_000 }, async t => {
  const f = await setup(t);
  // The orchestrator is down: the attempt is recorded and its process runs; a start adopts it only after it ended.
  const adopt = async (key: string, timeoutMs: number) => {
    const call = f.ticket({ command: "sleep 1", timeoutMs }, key), id = `command:${call.callId}#1`, dir = join(callDir(f.home, f.wid, key, 1), "command-1");
    await f.journal.append("command-intent", { call: call.callId, id, n: 1 });
    const spawned = await spawnCommand({ command: ["sh", "-c", "sleep 1"], cwd: f.cwd, dir, env: { ...process.env, DSA_EXEC: id } });
    await f.journal.append("command-started", { call: call.callId, id, pid: spawned.pid, start: spawned.start, dir });
    await until(() => existsSync(join(dir, "exit")), "exit record");
    await delay(100);
    return f.executor.run(call);
  };
  const late = await adopt("late", 500);
  assert.equal(late.status, "timeout", JSON.stringify(late));
  assert.equal(late.error, "Command timed out after 500 ms");
  assert.equal((late.data as { exitCode: number }).exitCode, 0);
  const inTime = await adopt("in-time", 5000);
  assert.equal(inTime.status, "ok", JSON.stringify(inTime));
});

test("C-no-started: a live tagged attempt with no started record is held to its deadline from the intent", { timeout: 60_000, skip: process.platform === "win32" ? "asserts the inherited DSA_EXEC tag; Windows finds a process by its tree" : false }, async t => {
  const f = await setup(t);
  const call = f.ticket({ command: "sleep 30", timeoutMs: 1000 }), id = `command:${call.callId}#1`, dir = join(callDir(f.home, f.wid, "a", 1), "command-1");
  // The crash cut: the intent and the process, no command-started.
  await f.journal.append("command-intent", { call: call.callId, id, n: 1 });
  await spawnCommand({ command: ["sh", "-c", "sleep 30"], cwd: f.cwd, dir, env: { ...process.env, DSA_EXEC: id } });
  await until(async () => (await tagged(id)).length > 0, "tagged");
  const began = Date.now();
  const result: CallResult = await f.executor.run(call);
  assert.equal(result.status, "timeout", JSON.stringify(result));
  assert.ok(Date.now() - began < 10_000);
  assert.deepEqual(await tagged(id), []);
  assert.ok(!f.journal.entries().some(e => e.type === JT.sealed && (e.result as CallResult).status !== "timeout"));
});

test("F3: a stop recorded while the spawn prepares (its mkdir) starts no process and seals stopped", { timeout: 60_000, skip: process.platform === "win32" ? "injects a synchronous mkdir hook; Windows command spawn prep differs" : false }, async t => {
  const fs = (await import("node:fs/promises")).default, { syncBuiltinESMExports } = await import("node:module");
  const f = await setup(t);
  const call = f.ticket({ command: "echo side-effect > marker" }), mkdirReal = fs.mkdir;
  let injected = false;
  fs.mkdir = (async (...args: Parameters<typeof mkdirReal>) => {
    if (!injected && String(args[0]).endsWith("/command-1")) { injected = true; await f.journal.append("stop-intent", { call: call.callId }); }
    return mkdirReal(...args);
  }) as typeof mkdirReal;
  syncBuiltinESMExports();
  let result: CallResult;
  try { result = await f.executor.run(call); } finally { fs.mkdir = mkdirReal; syncBuiltinESMExports(); }
  assert.ok(injected, "the stop was recorded during the mkdir");
  assert.equal(result.status, "stopped", JSON.stringify(result));
  assert.ok(!f.journal.entries().some(e => e.type === "command-started"), "no command-started");
  await delay(300);
  assert.ok(!existsSync(join(f.cwd, "marker")), "no side effect");
});
