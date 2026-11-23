import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LockHandle, OsLock as Contract } from "../types.ts";
import { frameworkCompiler } from "./job.ts";
import { envValue, helperEnv, mergeEnv, powershellPath } from "./windows.ts";

const perl = `use Fcntl qw(:flock); $|=1;
open(my $f, ">>", $ARGV[0]) or do { warn "open: $!"; exit 1; };
if (!flock($f, LOCK_EX|LOCK_NB)) { exit 2 if $!{EWOULDBLOCK} || $!{EAGAIN}; warn "flock: $!"; exit 1; }
print "locked\\n"; my $buf; 1 while sysread(STDIN, $buf, 4096);`;
const python = `import sys,fcntl,errno
f=open(sys.argv[1], 'a')
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except OSError as e:
 if e.errno in (errno.EAGAIN,errno.EACCES): sys.exit(2)
 raise
print('locked',flush=True)
while sys.stdin.buffer.read(4096): pass
`;
/** Windows has no flock, Node's fs.open shares files on Win32, and foreign PID checks can race PID reuse or fail to
 *  prove handle ownership. PowerShell opens the lock file with .NET FileStream and FileShare.None (dwShareMode = 0), so
 *  the Windows kernel refuses every other open, rename or delete while the handle lives and releases it at once when
 *  the helper dies (C4). Only Win32 sharing/lock violations (0x80070020 / 0x80070021) exit 2 (held); access denied, an
 *  existing directory at the lock path or a missing parent directory exits 1 without deleting or renaming anything. */
const powershell =
  "$ErrorActionPreference = 'Stop'; " +
  "$p = $env:DSA_LOCK_PATH; " +
  "if ([string]::IsNullOrEmpty($p)) { [System.Console]::Error.WriteLine('open: empty lock path'); [System.Environment]::Exit(1) }; " +
  "try { " +
  "$fs = [System.IO.FileStream]::new($p, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) " +
  "} catch { " +
  "$e = $_.Exception; " +
  "while ($e -and -not ($e -is [System.IO.IOException]) -and $e.InnerException) { $e = $e.InnerException }; " +
  "$hr = if ($e) { [int]$e.HResult } else { 0 }; " +
  "if ($e -is [System.IO.IOException] -and ($hr -eq -2147024864 -or $hr -eq -2147024863)) { [System.Environment]::Exit(2) }; " +
  "try { " +
  "if ([System.IO.Directory]::Exists($p)) { [System.Console]::Error.WriteLine(\"open: lock path is a directory: $p\"); [System.Environment]::Exit(1) }; " +
  "$msg = if ($e) { \"$($e.GetType().Name) (0x$($hr.ToString('x8'))): $($e.Message)\" } else { \"$_\" }; " +
  "[System.Console]::Error.WriteLine(\"open: $msg\") " +
  "} catch {}; " +
  "[System.Environment]::Exit(1) " +
  "}; " +
  "try { " +
  "$out = [System.Console]::OpenStandardOutput(); " +
  "$out.Write([byte[]](108,111,99,107,101,100,10), 0, 7); " +
  "$out.Flush(); " +
  "$in = [System.Console]::OpenStandardInput(); " +
  "while ($in.ReadByte() -ge 0) {} " +
  "} catch {}; " +
  "try { $fs.Close() } catch {}; " +
  "[System.GC]::KeepAlive($fs); " +
  "[System.Environment]::Exit(0)";

/** Compiled .NET Framework helper for Windows: identical C4 FileShare.None handle semantics to the PowerShell fallback
 *  below, but avoids cold PowerShell startup on every lock acquisition (tens of ms instead of seconds). Pure ASCII so
 *  csc.exe parses identically under any code page; lock path arrives via UTF-16 environment variable DSA_LOCK_PATH. */
export const WIN_LOCK_HELPER_EXE = "DsaLock.exe";
export const WIN_LOCK_HELPER_SOURCE_FILE = "DsaLock.cs";
export const WIN_LOCK_HELPER_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DsaLock
{
    static void WriteError(string message)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(message + "\\n");
            Stream stderr = Console.OpenStandardError();
            stderr.Write(bytes, 0, bytes.Length);
            stderr.Flush();
        }
        catch { }
    }

    public static int Main()
    {
        string p = Environment.GetEnvironmentVariable("DSA_LOCK_PATH");
        if (string.IsNullOrEmpty(p))
        {
            WriteError("open: empty lock path");
            return 1;
        }
        FileStream fs = null;
        try
        {
            fs = new FileStream(p, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (Exception ex)
        {
            Exception e = ex;
            while (e != null && !(e is IOException) && e.InnerException != null) e = e.InnerException;
            int hr = e != null ? Marshal.GetHRForException(e) : 0;
            if (e is IOException && (hr == -2147024864 || hr == -2147024863)) return 2;
            try
            {
                if (Directory.Exists(p))
                {
                    WriteError("open: lock path is a directory: " + p);
                    return 1;
                }
                string msg = e != null
                    ? e.GetType().Name + " (0x" + hr.ToString("x8") + "): " + e.Message
                    : ex.ToString();
                WriteError("open: " + msg);
            }
            catch { }
            return 1;
        }
        try
        {
            Stream stdout = Console.OpenStandardOutput();
            byte[] locked = new byte[] { 108, 111, 99, 107, 101, 100, 10 };
            stdout.Write(locked, 0, locked.Length);
            stdout.Flush();
            Stream stdin = Console.OpenStandardInput();
            byte[] buf = new byte[64];
            while (stdin.Read(buf, 0, buf.Length) > 0) { }
        }
        catch { }
        finally
        {
            try { if (fs != null) fs.Close(); } catch { }
            GC.KeepAlive(fs);
        }
        return 0;
    }
}
`;

export interface LockHelper {
  readonly command: string;
  readonly args: readonly string[];
  /** Pass `path` in `DSA_LOCK_PATH` instead of argv (`powershell.exe -Command` parses trailing argv as script text). */
  readonly pathInEnv?: boolean;
  /** Fall through to the next candidate on any spawn error (e.g. AppLocker/AV EACCES on a cached compiled helper). */
  readonly fallbackOnSpawnError?: boolean;
  /** Self-heal a corrupt cached compiled helper when it crashes without an `open: ` lock-path diagnostic. */
  readonly selfHealOnCrash?: boolean;
}

function readyExecutable(exe: string): boolean {
  try {
    const info = statSync(exe);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** Content-addressed user-private cache directories for the compiled Windows lock helper (`%LOCALAPPDATA%` first, then
 *  `DSA_HOME` when `LOCALAPPDATA` is absent in a stripped environment; never a shared temp directory). Returns empty when
 *  neither is set so callers fall back to PowerShell. */
export function winLockHelperCacheDirs(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): string[] {
  const hash = createHash("sha256").update(WIN_LOCK_HELPER_SOURCE).update("\0").update(arch).digest("hex").slice(0, 16);
  const dirs: string[] = [];
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) dirs.push(join(localAppData, "pi-durable-subagents", "lock-helper", `v1-${hash}`));
  const dsaHome = envValue(env, "DSA_HOME");
  if (dsaHome) {
    const candidate = join(dsaHome, "cache", "lock-helper", `v1-${hash}`);
    if (!dirs.includes(candidate)) dirs.push(candidate);
  }
  return dirs;
}

/** Sub-budget reserved for compiling the Windows lock helper so the PowerShell fallback always retains at least ~2/3 of
 *  the caller's `timeoutMs` budget. */
export function winLockHelperCompileBudget(budgetMs: number): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 0;
  return Math.min(5_000, Math.floor(budgetMs / 3));
}

/** Cooldown before retrying a failed Windows lock helper compile/spawn/crash (permanent disable is only for missing `csc.exe`). */
export const WIN_LOCK_HELPER_COOLDOWN_MS = 60_000;

function abortError(): NodeJS.ErrnoException {
  return Object.assign(new Error("lock helper compile aborted"), { code: "ABORT_ERR", name: "AbortError", killed: true });
}

function isMissingCompilerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { compilerMissing?: boolean; code?: string };
  return e.compilerMissing === true;
}

/** Compile and atomically publish `DsaLock.exe` into `cacheDir` (reusing an existing binary immediately). Safe under
 *  concurrent multi-process compilation: each builder compiles in a private staging dir and accepts an already-published
 *  binary if another process won the publish race. */
export async function compileWinLockHelper(
  cacheDir: string,
  options: {
    compiler?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    arch?: string;
    renameFile?: (from: string, to: string) => Promise<void>;
    publishMs?: number;
    retryMs?: number;
  } = {},
): Promise<string> {
  const exe = join(cacheDir, WIN_LOCK_HELPER_EXE);
  if (readyExecutable(exe)) return exe;
  if (options.signal?.aborted) throw abortError();
  await mkdir(cacheDir, { recursive: true });
  if (readyExecutable(exe)) return exe;
  const effectiveEnv = options.env ?? helperEnv();
  let compiler: string;
  try {
    compiler = options.compiler ?? frameworkCompiler(effectiveEnv, options.arch ?? process.arch);
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { compilerMissing: true },
    );
  }
  const stage = join(cacheDir, `build-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`);
  const build = "DsaLock.build.exe";
  await mkdir(stage, { recursive: true });
  try {
    if (options.signal?.aborted) throw abortError();
    await writeFile(join(stage, WIN_LOCK_HELPER_SOURCE_FILE), WIN_LOCK_HELPER_SOURCE, "utf8");
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) { reject(abortError()); return; }
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const child = execFile(
        compiler,
        ["/nologo", "/optimize+", "/codepage:65001", "/target:exe", `/out:${build}`, WIN_LOCK_HELPER_SOURCE_FILE],
        {
          cwd: stage,
          windowsHide: true,
          env: effectiveEnv,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) { done(resolve); return; }
          const code = (error as NodeJS.ErrnoException).code;
          const detail = String(stderr || stdout || "").trim().replace(/\s+/g, " ").slice(0, 200);
          const wrapped = Object.assign(
            new Error(`lock helper compile failed: ${error.message}${detail ? `: ${detail}` : ""}`),
            {
              killed: (error as { killed?: boolean }).killed,
              code,
              compilerMissing: code === "ENOENT" && !stderr && !stdout,
            },
          );
          done(() => reject(wrapped));
        },
      );
      const terminateChild = () => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      };
      const onAbort = () => {
        terminateChild();
        done(() => reject(abortError()));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options.timeoutMs ?? 30_000;
      const killTimer = setTimeout(() => {
        terminateChild();
        done(() => reject(Object.assign(new Error(`lock helper compile timed out (${timeout} ms)`), { killed: true, code: "ETIMEDOUT" })));
      }, Math.max(1, timeout));
      killTimer.unref();
    });
    if (options.signal?.aborted) throw abortError();
    const built = join(stage, build);
    const renameFile = options.renameFile ?? rename;
    const deadline = Date.now() + (options.publishMs ?? 5_000);
    const retryMs = options.retryMs ?? 50;
    for (;;) {
      if (options.signal?.aborted) throw abortError();
      if (readyExecutable(exe)) return exe;
      try {
        await renameFile(built, exe);
        if (readyExecutable(exe)) return exe;
        throw new Error(`lock helper executable missing after publish: ${exe}`);
      } catch (error) {
        if (readyExecutable(exe)) return exe;
        const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
        if (!["EBUSY", "EPERM", "EACCES", "EAGAIN", "EEXIST"].includes(code) || Date.now() + retryMs >= deadline) {
          throw error;
        }
        await new Promise<void>(r => {
          const onAbort = () => { clearTimeout(waitTimer); r(); };
          const waitTimer = setTimeout(() => { options.signal?.removeEventListener("abort", onAbort); r(); }, retryMs);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}

let cachedWinHelper: string | undefined;
let winHelperDisabled = false;
let winHelperCooldownUntil = 0;
let winHelperInFlight: {
  promise: Promise<string | undefined>;
  controller: AbortController;
  waiters: number;
} | undefined;

/** Test seam: reset module-level cached Windows lock helper state. */
export function resetWinLockHelperState(): void {
  cachedWinHelper = undefined;
  winHelperDisabled = false;
  winHelperCooldownUntil = 0;
  if (winHelperInFlight) {
    winHelperInFlight.controller.abort();
    winHelperInFlight = undefined;
  }
}

export interface ResolveWinLockHelperOptions {
  env?: NodeJS.ProcessEnv;
  arch?: string;
  compiler?: string;
  now?: () => number;
  cooldownMs?: number;
  compile?: (cacheDir: string, options: { compiler?: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; arch?: string }) => Promise<string>;
}

/** Resolve or compile the cached Windows lock helper within the reserved sub-budget so PowerShell fallback keeps the
 *  majority of `budgetMs`. Transient failures apply a cooldown; only a missing compiler disables permanently. */
export async function resolveWinLockHelper(budgetMs: number, options: ResolveWinLockHelperOptions = {}): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? WIN_LOCK_HELPER_COOLDOWN_MS;
  if (cachedWinHelper && readyExecutable(cachedWinHelper)) return cachedWinHelper;
  cachedWinHelper = undefined;
  if (winHelperDisabled) return undefined;
  if (now() < winHelperCooldownUntil) return undefined;
  const dirs = winLockHelperCacheDirs(options.env, options.arch);
  if (!dirs.length) return undefined;
  for (const dir of dirs) {
    const exe = join(dir, WIN_LOCK_HELPER_EXE);
    if (readyExecutable(exe)) {
      cachedWinHelper = exe;
      return exe;
    }
  }
  const compileBudget = winLockHelperCompileBudget(budgetMs);
  if (compileBudget <= 0) return undefined;
  if (!winHelperInFlight) {
    const controller = new AbortController();
    const compileFn = options.compile ?? compileWinLockHelper;
    const entry = {
      controller,
      waiters: 0,
      promise: (async () => {
        let missingCompiler = false;
        let aborted = false;
        for (const dir of dirs) {
          if (controller.signal.aborted) { aborted = true; break; }
          try {
            const exe = await compileFn(dir, {
              ...(options.compiler !== undefined ? { compiler: options.compiler } : {}),
              timeoutMs: compileBudget,
              signal: controller.signal,
              ...(options.env !== undefined ? { env: options.env } : {}),
              ...(options.arch !== undefined ? { arch: options.arch } : {}),
            });
            cachedWinHelper = exe;
            return exe;
          } catch (error) {
            if (isMissingCompilerError(error)) {
              missingCompiler = true;
            } else if (controller.signal.aborted || (error as { name?: string; code?: string } | undefined)?.name === "AbortError" || (error as { code?: string } | undefined)?.code === "ABORT_ERR") {
              aborted = true;
            }
          }
        }
        if (missingCompiler) {
          winHelperDisabled = true;
        } else if (!aborted) {
          winHelperCooldownUntil = Math.max(winHelperCooldownUntil, now() + cooldownMs);
        }
        return undefined;
      })().finally(() => {
        if (winHelperInFlight === entry) winHelperInFlight = undefined;
      }),
    };
    winHelperInFlight = entry;
  }
  const active = winHelperInFlight;
  active.waiters += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      active.promise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(undefined); }, compileBudget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    active.waiters -= 1;
    if (timedOut && active.waiters <= 0) {
      // Kill and unref the timed-out compiler so short-lived CLI processes never hang after falling back to PowerShell.
      active.controller.abort();
      winHelperCooldownUntil = Math.max(winHelperCooldownUntil, now() + cooldownMs);
    }
  }
}

const powershellHelper = (): LockHelper => ({
  command: powershellPath(),
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershell],
  pathInEnv: true,
});

const defaultHelpers = async (budgetMs: number): Promise<readonly LockHelper[]> => {
  if (process.platform === "win32") {
    const exe = await resolveWinLockHelper(budgetMs);
    const ps = powershellHelper();
    return exe ? [{ command: exe, args: [], pathInEnv: true, fallbackOnSpawnError: true, selfHealOnCrash: true }, ps] : [ps];
  }
  return [{ command: "perl", args: ["-e", perl] }, { command: "python3", args: ["-c", python] }];
};

/** The error code of a helper that did not answer in time (a slow or suspended machine): transient, not a broken lock. */
export const LOCK_TIMEOUT = "DSA_LOCK_TIMEOUT";
export function isLockTimeout(error: unknown): boolean { return (error as { code?: unknown } | undefined)?.code === LOCK_TIMEOUT; }

/** C4: A kernel lock held by a helper whose stdin belongs only to the holder: `flock` through perl or python3 on
 *  Linux/macOS, a `FileShare.None` `FileStream` handle through a cached compiled .NET Framework helper (with Windows
 *  PowerShell fallback) on Windows. */
export class OsLock implements Contract {
  /** `timeoutMs` bounds how long the helper may take to answer (3 s on Unix, 15 s on Windows for cold helper compile or
   *  PowerShell fallback startup; background callers allow 15 s everywhere). */
  private readonly timeoutMs: number;
  private readonly candidates?: readonly LockHelper[];
  constructor(timeoutMs = process.platform === "win32" ? 15_000 : 3000, candidates?: readonly LockHelper[]) {
    this.timeoutMs = timeoutMs;
    this.candidates = candidates;
  }
  /** C4: Attempt non-blocking exclusion; holder death closes the helper's stdin. */
  async tryAcquire(path: string): Promise<LockHandle | null> {
    const win = process.platform === "win32";
    if (!this.candidates && !win && process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error(`C4 capability unavailable: ${process.platform}`);
    }
    const deadline = performance.now() + this.timeoutMs;
    const candidates = this.candidates ?? await defaultHelpers(this.timeoutMs);
    for (const candidate of candidates) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        throw Object.assign(new Error(`C4 lock helper timeout (${this.timeoutMs} ms)`), { code: LOCK_TIMEOUT });
      }
      const args = candidate.pathInEnv ? [...candidate.args] : [...candidate.args, path];
      const env = candidate.pathInEnv
        ? (win ? mergeEnv(helperEnv(), { DSA_LOCK_PATH: path }) : { ...process.env, DSA_LOCK_PATH: path })
        : process.env;
      const child = spawn(candidate.command, args, { stdio: "pipe", env, windowsHide: true });
      let errorText = "";
      let spawnFailed = false;
      let exitCode: number | null | undefined;
      child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-4096); });
      child.stdin.on("error", () => {});
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", error => { spawnFailed = true; reject(error); });
        child.once("exit", resolve);
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", error => { spawnFailed = true; reject(error); });
        child.once("close", resolve);
      });
      void exited.catch(() => {});
      void closed.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const acquired = await Promise.race([
          new Promise<true>((resolve, reject) => {
            let output = "";
            child.stdout.on("data", chunk => {
              output += chunk;
              if (output === "locked\n") resolve(true);
              else if (output.includes("\n")) reject(new Error("Invalid lock helper response"));
            });
          }),
          closed.then(code => {
            exitCode = code;
            if (code === 2) return false;
            throw new Error(`C4 lock helper exited (${code}): ${errorText}`);
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`C4 lock helper timeout (${this.timeoutMs} ms)`), { code: LOCK_TIMEOUT })), remaining); }),
        ]);
        if (!acquired) return null;
        let release: Promise<void> | undefined;
        return { release: () => release ??= (async () => {
          child.stdin.end();
          const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
          try { await exited; } finally { clearTimeout(kill); }
        })() };
      } catch (error) {
        child.kill("SIGKILL");
        await exited.catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || (spawnFailed && candidate.fallbackOnSpawnError)) {
          if (candidate.command === cachedWinHelper) cachedWinHelper = undefined;
          if (candidate.selfHealOnCrash) {
            if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
              winHelperCooldownUntil = Math.max(winHelperCooldownUntil, Date.now() + WIN_LOCK_HELPER_COOLDOWN_MS);
            } else if (code !== "ENOENT") {
              await rm(candidate.command, { force: true }).catch(() => {});
              winHelperCooldownUntil = Math.max(winHelperCooldownUntil, Date.now() + WIN_LOCK_HELPER_COOLDOWN_MS);
            }
          }
          continue;
        }
        if (candidate.selfHealOnCrash && !isLockTimeout(error) && typeof exitCode === "number" && exitCode !== 0 && exitCode !== 2 && !errorText.startsWith("open: ")) {
          if (candidate.command === cachedWinHelper) cachedWinHelper = undefined;
          await rm(candidate.command, { force: true }).catch(() => {});
          winHelperCooldownUntil = Math.max(winHelperCooldownUntil, Date.now() + WIN_LOCK_HELPER_COOLDOWN_MS);
          continue;
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw new Error(win ? "C4 capability unavailable: PowerShell lock helper was not found" : "C4 capability unavailable: install perl or python3 for flock");
  }
}
