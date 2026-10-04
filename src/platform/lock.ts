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

/** C4: A kernel flock held by a helper whose stdin belongs only to the holder. */
export class OsLock implements Contract {
  /** C4: Attempt non-blocking exclusion; holder death closes the helper's stdin. */
  async tryAcquire(path: string): Promise<LockHandle | null> {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error(`C4 capability unavailable: ${process.platform}`);
    for (const [command, args] of [["perl", ["-e", perl, path]], ["python3", ["-c", python, path]]] as const) {
      const child = spawn(command, [...args], { stdio: "pipe" });
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
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("C4 lock helper timeout")), 3000); }),
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
    throw new Error("C4 capability unavailable: install perl or python3 for flock");
  }
}
