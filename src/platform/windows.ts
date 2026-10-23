// Native Windows support: PowerShell is the only process observer Node has (Win32_Process through CIM), and
// taskkill is its process-tree terminator. Environment variables of other processes are not readable on Windows, so
// process identity is (pid, creation time) and process trees replace the inherited DSA_EXEC tag.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const IS_WINDOWS = process.platform === "win32";

/** The Windows directory holding powershell.exe and taskkill.exe. */
export function systemRoot(): string { return process.env.SystemRoot || process.env.windir || "C:\\Windows"; }

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
  return env.ComSpec || env.COMSPEC || join(systemRoot(), "System32", "cmd.exe");
}

const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
/** Run a PowerShell script; rejects with its stderr. */
export async function powershell(script: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await exec(powershellPath(), [...PS_FLAGS, script],
      { signal: options.signal, timeout: options.timeout ?? 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    // A process that vanished while it was queried is not an error: the caller reads an empty answer.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw error;
  }
}
export function powershellSync(script: string, options: { timeout?: number } = {}): string {
  return execFileSync(powershellPath(), [...PS_FLAGS, script], { timeout: options.timeout ?? 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
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
export const PROCESS_ROWS_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { " +
  "$d = $_.CreationDate; $t = if ($d) { $d.Ticks } else { '' }; " +
  "$c = [string]$_.CommandLine; $c = $c.Replace(\"`t\", ' ').Replace(\"`r\", ' ').Replace(\"`n\", ' '); " +
  "\"{0}`t{1}`t{2}`t{3}`t{4}\" -f $_.ProcessId, $_.ParentProcessId, $t, ($_.UserModeTime + $_.KernelModeTime), $c }";

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
    const out = await powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.Ticks }`, options);
    return out.trim();
  } catch { return ""; }
}
export function winStartSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try { return powershellSync(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.Ticks }`).trim(); }
  catch { return ""; }
}
/** A diagnostic command line (never evidence of identity or death). */
export async function winCommandLine(pid: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const out = await powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`, { signal, timeout: 1000 });
    return out.trim().replace(/\s+/g, " ").slice(0, 200);
  } catch { return ""; }
}
export function winCommandLineSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    return powershellSync(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`, { timeout: 1000 })
      .trim().replace(/\s+/g, " ").slice(0, 200);
  } catch { return ""; }
}
/** A tag carried in a command line (`DSA_EXEC=<id>`), the Windows substitute for an unreadable environment: a launcher
 *  we control writes it into its own argv so a crash before the identity is journaled still finds the process. */
export function winTag(command: string | undefined, name: string): string | undefined {
  if (!command) return undefined;
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s&"']+)`).exec(command);
  return match?.[1];
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
      { timeout: options.timeout ?? 10_000, windowsHide: true });
  } catch (error) { if (!gone(error)) throw error; }
}
export function killTreeSync(pid: number, options: { force?: boolean } = {}): void {
  if (!IS_WINDOWS) throw new Error("killTreeSync is Windows-only");
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync(taskkillPath(), ["/PID", String(pid), "/T", ...(options.force === false ? [] : ["/F"])],
      { timeout: 10_000, windowsHide: true, stdio: "ignore" });
  } catch (error) { if (!gone(error)) throw error; }
}
