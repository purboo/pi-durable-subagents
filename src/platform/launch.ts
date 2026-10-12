// Starting the orchestrator (README "Starting the orchestrator"). Every starter (the CLI, a pi session, the restart
// successor) goes through launchOrchestrator, so the orchestrator never depends on whoever happened to start it:
// - `pi` is resolved once, by the starter, to an absolute path passed on as DSA_PI_BIN (the starter's PATH may be the
//   only one that has it: a systemd unit or cron job usually has a minimal PATH);
// - on Linux with a systemd user manager it runs in its own transient scope, outside the starter's cgroup, so the end
//   of a oneshot unit, a cron job or a CI step (which kill their whole cgroup) does not end it.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Whether `path` is a regular file this process may execute. */
export function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}
/** The first executable `name` in the directories of `PATH`, unresolved (a package-manager shim stays a shim). */
export function findOnPath(name: string, PATH: string | undefined): string | undefined {
  for (const dir of (PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    if (executableFile(file)) return file;
  }
  return undefined;
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

/** systemd-run when the orchestrator should run in its own scope: Linux, a user manager (XDG_RUNTIME_DIR), systemd-run
 *  on PATH, DSA_SCOPE not "off", and a probe scope that works. Probed once per start attempt (the starter only runs
 *  when no orchestrator holds the lock). */
export async function scopeRunner(env: NodeJS.ProcessEnv, options: Pick<LaunchOptions, "platform" | "probe"> = {}): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "linux" || env.DSA_SCOPE === "off" || !env.XDG_RUNTIME_DIR) return undefined;
  const runner = findOnPath("systemd-run", env.PATH);
  if (!runner) return undefined;
  const ok = await (options.probe ?? runProbe)(runner, [...SCOPE_ARGS, "true"], { env, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => false);
  return ok ? runner : undefined;
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}

/** Start the orchestrator at `entry`, detached, with `env` minus the starting session's DSA_SESSION (it serves every
 *  session) plus DSA_HOME and the resolved DSA_PI_BIN. In its own systemd scope when one is available (the scope execs
 *  the command: same environment, and the pid is the orchestrator's), else a plain detached process. */
export async function launchOrchestrator(entry: string, env: NodeJS.ProcessEnv, options: LaunchOptions): Promise<Launched> {
  const pi = resolvePi(env);
  if (!pi.path && options.requirePi) throw new PiNotFound(pi.problem!);
  const { DSA_SESSION: _session, ...rest } = env;
  const childEnv: NodeJS.ProcessEnv = { ...rest, DSA_HOME: options.home, ...(pi.path ? { DSA_PI_BIN: pi.path } : {}) };
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
