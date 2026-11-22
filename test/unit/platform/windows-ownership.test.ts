// Regression coverage for Windows process ownership and termination across async & sync cleanup paths:
// - Reproduces the native CI defect where `EvaluatorClient` (`Engine.close()`) spawned on recycled PID 6400 and a
//   pre-existing critical system process on PID 6160 still carried `ParentProcessId = 6400` (`start < host.start`).
// - Verifies `Containment.scan`/`fence`/`spawn`, `EvaluatorClient`, `fenceAgent`, `endLeaseProcesses`, `legacyRestart`
//   and `killProcess`/`killTree` (async & sync) using harmless fakes only (no destructive OS probes) and compares exact
//   call targets.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { Containment } from "../../../src/platform/containment.ts";
import { spawnInJob } from "../../../src/platform/job.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { endLeaseProcesses, type LeaseTicket } from "../../../src/platform/lease.ts";
import { legacyRestart } from "../../../src/cli/restart.ts";
import {
  buildWinKillScript,
  isOwnedWinChild,
  isWinStart,
  killProcess,
  killProcessSync,
  killTree,
  killTreeSync,
  normalizeWinTargets,
  parseProcessRows,
  sameCreation,
  winLiveDescendants,
  winTag,
  type WinProcessIdentity,
  type WinProcessRow,
} from "../../../src/platform/windows.ts";
import { EvaluatorClient } from "../../../src/orchestrator/evaluator-client.ts";
import { Engine } from "../../../src/orchestrator/engine.ts";
import { fenceAgent } from "../../../src/orchestrator/executor/ended.ts";
import { JT, type ProcInfo, type SpawnSpec } from "../../../src/types.ts";
import { fakeExecutor } from "../orchestrator/engine/fake.ts";

const T_BOOT = "639000000100000000";
const T_HOST = "639000000500000000";
const T_TOOL = "639000000550000000";
const T_GRAND = "639000000580000000";
const T_BOOT_CHILD = "639000000600000000";
const T_REUSED = "639000000900000000";
const T_REUSED_CHILD = "639000000950000000";

async function tempHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-own-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("Windows tree ownership primitives reject pre-existing boot orphans, exited/reused parents and malformed tokens", () => {
  assert.equal(isWinStart(T_HOST), true);
  for (const bad of ["", undefined, "0", "-1", "abc", "639000000500000000x", "9999999999999999999"]) {
    assert.equal(isWinStart(bad), false, `must reject start=${String(bad)}`);
    assert.equal(sameCreation(bad, T_HOST), false);
    assert.equal(sameCreation(T_HOST, bad), false);
  }
  assert.equal(isOwnedWinChild({ pid: 6400, start: T_HOST }, { pid: 6160, ppid: 6400, start: T_BOOT }), false,
    "critical system process 6160 created before recycled parent 6400 is never owned");
  assert.equal(isOwnedWinChild({ pid: 6400, start: T_HOST }, { pid: 6404, ppid: 6400, start: T_TOOL }), true);

  const snapshot: WinProcessRow[] = [
    { pid: 6400, ppid: 4212, start: T_HOST },
    { pid: 6160, ppid: 6400, start: T_BOOT, command: "csrss.exe" },
    { pid: 7000, ppid: 6160, start: T_BOOT_CHILD, command: "conhost.exe" },
    { pid: 6404, ppid: 6400, start: T_TOOL, command: "node.exe tool" },
    { pid: 6408, ppid: 6404, start: T_GRAND, command: "node.exe leaf" },
    // PID 5000 already exited and was reused by T_REUSED, which spawned 5004.
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
    { pid: 5004, ppid: 5000, start: T_REUSED_CHILD, command: "dllhost.exe" },
  ];
  const descendants = winLiveDescendants(
    [{ pid: 6400, start: T_HOST }, { pid: 5000, start: T_BOOT }],
    snapshot,
  );
  assert.deepEqual(
    descendants.map(r => ({ pid: r.pid, start: r.start })),
    [{ pid: 6404, start: T_TOOL }, { pid: 6408, start: T_GRAND }],
    "excludes 6160/7000 under recycled 6400 and 5004 under replaced 5000",
  );

  // parseProcessRows drops rows with non-decimal or zero pid/start tokens.
  assert.deepEqual(
    parseProcessRows(`0\t0\t${T_BOOT}\t0\tSystem Idle\n6160\t6400\tbad\t0\tcsrss\n6400\t4212\t${T_HOST}\t20000\tnode.exe`),
    [{ pid: 6400, ppid: 4212, start: T_HOST, cpuMs: 2, command: "node.exe" }],
  );
});

test("reproduction (PID 6400 / critical PID 6160): Engine + EvaluatorClient cleanup targets only proven-owned host", async t => {
  const home = await tempHome(t), orch = await openJournal(orchLedger(home));
  await mkdir(join(home, "agent/agents"), { recursive: true });
  await writeFile(join(home, "agent/agents/test.md"), "---\nname: test\ndescription: test\n---\nTest");

  const realContainment = new Containment();
  const spawnedSpecs: SpawnSpec[] = [];
  const killCalls: WinProcessIdentity[][] = [];
  let hostAliveInTable = true;
  let hostPidInSim = 6400;

  // Simulate Windows process table where our real evaluator/host.ts sits at PID 6400 while critical system process
  // PID 6160 (and its child 7000) still list ParentProcessId = 6400 from boot.
  const fakeWinContainment = new Containment({
    async list(knownExecs = new Set()) {
      const rows: ProcInfo[] = [
        { pid: 6160, ppid: hostPidInSim, start: T_BOOT },
        { pid: 7000, ppid: 6160, start: T_BOOT_CHILD },
      ];
      if (hostAliveInTable) {
        const tag = winTag(spawnedSpecs.at(-1)?.args.join(" "), "DSA_EXEC");
        rows.unshift({
          pid: hostPidInSim,
          ppid: 4212,
          start: T_HOST,
          ...(tag && knownExecs.has(tag) ? { tag } : {}),
        });
      } else {
        // Simulate rapid host exit on stdin.end() followed immediately by PID 6400 reuse by a system process!
        rows.unshift({ pid: hostPidInSim, ppid: 4, start: T_REUSED });
        rows.push({ pid: 6500, ppid: hostPidInSim, start: T_REUSED_CHILD });
      }
      return rows;
    },
  }, {
    platform: "win32",
    captureStart: async () => T_HOST,
    killWindows: async targets => {
      killCalls.push(targets.map(x => ({ ...x })));
      hostAliveInTable = false;
    },
  });

  // Wrap spawn to run the real evaluator/host.ts process locally while presenting simulated PID 6400 to EvaluatorClient.
  let realHostClose: (() => Promise<void>) | undefined;
  const transportContainment = {
    async spawn(spec: SpawnSpec) {
      spawnedSpecs.push(spec);
      const real = await realContainment.spawn(spec);
      realHostClose = async () => { real.stdin.end(); await realContainment.fence(spec.exec, [{ pid: real.pid, ppid: process.pid, start: real.start }]); };
      return { ...real, pid: hostPidInSim, start: T_HOST };
    },
    scan: fakeWinContainment.scan.bind(fakeWinContainment),
    fence: fakeWinContainment.fence.bind(fakeWinContainment),
  };

  const ledgers = { home, orch, config: { k: { idleExitMs: 60_000, trackerMs: 30 } } };
  const evaluator = new EvaluatorClient(ledgers, { containment: transportContainment, platform: "win32" });
  const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: "a" }), {
    evaluator,
    discovery: { home, agentDir: join(home, "agent"), globalNpmRoot: null },
  });
  t.after(async () => { await realHostClose?.(); await orch.close(); });

  await engine.recover();
  assert.ok(spawnedSpecs.length === 1);
  const evalExec = String(orch.entries().find(e => e.type === "eval-host")!.exec);
  assert.equal(winTag(spawnedSpecs[0]!.args.join(" "), "DSA_EXEC"), evalExec, "Windows evaluator carries versioned DSA_EXEC argv tag");

  await publishRequest(orchInbox(home), {
    rid: "r1", from: "test", to: "orch", sseq: 1, kind: "run",
    body: { cwd: home, source: "return await runs.run('a',{agent:'test',task:'held'});" },
  });
  await engine.intake();
  const wid = String(orch.entries().find(e => e.type === JT.created)!.wid);
  while (!readJournalSnapshot(journalPath(home, wid)).some(e => e.type === "fake-run")) {
    await new Promise(r => setTimeout(r, 15));
  }
  // Wait across at least two trackerMs periods so EvaluatorClient's active-script scan runs against PID 6400 + PID 6160.
  await new Promise(r => setTimeout(r, 90));

  const trackedEntries = orch.entries().filter(e => e.type === "eval-tracked").map(e => e.process as ProcInfo);
  assert.deepEqual(
    trackedEntries.map(p => ({ pid: p.pid, start: p.start })),
    [{ pid: 6400, start: T_HOST }],
    "EvaluatorClient periodic scan never persists boot orphan PID 6160 or its child 7000",
  );

  // Case A: host is still visible at PID 6400 during engine.close() -> targets ONLY (6400, T_HOST), never 6160/7000.
  await engine.close();
  assert.deepEqual(killCalls, [[{ pid: 6400, start: T_HOST }]]);
  assert.ok(orch.entries().some(e => e.type === "eval-fenced" && e.exec === evalExec));

  // Case B: host already exited on stdin.end() and PID 6400 was reused by (6400, T_REUSED) before fence's scan -> zero kill calls.
  killCalls.length = 0;
  hostAliveInTable = true;
  await evaluator.start(() => {}, () => {});
  await realHostClose?.();
  realHostClose = undefined;
  hostAliveInTable = false; // PID 6400 now holds (6400, T_REUSED) + child 6500 alongside boot orphan 6160
  await evaluator.close();
  assert.deepEqual(killCalls, [], "exited evaluator host whose PID was reused produces zero kill calls");

  // Case C: crash between eval-host and eval-tracked recovers via Windows versioned DSA_EXEC argv tag and still excludes 6160.
  await orch.append("eval-host", { exec: "eval:crash-before-tracked" });
  spawnedSpecs.push({ exec: "eval:crash-before-tracked", command: "node.exe", args: ["host.ts", `DSA_EXEC=v1~${Buffer.from("eval:crash-before-tracked").toString("base64url")}`], cwd: home, env: {} });
  hostAliveInTable = true;
  await evaluator.close();
  assert.deepEqual(killCalls, [[{ pid: 6400, start: T_HOST }]]);
  assert.ok(orch.entries().some(e => e.type === "eval-fenced" && e.exec === "eval:crash-before-tracked"));
});

test("Containment.fence and fenceAgent (Windows): exact owned targets under exit/PID reuse, never swallowing kill failures", async t => {
  const home = await tempHome(t);
  const journal = await openJournal(join(home, "wf.jsonl"));
  t.after(() => journal.close());

  const exec = "01WINOWN@1/a@1#1.1";
  const killCalls: WinProcessIdentity[][] = [];
  let phase: "full-tree" | "parent-reused" | "retired" = "full-tree";

  const containment = new Containment({
    async list() {
      if (phase === "retired") return [{ pid: 6160, ppid: 6400, start: T_BOOT }, { pid: 6400, ppid: 4, start: T_REUSED }];
      if (phase === "parent-reused") {
        // Direct child 6400 exited and PID 6400 was reused by T_REUSED (spawning 6500); tracked 6404 + live child 6408 remain.
        return [
          { pid: 6400, ppid: 4, start: T_REUSED },
          { pid: 6500, ppid: 6400, start: T_REUSED_CHILD },
          { pid: 6160, ppid: 6400, start: T_BOOT },
          { pid: 6404, ppid: 6400, start: T_TOOL },
          { pid: 6408, ppid: 6404, start: T_GRAND },
        ];
      }
      return [
        { pid: 6400, ppid: 4212, start: T_HOST },
        { pid: 6160, ppid: 6400, start: T_BOOT },
        { pid: 7000, ppid: 6160, start: T_BOOT_CHILD },
        { pid: 5000, ppid: 4, start: T_REUSED },
        { pid: 5004, ppid: 5000, start: T_REUSED_CHILD },
        { pid: 6404, ppid: 6400, start: T_TOOL },
      ];
    },
  }, {
    platform: "win32",
    killWindows: async targets => {
      killCalls.push(targets.map(x => ({ ...x })));
      phase = phase === "full-tree" ? "parent-reused" : "retired";
    },
  });

  await fenceAgent(
    containment,
    journal,
    exec,
    [
      { pid: 6400, ppid: 4212, start: T_HOST },
      { pid: 5000, ppid: 4212, start: T_BOOT }, // historical tracked pid, now reused by T_REUSED
    ],
    { pid: 6400, start: T_HOST },
  );

  assert.deepEqual(killCalls, [
    [{ pid: 6400, start: T_HOST }, { pid: 6404, start: T_TOOL }],
    [{ pid: 6404, start: T_TOOL }, { pid: 6408, start: T_GRAND }],
  ]);
  const endedPids = journal.entries().filter(e => e.type === "ended")
    .flatMap(e => (e.procs as { pid: number }[]).map(p => p.pid));
  assert.deepEqual(endedPids, [6404, 6404, 6408], "beforeKill records only proven-owned non-direct descendants");

  // A failure terminating a verified live target must reject fenceAgent too (never swallowed into a silent spin).
  const failingContainment = new Containment({
    list: async () => [{ pid: 6400, ppid: 4212, start: T_HOST }],
  }, {
    platform: "win32",
    killWindows: async () => { throw new Error("TerminateProcess(6400) failed with Win32 error 5"); },
  });
  await assert.rejects(
    fenceAgent(failingContainment, journal, exec, [{ pid: 6400, ppid: 4212, start: T_HOST }], { pid: 6400, start: T_HOST }),
    /TerminateProcess\(6400\) failed/,
  );
});

test("fail-closed identity enforcement across Containment.spawn/fence, killProcess/killTree, lease cleanup and legacyRestart", async () => {
  // 1. Containment.spawn fails closed and kills its own direct ChildProcess handle if start identity cannot be read.
  const spawnKillCalls: WinProcessIdentity[][] = [];
  const spawnContainment = new Containment(new ProcessTable({ platform: "darwin", ps: async () => "" }), {
    platform: "win32",
    captureStart: async () => "",
    killWindows: async targets => { spawnKillCalls.push([...targets]); },
  });
  await assert.rejects(
    spawnContainment.spawn({ exec: "unverified-spawn", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: tmpdir(), env: {} }),
    /no verifiable start identity/,
  );
  assert.deepEqual(spawnKillCalls, [], "unverified spawn failure never calls bare-PID Windows tree killer");

  // 2. Containment.fence fails closed when a tagged process lacks a valid Windows start token: zero kills, no false fence.
  const fenceKillCalls: WinProcessIdentity[][] = [];
  const unverifiedFence = new Containment({
    list: async () => [{ pid: 6160, ppid: 6400, start: "", tag: "exec-unverified" }],
  }, {
    platform: "win32",
    killWindows: async targets => { fenceKillCalls.push([...targets]); },
  });
  await assert.rejects(
    unverifiedFence.fence("exec-unverified", [], { timeoutMs: 40 }),
    /Fence timeout: exec-unverified \(unverified identity for pid 6160\)/,
  );
  assert.deepEqual(fenceKillCalls, [], "never kills a tagged row without a verifiable start token");

  // 3. Async & sync Windows killers reject missing/malformed identities before invoking PowerShell and never invoke taskkill.
  let asyncRuns = 0, syncRuns = 0;
  for (const invalid of [
    { pid: 6160, start: "" },
    { pid: 6160, start: "not-ticks" },
    { pid: 0, start: T_HOST },
    { pid: -5, start: T_HOST },
  ]) {
    assert.throws(() => normalizeWinTargets(invalid), /without verified identity/);
    await assert.rejects(killTree(invalid, { platform: "win32", run: async () => { asyncRuns++; return ""; } }), /without verified identity/);
    await assert.rejects(killProcess(invalid, { platform: "win32", run: async () => { asyncRuns++; return ""; } }), /without verified identity/);
    assert.throws(() => killTreeSync(invalid, { platform: "win32", runSync: () => { syncRuns++; return ""; } }), /without verified identity/);
    assert.throws(() => killProcessSync(invalid, { platform: "win32", runSync: () => { syncRuns++; return ""; } }), /without verified identity/);
  }
  assert.equal(asyncRuns, 0);
  assert.equal(syncRuns, 0);

  const capturedScripts: string[] = [];
  await killProcess({ pid: 6400, start: T_HOST }, { platform: "win32", run: async s => { capturedScripts.push(s); return ""; } });
  killTreeSync([{ pid: 6400, start: T_HOST }, { pid: 6404, start: T_TOOL }], { platform: "win32", runSync: s => { capturedScripts.push(s); return ""; } });
  assert.equal(capturedScripts.length, 2);
  for (const s of capturedScripts) {
    assert.ok(!/taskkill/i.test(s), "never invokes taskkill");
    assert.match(s, /GetProcessTimes/);
    assert.match(s, /TerminateProcess/);
  }
  assert.ok(!capturedScripts[0]!.includes("SELECT ProcessId,ParentProcessId"), "killProcess ends only the verified target");
  assert.match(capturedScripts[0]!, new RegExp(`6400:${T_HOST}`));
  assert.ok(capturedScripts[1]!.includes("SELECT ProcessId,ParentProcessId"), "killTree expands creation-checked descendants while holding parent handles");
  assert.match(capturedScripts[1]!, new RegExp(`6400:${T_HOST};6404:${T_TOOL}`));
  assert.equal(buildWinKillScript([{ pid: 6400, start: T_HOST }, { pid: 6400, start: T_HOST }], false).includes(`${T_HOST};${T_HOST}`), false, "deduplicates identical targets");

  // 4. endLeaseProcesses (Windows sync killer path): fails closed without command.start; excludes boot orphan 6160 and reused PIDs.
  const leaseKills: WinProcessIdentity[][] = [];
  const leaseLogs: string[] = [];
  const baseTicket: LeaseTicket = {
    seq: 1, resource: "machine", mode: "exclusive",
    wrapper: { pid: 4000, start: T_HOST },
    command: { pid: 6400 }, // missing start!
    argv: ["cmd"], cwd: ".", since: 1, grantedAt: 1,
  };
  await endLeaseProcesses(baseTicket, 100, l => leaseLogs.push(l), {
    platform: "win32",
    snapshotWin: () => new Map([[6400, { pid: 6400, ppid: 4000, start: T_HOST }]]),
    killWinSync: targets => { leaseKills.push([...targets]); },
  });
  assert.equal(leaseKills.length, 0, "lease cleanup refuses to kill bare command pid without start token");
  assert.match(leaseLogs[0] ?? "", /without verified start identity/);

  let leaseRound = 0;
  await endLeaseProcesses({ ...baseTicket, command: { pid: 6400, start: T_HOST } }, 100, l => leaseLogs.push(l), {
    platform: "win32",
    snapshotWin: () => leaseRound++ === 0
      ? new Map<number, WinProcessRow>([
          [6400, { pid: 6400, ppid: 4000, start: T_HOST }],
          [6160, { pid: 6160, ppid: 6400, start: T_BOOT }],
          [6404, { pid: 6404, ppid: 6400, start: T_TOOL }],
        ])
      : new Map<number, WinProcessRow>([
          [6400, { pid: 6400, ppid: 4, start: T_REUSED }],
          [6500, { pid: 6500, ppid: 6400, start: T_REUSED_CHILD }],
          [6160, { pid: 6160, ppid: 6400, start: T_BOOT }],
        ]),
    killWinSync: targets => { leaseKills.push([...targets]); },
  });
  assert.deepEqual(leaseKills, [[{ pid: 6400, start: T_HOST }, { pid: 6404, start: T_TOOL }]]);

  // 5. legacyRestart (Windows sync killer path): fails closed without start; targets exact (pid, start) when verified.
  const restartHome = await mkdtemp(join(tmpdir(), "dsa-win-leg-"));
  try {
    const restartKills: WinProcessIdentity[] = [];
    const refused = legacyRestart(restartHome, { version: "1.0.17", pid: 6400, ts: 1 }, {}, {
      platform: "win32",
      killWinSync: target => { restartKills.push(target); },
    });
    assert.equal(refused.applied, false);
    assert.match((refused as { reason: string }).reason, /cannot verify orchestrator identity/);
    assert.equal(restartKills.length, 0);

    const applied = legacyRestart(restartHome, { version: "1.0.17", pid: 6400, start: T_HOST, ts: 1 }, {}, {
      platform: "win32",
      killWinSync: target => { restartKills.push(target); },
    });
    assert.deepEqual(applied, { applied: true });
    assert.deepEqual(restartKills, [{ pid: 6400, start: T_HOST }]);
  } finally {
    await rm(restartHome, { recursive: true, force: true });
  }
});

test("spawnInJob default owner cleanup ends a stalled owner via its direct ChildProcess handle without taskkill", {
  skip: process.platform === "win32" ? "POSIX fake-csc script exercises cross-platform ChildProcess handle kill; job.test.ts covers native csc.exe" : false,
}, async t => {
  const dir = await tempHome(t);
  const runner = join(dir, "stalled-owner.cjs"), compiler = join(dir, "fake-csc");
  await writeFile(runner, [
    `#!${process.execPath}`,
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "writeFileSync(join(process.argv[2], 'owner-pid'), String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  chmodSync(runner, 0o755);
  await writeFile(compiler, [
    `#!${process.execPath}`,
    "const { chmodSync, copyFileSync } = require('node:fs');",
    "const out = process.argv.slice(2).find(a => a.startsWith('/out:'))?.slice(5);",
    `copyFileSync(${JSON.stringify(runner)}, out); chmodSync(out, 0o755);`,
  ].join("\n"));
  chmodSync(compiler, 0o755);

  await assert.rejects(
    spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} },
      { compiler, timeoutMs: 80, endMs: 1000 }),
    /reported no group within 80 ms/,
  );
  const stalledPid = Number(await readFile(join(dir, "owner-pid"), "utf8"));
  assert.ok(stalledPid > 0);
  assert.throws(() => process.kill(stalledPid, 0), /ESRCH/, "direct ChildProcess handle ended the stalled owner cleanly");
});


