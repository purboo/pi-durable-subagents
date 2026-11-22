// Command calls (CallSpec.command): the launcher. On Unix a command runs detached in its own session under a tiny
// /bin/sh wrapper that runs it, then records its exit status atomically in the attempt directory (`exit.tmp`, renamed
// to `exit`) and exits with the same status. Windows has no /bin/sh: the same wrapper is a short Node program (Node is
// already the runtime), and a string command runs through the command's `ComSpec` (cmd.exe by default). Its output (stdout and stderr, interleaved) is
// appended to `output.log` in the same directory through a descriptor the orchestrator opens, passes and closes: no
// pipe leads back into the orchestrator and no node process stays resident for the life of the command, so it outlives
// the orchestrator that started it.
//
// On Windows the wrapper also runs inside a Windows Job Object of its own (platform/job.ts): the wrapper is the group's
// root, created suspended and assigned before its first instruction, and the group's only handle dies with the owner --
// a small .NET Framework winexe compiled per launch with the framework's own csc.exe. A command attempt therefore cannot
// leave descendants behind, and a scan that finds the wrapper gone finds the group closed: no second attempt starts
// while processes of the first can still act. The attempt's `exec` tag goes into the owner's own command line as well,
// so the attempt is findable while the owner is still starting -- the window between the recorded intent and the group
// record, where the wrapper does not exist yet. The owner is compiled during the start, so `proceed` is checked again
// after the compilation and immediately before the spawn: a stop that arrived while the compiler ran starts nothing.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, open, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { captureStart } from "./proctable.ts";
import { execTarget, findOnPath } from "./launch.ts";
import { spawnInJob } from "./job.ts";
import { comspec, envValue, IS_WINDOWS, mergeEnv, normalizeEnv, winTagArg } from "./windows.ts";

export const COMMAND_LOG = "output.log";
export const COMMAND_EXIT = "exit";
/** What the Windows wrapper reads: the command, its cwd and its complete environment (a command line can be long and
 *  contain anything, so it is a file, not argv). */
export const COMMAND_SPEC = "command.json";
/** The Windows wrapper itself, written into the attempt directory before each spawn (Node runs a file, not a URL). */
export const COMMAND_WRAPPER = "wrapper.mjs";
/** The output a result carries: the last bytes of `output.log`. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

/** The wrapper: `$1` is the attempt directory, `$2` the absolute `mv`, the rest the command's argv. Its own steps use
 *  only shell builtins and that absolute `mv` with every expansion quoted, so they work under any environment the
 *  command gets (PATH unset or bogus, IFS, LC_*). The argv runs through `exec` in a subshell: it is always a program
 *  (looked up on the command's PATH; a shell builtin name such as `exit` is no builtin there, 127 when no program has
 *  it), and its end, however it comes, never skips recording the status. A program named by a path that does not exist
 *  is 127 before `exec`: some shells (bash 3.2, the macOS /bin/sh) report 126 for it instead. */
const WRAPPER = 'd="$1"; m="$2"; shift 2; ( case "$1" in (*/*) [ -e "$1" ] || { printf "%s: %s: not found\\n" "$0" "$1" >&2; exit 127; } ;; esac; exec "$@" ); s="$?"; printf "%s\\n" "$s" > "$d/exit.tmp" && "$m" -f "$d/exit.tmp" "$d/exit"; exit "$s"';
/** Windows wrapper: `argv[2]` is the attempt directory (its command.json holds the command, cwd and environment).
 *  It runs the child with inherited output descriptors, records the status and exits with it. It merges the environment
 *  by Windows name, not by spelling: `Path`/`PATH`, `ComSpec`/`COMSPEC` and `PATHEXT`/`PathExt` are one variable each, the
 *  command's own definition wins (the wrapper process's only fills in a name the command lacks), and the block the child
 *  gets never carries a name twice. The string command runs through the command's `ComSpec`, not this process's. */
const WIN_WRAPPER = `import { spawn } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const spec = JSON.parse(readFileSync(join(dir, "${COMMAND_SPEC}"), "utf8"));
try { unlinkSync(join(dir, "${COMMAND_SPEC}")); } catch { /* already gone */ }
function record(status) {
  try { writeFileSync(join(dir, "exit.tmp"), String(status)); renameSync(join(dir, "exit.tmp"), join(dir, "exit")); } catch { /* never lose the command's own result */ }
}
function value(env, name) { const lower = name.toLowerCase(); let found; for (const key of Object.keys(env)) if (key.toLowerCase() === lower) found = env[key]; return found; }
function put(env, name, val) { const lower = name.toLowerCase(); for (const key of Object.keys(env)) if (key.toLowerCase() === lower) delete env[key]; env[name] = val; }
const shell = value(spec.env, "ComSpec") || value(process.env, "ComSpec") || "cmd.exe";
// The command's block by name: one PATH (also when the call spelled it Path), one ComSpec, one PATHEXT.
const env = {};
for (const key of Object.keys(spec.env)) put(env, key, spec.env[key]);
put(env, "ComSpec", shell);
put(env, "PATHEXT", value(spec.env, "PATHEXT") || value(process.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD");
const options = { cwd: spec.cwd, env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true };
let child;
try { child = typeof spec.command === "string" ? spawn(spec.command, { ...options, shell }) : spawn(spec.command[0], spec.command.slice(1), options); }
catch (error) { const status = error && error.code === "ENOENT" ? 127 : 126; record(status); process.exit(status); }
child.once("error", error => { const status = error && error.code === "ENOENT" ? 127 : 126; record(status); process.exit(status); });
child.once("exit", (code, signal) => { const status = code === null ? (signal ? 128 : 1) : code; record(status); process.exit(status); });
`;
/** The wrapper's source (it is written into the attempt directory as `COMMAND_WRAPPER`): exported so its own environment
 *  merge and exit record can be exercised on a host that is not Windows. */
export const COMMAND_WRAPPER_SOURCE = WIN_WRAPPER;

/** `mv` for the wrapper: from this process's PATH, else /bin or /usr/bin; resolved once. */
let mvPath: string | undefined;
export function resolveMv(PATH = process.env.PATH): string {
  mvPath ??= findOnPath("mv", PATH) ?? findOnPath("mv", "/bin:/usr/bin") ?? "/bin/mv";
  return mvPath;
}

export interface CommandSpawn {
  /** The command: an argv array is executed directly, a string runs through `/bin/sh -c`. */
  command: string | readonly string[];
  cwd: string;
  /** The complete environment of the command. */
  env: NodeJS.ProcessEnv;
  /** The attempt directory (absolute): holds output.log and the exit record. */
  dir: string;
  /** The execution tag, written into the Windows wrapper's command line (its environment is unreadable elsewhere). */
  exec?: string;
  /** The last check, synchronous, after every preparation and immediately before the spawn (no await between them):
   *  false starts no process (spawnCommand resolves undefined). On Windows the preparation includes compiling the Job
   *  Object owner, so the check is made twice: before the compilation and again after it, immediately before the spawn. */
  proceed?: () => boolean;
}
export interface SpawnedCommand {
  /** The wrapper process (the session leader); `start` is its start token ("" when it ended before it was captured). */
  pid: number; start: string;
  /** Windows: the job host (compiled owner) that holds the attempt's kernel group. Its identity is tracked with the
   *  wrapper's, so a scan finds the whole group and its absence proves the group is closed (see platform/job.ts). */
  group?: { pid: number; start: string };
  /** Windows: the attempt was started but its owner could not be confirmed retired (platform/job.ts). `pid`/`start` are
   *  then the owner's identity; the attempt must be watched until a scan confirms it retired, never started again. */
  uncertain?: string;
  /** Resolves when the wrapper ends while this process runs (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}

/** The argv the wrapper runs: an argv as given (a program, never shell syntax), a string through the platform shell. */
export const commandArgv = (command: string | readonly string[]): string[] =>
  typeof command === "string" ? [IS_WINDOWS ? comspec() : "/bin/sh", "-c", command] : [...command];

/** Start a command (see the module comment). Rejects when it cannot start (a missing cwd, no /bin/sh); undefined when
 *  `proceed` said no. */
export async function spawnCommand(spec: CommandSpawn & { proceed: () => boolean }): Promise<SpawnedCommand | undefined>;
export async function spawnCommand(spec: CommandSpawn): Promise<SpawnedCommand>;
export async function spawnCommand(spec: CommandSpawn): Promise<SpawnedCommand | undefined> {
  await mkdir(spec.dir, { recursive: true });
  const fd = openSync(join(spec.dir, COMMAND_LOG), "a");
  try {
    if (IS_WINDOWS) {
      // A command line can be long and contain anything: pass it through a file, not argv. An argv whose program is a
      // .cmd/.bat shim is unwrapped here, before it is recorded, so the child runs the program its shim names. A bare
      // program is resolved on the command's own PATH (the spec env, with the call's shim directory), never this
      // process's. The environment it runs with is one Windows block: one `PATH` (also when the call spelled it `Path`),
      // one `ComSpec`, one `PATHEXT`.
      const inherited = normalizeEnv(spec.env);
      const env = mergeEnv(inherited, { ComSpec: envValue(inherited, "ComSpec") || comspec(inherited),
        PATHEXT: envValue(inherited, "PATHEXT") || ".COM;.EXE;.BAT;.CMD" });
      const command = typeof spec.command === "string" ? spec.command : (() => { const target = execTarget(spec.command[0]!, spec.command.slice(1), { env }); return [target.command, ...target.args]; })();
      await writeFile(join(spec.dir, COMMAND_SPEC), JSON.stringify({ command, cwd: spec.cwd, env }));
      await writeFile(join(spec.dir, COMMAND_WRAPPER), COMMAND_WRAPPER_SOURCE);
      // An already revoked permission never compiles; spawnInJob checks again after the compilation, immediately before
      // the spawn (a stop or retirement that arrived while the compiler ran still starts no process).
      if (spec.proceed && !spec.proceed()) return undefined;
      // The wrapper's environment as a direct spawn would give it; the command inside still gets command.json's env.
      // spawnInJob compiles the Job Object owner (bounded, foreground, no process of the attempt) and resolves undefined
      // when its post-compilation check refuses.
      return await spawnInJob(spec.dir, { exe: process.execPath, env, cwd: spec.cwd, log: join(spec.dir, COMMAND_LOG),
        args: [join(spec.dir, COMMAND_WRAPPER), spec.dir, ...(spec.exec ? [winTagArg("DSA_EXEC", spec.exec)] : [])],
        ...(spec.exec ? { exec: spec.exec } : {}) }, spec.proceed ? { proceed: spec.proceed } : {});
    }
    const mv = resolveMv(), argv = commandArgv(spec.command);
    if (spec.proceed && !spec.proceed()) return undefined;
    const child = spawn("/bin/sh", ["-c", WRAPPER, "dsa-command", spec.dir, mv, ...argv],
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
