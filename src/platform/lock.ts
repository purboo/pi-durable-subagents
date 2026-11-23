import { spawn } from "node:child_process";
import type { LockHandle, OsLock as Contract } from "../types.ts";
import { powershellPath } from "./windows.ts";

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

export interface LockHelper {
  readonly command: string;
  readonly args: readonly string[];
  /** Pass `path` in `DSA_LOCK_PATH` instead of argv (`powershell.exe -Command` parses trailing argv as script text). */
  readonly pathInEnv?: boolean;
}

const defaultHelpers = (): readonly LockHelper[] => process.platform === "win32"
  ? [{ command: powershellPath(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershell], pathInEnv: true }]
  : [{ command: "perl", args: ["-e", perl] }, { command: "python3", args: ["-c", python] }];

/** The error code of a helper that did not answer in time (a slow or suspended machine): transient, not a broken lock. */
export const LOCK_TIMEOUT = "DSA_LOCK_TIMEOUT";
export function isLockTimeout(error: unknown): boolean { return (error as { code?: unknown } | undefined)?.code === LOCK_TIMEOUT; }

/** C4: A kernel lock held by a helper whose stdin belongs only to the holder: `flock` through perl or python3 on
 *  Linux/macOS, a `FileShare.None` `FileStream` handle through Windows PowerShell on Windows. */
export class OsLock implements Contract {
  /** `timeoutMs` bounds how long the helper may take to answer (3 s on Unix, 15 s on Windows for cold PowerShell
   *  startup; background callers allow 15 s everywhere). */
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
    for (const candidate of this.candidates ?? defaultHelpers()) {
      const args = candidate.pathInEnv ? [...candidate.args] : [...candidate.args, path];
      const env = candidate.pathInEnv ? { ...process.env, DSA_LOCK_PATH: path } : process.env;
      const child = spawn(candidate.command, args, { stdio: "pipe", env, windowsHide: true });
      let errorText = "";
      child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-4096); });
      child.stdin.on("error", () => {});
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", resolve);
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
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
            if (code === 2) return false;
            throw new Error(`C4 lock helper exited (${code}): ${errorText}`);
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`C4 lock helper timeout (${this.timeoutMs} ms)`), { code: LOCK_TIMEOUT })), this.timeoutMs); }),
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
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw new Error(win ? "C4 capability unavailable: PowerShell lock helper was not found" : "C4 capability unavailable: install perl or python3 for flock");
  }
}
