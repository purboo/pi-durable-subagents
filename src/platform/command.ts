// Command calls (CallSpec.command): the launcher. On Unix a command runs detached in its own session under a tiny
// /bin/sh wrapper that runs it, then records its exit status atomically in the attempt directory (`exit.tmp`, renamed
// to `exit`) and exits with the same status. Windows has no /bin/sh: the same wrapper is a short Node program (Node is
// already the runtime), and a string command runs through the command's `ComSpec` (cmd.exe by default). Its output (stdout and stderr, interleaved) is
// appended to `output.log` in the same directory through a descriptor the orchestrator opens, passes and closes: no
// pipe leads back into the orchestrator and no node process stays resident for the life of the command, so it outlives
// the orchestrator that started it. On Windows that descriptor is not this process's: the attempt's group owner opens
// its own two append handles for the log (platform/job.ts), so nothing here opens or holds `output.log` while the owner
// compiles and starts.
//
// On Windows the wrapper also runs inside a Windows Job Object of its own (platform/job.ts): the wrapper is the group's
// root, created suspended and assigned before its first instruction, and the group's only handle dies with the owner --
// a small .NET Framework winexe compiled per launch with the framework's own csc.exe. A command attempt therefore cannot
// leave descendants behind, and a scan that finds the wrapper gone finds the group closed: no second attempt starts
// while processes of the first can still act. The attempt's `exec` tag goes into the owner's own command line as well,
// so the attempt is findable while the owner is still starting. The owner is the expensive part of a start, so it is
// staged (prepareCommand) before the attempt's durable intent: `proceed` is checked before the compilation and again
// immediately before the spawn, and a stop, retirement or exit during the compilation cancels it -- nothing recorded,
// nothing started, so that cut is unambiguously prelaunch.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { retryWinSharing, type RetryWinSharingOptions } from "../kernel/fsx.ts";
import { captureStart } from "./proctable.ts";
import { execTarget, findOnPath } from "./launch.ts";
import type { ResourceLimits } from "../types.ts";
import { prepareJob, spawnInJob, type JobPrep } from "./job.ts";
import { probeKernelLimits, wrapLinuxScope } from "./limits.ts";
import { DWORD_MAX, comspec, envValue, helperEnv, IS_WINDOWS, mergeEnv, normalizeEnv, systemRoot, winTagArg } from "./windows.ts";

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
const SHARING = new Set(["EACCES", "EBUSY", "EPERM"]);
const WAIT = new Int32Array(new SharedArrayBuffer(4));
function retrySharing(fn, deadline) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); }
    catch (error) {
      if (!SHARING.has(error && error.code) || attempt >= 25) throw error;
      const left = deadline - Date.now();
      if (left <= 0) throw error;
      Atomics.wait(WAIT, 0, 0, Math.min(left, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
const spec = JSON.parse(retrySharing(() => readFileSync(join(dir, "${COMMAND_SPEC}"), "utf8"), Date.now() + 2500));
try { unlinkSync(join(dir, "${COMMAND_SPEC}")); } catch { /* already gone */ }
// The status of the attempt is the kernel's 32-bit exit code. Node hands a Windows status back as a number whose bit
// pattern is that code -- on some paths as a signed int32 (0xC0000005 reads -1073741819) -- and a negative number is not
// an exit record at all, so every status is normalized to its DWORD here before it is written. process.exit takes an
// integer and the OS keeps its low 32 bits, so the same DWORD reaches the caller as this wrapper's own exit status: the
// record and the observed outcome cannot disagree.
function dword(code) { return code >>> 0; }
// Publish the exit record atomically (temp file then rename) with bounded retries on Windows transient sharing errors
// (antivirus/indexer/concurrent reader). Never fall back to a direct write to "exit" so readers never see partial data.
function record(status) {
  const deadline = Date.now() + 2500;
  try {
    retrySharing(() => writeFileSync(join(dir, "exit.tmp"), String(status)), deadline);
    retrySharing(() => renameSync(join(dir, "exit.tmp"), join(dir, "exit")), deadline);
  } catch {
    try { unlinkSync(join(dir, "exit.tmp")); } catch { /* never lose the command's own result */ }
  }
}
function value(env, name) { const lower = name.toLowerCase(); let found; for (const key of Object.keys(env)) if (key.toLowerCase() === lower) found = env[key]; return found; }
function put(env, name, val) { const lower = name.toLowerCase(); for (const key of Object.keys(env)) if (key.toLowerCase() === lower) delete env[key]; env[name] = val; }
const shell = value(spec.env, "ComSpec") || value(process.env, "ComSpec") || "cmd.exe";
// The command's block by name: one PATH (also when the call spelled it Path), one ComSpec, one PATHEXT.
const env = {};
for (const key of Object.keys(spec.env)) put(env, key, spec.env[key]);
put(env, "ComSpec", shell);
put(env, "PATHEXT", value(spec.env, "PATHEXT") || value(process.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD");
const options = { cwd: spec.cwd, env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true, ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}) };
let child;
try { child = typeof spec.command === "string" ? spawn(spec.command, { ...options, shell }) : spawn(spec.command[0], spec.command.slice(1), options); }
catch (error) { const status = error && error.code === "ENOENT" ? 127 : 126; record(status); process.exit(status); }
child.once("error", error => { const status = error && error.code === "ENOENT" ? 127 : 126; record(status); process.exit(status); });
child.once("exit", (code, signal) => { const status = code === null ? (signal ? 128 : 1) : dword(code); record(status); process.exit(status); });
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
  /** Windows: the staged preparation (prepareCommand) made before the attempt's intent. The start then writes nothing and
   *  compiles nothing: the spec and the wrapper are the ones the owner was prepared for. */
  prepared?: CommandPrep;
  /** Cancels a preparation this call stages itself. A staged one carries its own signal (prepareCommand). */
  signal?: AbortSignal;
  /** The last check, synchronous, after every preparation and immediately before the spawn (no await between them):
   *  false starts no process (spawnCommand resolves undefined). On Windows the expensive preparation is staged before the
   *  intent, so the check that a stop arrived while the owner compiled is the executor's second one: it calls this after
   *  the staging, immediately before the spawn. */
  proceed?: () => boolean;
  /** Optional per-call process-tree resource limits (passed to Windows Job Object or Linux cgroup v2 scope). */
  limits?: ResourceLimits;
}
export interface SpawnedCommand {
  /** The wrapper process (the session leader); `start` is its start token ("" when it ended before it was captured). */
  pid: number; start: string;
  /** Windows: the job host (compiled owner) that holds the attempt's kernel group. Its identity is tracked with the
   *  wrapper's, so a scan finds the whole group and its absence proves the group is closed (see platform/job.ts). */
  group?: { pid: number; start: string };
  /** Linux: transient systemd scope unit name when launched with cgroup v2 kernel hard limits. */
  scopeUnit?: string;
  /** Windows: the attempt was started but its owner could not be confirmed retired (platform/job.ts). `pid`/`start` are
   *  then the owner's identity; the attempt must be watched until a scan confirms it retired, never started again. */
  uncertain?: string;
  /** Resolves when the wrapper ends while this process runs (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}

/** The argv the wrapper runs: an argv as given (a program, never shell syntax), a string through the platform shell. */
export const commandArgv = (command: string | readonly string[]): string[] =>
  typeof command === "string" ? [IS_WINDOWS ? comspec() : "/bin/sh", "-c", command] : [...command];

/** What a Windows start stages before the attempt's durable intent: the compiled group owner (undefined on POSIX, which has
 *  nothing to prepare). */
export type CommandPrep = JobPrep;
/** Whether `error` is a preparation cancelled by a stop, a retirement or the orchestrator's exit (never a failure of the
 *  attempt, and never sealed as one). */
export { prepareCancelled } from "./job.ts";

/** The Windows plan of one command start: the child's environment as one block (Windows names one variable whatever their
 *  case: one `PATH`, one `ComSpec`, one `PATHEXT`), the command the wrapper runs (an argv whose program is a .cmd/.bat shim
 *  unwrapped to the program it names) and the wrapper's own argv. Shared by the staging and the start, so both describe the
 *  same attempt. */
function windowsPlan(spec: CommandSpawn): { env: NodeJS.ProcessEnv; command: string | readonly string[]; verbatim?: true; args: string[] } {
  const inherited = normalizeEnv(spec.env);
  const env = mergeEnv(inherited, { ComSpec: envValue(inherited, "ComSpec") || comspec(inherited),
    PATHEXT: envValue(inherited, "PATHEXT") || ".COM;.EXE;.BAT;.CMD" });
  let command: string | readonly string[];
  let verbatim: true | undefined;
  if (typeof spec.command === "string") command = spec.command;
  else {
    const target = execTarget(spec.command[0]!, spec.command.slice(1), { env });
    command = [target.command, ...target.args];
    verbatim = target.verbatim;
  }
  return { env, command, ...(verbatim ? { verbatim } : {}), args: [join(spec.dir, COMMAND_WRAPPER), spec.dir, ...(spec.exec ? [winTagArg("DSA_EXEC", spec.exec)] : [])] };
}

/** Stage what a Windows command start needs, before its durable intent: the command spec and the wrapper the child runs,
 *  then the group owner compiled (bounded and cancellable: `signal` ends the compiler, removes what it wrote and rejects
 *  with a cancelled preparation). Nothing is started, so a crash here leaves no intent and no process: the attempt is
 *  unambiguously prelaunch. POSIX prepares nothing (the wrapper is /bin/sh). */
/** Commit headroom reserved for Windows wrapper.mjs (Node.js) inside the Job Object so a tight memoryMb limit never
 *  OOM-kills the wrapper before it can run the user command or write its exit record; Layer 1 enforces exact memoryMb. */
const WIN_WRAPPER_MEMORY_OVERHEAD_MB = 64;
function winJobLimits(limits: ResourceLimits | undefined): { memoryMb?: number; maxProcesses?: number; cpuPercent?: number } | undefined {
  if (!limits) return undefined;
  const { memoryMb, maxProcesses, cpuPercent } = limits;
  if (memoryMb === undefined && maxProcesses === undefined && cpuPercent === undefined) return undefined;
  return {
    ...(memoryMb !== undefined ? { memoryMb: memoryMb + WIN_WRAPPER_MEMORY_OVERHEAD_MB } : {}),
    // Account for wrapper.mjs (1 Node process) running inside the Job Object alongside the user command.
    ...(maxProcesses !== undefined ? { maxProcesses: maxProcesses + 1 } : {}),
    ...(cpuPercent !== undefined ? { cpuPercent } : {}),
  };
}

export async function prepareCommand(spec: CommandSpawn): Promise<CommandPrep | undefined> {
  if (!IS_WINDOWS) return undefined;
  // A command line can be long and contain anything: pass it through a file, not argv.
  await mkdir(spec.dir, { recursive: true });
  const plan = windowsPlan(spec);
  await writeFile(join(spec.dir, COMMAND_SPEC), JSON.stringify({ command: plan.command, cwd: spec.cwd, env: plan.env, ...(plan.verbatim ? { verbatim: true } : {}) }));
  await writeFile(join(spec.dir, COMMAND_WRAPPER), COMMAND_WRAPPER_SOURCE);
  const limits = winJobLimits(spec.limits);
  return prepareJob(spec.dir, { exe: process.execPath, env: helperEnv({ SystemRoot: systemRoot() }), cwd: spec.cwd, log: join(spec.dir, COMMAND_LOG),
    args: plan.args, ...(spec.exec ? { exec: spec.exec } : {}), ...(limits ? { limits } : {}) }, { ...(spec.signal ? { signal: spec.signal } : {}) });
}

/** Start a command (see the module comment). Rejects when it cannot start (a missing cwd, no /bin/sh); undefined when
 *  `proceed` said no. */
export async function spawnCommand(spec: CommandSpawn & { proceed: () => boolean }): Promise<SpawnedCommand | undefined>;
export async function spawnCommand(spec: CommandSpawn): Promise<SpawnedCommand>;
export async function spawnCommand(spec: CommandSpawn): Promise<SpawnedCommand | undefined> {
  await mkdir(spec.dir, { recursive: true });
  if (IS_WINDOWS) {
    // The log belongs to the attempt's group owner: it opens its own append handles for it (platform/job.ts), so this
    // process opens none -- an unused descriptor would only be held open across the compilation and the handshake.
    // A staged preparation (prepareCommand) already wrote command.json, the wrapper and the compiled owner: rewriting
    // them would only risk a spec the owner was not prepared for, so the start reads what it staged.
    const plan = windowsPlan(spec);
    if (!spec.prepared) {
      await writeFile(join(spec.dir, COMMAND_SPEC), JSON.stringify({ command: plan.command, cwd: spec.cwd, env: plan.env, ...(plan.verbatim ? { verbatim: true } : {}) }));
      await writeFile(join(spec.dir, COMMAND_WRAPPER), COMMAND_WRAPPER_SOURCE);
    }
    // An already revoked permission never prepares or starts; the executor's stage checks again immediately before the
    // spawn (spawnInJob), so a stop or retirement that arrived while the owner compiled still starts nothing.
    if (spec.proceed && !spec.proceed()) return undefined;
    // Start the internal Node wrapper with OS defaults. It reads the command's environment from command.json.
    const limits = winJobLimits(spec.limits);
    return await spawnInJob(spec.dir, { exe: process.execPath, env: helperEnv({ SystemRoot: systemRoot() }), cwd: spec.cwd, log: join(spec.dir, COMMAND_LOG),
      args: plan.args, ...(spec.exec ? { exec: spec.exec } : {}), ...(limits ? { limits } : {}) }, { ...(spec.proceed ? { proceed: spec.proceed } : {}),
      ...(spec.prepared ? { prepared: spec.prepared } : {}), ...(spec.signal ? { signal: spec.signal } : {}) });
  }
  // POSIX: the wrapper's stdout and stderr are this descriptor, which it inherits and this process closes after the
  // spawn: the command's log is never a pipe held by a process that has to outlive it.
  const fd = openSync(join(spec.dir, COMMAND_LOG), "a");
  try {
    const mv = resolveMv(), argv = commandArgv(spec.command);
    if (spec.proceed && !spec.proceed()) return undefined;
    const baseArgs = ["-c", WRAPPER, "dsa-command", spec.dir, mv, ...argv];
    const wrapped = spec.limits && process.platform === "linux"
      ? wrapLinuxScope(spec.exec ?? `cmd-${Date.now()}`, "/bin/sh", baseArgs, spec.limits, probeKernelLimits({ platform: "linux", env: spec.env, kind: "command" }))
      : { command: "/bin/sh", args: baseArgs };
    const child = spawn(wrapped.command, wrapped.args,
      { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", fd, fd] });
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const pid = child.pid!;
    const start = child.exitCode !== null || child.signalCode !== null ? "" : await captureStart(pid).catch(() => "");
    return { pid, start, ...(wrapped.unit ? { scopeUnit: wrapped.unit } : {}), exited };
  } finally { closeSync(fd); }
}

export interface ReadExitRecordOptions extends RetryWinSharingOptions {
  /** Test seam: read the exit record text and mtimeMs. */
  read?: (path: string) => Promise<{ text: string; at: number }>;
}

async function readExitFile(path: string): Promise<{ text: string; at: number }> {
  const file = await open(path, "r");
  try {
    const [text, info] = await Promise.all([file.readFile("utf8"), file.stat()]);
    return { text, at: info.mtimeMs };
  } finally {
    await file.close();
  }
}

/** The status the wrapper recorded, or undefined while there is none (the command runs, or ended without one). The record
 *  is one exit status: on Windows the whole DWORD (a status above 0x7fffffff included), on POSIX 0..255. Anything outside
 *  that is not a status a wrapper wrote -- a negative number a Node version reported, a corrupt or foreign file -- and is
 *  not read as one. On Windows, transient sharing conflicts (`EACCES`, `EBUSY`, `EPERM`) are retried boundedly. */
export async function readExitRecord(dir: string, options: ReadExitRecordOptions = {}): Promise<{ status: number; at: number } | undefined> {
  const path = join(dir, COMMAND_EXIT);
  const reader = options.read ?? readExitFile;
  let recorded: string, at: number;
  try {
    ({ text: recorded, at } = await retryWinSharing(() => reader(path), {
      timeoutMs: 2_000,
      maxAttempts: 20,
      ...options,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A wrapper writes one decimal status (and a newline): anything else in the file -- nothing, a sign, an exponent,
  // text -- is not a status of this attempt.
  const text = recorded.trim();
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const status = Number(text);
  return status <= DWORD_MAX ? { status, at } : undefined;
}

const signalNames = new Map(Object.entries(constants.signals).map(([name, n]) => [n as number, name]));
/** How an exit status reads. On POSIX the wrapper sees the status of a shell: a command killed by signal N exits 128+N,
 *  and a command that itself exits with a status above 128 (`exit 130`) therefore reads as killed by that signal -- the two
 *  cannot be told apart from the status alone (the shell convention). A status that is not 128 plus a known signal number
 *  reads as the status itself: a Windows DWORD, a status above 0x7fffffff included, always does. */
export function exitMeaning(status: number): { exitCode: number | null; signal: string | null } {
  const name = status > 128 ? signalNames.get(status - 128) : undefined;
  return name ? { exitCode: null, signal: name } : { exitCode: status, signal: null };
}

/** The last `bytes` of a file, starting on a UTF-8 character boundary ("" when it is missing). */
export async function readTail(path: string, bytes = OUTPUT_TAIL_BYTES, options: RetryWinSharingOptions = {}): Promise<string> {
  const file = await retryWinSharing(() => open(path, "r"), { timeoutMs: 1_000, maxAttempts: 15, ...options })
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
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
