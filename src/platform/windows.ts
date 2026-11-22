// Native Windows support: PowerShell is the only process observer Node has (Win32_Process through CIM), and
// taskkill is its process-tree terminator. Environment variables of other processes are not readable on Windows, so
// process identity is (pid, creation time) and process trees replace the inherited DSA_EXEC tag.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const IS_WINDOWS = process.platform === "win32";

/** The Windows directory holding powershell.exe and taskkill.exe. */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string { return envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows"; }

/** A variable of a Windows environment block. Names compare case-insensitively (`Path` is `PATH`, `ComSpec` is `COMSPEC`)
 *  and the last definition wins, exactly as `process.env` behaves on Windows; the value is the key's own spelling's. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  let value: string | undefined;
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) value = env[key];
  return value;
}
/** One environment from `base` and the overrides applied in order. An override replaces every definition of its name under
 *  any spelling instead of adding a second one, so a block never carries `Path` beside `PATH`: Windows finds one variable
 *  per name, and a second definition is at best ignored (the wrapper's child would see the inherited PATH, not the
 *  command's). Keys keep the spelling of whichever definition won. */
export function mergeEnv(base: NodeJS.ProcessEnv, ...overrides: (NodeJS.ProcessEnv | Record<string, string | undefined> | undefined)[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const override of overrides) {
    if (!override) continue;
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === lower) delete env[existing];
      env[key] = value;
    }
  }
  return env;
}
/** An environment block with one definition per name (the later spelling wins): what a Windows child reads unambiguously. */
export const normalizeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => mergeEnv({}, env);

/** Supply OS defaults to helpers launched from deliberately isolated environments. */
export function helperEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // A derivation that fails must not take the helper down with it: a variable that stays unset is what it had before.
  const attempt = (read: () => string, fallback: string) => { try { return read() || fallback; } catch { return fallback; } };
  const root = systemRoot(base), temp = envValue(base, "TEMP") || envValue(base, "TMP") || attempt(tmpdir, join(root, "Temp"));
  const home = envValue(base, "USERPROFILE") || attempt(homedir, join(root, "Users", "Default"));
  const system32 = join(root, "System32");
  /** A default for a variable the caller lacks, under one Windows name: a caller that spelled it `Path` or `COMSPEC`
   *  keeps its own definition (and its own spelling) instead of getting a second one beside it. */
  const missing = (name: string, value: string) => envValue(base, name) ? {} : { [name]: value };
  return mergeEnv(base, {
    ...missing("SystemRoot", root), ...missing("windir", root), ...missing("SystemDrive", root.slice(0, 2)),
    ...missing("ComSpec", join(system32, "cmd.exe")),
    ...missing("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
    ...missing("PSModulePath", join(system32, "WindowsPowerShell", "v1.0", "Modules")),
    ...missing("TEMP", temp), ...missing("TMP", temp), ...missing("USERPROFILE", home),
    ...missing("APPDATA", join(home, "AppData", "Roaming")),
    ...missing("LOCALAPPDATA", join(home, "AppData", "Local")),
    ...missing("PATH", [system32, root].join(";")) });
}

/** Windows PowerShell 5.1 by its absolute path: every supported Windows has it. */
export function powershellPath(): string {
  const local = join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(local) ? local : "powershell.exe";
}
export function taskkillPath(): string {
  const local = join(systemRoot(), "System32", "taskkill.exe");
  return existsSync(local) ? local : "taskkill.exe";
}
/** The command processor a string command runs through (`command calls` keep their shell semantics). */
export function comspec(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "ComSpec") || join(systemRoot(env), "System32", "cmd.exe");
}

const PS_PREAMBLE = "$ErrorActionPreference = 'Stop'; ";
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
/** Run a PowerShell script; rejects with its stderr. */
export async function powershell(script: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  const { stdout } = await exec(powershellPath(), [...PS_FLAGS, PS_PREAMBLE + script],
    { signal: options.signal, timeout: options.timeout ?? 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: helperEnv() });
  return stdout;
}
export function powershellSync(script: string, options: { timeout?: number } = {}): string {
  return execFileSync(powershellPath(), [...PS_FLAGS, PS_PREAMBLE + script], { timeout: options.timeout ?? 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: helperEnv() });
}

export interface WinProcessRow {
  pid: number;
  ppid: number;
  /** Creation time in .NET ticks (a stable identity token, never reused with the same pid). */
  start: string;
  cpuMs?: number;
  command?: string;
}

/** One line per process: pid, ppid, creation ticks, CPU (100ns -> ms) and command line (tabs/newlines replaced by
 *  spaces so a line stays one row). */
const creationTicks = "[System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).Ticks";
function processQuery(fields: string, body: string, pid?: number): string {
  const where = pid === undefined ? "" : ` WHERE ProcessId=${pid}`;
  return `$s = [wmisearcher]'SELECT ${fields} FROM Win32_Process${where}'; foreach ($p in $s.Get()) { ${body} }`;
}
export const PROCESS_ROWS_SCRIPT = processQuery("ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime,CommandLine",
  `if (!$p.CreationDate) { continue }; $t = ${creationTicks}; ` +
  '$c = ([string]$p.CommandLine) -replace "[`t`r`n]", " "; ' +
  '"{0}`t{1}`t{2}`t{3}`t{4}" -f $p.ProcessId, $p.ParentProcessId, $t, ([uint64]$p.UserModeTime + [uint64]$p.KernelModeTime), $c');

export function parseProcessRows(stdout: string): WinProcessRow[] {
  const rows: WinProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [pid, ppid, start, cpu, ...rest] = line.split("\t");
    const id = Number(pid), parent = Number(ppid), ticks = Number(cpu);
    if (!Number.isInteger(id) || !Number.isInteger(parent) || !start) continue;
    rows.push({ pid: id, ppid: parent, start, ...(Number.isFinite(ticks) ? { cpuMs: ticks / 10_000 } : {}),
      ...(rest.length ? { command: rest.join(" ") } : {}) });
  }
  return rows;
}

/** One full process-table observation (about 0.5 s: PowerShell startup plus the CIM query). */
export async function winProcessRows(options: { signal?: AbortSignal; timeout?: number } = {}): Promise<WinProcessRow[]> {
  return parseProcessRows(await powershell(PROCESS_ROWS_SCRIPT, options));
}

let snapshot: { at: number; rows: Map<number, WinProcessRow> } | undefined;
/** A short-lived synchronous snapshot for lease readers and liveness checks. Missing rows are not proof of death. */
export function winSnapshotSync(maxAgeMs = 250): Map<number, WinProcessRow> {
  if (!snapshot || Date.now() - snapshot.at > maxAgeMs) {
    const rows = parseProcessRows(powershellSync(PROCESS_ROWS_SCRIPT));
    snapshot = { at: Date.now(), rows: new Map(rows.map(row => [row.pid, row])) };
  }
  return snapshot.rows;
}

/** The creation-time token of one process ("" when it has already gone). */
export async function winStart(pid: number, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const out = await powershell(processQuery("CreationDate", `if ($p.CreationDate) { ${creationTicks} }`, pid), options);
    return out.trim();
  } catch { return ""; }
}
export function winStartSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try { return powershellSync(processQuery("CreationDate", `if ($p.CreationDate) { ${creationTicks} }`, pid)).trim(); }
  catch { return ""; }
}
/** A diagnostic command line (never evidence of identity or death). */
export async function winCommandLine(pid: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const out = await powershell(processQuery("CommandLine", "$p.CommandLine", pid), { signal, timeout: 1000 });
    return out.trim().replace(/\s+/g, " ").slice(0, 200);
  } catch { return ""; }
}
export function winCommandLineSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    return powershellSync(processQuery("CommandLine", "$p.CommandLine", pid), { timeout: 1000 })
      .trim().replace(/\s+/g, " ").slice(0, 200);
  } catch { return ""; }
}
/** Prefix of versioned Windows command-line tags: base64url UTF-8 so spaces, quotes, `&`, `%` and arbitrary Unicode
 *  travel as one unquoted ASCII token and cannot collide with legacy ids or `DSA_HOLD` (`<resource>:<seq>`). */
export const WIN_TAG_PREFIX = "v1~";

/** Encode `<name>=<value>` as one ASCII command-line token safe for CreateProcess argv and cmd.exe without quoting. */
export function winTagArg(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid Windows tag name: ${name}`);
  if (!value) throw new Error(`Invalid Windows tag value for ${name}`);
  return `${name}=${WIN_TAG_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeWinTag(raw: string): string | undefined {
  const payload = raw.slice(WIN_TAG_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const bytes = Buffer.from(payload, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== payload) return undefined;
  const decoded = bytes.toString("utf8");
  return decoded && Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
}

/** A tag carried in a command line (`DSA_EXEC=v1~<base64url>`, with legacy `DSA_EXEC=<id>` read compatibility), the
 *  Windows substitute for an unreadable environment: a launcher we control writes it into its own argv so a crash
 *  before the identity is journaled still finds the process. */
export function winTag(command: string | undefined, name: string): string | undefined {
  if (!command || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const pattern = new RegExp(`(?:^|\\s)"?${name}=([^\\s&"')]+)`, "g");
  const versioned = new Set<string>(), legacy = new Set<string>();
  let sawVersioned = false;
  for (const match of command.matchAll(pattern)) {
    const raw = match[1]!;
    if (raw.startsWith(WIN_TAG_PREFIX)) {
      sawVersioned = true;
      const decoded = decodeWinTag(raw);
      if (decoded !== undefined) versioned.add(decoded);
    } else legacy.add(raw);
  }
  if (sawVersioned) return versioned.size === 1 ? versioned.values().next().value : undefined;
  return legacy.size === 1 ? legacy.values().next().value : undefined;
}

/** How taskkill reports that the target is already gone. */
const gone = (error: unknown) => {
  const e = error as { code?: number | string; status?: number; stderr?: string };
  return e.status === 128 || e.code === 128 || /not found|not running|no running instance/i.test(String(e.stderr ?? ""));
};

/** End a process and every live descendant (`taskkill /T`). A vanished process is not an error. */
export async function killTree(pid: number, options: { force?: boolean; timeout?: number } = {}): Promise<void> {
  if (!IS_WINDOWS) throw new Error("killTree is Windows-only");
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    await exec(taskkillPath(), ["/PID", String(pid), "/T", ...(options.force === false ? [] : ["/F"])],
      { timeout: options.timeout ?? 10_000, windowsHide: true, env: helperEnv() });
  } catch (error) { if (!gone(error)) throw error; }
}
export function killTreeSync(pid: number, options: { force?: boolean } = {}): void {
  if (!IS_WINDOWS) throw new Error("killTreeSync is Windows-only");
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync(taskkillPath(), ["/PID", String(pid), "/T", ...(options.force === false ? [] : ["/F"])],
      { timeout: 10_000, windowsHide: true, stdio: "ignore", env: helperEnv() });
  } catch (error) { if (!gone(error)) throw error; }
}
