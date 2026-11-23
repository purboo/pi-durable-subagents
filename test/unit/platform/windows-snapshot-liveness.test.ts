// Regression coverage for Windows process-snapshot liveness and scanned CommandLine reuse:
// - Protected process (EPERM + missing snapshot row) PID reuse fails closed when expectedStart is verified,
//   while liveness checks without expectedStart preserve existing EPERM => alive semantics.
// - winSnapshotSync propagates query failures instead of caching/returning an empty table, while liveness callers
//   (winProcessAlive, snapshot.processAlive, lease.alive / live / liveTickets) neither crash nor turn transient
//   snapshot errors into "all processes dead".
// - Windows ProcessTable -> Containment -> fenceAgent reuses already-scanned CommandLine rows within the 500 ms
//   ended budget without spawning extra per-PID PowerShell queries or leaking command lines into tracked journals.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../src/kernel/journal.ts";
import { processAlive } from "../../../src/orchestrator/snapshot.ts";
import { fenceAgent } from "../../../src/orchestrator/executor/ended.ts";
import { Containment } from "../../../src/platform/containment.ts";
import { alive, endLeaseProcesses, live, liveTickets, writeTicketSync, type LeaseTicket } from "../../../src/platform/lease.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import {
  attachScannedCommand,
  clipWinCommandLine,
  parseProcessRows,
  probeKernelPid,
  resetWinSnapshotCache,
  scannedCommand,
  winProcessAlive,
  winSnapshotSync,
  winTagArg,
  type WinProcessIdentity,
  type WinProcessRow,
} from "../../../src/platform/windows.ts";

const T_OLD = "639000000100000000";
const T_LIVE = "639000000500000000";
const T_LIVE_WMI = "639000000500000007";
const T_REUSED = "639000000900000000";
const T_CHILD = "639000000550000000";

function epermKill(): never {
  throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
}
function esrchKill(): never {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

test("probeKernelPid distinguishes accessible, EPERM protected, and ESRCH/invalid PIDs", () => {
  assert.equal(probeKernelPid(0, () => {}), "dead");
  assert.equal(probeKernelPid(-1, () => {}), "dead");
  assert.equal(probeKernelPid(1234, () => {}), "alive");
  assert.equal(probeKernelPid(1234, epermKill), "eperm");
  assert.equal(probeKernelPid(1234, esrchKill), "dead");
});

test("Windows EPERM + missing snapshot row fails closed with expectedStart and stays alive without expectedStart", () => {
  // Simulate a protected system process (e.g. csrss.exe) whose empty CreationDate was filtered out of parseProcessRows.
  const emptyProtectedTable = new Map<number, WinProcessRow>(
    parseProcessRows(`6400\t4\t\t0\tcsrss.exe\n7000\t4\t${T_LIVE}\t10000\tnode.exe`).map(r => [r.pid, r]),
  );
  assert.equal(emptyProtectedTable.has(6400), false, "protected process with empty CreationDate is filtered out");

  let snapshotCalls = 0;
  let directStartCalls = 0;
  const opts = {
    platform: "win32" as const,
    probePid: (pid: number) => probeKernelPid(pid, epermKill),
    snapshotWin: () => { snapshotCalls++; return emptyProtectedTable; },
    startWinSync: () => { directStartCalls++; return ""; },
  };

  // With verified expectedStart: reused protected PID MUST fail closed (false).
  assert.equal(winProcessAlive(6400, T_OLD, opts), false);
  assert.equal(processAlive(6400, T_OLD, opts), false);
  assert.equal(alive({ pid: 6400, start: T_OLD }, opts), false);
  assert.equal(directStartCalls, 0, "EPERM + missing snapshot row fails closed without extra winStartSync calls");

  // Without expectedStart: preserves existing EPERM => alive semantics (and does not need a snapshot).
  const beforeNoStart = snapshotCalls;
  assert.equal(winProcessAlive(6400, undefined, opts), true);
  assert.equal(processAlive(6400, undefined, opts), true);
  assert.equal(alive({ pid: 6400 }, opts), true);
  assert.equal(snapshotCalls, beforeNoStart, "liveness without expectedStart skips WMI snapshot");

  // If WMI DOES expose a CreationDate for an EPERM process, compare it normally.
  assert.equal(winProcessAlive(7000, T_LIVE_WMI, opts), true);
  assert.equal(winProcessAlive(7000, T_OLD, opts), false);

  // Dead PID (ESRCH) always returns false with or without expectedStart.
  const deadOpts = { ...opts, probePid: (pid: number) => probeKernelPid(pid, esrchKill) };
  assert.equal(winProcessAlive(6400, undefined, deadOpts), false);
  assert.equal(winProcessAlive(6400, T_OLD, deadOpts), false);
  assert.equal(processAlive(6400, T_OLD, deadOpts), false);
  assert.equal(alive({ pid: 6400, start: T_OLD }, deadOpts), false);

  // Malformed expectedStart fails closed even for an accessible PID.
  const aliveOpts = { ...opts, probePid: () => "alive" as const };
  assert.equal(winProcessAlive(7000, "not-a-tick", aliveOpts), false);
  assert.equal(processAlive(7000, "0", aliveOpts), false);
  assert.equal(alive({ pid: 7000, start: "bad" }, aliveOpts), false);
});

test("Windows accessible PID missing from stale cache refreshes once and distinguishes new, reused, and exited PIDs", () => {
  const stale = new Map<number, WinProcessRow>();
  const freshMatch = new Map<number, WinProcessRow>([[6400, { pid: 6400, ppid: 4212, start: T_LIVE }]]);
  const freshReused = new Map<number, WinProcessRow>([[6400, { pid: 6400, ppid: 4, start: T_REUSED }]]);

  // 1. Newly spawned process missing from cached snapshot is found on maxAgeMs=0 refresh.
  const ages: (number | undefined)[] = [];
  assert.equal(
    winProcessAlive(6400, T_LIVE_WMI, {
      probePid: () => "alive",
      snapshotWin: maxAgeMs => { ages.push(maxAgeMs); return maxAgeMs === 0 ? freshMatch : stale; },
    }),
    true,
  );
  assert.deepEqual(ages, [undefined, 0]);

  // 2. Reused PID found on refresh fails closed.
  assert.equal(
    winProcessAlive(6400, T_OLD, {
      probePid: () => "alive",
      snapshotWin: maxAgeMs => (maxAgeMs === 0 ? freshReused : stale),
    }),
    false,
  );

  // 3. Process that exited between kill(pid, 0) and fresh snapshot returns false (no false alive).
  assert.equal(
    winProcessAlive(6400, T_LIVE, {
      probePid: () => "alive",
      snapshotWin: () => stale,
    }),
    false,
  );

  // 4. Same via explicit startWinSync seam (used by lease.alive callers): empty start returns false, matching returns true.
  assert.equal(
    alive({ pid: 6400, start: T_LIVE }, {
      platform: "win32",
      probePid: () => "alive",
      snapshotWin: () => stale,
      startWinSync: () => "",
    }),
    false,
  );
  assert.equal(
    alive({ pid: 6400, start: T_LIVE }, {
      platform: "win32",
      probePid: () => "alive",
      snapshotWin: () => stale,
      startWinSync: () => T_LIVE_WMI,
    }),
    true,
  );
});

test("winSnapshotSync propagates query errors without caching empty results, while liveness callers survive transient failures", async t => {
  resetWinSnapshotCache();
  t.after(resetWinSnapshotCache);

  let now = 1_000;
  let runs = 0;
  let shouldFail = true;
  const runSync = () => {
    runs++;
    if (shouldFail) throw new Error("WMI transient timeout");
    return `6400\t4212\t${T_LIVE}\t10000\tnode.exe worker`;
  };

  // 1. winSnapshotSync propagates errors instead of returning an empty map.
  assert.throws(() => winSnapshotSync(250, { runSync, now: () => now }), /WMI transient timeout/);
  assert.equal(runs, 1);

  // 2. Once WMI recovers, winSnapshotSync populates and reuses its cache within maxAgeMs.
  shouldFail = false;
  const first = winSnapshotSync(250, { runSync, now: () => now });
  assert.equal(first.get(6400)?.start, T_LIVE);
  assert.equal(runs, 2);
  now += 100;
  const cached = winSnapshotSync(250, { runSync, now: () => now });
  assert.equal(cached, first);
  assert.equal(runs, 2);

  // 3. A subsequent error after cache expiry propagates and does NOT corrupt the cache with an empty map.
  now += 300;
  shouldFail = true;
  assert.throws(() => winSnapshotSync(250, { runSync, now: () => now }), /WMI transient timeout/);
  assert.equal(runs, 3);

  // 4. Callers (winProcessAlive, processAlive, lease.alive, lease.liveTickets) do not crash on transient snapshot errors
  //    and never turn query errors into "all processes dead", while still failing closed for EPERM + expectedStart.
  const failingSnap = () => { throw new Error("PowerShell transient failure"); };
  assert.equal(winProcessAlive(6400, T_LIVE, { probePid: () => "alive", snapshotWin: failingSnap }), true);
  assert.equal(processAlive(6400, T_LIVE, { platform: "win32", probePid: () => "alive", snapshotWin: failingSnap }), true);
  assert.equal(winProcessAlive(6400, T_OLD, { probePid: () => "eperm", snapshotWin: failingSnap }), false);
  assert.equal(processAlive(6400, T_OLD, { platform: "win32", probePid: () => "eperm", snapshotWin: failingSnap }), false);

  // Transient error on refresh after cache miss also keeps accessible live process alive instead of crashing/false-dead.
  assert.equal(
    winProcessAlive(6400, T_LIVE, {
      probePid: () => "alive",
      snapshotWin: maxAgeMs => {
        if (maxAgeMs === 0) throw new Error("PowerShell refresh failed");
        return new Map();
      },
    }),
    true,
  );

  // Lease ticket protection: a transient snapshot error must NOT cause liveTickets to delete a live holder's ticket,
  // whereas an EPERM reused protected PID with a missing row DOES retire the dead holder's ticket.
  const home = await mkdtemp(join(tmpdir(), "dsa-win-snap-lease-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  mkdirSync(join(home, "leases", "gpu"), { recursive: true });
  const jobDir = join(home, "leases", "gpu", ".jobs", "000000000001");
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "group"), JSON.stringify({
    pid: 6404, start: T_CHILD, group: { pid: 6402, start: T_LIVE },
  }));
  const ticket: LeaseTicket = {
    seq: 1, resource: "gpu", mode: "exclusive",
    wrapper: { pid: 6400, start: T_LIVE },
    group: { pid: 6402, start: T_LIVE },
    command: { pid: 6404, start: T_CHILD },
    jobDir,
    argv: ["node", "work.js"], cwd: home, since: 1, grantedAt: 1,
  };
  writeTicketSync(home, ticket);

  // Wrapper dead, job owner + command accessible ("alive"), snapshot throws -> stays live, ticket NOT deleted.
  const kept = liveTickets(home, "gpu", {
    platform: "win32",
    probePid: pid => (pid === 6402 || pid === 6404 ? "alive" : "dead"),
    snapshotWin: failingSnap,
  });
  assert.equal(kept.length, 1);
  assert.equal(existsSync(join(home, "leases", "gpu", "000000000001.json")), true);

  // Wrapper, owner, and command PIDs all reused by protected system processes (EPERM + missing snapshot rows) -> retired!
  const retired = liveTickets(home, "gpu", {
    platform: "win32",
    probePid: () => "eperm",
    snapshotWin: () => new Map(),
  });
  assert.equal(retired.length, 0);
  assert.equal(existsSync(join(home, "leases", "gpu", "000000000001.json")), false);

  // Direct live() check on a ticket whose wrapper PID was reused by a protected process (EPERM + missing row).
  assert.equal(
    live({ ...ticket, group: undefined, jobDir: undefined, command: undefined }, {
      platform: "win32",
      probePid: () => "eperm",
      snapshotWin: () => new Map(),
    }),
    false,
  );
});

test("Windows ProcessTable -> Containment -> fenceAgent reuses scanned CommandLine without extra per-PID PowerShell calls", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-cmdline-reuse-"));
  const journal = await openJournal(join(home, "wf.jsonl"));
  t.after(async () => { await journal.close(); await rm(home, { recursive: true, force: true }); });

  const exec = "01WINCMD@1/a@1#1.1";
  const longArg = "x".repeat(300);
  const rawRows: WinProcessRow[] = [
    { pid: 6400, ppid: 4212, start: T_LIVE, cpuMs: 12, command: `node.exe  host.js ${winTagArg("DSA_EXEC", exec)}` },
    { pid: 6404, ppid: 6400, start: T_CHILD, cpuMs: 3, command: `  node.exe\tworker.js   --long ${longArg}  ` },
    // Protected/unreadable descendant whose CommandLine was observed empty (""): still reused without spawning PowerShell.
    { pid: 6408, ppid: 6404, start: "639000000580000000", cpuMs: 1, command: "" },
    // Unrelated process with an unknown tag: list() clears tag while preserving scannedCommand.
    { pid: 6412, ppid: 6400, start: "639000000590000000", cpuMs: 1, command: `node.exe helper ${winTagArg("DSA_EXEC", "unknown-exec")}` },
  ];

  // Verify ProcessTable attaches scannedCommand non-enumerably (no journal leak) and preserves it across tag clearing.
  const table = new ProcessTable({
    platform: "win32",
    winRows: async () => (aliveInTable ? rawRows : []),
  });
  let aliveInTable = true;
  const listed = await table.list(new Set([exec]), { fresh: true });
  const workerRow = listed.find(p => p.pid === 6404)!;
  const helperRow = listed.find(p => p.pid === 6412)!;
  assert.equal("command" in workerRow, false, "scannedCommand is non-enumerable so tracked journals do not persist argv");
  assert.equal(JSON.stringify(workerRow).includes("worker.js"), false);
  assert.equal(scannedCommand(workerRow), clipWinCommandLine(rawRows[1]!.command!));
  assert.equal(scannedCommand(workerRow)!.length, 200);
  assert.equal(helperRow.tag, undefined, "unknown tag was cleared");
  assert.equal(scannedCommand(helperRow), clipWinCommandLine(rawRows[3]!.command!), "scannedCommand survives tag clearing");

  // Also verify direct attachScannedCommand / plain WinProcessRow command property handling.
  assert.equal(scannedCommand(attachScannedCommand({ pid: 1 }, "  a   b  ")), "a b");
  assert.equal(scannedCommand({ pid: 1, command: "  c\td  " }), "c d");
  assert.equal(scannedCommand({ pid: 1 }), undefined);

  // Full Containment + fenceAgent run: ZERO readCommand calls when ProcessTable already scanned CommandLine.
  const killCalls: WinProcessIdentity[][] = [];
  const extraReads: number[] = [];
  const containment = new Containment(table, {
    platform: "win32",
    killWindows: async targets => {
      killCalls.push(targets.map(x => ({ ...x })));
      aliveInTable = false;
    },
  });

  await fenceAgent(
    containment,
    journal,
    exec,
    [{ pid: 6400, ppid: 4212, start: T_LIVE }],
    { pid: 6400, start: T_LIVE },
    { readCommand: async pid => { extraReads.push(pid); return "should-not-be-called"; } },
  );

  assert.deepEqual(extraReads, [], "scanned CommandLine rows (including empty string) must not trigger per-PID winCommandLine calls");
  assert.equal(killCalls.length, 1);
  assert.deepEqual(killCalls[0]!.map(k => k.pid), [6400, 6404, 6412, 6408]);
  const ended = journal.entries().filter(e => e.type === "ended");
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0]!.procs, [
    { pid: 6404, command: clipWinCommandLine(rawRows[1]!.command!) },
    { pid: 6412, command: clipWinCommandLine(rawRows[3]!.command!) },
    { pid: 6408, command: "" },
  ]);
});

test("endLeaseProcesses retries across transient winSnapshotSync failures and uses probePid", async () => {
  let snaps = 0, killed = false;
  const killedPids: number[] = [];
  const probed: number[] = [];
  const messages: string[] = [];
  const ticket: LeaseTicket = {
    seq: 7, resource: "gpu", mode: "exclusive",
    wrapper: { pid: 100, start: T_LIVE },
    group: { pid: 5500, start: T_LIVE },
    command: { pid: 5504, start: T_CHILD },
    jobDir: "C:\\nonexistent-job-dir-for-snap-retry",
    argv: ["node"], cwd: "C:\\work", since: 1,
  };
  await endLeaseProcesses(ticket, 50, line => messages.push(line), {
    platform: "win32",
    snapshotWin: () => {
      snaps++;
      if (snaps <= 2) throw new Error("transient WMI timeout");
      return killed ? new Map() : new Map([
        [5500, { pid: 5500, ppid: 100, start: T_LIVE, cpuMs: 1 }],
        [5504, { pid: 5504, ppid: 5500, start: T_CHILD, cpuMs: 1 }],
      ]);
    },
    probePid: pid => { probed.push(pid); return killed ? "dead" : "alive"; },
    killOwnerWinSync: targets => { killedPids.push(...targets.map(t => t.pid)); killed = true; },
  });
  assert.ok(snaps >= 3, `expected snapshot retry after transient errors, got ${snaps}`);
  assert.ok(probed.includes(5500), "endLeaseProcesses must consult LeaseCheckOptions.probePid");
  assert.ok(killedPids.includes(5500), "owner was killed even while initial snapshots failed");
  assert.deepEqual(messages, [], "clean retirement after retry must not warn of survivors");
});
