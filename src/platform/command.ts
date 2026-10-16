// Command calls (CallSpec.command): the launcher. A command runs detached in its own session under a tiny /bin/sh
// wrapper that runs it, then records its exit status atomically in the attempt directory (`exit.tmp`, renamed to `exit`)
// and exits with the same status. Its output (stdout and stderr, interleaved) is appended to `output.log` in the same
// directory through a descriptor the orchestrator opens, passes and closes: no pipe leads back into the orchestrator and
// no node process stays resident for the life of the command, so it outlives the orchestrator that started it.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, open } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { captureStart } from "./proctable.ts";

export const COMMAND_LOG = "output.log";
export const COMMAND_EXIT = "exit";
/** The output a result carries: the last bytes of `output.log`. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

/** The wrapper: `$1` is the attempt directory, the rest the command's argv. The command runs in a subshell, so a shell
 *  builtin as argv[0] (`exit 3`, `exec ...`, `cd ...`) ends the subshell, never the wrapper before it records the status. */
const WRAPPER = 'd=$1; shift; ( "$@" ); s=$?; printf "%s\\n" "$s" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"; exit $s';

export interface CommandSpawn {
  /** The command: an argv array is executed directly, a string runs through `/bin/sh -c`. */
  command: string | readonly string[];
  cwd: string;
  /** The complete environment of the command. */
  env: NodeJS.ProcessEnv;
  /** The attempt directory (absolute): holds output.log and the exit record. */
  dir: string;
}
export interface SpawnedCommand {
  /** The wrapper process (the session leader); `start` is its start token ("" when it ended before it was captured). */
  pid: number; start: string;
  /** Resolves when the wrapper ends while this process runs (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}

/** The argv the wrapper runs. */
export const commandArgv = (command: string | readonly string[]): string[] => typeof command === "string" ? ["/bin/sh", "-c", command] : [...command];

/** Start a command (see the module comment). Rejects when it cannot start (a missing cwd, no /bin/sh). */
export async function spawnCommand(spec: CommandSpawn): Promise<SpawnedCommand> {
  await mkdir(spec.dir, { recursive: true });
  const fd = openSync(join(spec.dir, COMMAND_LOG), "a");
  try {
    const child = spawn("/bin/sh", ["-c", WRAPPER, "dsa-command", spec.dir, ...commandArgv(spec.command)],
      { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", fd, fd] });
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const pid = child.pid!;
    const start = child.exitCode !== null || child.signalCode !== null ? "" : await captureStart(pid).catch(() => "");
    return { pid, start, exited };
  } finally { closeSync(fd); }
}

/** The status the wrapper recorded, or undefined while there is none (the command runs, or ended without one). */
export async function readExitRecord(dir: string): Promise<{ status: number; at: number } | undefined> {
  const path = join(dir, COMMAND_EXIT);
  let text: string, at: number;
  try { [text, at] = await Promise.all([readFile(path, "utf8"), stat(path).then(s => s.mtimeMs)]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const status = Number(text.trim());
  return Number.isInteger(status) && status >= 0 ? { status, at } : undefined;
}

const signalNames = new Map(Object.entries(constants.signals).map(([name, n]) => [n as number, name]));
/** How an exit status reads. The wrapper sees the status of a shell: a command killed by signal N exits 128+N. A command
 *  that itself exits with a status above 128 (`exit 130`) therefore reads as killed by that signal: the two cannot be
 *  told apart from the status alone (the shell convention). */
export function exitMeaning(status: number): { exitCode: number | null; signal: string | null } {
  const name = status > 128 ? signalNames.get(status - 128) : undefined;
  return name ? { exitCode: null, signal: name } : { exitCode: status, signal: null };
}

/** The last `bytes` of a file, starting on a UTF-8 character boundary ("" when it is missing). */
export async function readTail(path: string, bytes = OUTPUT_TAIL_BYTES): Promise<string> {
  const file = await open(path, "r").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!file) return "";
  try {
    const { size } = await file.stat(), from = Math.max(0, size - bytes), buffer = Buffer.alloc(size - from);
    for (let read = 0; read < buffer.length;) { const { bytesRead } = await file.read(buffer, read, buffer.length - read, from + read); if (!bytesRead) break; read += bytesRead; }
    // Skip continuation bytes (10xxxxxx) a cut in the middle of a character left at the start.
    let skip = 0;
    if (from > 0) while (skip < buffer.length && skip < 4 && (buffer[skip]! & 0xc0) === 0x80) skip++;
    return buffer.subarray(skip).toString("utf8");
  } finally { await file.close(); }
}
