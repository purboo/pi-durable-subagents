// Starting the orchestrator (README "Starting the orchestrator"). Every starter (the CLI, a pi session, the restart
// successor) goes through launchOrchestrator, so the orchestrator never depends on whoever happened to start it:
// - `pi` is resolved once, by the starter, to an absolute path passed on as DSA_PI_BIN (the starter's PATH may be the
//   only one that has it: a systemd unit or cron job usually has a minimal PATH);
// - on Linux with a systemd user manager and lingering enabled for the user it runs in its own transient scope, outside
//   the starter's cgroup, so the end of a oneshot unit, a cron job or a CI step (which kill their whole cgroup) does not
//   end it. Without lingering the user manager stops its scopes at logout, while a plain detached process survives it
//   (KillUserProcesses=no, the usual default): it starts as a plain detached process then.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { comspec, IS_WINDOWS } from "./windows.ts";

const WINDOWS_EXECUTABLE = new Set([".exe", ".com", ".cmd", ".bat"]);
/** Whether `path` is a regular file this process may execute. On Windows only a PE image or a batch file is directly
 *  executable; the extensionless `pi` (a POSIX shell script an npm install also writes) is not. */
export function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (IS_WINDOWS) {
      const ext = extname(path).toLowerCase();
      if (!WINDOWS_EXECUTABLE.has(ext)) return false;
      accessSync(path, constants.F_OK);
      return true;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}
/** PATH directories. Windows separators are `;`, but POSIX-style test setups prepend `dir:...`; split those too, without
 *  cutting a `C:` drive prefix (a colon at index 1 after a letter). */
function pathDirs(PATH: string | undefined): string[] {
  if (!IS_WINDOWS) return (PATH ?? "").split(delimiter);
  const out: string[] = [];
  for (const part of (PATH ?? "").split(";")) {
    let start = 0;
    for (let i = 0; i < part.length; i++)
      if (part[i] === ":" && !(i === 1 && /[A-Za-z]/.test(part[0]!))) { out.push(part.slice(start, i)); start = i + 1; }
    out.push(part.slice(start));
  }
  return out;
}
/** The first executable `name` in the directories of `PATH`, unresolved (a package-manager shim stays a shim). Windows
 *  looks through PATHEXT: `pi` resolves to `pi.cmd`/`pi.exe`, never the extensionless POSIX shim beside them. */
export function findOnPath(name: string, PATH: string | undefined): string | undefined {
  const exts = IS_WINDOWS && !extname(name)
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(ext => ext.toLowerCase()).filter(ext => WINDOWS_EXECUTABLE.has(ext))
    : [""];
  for (const dir of pathDirs(PATH)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (executableFile(file)) return file;
    }
  }
  return undefined;
}

/** What a spawn actually runs. An npm `.cmd` shim is not a PE image and Node cannot start it directly; the shim names
 *  the node script it runs, so that script runs under this Node instead and argv stays an argv (no shell quoting). */
export function execTarget(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (!IS_WINDOWS) return { command, args: [...args] };
  // A bare name is looked up through PATHEXT (`pi` → `pi.cmd`), the way a shell would find it.
  const resolved = !isAbsolute(command) && !/[\\/]/.test(command) ? findOnPath(command, process.env.PATH) ?? command : command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args] };
  const script = shimScript(resolved);
  if (script) return { command: process.execPath, args: [script, ...args] };
  return { command: comspec(), args: ["/d", "/s", "/c", resolved, ...args] };
}
/** The node script a generated `.cmd`/`.bat` shim runs, when it names one (`%dp0%` is the shim's directory). */
export function shimScript(file: string): string | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  const dir = dirname(file);
  for (const match of text.matchAll(/"([^"\r\n]+\.(?:js|mjs|cjs))"|'([^'\r\n]+\.(?:js|mjs|cjs))'/gi)) {
    const raw = match[1] ?? match[2]!, resolved = raw.replace(/%~?dp0%?/gi, dir);
    if (isAbsolute(resolved) && existsSync(resolved)) return resolved;
  }
  return undefined;
}
/** The command processor a string command/gate runs through on this platform. */
export function shellTarget(command: string, exec?: string): { command: string; args: string[]; shell?: boolean } {
  // A command line is readable across processes on Windows (the environment is not): the marker lets recovery find a
  // gate whose identity was never journaled. The id is a safe token (no whitespace, `&` or quotes).
  return IS_WINDOWS ? { command: exec ? `set DSA_EXEC=${exec}&& ${command}` : command, args: [], shell: true } : { command: "/bin/sh", args: ["-c", command] };
}

export interface PiResolution { path?: string; source?: "DSA_PI_BIN" | "PATH"; problem?: string }
/** The `pi` the orchestrator launches subagents with: DSA_PI_BIN when set (it must be an executable file), else the
 *  first `pi` on PATH. `problem` says why there is none. */
export function resolvePi(env: NodeJS.ProcessEnv): PiResolution {
  const given = env.DSA_PI_BIN;
  if (given) {
    if (isAbsolute(given) && executableFile(given)) return { path: given, source: "DSA_PI_BIN" };
    return { problem: `DSA_PI_BIN=${given} is not an absolute path to an executable file` };
  }
  const found = findOnPath("pi", env.PATH);
  return found ? { path: found, source: "PATH" } : { problem: `pi was not found on PATH (${env.PATH || "unset"}) and DSA_PI_BIN is not set` };
}

/** The starter cannot start an orchestrator that could launch no subagent. */
export class PiNotFound extends Error {
  constructor(problem: string) {
    super(`cannot start the orchestrator: ${problem}. Set DSA_PI_BIN to the absolute path of pi, or run this from an ` +
      "environment whose PATH has pi. A request already sent stays pending: it runs when an orchestrator starts from an " +
      "environment that has pi (any pi session starts one)");
    this.name = "PiNotFound";
  }
}

/** Runs a short command; resolves whether it exited 0 within the timeout. */
export type ProbeRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<boolean>;
export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface LaunchOptions {
  /** DSA_HOME of the orchestrator. */
  home: string;
  /** Refuse (PiNotFound) when pi cannot be resolved; otherwise start anyway (the orchestrator falls back to its own
   *  lookup, then to a bare `pi`). */
  requirePi?: boolean;
  node?: string;
  platform?: NodeJS.Platform;
  probe?: ProbeRunner;
  /** Whether `user` has lingering enabled (default: /var/lib/systemd/linger/<user> exists). */
  linger?: (user: string) => boolean;
  spawn?: Spawner;
}
export interface Launched { pid: number; scope: boolean; pi?: string }

export const SCOPE_ARGS = ["--user", "--scope", "--quiet", "--collect"] as const;
const PROBE_TIMEOUT_MS = 3000;

export const runProbe: ProbeRunner = (command, args, { env, timeoutMs }) => new Promise(resolve => {
  let child: ChildProcess;
  try { child = spawn(command, args, { env, stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" }); }
  catch { resolve(false); return; }
  child.once("error", () => resolve(false));
  child.once("exit", code => resolve(code === 0));
});

/** Whether systemd keeps `user`'s manager (and its scopes) running after the last logout. */
export function lingering(user: string): boolean {
  return !!user && !user.includes("/") && existsSync(join("/var/lib/systemd/linger", user));
}
function currentUser(env: NodeJS.ProcessEnv): string {
  if (env.USER) return env.USER;
  try { return userInfo().username; } catch { return ""; }
}

/** systemd-run when the orchestrator should run in its own scope: Linux, a user manager (XDG_RUNTIME_DIR) that lingers
 *  (it outlives logouts; a scope under a manager that does not would be stopped at logout), systemd-run on PATH,
 *  DSA_SCOPE not "off", and a probe scope that works. Probed once per start attempt (the starter only runs when no
 *  orchestrator holds the lock). */
export async function scopeRunner(env: NodeJS.ProcessEnv, options: Pick<LaunchOptions, "platform" | "probe" | "linger"> = {}): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "linux" || env.DSA_SCOPE === "off" || !env.XDG_RUNTIME_DIR) return undefined;
  if (!(options.linger ?? lingering)(currentUser(env))) return undefined;
  const runner = findOnPath("systemd-run", env.PATH);
  if (!runner) return undefined;
  const ok = await (options.probe ?? runProbe)(runner, [...SCOPE_ARGS, "true"], { env, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => false);
  return ok ? runner : undefined;
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}

/** The variables the executor sets for one call's processes (a subagent, a command call, a gate). An orchestrator
 *  started from inside a call (its CLI, a command that runs `start`) never carries them: with the call's DSA_EXEC it
 *  would be one of that call's processes, and the call's fence (its end, a stop) would kill it. */
export const PER_CALL_ENV = ["DSA_SESSION", "DSA_EXEC", "DSA_CALL", "DSA_INBOX", "DSA_JOURNAL", "DSA_SCHEMA", "DSA_BUDGET", "DSA_MODEL", "DSA_RESULT", "DSA_OUTPUT", "DSA_PROBE"] as const;
/** `env` without PER_CALL_ENV. */
export function orchestratorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const name of PER_CALL_ENV) delete rest[name];
  return rest;
}

/** Start the orchestrator at `entry`, detached, with `env` minus the starting session's DSA_SESSION (it serves every
 *  session) and every other per-call variable (PER_CALL_ENV) plus DSA_HOME and the resolved DSA_PI_BIN. In its own systemd scope when one is available (the scope execs
 *  the command: same environment, and the pid is the orchestrator's), else a plain detached process. */
export async function launchOrchestrator(entry: string, env: NodeJS.ProcessEnv, options: LaunchOptions): Promise<Launched> {
  const pi = resolvePi(env);
  if (!pi.path && options.requirePi) throw new PiNotFound(pi.problem!);
  const childEnv: NodeJS.ProcessEnv = { ...orchestratorEnv(env), DSA_HOME: options.home, ...(pi.path ? { DSA_PI_BIN: pi.path } : {}) };
  const node = options.node ?? process.execPath, run = options.spawn ?? spawn;
  const runner = await scopeRunner(env, options);
  if (runner) {
    try {
      const child = run(runner, [...SCOPE_ARGS, "--description", "pi-durable-subagents orchestrator", "--", node, entry], { detached: true, stdio: "ignore", env: childEnv });
      await started(child);
      child.unref();
      return { pid: child.pid!, scope: true, ...(pi.path ? { pi: pi.path } : {}) };
    } catch { /* fall back to a plain detached process */ }
  }
  const child = run(node, [entry], { detached: true, stdio: "ignore", env: childEnv });
  await started(child);
  child.unref();
  return { pid: child.pid!, scope: false, ...(pi.path ? { pi: pi.path } : {}) };
}
