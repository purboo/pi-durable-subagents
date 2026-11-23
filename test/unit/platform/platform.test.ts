import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";
import { OsLock } from "../../../src/platform/lock.ts";
import type { Spawned } from "../../../src/types.ts";

async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = await fn(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Timed out waiting for process evidence");
}
function line(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No child response")), 4000);
    let text = "";
    child.stdout!.on("data", chunk => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); resolve(text.trim()); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Child exited before response")); });
  });
}
async function cleanup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}
const spec = (exec: string, command: string, args: string[]) => ({ exec, command, args, cwd: tmpdir(), env: {} });

test("process table reports identity and CPU; direct spawn fences", { timeout: 20000 }, async () => {
  const c = new Containment(); const tag = randomUUID(); let child: Spawned | undefined;
  try {
    child = await c.spawn(spec(tag, process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    const table = new ProcessTable();
    const p = (await table.list(new Set([tag]))).find(p => p.pid === child!.pid)!;
    assert.equal(p.ppid, process.pid); assert.equal(p.start, child.start);
    // Windows cannot read another process's environment: identity is (pid, creation time) and the tree is the tag.
    if (process.platform !== "win32") assert.equal(p.tag, tag);
    assert.ok(p.cpuMs! >= 0);
    await c.fence(tag, []); assert.ok(await child.exited);
  } finally { await c.fence(tag, []); }
});

test("Windows: the process table answers when the caller's environment holds no system variables", { timeout: 60_000, skip: process.platform === "win32" ? false : "the PowerShell/CIM helpers are Windows-only" }, async () => {
  // Exactly what a chaos/drill/e2e fixture, the evaluator host or a service starter hands the orchestrator: PATH and
  // HOME, but no SystemRoot, TEMP, USERPROFILE, ComSpec or PSModulePath. powershell.exe cannot autoload Get-CimInstance
  // from an empty %SystemRoot%, so this scan used to fail or outlast the fence budget (Fence timeout at its full 15 s).
  const saved = process.env;
  try {
    process.env = { PATH: saved.PATH ?? "", HOME: saved.HOME ?? "C:\\" } as NodeJS.ProcessEnv;
    const started = Date.now();
    const rows = await new ProcessTable().list(new Set(), { fresh: true });
    const ms = Date.now() - started;
    assert.ok(rows.some(row => row.pid === process.pid), "the scan reports this process");
    assert.ok(ms < 10_000, `an isolated environment took ${ms} ms for one process-table scan`);
  } finally { process.env = saved; }
});

test("setsid escaped descendant is fenced by tag after parent SIGKILL", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const tag = randomUUID(); const c = new Containment(); const table = new ProcessTable();
  try {
    const parent = await c.spawn(spec(tag, "/bin/sh", ["-c", "setsid sleep 60 & wait"]));
    const escaped = await until(async () => {
      const p = (await table.list()).find(p => p.tag === tag && p.pid !== parent.pid);
      if (!p) return;
      const stat = await readFile(`/proc/${p.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(fields[3]) === p.pid && stat.includes("(sleep)") ? p : undefined;
    });
    process.kill(parent.pid, "SIGKILL"); await parent.exited;
    assert.ok((await table.list()).some(p => p.pid === escaped.pid));
    await new Containment().fence(tag, []);
    assert.equal((await table.list()).filter(p => p.tag === tag).length, 0);
  } finally { await c.fence(tag, []); }
});

test("tracked identity is fenced after exec clears its tag", { timeout: 10000, skip: process.platform === "win32" ? "needs /bin/sh and DSA_EXEC environment discovery" : false }, async () => {
  const tag = randomUUID(); const c = new Containment(); let tracked: Awaited<ReturnType<ProcessTable["list"]>> = [];
  try {
    const child = await c.spawn(spec(tag, "/bin/sh", ["-c", "read x; exec env -u DSA_EXEC sleep 60"]));
    tracked = (await new ProcessTable().list(new Set([tag]))).filter(p => p.pid === child.pid);
    child.stdin.write("go\n");
    await until(async () => (await new ProcessTable().list(new Set([tag]))).find(p => p.pid === child.pid && p.tag === undefined));
    await new Containment().fence(tag, tracked);
    assert.equal((await child.exited).signal, "SIGKILL");
  } finally { await c.fence(tag, tracked); }
});

test("scan discovers untagged descendants and ignores mismatched start tokens", { timeout: 10000, skip: process.platform === "win32" ? "needs /bin/sh and DSA_EXEC environment discovery" : false }, async () => {
  const tag = randomUUID(); const c = new Containment();
  try {
    const parent = await c.spawn(spec(tag, "/bin/sh", ["-c", "env -u DSA_EXEC /bin/sh -c 'echo $$; exec sleep 60' & wait"]));
    // Linux caches the first observed execution tag for a (pid, start) identity across exec.
    // Start scanning only after the child itself confirms that it has entered the untagged environment.
    let ready = "";
    for await (const chunk of parent.stdout) {
      ready += chunk.toString();
      if (ready.includes("\n")) break;
    }
    assert.match(ready.trim(), /^\d+$/);
    const child = await until(async () => (await c.scan(new Map())).get(tag)?.find(p => p.pid === Number(ready)));
    assert.equal(child.tag, undefined);
    const fresh = new Containment();
    await fresh.fence("nonexistent", [{ ...child, start: "wrong" }]);
    assert.ok((await new ProcessTable().list()).some(p => p.pid === child.pid));
    await c.fence(tag, [child]);
  } finally { await c.fence(tag, []); }
});

test("fence rejects when process-table evidence does not arrive; spawn errors reject", { timeout: 5000 }, async () => {
  const c = new Containment({ list: () => new Promise(() => {}) }, {
    captureStart: async () => "",
    killPosix: () => { throw new Error("unexpected POSIX signal"); },
    killWindows: async () => { throw new Error("unexpected Windows kill"); },
  });
  // The rejection names where the budget went: a scan that never answered is not a process that survived a kill.
  await assert.rejects(c.fence("missing", [], { timeoutMs: 30 }), (error: Error) => {
    assert.match(error.message, /^Fence timeout: missing after \d+ ms of 30 ms \(0 scan\(s\) completed, .*waiting on the scan\)$/);
    return true;
  });
  await assert.rejects(new Containment().spawn(spec(randomUUID(), "/nonexistent-dsa-command", [])), /ENOENT/);
});

test("a fence that only ever skips unconfirmed identities says so instead of blaming a kill", { timeout: 5000 }, async t => {
  // The listed process never confirms its start token (a reused pid on POSIX, or an unverified tagged row on Windows):
  // nothing is signalled, so the timeout must not read as "processes survived SIGKILL". All probes and kill paths are
  // injected seams on a harmless synthetic pid (<= Darwin PID_MAX 99999) so no OS pid is ever inspected or signalled.
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const exec = "w@1/a@1#1.1", fakePid = 42_424;
  const neverKill = {
    killPosix: (pid: number) => assert.fail(`must never signal unconfirmed POSIX pid ${pid}`),
    killWindows: async () => assert.fail("must never terminate unconfirmed Windows target"),
  };

  // 1. Default host platform (exercises the active OS branch without platform override).
  now = 0;
  const hostWin = process.platform === "win32";
  const hostRow = hostWin
    ? { pid: fakePid, ppid: 1, start: "", tag: exec }
    : { pid: fakePid, ppid: 1, start: "recorded-start" };
  const hostTracked = hostWin ? [] : [hostRow];
  const hostContainment = new Containment({ list: async () => { now += 75; return [hostRow]; } }, {
    ...neverKill,
    captureStart: async () => "reused-start",
  });
  await assert.rejects(hostContainment.fence(exec, hostTracked, { timeoutMs: 200 }), (error: Error) => {
    assert.match(error.message, /^Fence timeout: w@1\/a@1#1\.1 after \d+ ms of 200 ms/);
    assert.match(error.message, /[1-9]\d* scan\(s\) completed, slowest \d+ ms, 1 process\(es\) at the last scan, 0 kill\(s\), [1-9]\d* skipped for an unconfirmed identity/);
    if (hostWin) assert.match(error.message, /, unverified identity for pid 42424\)$/);
    return true;
  });

  // 2. POSIX (Darwin/Linux): pre-kill captureStart mismatch and post-beforeKill PID-reuse recheck both count as skips.
  for (const platform of ["darwin", "linux"] as const) {
    now = 0;
    let checks = 0, beforeKillRuns = 0;
    const posixRow = { pid: fakePid, ppid: 1, start: "Sun Oct 4 01:02:03 2026" };
    const posix = new Containment({ list: async () => { now += 75; return [posixRow]; } }, {
      ...neverKill,
      platform,
      // Odd checks confirm before `beforeKill`; even checks see PID reuse right before SIGKILL.
      captureStart: async () => (++checks % 2 === 1 ? posixRow.start : "Sun Oct 4 01:02:09 2026"),
    });
    await assert.rejects(posix.fence(exec, [posixRow], {
      timeoutMs: 200,
      beforeKill: async () => { beforeKillRuns++; },
    }), (error: Error) => {
      assert.match(error.message, /^Fence timeout: w@1\/a@1#1\.1 after \d+ ms of 200 ms/);
      assert.match(error.message, /[1-9]\d* scan\(s\) completed, slowest \d+ ms, 1 process\(es\) at the last scan, 0 kill\(s\), [1-9]\d* skipped for an unconfirmed identity/);
      return true;
    });
    assert.ok(beforeKillRuns >= 1, `${platform}: exercised post-beforeKill identity revalidation`);
  }

  // 3. Windows: a tagged process without a verifiable .NET tick identity is skipped fail-closed with zero kills.
  now = 0;
  const win = new Containment({ list: async () => { now += 75; return [{ pid: fakePid, ppid: 1, start: "", tag: exec }]; } }, {
    ...neverKill,
    platform: "win32",
    captureStart: async () => "",
  });
  await assert.rejects(win.fence(exec, [], { timeoutMs: 200 }), (error: Error) => {
    assert.match(error.message, /^Fence timeout: w@1\/a@1#1\.1 after \d+ ms of 200 ms/);
    assert.match(error.message, /[1-9]\d* scan\(s\) completed, slowest \d+ ms, 1 process\(es\) at the last scan, 0 kill\(s\), [1-9]\d* skipped for an unconfirmed identity.*unverified identity for pid 42424\)$/);
    return true;
  });
});

const lockModule = pathToFileURL(join(process.cwd(), "src/platform/lock.ts")).href;
function holder(path: string): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import {OsLock} from ${JSON.stringify(lockModule)};
    const lock = await new OsLock().tryAcquire(process.argv[1]);
    console.log(lock ? 'yes' : 'no');
    if(lock) { process.stdin.resume(); process.stdin.on('end', async()=>{await lock.release();}); }
  `, path], { stdio: "pipe" });
}

test("OS lock releases on holder SIGKILL and exactly one concurrent acquirer succeeds", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-")); const path = join(dir, "lock");
  const children: ChildProcess[] = []; const lock = new OsLock();
  try {
    const a = holder(path), b = holder(path); children.push(a, b);
    const answers = await Promise.all([line(a), line(b)]);
    assert.deepEqual([...answers].sort(), ["no", "yes"]);
    assert.equal(await lock.tryAcquire(path), null);
    const winner = answers[0] === "yes" ? a : b;
    const helpers = (await new ProcessTable().list()).filter(p => p.ppid === winner.pid);
    assert.equal(helpers.length, 1);
    await cleanup(winner);
    await until(async () => {
      const live = await new ProcessTable().list();
      return helpers.every(helper => !live.some(p => p.pid === helper.pid && p.start === helper.start)) ? true : undefined;
    });
    const next = await until(async () => (await lock.tryAcquire(path)) ?? undefined);
    await next.release(); await next.release();
    const reacquired = await lock.tryAcquire(path); assert.ok(reacquired); await reacquired.release();
    await assert.rejects(lock.tryAcquire(join(dir, "missing", "lock")), /helper exited/);
  } finally {
    await Promise.all(children.map(cleanup));
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #2: a lock helper that does not answer in time fails with the transient timeout code, after the given limit", { timeout: 15000, skip: process.platform === "win32" ? "the Windows lock helper is this Node and cannot be slowed through PATH" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-slow-"));
  try {
    // A perl that never answers (a machine going back to sleep): first on PATH.
    await writeFile(join(dir, "perl"), "#!/bin/sh\nread x\n", { mode: 0o755 });
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {OsLock, isLockTimeout} from ${JSON.stringify(lockModule)};
      const started = Date.now();
      try { await new OsLock(400).tryAcquire(process.argv[1]); console.log('acquired'); }
      catch (error) { console.log(JSON.stringify({ timeout: isLockTimeout(error), message: error.message, ms: Date.now() - started })); }
    `, join(dir, "lock")], { stdio: "pipe", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const out = JSON.parse(await line(child)) as { timeout: boolean; message: string; ms: number };
    assert.equal(out.timeout, true); assert.match(out.message, /^C4 lock helper timeout \(400 ms\)$/);
    assert.ok(out.ms >= 380 && out.ms < 3000, `${out.ms} ms`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("C3 fence never kills a pid whose start differs from the scanned identity (pid reuse)", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const { spawn: spawnChild } = await import("node:child_process");
  const bystander = spawnChild("sleep", ["30"], { stdio: "ignore" });
  await new Promise(resolve => bystander.once("spawn", resolve));
  try {
    // A scan result that names the bystander's pid with another start token: a reused pid, not our process.
    const stale = { pid: bystander.pid!, ppid: 1, start: "1", tag: "exec-reused" };
    let calls = 0;
    const table = { list: async () => (calls++ ? [] : [stale]) };
    await new Containment(table as never).fence("exec-reused", [], { timeoutMs: 2000 });
    assert.equal(bystander.exitCode, null); assert.equal(bystander.signalCode, null);
  } finally { bystander.kill("SIGKILL"); }
});
