// Platform differences the CI scripts have to handle on a real Windows runner: the npm install is only `npm.cmd`, `PATH`
// uses `;` and Windows keeps it under the name `Path`, an absolute module path is importable only as a `file:` URL, and a
// run that is over has to end with its whole process tree. Every function takes `platform` (default: this process's), so
// both platforms' behavior is checkable from either one.
import { pathToFileURL } from "node:url";

const isWindows = platform => platform === "win32";

/** How to start npm for a given environment. Under `npm run` (how CI starts the scripts) `npm_execpath` is npm's own JS
 *  entry, which this Node runs directly: no shell, no quoting, the same npm. Elsewhere a Windows install has `npm.cmd`
 *  only, and Node refuses to start a `.cmd` without a shell (the 2024 command-injection fix), so cmd.exe runs it. */
export function npmInvocation(platform = process.platform, env = process.env) {
  const execpath = env.npm_execpath;
  if (execpath && /\.(?:c|m)?js$/i.test(execpath)) return { command: process.execPath, args: [execpath], shell: false };
  return isWindows(platform) ? { command: "npm.cmd", args: [], shell: true } : { command: "npm", args: [], shell: false };
}

/** Arguments for a command Node starts through cmd.exe: cmd splits the command line on whitespace, so quote what has any
 *  (a checkout under `C:\Users\First Last\...`). No argument these scripts pass contains a quote. */
export function cmdArgs(args) {
  return args.map(arg => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
}

/** `PATH` with `dir` first, separated the way the platform does it (`;` on Windows) — a `:` separator on Windows would
 *  make one directory of `C:\repo\node_modules\.bin:C:\Windows\...`. */
export function withBinPath(dir, platform = process.platform, base = process.env.PATH ?? "") {
  const separator = isWindows(platform) ? ";" : ":";
  return base ? `${dir}${separator}${base}` : dir;
}

/** Sets `PATH` in a child environment built by spreading `process.env`. Windows names it `Path`, and that copy carries
 *  the original spelling: a second `PATH` beside it leaves the child with whichever one it looks up first. */
export function setEnvPath(env, value) {
  for (const key of Object.keys(env)) if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
  env.PATH = value;
  return env;
}

/** A module path as an `import()` specifier. POSIX accepts a bare absolute path, Windows reads the drive letter as a URL
 *  scheme (`c:`), so the path becomes a `file:` URL, which both accept. */
export function fileSpecifier(path) {
  return pathToFileURL(path).href;
}

/** Ending a run's whole process tree. On Windows a signal reaches only the one process, leaving its children (the pi
 *  subagents of a test run) to hold the pipes and the temp directory; `taskkill /T` ends them too. POSIX callers spawn
 *  detached and signal the group (a negative pid), which this returns nothing for. */
export function treeKillCommand(pid, platform = process.platform) {
  return isWindows(platform) ? { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] } : undefined;
}
