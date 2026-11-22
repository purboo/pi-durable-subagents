// Regression coverage for Windows Containment.fence end-to-end deadline (F1):
// - Bounds `beforeKill` diagnostics and verified kill batches (`KILL_BATCH_SIZE`) to the remaining fence deadline,
//   aborts in-flight work, and never starts kills or later batches after the deadline.
// - Ensures deadline expiry during diagnostics or verified kills rejects with `Fence timeout` carrying phase/counts
//   and drives downstream F1 (`fence-failed` + `unknown` attention item, parked until a sweep proves retirement).
// - Preserves immediate propagation and existing downstream non-timeout policy for genuine Win32 refusals/errors.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { Containment } from "../../../src/platform/containment.ts";
import {
  KILL_BATCH_SIZE,
  killProcess,
  killTree,
  type WinProcessIdentity,
} from "../../../src/platform/windows.ts";
import type { CallTicket } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { fenceAgent } from "../../../src/orchestrator/executor/ended.ts";
import { recoverGates } from "../../../src/orchestrator/executor/effects/gate.ts";
import { CT, JT, type Entry, type ProcInfo } from "../../../src/types.ts";

const T_HOST = "639000000500000000";
const T_CHILD_BASE = 639000000550000000n;

function makeTargets(count: number): ProcInfo[] {
  const rows: ProcInfo[] = [{ pid: 6400, ppid: 4212, start: T_HOST }];
  for (let i = 1; i < count; i++) {
    rows.push({ pid: 6400 + i, ppid: 6400, start: String(T_CHILD_BASE + BigInt(i * 100)) });
  }
  return rows;
}

async function tempHome(t: TestContext): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-win-fence-budget-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("Windows fence: beforeKill exhausting the fence deadline aborts diagnostics and issues no kill after deadline", { timeout: 10000 }, async () => {
  const exec = "01WINBUDGET@1/a@1#1.1";
  const rows = makeTargets(2);
  const killCalls: WinProcessIdentity[][] = [];
  let diagSignalAborted = false;
  let diagAbortedAt = 0;

  const containment = new Containment({
    list: async () => rows,
  }, {
    platform: "win32",
    killWindows: async targets => {
      killCalls.push(targets.map(t => ({ ...t })));
    },
  });

  const started = performance.now();
  await assert.rejects(
    containment.fence(exec, [rows[0]!], {
      timeoutMs: 60,
      beforeKill: async (_targets, signal) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            diagSignalAborted = true;
            diagAbortedAt = performance.now() - started;
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      },
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /^Fence timeout: 01WINBUDGET@1\/a@1#1\.1 after \d+ ms of 60 ms \(1 scan\(s\) completed, slowest \d+ ms, 2 process\(es\) at the last scan, 0 kill\(s\), 0 skipped for an unconfirmed identity; waiting on the beforeKill diagnostics\)$/,
      );
      return true;
    },
  );
  const elapsed = performance.now() - started;
  assert.equal(diagSignalAborted, true, "beforeKill signal is aborted when the fence deadline expires");
  assert.ok(diagAbortedAt < 350, `beforeKill aborted near the 60 ms deadline instead of waiting 500 ms (got ${Math.round(diagAbortedAt)} ms)`);
  assert.ok(elapsed < 350, `fence rejected promptly at its deadline (got ${Math.round(elapsed)} ms)`);
  assert.equal(killCalls.length, 0, "no Windows kill is started once beforeKill exhausts the fence deadline");

  // Complementary check: when beforeKill hits only its 500 ms diagnostic sub-cap while fence budget remains,
  // diagnostics are aborted and verified termination still runs and proves retirement within the remaining budget.
  let alive = true;
  let subCapAborted = false;
  const retiring = new Containment({
    list: async () => alive ? rows : [],
  }, {
    platform: "win32",
    killWindows: async targets => {
      killCalls.push(targets.map(t => ({ ...t })));
      alive = false;
    },
  });
  await retiring.fence(exec, [rows[0]!], {
    timeoutMs: 1200,
    beforeKill: async (_targets, signal) => {
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => { subCapAborted = true; resolve(); }, { once: true });
      });
    },
  });
  assert.equal(subCapAborted, true, "500 ms diagnostic sub-cap still aborts slow beforeKill");
  assert.equal(killCalls.length, 1, "kill runs when fence deadline still has remaining budget");
  assert.equal(killCalls[0]!.length, 2);
});

test("Windows fence and killTree: verified kill batches bound to remaining budget, abort in-flight work and skip later batches", { timeout: 10000 }, async () => {
  const exec = "01WINBATCH@1/b@1#1.1";
  const totalTargets = KILL_BATCH_SIZE * 2 + 12; // 3 batches: 128, 128, 12
  const rows = makeTargets(totalTargets);
  const observedBatches: { count: number; timeout: number | undefined }[] = [];
  let secondBatchAborted = false;

  const containment = new Containment({
    list: async () => rows,
  }, {
    platform: "win32",
    killWindows: (targets, opts) => killTree(targets, {
      ...opts,
      platform: "win32",
      run: async (script, runOpts) => {
        const count = (script.match(/\d+:639\d+/g) ?? []).length;
        observedBatches.push({ count, timeout: runOpts.timeout });
        if (observedBatches.length === 1) {
          await delay(35);
          return "";
        }
        await new Promise<void>((_, reject) => {
          runOpts.signal?.addEventListener("abort", () => {
            secondBatchAborted = true;
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
        return "";
      },
    }),
  });

  const started = performance.now();
  await assert.rejects(
    containment.fence(exec, [rows[0]!], { timeoutMs: 95 }),
    (error: Error) => {
      assert.match(
        error.message,
        new RegExp(`^Fence timeout: 01WINBATCH@1/b@1#1\\.1 after \\d+ ms of 95 ms \\(1 scan\\(s\\) completed, slowest \\d+ ms, ${totalTargets} process\\(es\\) at the last scan, ${KILL_BATCH_SIZE * 2} kill\\(s\\), 0 skipped for an unconfirmed identity; waiting on the kill\\)$`),
      );
      return true;
    },
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 400, `multi-batch fence honoured the 95 ms deadline instead of 1000 ms floor or per-batch reset (got ${Math.round(elapsed)} ms)`);
  assert.equal(secondBatchAborted, true, "in-flight second batch received AbortSignal cancellation at deadline");
  assert.equal(observedBatches.length, 2, "third batch never started after second batch hit deadline");
  assert.equal(observedBatches[0]!.count, KILL_BATCH_SIZE);
  assert.equal(observedBatches[1]!.count, KILL_BATCH_SIZE);
  assert.ok(observedBatches[0]!.timeout! <= 95, `first batch timeout (${observedBatches[0]!.timeout}) bounded to fence deadline, never floored to 1000 ms`);
  assert.ok(observedBatches[1]!.timeout! < observedBatches[0]!.timeout!, `second batch timeout (${observedBatches[1]!.timeout}) reduced to remaining budget (< ${observedBatches[0]!.timeout})`);

  // Direct killProcess multi-batch check + execFile-shaped child timeout (`killed: true`) classification in fence.
  const directTimeouts: number[] = [];
  let directSecondAborted = false;
  await assert.rejects(
    killProcess(rows.map(r => ({ pid: r.pid, start: r.start })), {
      platform: "win32",
      timeout: 80,
      run: async (_s, runOpts) => {
        directTimeouts.push(runOpts.timeout!);
        if (directTimeouts.length === 1) { await delay(30); return ""; }
        await new Promise<void>((_, reject) => {
          runOpts.signal?.addEventListener("abort", () => { directSecondAborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        });
        return "";
      },
    }),
    (err: NodeJS.ErrnoException) => err.code === "ETIMEDOUT",
  );
  assert.equal(directSecondAborted, true);
  assert.equal(directTimeouts.length, 2, "direct killProcess also aborts and skips the third batch");
  assert.ok(directTimeouts[1]! < directTimeouts[0]!);

  const execFileTimeoutContainment = new Containment({
    list: async () => [rows[0]!],
  }, {
    platform: "win32",
    killWindows: (targets, opts) => killTree(targets, {
      ...opts,
      platform: "win32",
      run: async (_s, runOpts) => {
        await delay(runOpts.timeout ?? 10);
        throw Object.assign(new Error("Command failed: powershell.exe -NoProfile"), { code: null, killed: true, signal: "SIGTERM" });
      },
    }),
  });
  await assert.rejects(
    execFileTimeoutContainment.fence(exec, [rows[0]!], { timeoutMs: 60 }),
    (error: Error) => {
      assert.match(error.message, /^Fence timeout: 01WINBATCH@1\/b@1#1\.1 after \d+ ms of 60 ms \(.*1 kill\(s\).*waiting on the kill\)$/);
      return true;
    },
  );
});

const agent = {
  name: "test",
  description: "test",
  body: "test",
  model: "probe/scripted",
  sourcePath: "/fixture/test.md",
  source: "project" as const,
  systemPromptMode: "replace" as const,
  inheritProjectContext: false,
  inheritSkills: false,
};
const noopEffects = {
  prepare: async (t: CallTicket) => ({ cwd: t.cwd }),
  beforeSeal: async (_t: CallTicket, _e: string, r: never) => r,
  afterSeal: async () => {},
  recover: async () => {},
};
const execLine = (exec: string) => ({ type: "custom", customType: CT.exec, data: { exec } });
const reportLine = (exec: string) => ({ type: "custom", customType: CT.report, data: { exec, outcome: "ok", data: { exec } } });
const attentionItem = (e: Entry) => e.item as { id: string; kind: string; text: string; call?: string; rev: number };

test("Windows fence timeout during kill drives downstream F1 (fence-failed + unknown attention) across Executor and gate recovery", { timeout: 15000 }, async t => {
  const home = await tempHome(t);
  const wid = ulid();
  const orch = await openJournal(orchLedger(home));
  const journal = await openJournal(journalPath(home, wid));
  t.after(async () => { await journal.close(); await orch.close(); });
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });

  const callId = `${wid}@1/a@1`, exec = `${callId}#1.1`;
  const gateId = `gate:${wid}@1/g@1#1`, gateCall = `${wid}@1/g@1`;
  await journal.append(JT.exec, { call: callId, exec });
  await journal.append("tracked", { exec, pid: 6400, start: T_HOST, child: true });
  await journal.append("gate-intent", { id: gateId, call: gateCall });
  await journal.append("gate-tracked", { id: gateId, process: { pid: 6401, ppid: 4212, start: T_HOST } });
  await orch.append("hold", { pool: "probe", slot: 0, exec });
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(callSession(home, wid, "a", 1), `${JSON.stringify(execLine(exec))}\n${JSON.stringify(reportLine(exec))}\n`);

  let execAlive = true, gateAlive = true, stallKill = true;
  const containment = new Containment({
    list: async () => [
      ...(execAlive ? [{ pid: 6400, ppid: 4212, start: T_HOST }] : []),
      ...(gateAlive ? [{ pid: 6401, ppid: 4212, start: T_HOST }] : []),
    ],
  }, {
    platform: "win32",
    fenceTimeoutMs: 60,
    killWindows: (targets, opts) => killTree(targets, {
      ...opts,
      platform: "win32",
      run: async (_script, runOpts) => {
        if (stallKill) {
          await new Promise<void>((_, reject) => {
            runOpts.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
          return "";
        }
        for (const target of targets) {
          if (target.pid === 6400) execAlive = false;
          if (target.pid === 6401) gateAlive = false;
        }
        return "";
      },
    }),
  });

  // 1. Gate recovery on kill timeout -> records `fence-failed` + `unknown` attention item with phase/counts, leaves gate unresolved.
  await recoverGates(journal, containment);
  const gateFailed = journal.entries().filter(e => e.type === "fence-failed" && e.exec === gateId);
  const gateAttn = journal.entries().filter(e => e.type === JT.attention && attentionItem(e).id === `fence:${gateId}`);
  assert.equal(gateFailed.length, 1);
  assert.match(String(gateFailed[0]!.error), /Fence timeout: gate:.*1 scan\(s\) completed.*1 kill\(s\).*waiting on the kill\)/);
  assert.equal(gateAttn.length, 1);
  assert.equal(attentionItem(gateAttn[0]!).kind, "unknown");
  assert.equal(journal.entries().some(e => e.type === "gate" && e.id === gateId), false);

  // 2. Executor recovery + run on kill timeout -> records `fence-failed` + `unknown` attention item, parks call, retains held slot.
  const ledgers = { home, orch, config: { k: { trackerMs: 20 }, writerLock: "off" as const } };
  const executor = createExecutor(ledgers, { effects: noopEffects, containment, memory: async () => 1e6, sweepMs: 50 });
  t.after(() => executor.shutdown());

  await executor.recover(wid, journal);
  const execFailed = journal.entries().filter(e => e.type === "fence-failed" && e.exec === exec);
  const execAttn = journal.entries().filter(e => e.type === JT.attention && attentionItem(e).id === `fence:${exec}`);
  assert.equal(execFailed.length, 1);
  assert.match(String(execFailed[0]!.error), /Fence timeout: .*#1\.1 after \d+ ms of 60 ms \(1 scan\(s\) completed.*1 kill\(s\).*waiting on the kill\)/);
  assert.equal(execAttn.length, 1);
  assert.deepEqual({ kind: attentionItem(execAttn[0]!).kind, call: attentionItem(execAttn[0]!).call }, { kind: "unknown", call: callId });
  assert.equal(journal.entries().some(e => e.type === JT.fenced && e.exec === exec), false);
  assert.equal(orch.entries().some(e => e.type === "release" && e.exec === exec), false, "unproven Windows fence keeps held slots");

  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  const pendingRun = executor.run(ticket);
  await delay(80);
  assert.equal(journal.entries().some(e => e.type === JT.sealed && e.call === callId), false, "call stays parked while kill keeps timing out");

  // Once the stall clears, sweep proves retirement for both the execution and the gate and resolves attention items.
  stallKill = false;
  const result = await pendingRun;
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { exec });
  assert.ok(journal.entries().some(e => e.type === JT.fenced && e.exec === exec));
  assert.ok(journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${exec}` && e.resolution === "fenced"));
  assert.ok(orch.entries().some(e => e.type === "release" && e.exec === exec));

  const deadline = Date.now() + 3000;
  while (!journal.entries().some(e => e.type === "gate" && e.id === gateId)) {
    if (Date.now() > deadline) throw new Error("gate was not retired by sweep");
    await delay(20);
  }
  assert.ok(journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${gateId}` && e.resolution === "fenced"));
});

test("Windows genuine immediate Win32 refusals propagate without waiting for deadline and retain non-timeout downstream policy", { timeout: 10000 }, async t => {
  const home = await tempHome(t);
  const wid = ulid();
  const orch = await openJournal(orchLedger(home));
  const journal = await openJournal(journalPath(home, wid));
  t.after(async () => { await journal.close(); await orch.close(); });
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });

  const multiRows = makeTargets(KILL_BATCH_SIZE + 5);
  for (const message of [
    "Refusing to end critical or unverified process 6400",
    "OpenProcess denied for verified live pid 6400",
    "TerminateProcess(6400) failed with Win32 error 5",
  ]) {
    let batchCalls = 0;
    const containment = new Containment({
      list: async () => multiRows,
    }, {
      platform: "win32",
      fenceTimeoutMs: 5000,
      killWindows: (targets, opts) => killTree(targets, {
        ...opts,
        platform: "win32",
        run: async () => {
          batchCalls++;
          throw Object.assign(new Error(`Command failed: powershell.exe\n${message}`), { code: 1, killed: false, signal: null });
        },
      }),
    });
    const started = performance.now();
    await assert.rejects(
      fenceAgent(containment, journal, `${wid}@1/refusal@1#1.1`, [multiRows[0]!], { pid: 6400, start: T_HOST }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /Fence timeout/);
        assert.ok(error.message.includes(message));
        return true;
      },
    );
    assert.ok(performance.now() - started < 500, "genuine Win32 refusal rejects immediately instead of waiting out 5000 ms budget");
    assert.equal(batchCalls, 1, "genuine Win32 refusal on batch 1 stops immediately without invoking batch 2");
  }

  // Downstream policy for non-timeout failures:
  // - Executor parks the call and logs the error, without recording timeout-only `fence-failed` / `unknown` attention;
  //   a subsequent clean sweep retires and resumes it.
  // - Gate recovery records `fence-failed` with the genuine error and does NOT open a timeout `unknown` attention item.
  const callId = `${wid}@1/c@1`, exec = `${callId}#1.1`;
  const gateId = `gate:${wid}@1/cg@1#1`, gateCall = `${wid}@1/cg@1`;
  await journal.append(JT.exec, { call: callId, exec });
  await journal.append("tracked", { exec, pid: 6400, start: T_HOST, child: true });
  await journal.append("gate-intent", { id: gateId, call: gateCall });
  await journal.append("gate-tracked", { id: gateId, process: { pid: 6401, ppid: 4212, start: T_HOST } });
  await mkdir(callDir(home, wid, "c", 1), { recursive: true });
  await writeFile(callSession(home, wid, "c", 1), `${JSON.stringify(execLine(exec))}\n${JSON.stringify(reportLine(exec))}\n`);

  let refuse = true, execAlive = true;
  const containment = new Containment({
    list: async () => [
      ...(execAlive ? [{ pid: 6400, ppid: 4212, start: T_HOST }] : []),
      { pid: 6401, ppid: 4212, start: T_HOST },
    ],
  }, {
    platform: "win32",
    fenceTimeoutMs: 5000,
    killWindows: (targets, opts) => killTree(targets, {
      ...opts,
      platform: "win32",
      run: async () => {
        if (refuse || targets.some(x => x.pid === 6401)) {
          throw Object.assign(new Error("Command failed: powershell.exe\nTerminateProcess(6400) failed with Win32 error 5"), { code: 1, killed: false, signal: null });
        }
        execAlive = false;
        return "";
      },
    }),
  });

  await recoverGates(journal, containment);
  assert.equal(journal.entries().filter(e => e.type === "fence-failed" && e.exec === gateId).length, 1);
  assert.match(String(journal.entries().find(e => e.type === "fence-failed" && e.exec === gateId)!.error), /TerminateProcess\(6400\) failed with Win32 error 5/);
  assert.equal(journal.entries().some(e => e.type === JT.attention && attentionItem(e).id === `fence:${gateId}`), false, "non-timeout gate refusal retains existing no-unknown-attention policy");

  const ledgers = { home, orch, config: { k: { trackerMs: 20 }, writerLock: "off" as const } };
  const executor = createExecutor(ledgers, { effects: noopEffects, containment, memory: async () => 1e6, sweepMs: 50 });
  t.after(() => executor.shutdown());

  await executor.recover(wid, journal);
  assert.ok(errors.some(e => e.includes(`fence of ${exec} failed`) && e.includes("TerminateProcess(6400) failed with Win32 error 5")));
  assert.equal(journal.entries().some(e => e.type === JT.fenced && e.exec === exec), false, "refused fence never marks execution fenced");
  assert.equal(journal.entries().some(e => e.type === "fence-failed" && e.exec === exec), false, "non-timeout executor refusal retains existing policy (no fence-failed entry)");
  assert.equal(journal.entries().some(e => e.type === JT.attention && attentionItem(e).id === `fence:${exec}`), false, "non-timeout executor refusal retains existing policy (no unknown attention)");

  refuse = false;
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "c", gen: 1, callId, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  const result = await executor.run(ticket);
  assert.equal(result.status, "ok");
  assert.ok(journal.entries().some(e => e.type === JT.fenced && e.exec === exec));
});
