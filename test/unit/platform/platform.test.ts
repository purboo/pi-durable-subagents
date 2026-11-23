import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";
import {
  OsLock,
  WIN_LOCK_HELPER_EXE,
  WIN_LOCK_HELPER_SOURCE,
  WIN_LOCK_HELPER_SOURCE_FILE,
  compileWinLockHelper,
  isLockTimeout,
  winLockHelperCacheDirs,
} from "../../../src/platform/lock.ts";
import type { Spawned } from "../../../src/types.ts";

const WAIT_MS = process.platform === "win32" ? 15000 : 4000;
async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) { const value = await fn(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Timed out waiting for process evidence");
}
function line(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No child response")), WAIT_MS);
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

test("OS lock releases on holder SIGKILL and exactly one concurrent acquirer succeeds", { timeout: process.platform === "win32" ? 45000 : 15000 }, async () => {
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

test("issue #2: a lock helper that does not answer in time fails with the transient timeout code, after the given limit", { timeout: 15000, skip: process.platform === "win32" ? "this fixture delays the POSIX perl helper through PATH" : false }, async () => {
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

test("OS lock releases when the helper dies directly, never steals a live lock, and holds an exclusive file on Windows", { timeout: process.platform === "win32" ? 45000 : 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-file-"));
  const path = join(dir, "orch $' (1).lock");
  const table = new ProcessTable();
  const lock = new OsLock();
  const first = holder(path);
  let recovered: Awaited<ReturnType<OsLock["tryAcquire"]>> = null;
  try {
    assert.equal(await line(first), "yes");
    assert.equal((await stat(path)).isFile(), true);
    if (process.platform === "win32") {
      await assert.rejects(open(path, "r"), /EBUSY|EPERM|EACCES/);
      await assert.rejects(rename(path, `${path}.moved`), /EBUSY|EPERM|EACCES/);
      await assert.rejects(unlink(path), /EBUSY|EPERM|EACCES/);
    }
    // Past the old 2 s directory stale window, concurrent contenders still get null and never steal the live lock.
    await delay(2200);
    assert.deepEqual(await Promise.all([lock.tryAcquire(path), lock.tryAcquire(path), lock.tryAcquire(path)]), [null, null, null]);
    // Observe from outside the holder so the snapshot helper itself cannot be selected.
    const helpers = (await table.list(new Set(), { fresh: true })).filter(p => p.ppid === first.pid);
    assert.equal(helpers.length, 1);
    const helper = helpers[0]!;
    process.kill(helper.pid, "SIGKILL");
    await until(async () => {
      const live = await table.list(new Set(), { fresh: true });
      return live.some(p => p.pid === helper.pid && p.start === helper.start) ? undefined : true;
    });
    assert.equal((await stat(path)).isFile(), true);
    recovered = await until(async () => (await lock.tryAcquire(path)) ?? undefined);
    // Releasing the dead first handle is a clean no-op and never disturbs the new holder.
    const released = new Promise(resolve => first.once("exit", resolve));
    first.stdin!.end();
    assert.equal(await released, 0);
    assert.equal(await lock.tryAcquire(path), null);
    await recovered.release();
    recovered = null;
    const handle = await open(path, "r");
    await handle.close();
  } finally {
    await cleanup(first);
    await recovered?.release().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("OS lock classifies access denied and existing directories as errors without deleting unverified paths", { timeout: process.platform === "win32" ? 30000 : 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-unverified-"));
  const lock = new OsLock();
  const dirLock = join(dir, "orchestrator.lock");
  const roLock = join(dir, "readonly.lock");
  try {
    await mkdir(dirLock);
    await writeFile(join(dirLock, "owner.json"), JSON.stringify({ pid: 999999, token: "999999:1" }));
    await writeFile(join(dirLock, "keep.txt"), "unverified");
    const old = new Date(Date.now() - 600_000);
    await utimes(dirLock, old, old);
    await assert.rejects(lock.tryAcquire(dirLock), /C4 lock helper exited \(1\):[\s\S]*open:/i);
    assert.equal((await stat(dirLock)).isDirectory(), true);
    assert.equal(await readFile(join(dirLock, "keep.txt"), "utf8"), "unverified");
    assert.match(await readFile(join(dirLock, "owner.json"), "utf8"), /999999/);

    if (process.platform === "win32" || process.getuid?.() !== 0) {
      await writeFile(roLock, "");
      await chmod(roLock, 0o444);
      try {
        await assert.rejects(lock.tryAcquire(roLock), /C4 lock helper exited \(1\):[\s\S]*open:/i);
      } finally {
        await chmod(roLock, 0o666).catch(() => {});
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OS lock helper protocol covers timeout, malformed response, ENOENT fallback and hung release on every platform", { timeout: 25000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-proto-"));
  try {
    const started = Date.now();
    await assert.rejects(
      new OsLock(300, [{ command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"] }]).tryAcquire(join(dir, "slow.lock")),
      error => isLockTimeout(error) && /^C4 lock helper timeout \(300 ms\)$/.test((error as Error).message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 10000, `${elapsed} ms`);

    await assert.rejects(
      new OsLock(3000, [{ command: process.execPath, args: ["-e", "process.stdout.write('bogus\\n')"] }]).tryAcquire(join(dir, "bad.lock")),
      /Invalid lock helper response/,
    );

    const missing = join(dir, "no-such-lock-helper");
    await assert.rejects(new OsLock(3000, [{ command: missing, args: [] }]).tryAcquire(join(dir, "none.lock")), /^Error: C4 capability unavailable:/);

    const envMarker = join(dir, "seen-path.txt");
    const fallback = new OsLock(3000, [
      { command: missing, args: [] },
      {
        command: process.execPath,
        args: ["--input-type=module", "-e", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(envMarker)}, process.env.DSA_LOCK_PATH ?? ""); process.stdout.write("locked\\n"); setInterval(()=>{}, 1000);`],
        pathInEnv: true,
      },
    ]);
    const target = join(dir, "fallback.lock");
    const held = await fallback.tryAcquire(target);
    assert.ok(held);
    assert.equal(await readFile(envMarker, "utf8"), target);
    const releaseStarted = Date.now();
    await held.release();
    const releaseMs = Date.now() - releaseStarted;
    assert.ok(releaseMs >= 900 && releaseMs < 10000, `hung helper force-killed on release (${releaseMs} ms)`);

    // A candidate marked fallbackOnSpawnError (used for the compiled Windows lock helper) falls back on EACCES too.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const blocked = join(dir, "blocked-helper");
      await writeFile(blocked, "#!/bin/sh\necho locked\n", { mode: 0o644 });
      const eaccesFallback = new OsLock(3000, [
        { command: blocked, args: [], fallbackOnSpawnError: true },
        { command: process.execPath, args: ["-e", "process.stdout.write('locked\\n'); process.stdin.resume();"] },
      ]);
      const h = await eaccesFallback.tryAcquire(join(dir, "eacces.lock"));
      assert.ok(h);
      await h.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows compiled lock helper source, cache dirs, atomic publish and reuse preserve C4 invariants", { timeout: 15000 }, async () => {
  // Pure ASCII C# source holding FileShare.None (never FileShare.Delete) and never deleting/moving unverified paths.
  assert.match(WIN_LOCK_HELPER_SOURCE, /^[\t\n\r\x20-\x7e]*$/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /FileMode\.OpenOrCreate,\s*FileAccess\.ReadWrite,\s*FileShare\.None/);
  assert.doesNotMatch(WIN_LOCK_HELPER_SOURCE, /FileShare\.(Delete|Read|Write)/);
  assert.doesNotMatch(WIN_LOCK_HELPER_SOURCE, /(File|Directory)\.(Delete|Move)/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /-2147024864/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /-2147024863/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /Directory\.Exists/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /DSA_LOCK_PATH/);
  assert.match(WIN_LOCK_HELPER_SOURCE, /108,\s*111,\s*99,\s*107,\s*101,\s*100,\s*10/);

  const dirsA = winLockHelperCacheDirs({ LOCALAPPDATA: "/local", TEMP: "/tmp" }, "x64");
  const dirsB = winLockHelperCacheDirs({ LOCALAPPDATA: "/local", TEMP: "/tmp" }, "ia32");
  assert.equal(dirsA.length, 2);
  assert.ok(dirsA[0]!.startsWith(join("/local", "pi-durable-subagents", "lock-helper", "v1-")));
  assert.ok(dirsA[1]!.startsWith(join("/tmp", "pi-durable-subagents", "lock-helper", "v1-")));
  assert.notEqual(dirsA[0], dirsB[0]);

  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-compile-"));
  const cacheDir = join(dir, "cache");
  const countFile = join(dir, "compile-count");
  const stub = join(dir, "fake-csc.sh");
  try {
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        `printf '1\\n' >> ${JSON.stringify(countFile)}`,
        `[ -f ${JSON.stringify(WIN_LOCK_HELPER_SOURCE_FILE)} ] || exit 11`,
        `printf 'MZ-stub' > DsaLock.build.exe`,
      ].join("\n"),
      { mode: 0o755 },
    );

    // 1. First compile publishes atomically and cleans up its staging dir; retries transient EBUSY.
    let busyOnce = true;
    const first = await compileWinLockHelper(cacheDir, {
      compiler: stub,
      retryMs: 5,
      renameFile: async (from, to) => {
        if (busyOnce) { busyOnce = false; throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); }
        await rename(from, to);
      },
    });
    assert.equal(first, join(cacheDir, WIN_LOCK_HELPER_EXE));
    assert.equal(await readFile(first, "utf8"), "MZ-stub");
    assert.deepEqual(await readdir(cacheDir), [WIN_LOCK_HELPER_EXE]);
    assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);

    // 2. Second call reuses the cached executable without invoking the compiler.
    const second = await compileWinLockHelper(cacheDir, { compiler: stub });
    assert.equal(second, first);
    assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);

    // 3. Concurrent publish race: another process publishes DsaLock.exe while our rename gets EPERM.
    const raceCache = join(dir, "race-cache");
    const raced = await compileWinLockHelper(raceCache, {
      compiler: stub,
      retryMs: 5,
      renameFile: async (_from, to) => {
        await writeFile(to, "MZ-winner");
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    assert.equal(await readFile(raced, "utf8"), "MZ-winner");
    assert.deepEqual(await readdir(raceCache), [WIN_LOCK_HELPER_EXE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
