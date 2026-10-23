import { spawn } from "node:child_process";
import type { LockHandle, OsLock as Contract } from "../types.ts";

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
/** Windows has no flock. A helper holds an atomically created lock directory; its owner record and a stale reclaim on
 *  the next attempt cover a holder that was killed without releasing. The holder's stdin gives the same release-on-
 *  parent-death property the Unix helpers get from their pipe. */
const node = `import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const path = process.argv[1];
const token = process.pid + ":" + Math.round(performance.timeOrigin);
const owner = join(path, "owner.json");
let held = false;
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function ownerPid() { try { const info = JSON.parse(readFileSync(owner, "utf8")); return info && typeof info.pid === "number" ? info.pid : 0; } catch { return 0; } }
function claim() {
  for (let tries = 0; tries < 20; tries++) {
    try { mkdirSync(path); writeFileSync(owner, JSON.stringify({ pid: process.pid, token })); return true; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = ownerPid();
      // The holder may be between mkdir and its owner write. Wait briefly for the owner record instead of reporting
      // the lock held: a burst of CLI senders would otherwise all miss the same short window.
      for (let wait = 0; !pid && wait < 40; wait++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        pid = ownerPid();
      }
      if (pid && alive(pid)) return false;
      if (!pid) { try { if (Date.now() - statSync(path).mtimeMs < 2000) return false; } catch { /* vanished: retry */ } }
      // A crashed holder left the directory. Rename it aside first: one contender wins the rename, so two cannot both
      // remove and create the same lock.
      const grave = path + ".stale." + process.pid + "." + Math.random().toString(36).slice(2);
      try { renameSync(path, grave); rmSync(grave, { recursive: true, force: true }); } catch { /* another contender */ }
    }
  }
  return false;
}
function release() {
  if (!held) return;
  held = false;
  try { const info = JSON.parse(readFileSync(owner, "utf8")); if (info.token !== token) return; } catch { return; }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* gone */ }
}
if (!claim()) process.exit(2);
held = true;
process.on("exit", release);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, () => { release(); process.exit(0); });
process.stdout.write("locked\\n");
process.stdin.resume();
process.stdin.on("end", () => { release(); process.exit(0); });
`;
const helpers = () => process.platform === "win32"
  ? [[process.execPath, ["--input-type=module", "-e", node]] as const]
  : [["perl", ["-e", perl]] as const, ["python3", ["-c", python]] as const];

/** The error code of a helper that did not answer in time (a slow or suspended machine): transient, not a broken lock. */
export const LOCK_TIMEOUT = "DSA_LOCK_TIMEOUT";
export function isLockTimeout(error: unknown): boolean { return (error as { code?: unknown } | undefined)?.code === LOCK_TIMEOUT; }

/** C4: A kernel flock held by a helper whose stdin belongs only to the holder. */
export class OsLock implements Contract {
  /** `timeoutMs` bounds how long the helper may take to answer (3 s by default; background callers allow more). */
  private readonly timeoutMs: number;
  constructor(timeoutMs = 3000) { this.timeoutMs = timeoutMs; }
  /** C4: Attempt non-blocking exclusion; holder death closes the helper's stdin. */
  async tryAcquire(path: string): Promise<LockHandle | null> {
    const win = process.platform === "win32";
    if (!win && process.platform !== "linux" && process.platform !== "darwin") throw new Error(`C4 capability unavailable: ${process.platform}`);
    // The helper runs on the orchestrator's own Node on Windows: no perl/python3 is installed by default there.
    for (const [command, args] of helpers().map(([c, a]) => [c, [...a, path]] as const)) {
      const child = spawn(command, [...args], { stdio: "pipe", windowsHide: true });
      let errorText = "";
      child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-4096); });
      child.stdin.on("error", () => {});
      const ended = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", resolve);
      });
      void ended.catch(() => {});
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
          ended.then(code => {
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
          try { await ended; } finally { clearTimeout(kill); }
        })() };
      } catch (error) {
        child.kill("SIGKILL");
        await ended.catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw new Error(process.platform === "win32" ? "C4 capability unavailable: the lock helper did not start" : "C4 capability unavailable: install perl or python3 for flock");
  }
}
