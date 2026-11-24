// Native Windows support: PowerShell is the process observer (Win32_Process through CIM) and executes handle-verified
// process termination (OpenProcess + GetProcessTimes + TerminateProcess; never bare-PID taskkill /T, which ignores
// creation times across exit/PID reuse and non-reparented boot/system orphans). Environment variables of other processes
// are not readable on Windows, so process identity is (pid, creation time) and live creation-ordered process trees replace
// the inherited DSA_EXEC tag.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const IS_WINDOWS = process.platform === "win32";

/** The Windows directory holding powershell.exe and cmd.exe. */
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

/** The whole 32-bit code of a Windows process status. Node hands the kernel's exit code back as a JS number whose bit
 *  pattern is that DWORD, on some paths and versions as a signed int32 (0xC0000005 reads -1073741819), so every status
 *  this package records, reads back or reports is normalized here: a negative number is not an exit status at all.
 *  (The Windows command wrapper, a standalone file, spells the same normalization itself; `>>> 0`.) */
export const dword = (status: number): number => status >>> 0;
/** The largest status a Windows process can end with: its exit code is one DWORD. */
export const DWORD_MAX = 0xffffffff;

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
/** The command processor a string command runs through (`command calls` keep their shell semantics). */
export function comspec(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "ComSpec") || join(systemRoot(env), "System32", "cmd.exe");
}

function winTimeoutError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "ETIMEDOUT";
  return error;
}

/** Whether an error from an async Windows helper/kill step represents deadline or abort expiry rather than a Win32 refusal. */
export function isWinKillTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string | number | null; killed?: boolean };
  if (e.name === "AbortError" || e.code === "ABORT_ERR" || e.code === "ETIMEDOUT") return true;
  return e.killed === true && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

const PS_PREAMBLE = "$ErrorActionPreference = 'Stop'; ";
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
/** Run a PowerShell script; rejects with its stderr. */
export async function powershell(script: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const timeout = options.timeout ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw winTimeoutError(`PowerShell timed out after ${timeout} ms`);
  const { stdout } = await exec(powershellPath(), [...PS_FLAGS, PS_PREAMBLE + script],
    { signal: options.signal, timeout: Math.max(1, Math.ceil(timeout)), maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: helperEnv() });
  return stdout;
}
export function powershellSync(script: string, options: { timeout?: number } = {}): string {
  const timeout = options.timeout ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw winTimeoutError(`PowerShell timed out after ${timeout} ms`);
  return execFileSync(powershellPath(), [...PS_FLAGS, PS_PREAMBLE + script], { timeout: Math.max(1, Math.ceil(timeout)), maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: helperEnv() });
}

export interface WinProcessIdentity {
  pid: number;
  /** Creation time in .NET ticks (required to prove process ownership on Windows). */
  start: string;
}

export interface WinProcessRow {
  pid: number;
  ppid: number;
  /** Creation time in .NET ticks (a stable identity token, never reused with the same pid). */
  start: string;
  cpuMs?: number;
  /** Resident WorkingSetSize in bytes, if reported by Win32_Process. */
  rssBytes?: number;
  command?: string;
}

const MAX_WIN_TICKS = 3155378975999999999n; // System.DateTime.MaxValue.Ticks

/** Valid Windows creation-time token: positive decimal .NET ticks within DateTime range. */
export function isWinStart(start: string | undefined): start is string {
  if (typeof start !== "string" || !/^\d{1,19}$/.test(start)) return false;
  const ticks = BigInt(start);
  return ticks > 0n && ticks <= MAX_WIN_TICKS;
}

/** Whether an observed start token names the same Windows process instance as a recorded creation time.
 *  GetProcessTimes truncates to whole microseconds ((creation / 10) * 10) and Win32_Process DMTF CreationDate carries
 *  whole microseconds as well; they agree within one microsecond unit (10 ticks), whereas any recycled pid is created
 *  at least a process lifetime later. Empty or malformed tokens fail closed (`false`). */
export function sameCreation(observed: string | undefined, recorded: string | undefined): boolean {
  if (!isWinStart(observed) || !isWinStart(recorded)) return false;
  if (observed === recorded) return true;
  const a = BigInt(observed), b = BigInt(recorded);
  return (a >= b ? a - b : b - a) <= 10n;
}

/** Whether a live row `child` can be a genuine child of a live row `parent` in the same process-table snapshot.
 *  Windows never reparents orphaned processes when their parent exits, so a recycled PID (`parent`) can match the static
 *  `ParentProcessId` of a long-running system/user process created before `parent` existed (e.g. a critical system
 *  process created at boot). Requiring `child.start >= parent.start` while `parent` is live excludes all pre-existing
 *  orphans on that PID, and because `parent` is still live no later incarnation of `parent.pid` has existed yet. */
export function isOwnedWinChild(parent: Pick<WinProcessRow, "pid" | "start">, child: Pick<WinProcessRow, "pid" | "ppid" | "start">): boolean {
  if (child.pid === parent.pid || child.ppid !== parent.pid) return false;
  if (!isWinStart(parent.start) || !isWinStart(child.start)) return false;
  return BigInt(child.start) >= BigInt(parent.start);
}

/** Proven-owned live descendants of `roots` in a single snapshot `rows`. Only roots that are themselves live with a
 *  matching creation time in `rows` may expand `ParentProcessId` edges: once a parent exits, its numeric PID can be
 *  recycled by an unrelated process whose children share that numeric `ppid` and have later creation times. */
export function winLiveDescendants(roots: readonly WinProcessIdentity[], rows: Iterable<WinProcessRow>): WinProcessRow[] {
  const byPid = new Map<number, WinProcessRow>(), byParent = new Map<number, WinProcessRow[]>();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0 || !isWinStart(row.start)) continue;
    byPid.set(row.pid, row);
    const list = byParent.get(row.ppid);
    if (list) list.push(row); else byParent.set(row.ppid, [row]);
  }
  const rootPids = new Set<number>(), seen = new Set<number>(), queue: WinProcessRow[] = [], out: WinProcessRow[] = [];
  for (const root of roots) {
    if (!Number.isInteger(root.pid) || root.pid <= 0 || !isWinStart(root.start)) continue;
    const live = byPid.get(root.pid);
    if (live && sameCreation(live.start, root.start) && !seen.has(live.pid)) {
      rootPids.add(live.pid); seen.add(live.pid); queue.push(live);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || !isOwnedWinChild(parent, child)) continue;
      seen.add(child.pid); queue.push(child);
      if (!rootPids.has(child.pid)) out.push(child);
    }
  }
  return out;
}

/** One line per process: pid, ppid, creation ticks, CPU (100ns -> ms) and command line (tabs/newlines replaced by
 *  spaces so a line stays one row). */
const creationTicks = "[System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).Ticks";
function processQuery(fields: string, body: string, pid?: number): string {
  const where = pid === undefined ? "" : ` WHERE ProcessId=${pid}`;
  return `$s = [wmisearcher]'SELECT ${fields} FROM Win32_Process${where}'; foreach ($p in $s.Get()) { ${body} }`;
}
export const PROCESS_ROWS_SCRIPT = processQuery("ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime,WorkingSetSize,CommandLine",
  `if (!$p.CreationDate) { continue }; $t = ${creationTicks}; ` +
  '$c = ([string]$p.CommandLine) -replace "[`t`r`n]", " "; ' +
  '"{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $p.ProcessId, $p.ParentProcessId, $t, ([uint64]$p.UserModeTime + [uint64]$p.KernelModeTime), ([uint64]$p.WorkingSetSize), $c');

export function parseProcessRows(stdout: string): WinProcessRow[] {
  const rows: WinProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    // 6+ columns (current PROCESS_ROWS_SCRIPT): pid, ppid, start, cpu, rssBytes, command...
    // 5 columns (legacy fixtures): pid, ppid, start, cpu, command
    const hasRss = parts.length >= 6 && /^\d+$/.test(parts[4]!);
    const [pid, ppid, start, cpu] = parts;
    const rss = hasRss ? Number(parts[4]) : undefined;
    const rest = hasRss ? parts.slice(5) : parts.slice(4);
    const id = Number(pid), parent = Number(ppid), ticks = Number(cpu);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(parent) || parent < 0 || !isWinStart(start)) continue;
    rows.push({ pid: id, ppid: parent, start, ...(Number.isFinite(ticks) ? { cpuMs: ticks / 10_000 } : {}),
      ...(rss !== undefined && Number.isFinite(rss) ? { rssBytes: rss } : {}),
      ...(rest.length ? { command: rest.join(" ") } : {}) });
  }
  return rows;
}

/** One full process-table observation (about 0.5 s: PowerShell startup plus the CIM query). */
export async function winProcessRows(options: { signal?: AbortSignal; timeout?: number } = {}): Promise<WinProcessRow[]> {
  return parseProcessRows(await powershell(PROCESS_ROWS_SCRIPT, options));
}

let snapshot: { at: number; rows: Map<number, WinProcessRow> } | undefined;

export interface WinSnapshotSyncOptions {
  /** Test seam: synchronous PowerShell script runner (default: `powershellSync`). */
  runSync?: (script: string) => string;
  /** Test seam: wall-clock timestamp source in ms (default: `Date.now`). */
  now?: () => number;
}

/** Test helper: clear the short-lived synchronous Windows snapshot cache. */
export function resetWinSnapshotCache(): void {
  snapshot = undefined;
}

function readWinSnapshotSync(maxAgeMs = 250, options?: WinSnapshotSyncOptions): { rows: Map<number, WinProcessRow>; fresh: boolean } {
  const clock = options?.now ?? Date.now;
  const now = clock();
  if (!snapshot || now < snapshot.at || now - snapshot.at > maxAgeMs) {
    const runSync = options?.runSync ?? powershellSync;
    const rows = parseProcessRows(runSync(PROCESS_ROWS_SCRIPT));
    snapshot = { at: clock(), rows: new Map(rows.map(row => [row.pid, row])) };
    return { rows: snapshot.rows, fresh: true };
  }
  return { rows: snapshot.rows, fresh: false };
}

/** A short-lived synchronous snapshot for lease readers and liveness checks. Propagates query failures instead of
 *  returning an empty table (missing rows are not proof of death, and an error must never look like every process exited). */
export function winSnapshotSync(maxAgeMs = 250, options?: WinSnapshotSyncOptions): Map<number, WinProcessRow> {
  return readWinSnapshotSync(maxAgeMs, options).rows;
}

export type KernelPidProbe = "alive" | "eperm" | "dead";

/** Probe whether a PID exists in the kernel while distinguishing accessible processes (`"alive"`) from protected or
 *  cross-user processes (`"eperm"`) and absent PIDs (`"dead"`). */
export function probeKernelPid(pid: number, kill: (pid: number, signal: 0) => void = process.kill): KernelPidProbe {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "eperm" : "dead";
  }
}

export interface WinProcessAliveOptions {
  /** Test seam: probe whether `pid` exists in the kernel (`"alive"`, `"eperm"`, or `"dead"`). */
  probePid?: (pid: number) => KernelPidProbe;
  /** Test seam: read the Windows process snapshot (default: `winSnapshotSync`). */
  snapshotWin?: (maxAgeMs?: number) => ReadonlyMap<number, WinProcessRow>;
  /** Test seam: read one process's creation time directly when absent from a cached snapshot. */
  startWinSync?: (pid: number) => string;
}

/** Whether a Windows process still runs, verifying `expectedStart` when provided.
 *  - Without `expectedStart`, `"alive"` and `"eperm"` both return `true` (PID exists).
 *  - With `expectedStart`, a protected process (`"eperm"`) absent from a successful snapshot (e.g. empty
 *    `CreationDate` filtered out by `parseProcessRows`) fails closed (`false`) instead of assuming PID reuse matches.
 *  - Transient snapshot query errors never crash callers or silently turn live accessible processes into dead. */
export function winProcessAlive(pid: number, expectedStart?: string, options: WinProcessAliveOptions = {}): boolean {
  const probe = (options.probePid ?? probeKernelPid)(pid);
  if (probe === "dead") return false;
  if (!expectedStart) return true;
  if (!isWinStart(expectedStart)) return false;
  let rows: ReadonlyMap<number, WinProcessRow>;
  let fresh = false;
  try {
    if (options.snapshotWin) {
      rows = options.snapshotWin();
    } else {
      const snap = readWinSnapshotSync();
      rows = snap.rows;
      fresh = snap.fresh;
    }
  } catch {
    return probe === "alive";
  }
  const row = rows.get(pid);
  if (row) return sameCreation(row.start, expectedStart);
  if (probe === "eperm") return false;
  if (options.startWinSync) {
    try {
      const direct = options.startWinSync(pid);
      return direct ? sameCreation(direct, expectedStart) : false;
    } catch {
      return true;
    }
  }
  if (fresh) return false;
  try {
    const refreshed = options.snapshotWin ? options.snapshotWin(0) : readWinSnapshotSync(0).rows;
    const freshRow = refreshed.get(pid);
    return freshRow ? sameCreation(freshRow.start, expectedStart) : false;
  } catch {
    return true;
  }
}

/** The creation-time token of one process ("" when it has already gone; rejects when the observer itself fails). */
export async function winStart(pid: number, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const out = (await powershell(processQuery("CreationDate", `if ($p.CreationDate) { ${creationTicks} }`, pid), options)).trim();
  if (!out) return "";
  if (!isWinStart(out)) throw new Error(`Invalid Windows creation time for pid ${pid}: ${String(out).slice(0, 80)}`);
  return out;
}
export function winStartSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const out = powershellSync(processQuery("CreationDate", `if ($p.CreationDate) { ${creationTicks} }`, pid)).trim();
    return isWinStart(out) ? out : "";
  } catch { return ""; }
}

/** Normalize and bound a diagnostic Windows command line (EX1: at most 200 characters, single-spaced). */
export function clipWinCommandLine(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 200);
}

const SCANNED_COMMAND = Symbol("dsa.win.scannedCommand");
type WithScannedCommand = { [SCANNED_COMMAND]?: string; command?: unknown };

/** Attach a diagnostic command line observed during a fresh Windows process-table scan without adding an enumerable
 *  field (so `gate-tracked`/`eval-tracked` journal serialization and `ProcInfo` shape remain unchanged). */
export function attachScannedCommand<T extends object>(proc: T, command: string | undefined): T {
  if (typeof command === "string") {
    Object.defineProperty(proc, SCANNED_COMMAND, { value: clipWinCommandLine(command), enumerable: false, configurable: true });
  }
  return proc;
}

/** Read a diagnostic command line already observed on a scanned process row, if present. */
export function scannedCommand(proc: object | undefined): string | undefined {
  if (!proc || typeof proc !== "object") return undefined;
  const carrier = proc as WithScannedCommand;
  if (typeof carrier[SCANNED_COMMAND] === "string") return carrier[SCANNED_COMMAND];
  if (typeof carrier.command === "string") return clipWinCommandLine(carrier.command);
  return undefined;
}

/** A diagnostic command line (never evidence of identity or death). */
export async function winCommandLine(pid: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0 || signal?.aborted) return "";
  try {
    const out = await powershell(processQuery("CommandLine", "$p.CommandLine", pid), { signal, timeout: 1000 });
    return clipWinCommandLine(out);
  } catch { return ""; }
}
export function winCommandLineSync(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    return clipWinCommandLine(powershellSync(processQuery("CommandLine", "$p.CommandLine", pid), { timeout: 1000 }));
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

export interface WinKillOptions {
  timeout?: number;
  signal?: AbortSignal;
  /** Test seam: platform override (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Test seam: async PowerShell script runner. */
  run?: (script: string, options: { timeout?: number; signal?: AbortSignal }) => Promise<string>;
}

export interface WinKillSyncOptions {
  timeout?: number;
  /** Test seam: platform override (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Test seam: synchronous PowerShell script runner. */
  runSync?: (script: string, options: { timeout?: number }) => string;
}

export const KILL_BATCH_SIZE = 128;

/** Validate and deduplicate Windows `(pid, start)` targets. Fails closed on any missing or malformed identity. */
export function normalizeWinTargets(targets: WinProcessIdentity | readonly WinProcessIdentity[]): WinProcessIdentity[] {
  const list: readonly WinProcessIdentity[] = Array.isArray(targets) ? targets : [targets as WinProcessIdentity];
  const deduped = new Map<string, WinProcessIdentity>();
  for (const target of list) {
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0 || target.pid > DWORD_MAX || !isWinStart(target.start)) {
      throw new Error(`Refusing to end Windows process without verified identity (pid=${String(target?.pid)}, start=${JSON.stringify(target?.start)})`);
    }
    deduped.set(`${target.pid}:${target.start}`, { pid: target.pid, start: target.start });
  }
  return [...deduped.values()];
}

/** Build the in-memory Win32 handle-verified termination script (never uses bare-PID `taskkill /T`).
 *  Each target handle is verified via `GetProcessTimes` before `TerminateProcess` on that same handle, and verified
 *  parent handles stay open until descendant discovery completes so Windows cannot recycle a parent PID mid-sweep. */
export function buildWinKillScript(targets: readonly WinProcessIdentity[], includeDescendants: boolean): string {
  const checked = normalizeWinTargets(targets);
  const spec = checked.map(t => `${t.pid}:${t.start}`).join(";");
  return [
    "if (!('DsaWin32.Kernel' -as [type])) {",
    "  $ab = [System.Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'DsaWin32'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "  $mb = $ab.DefineDynamicModule('DsaWin32')",
    "  $tb = $mb.DefineType('DsaWin32.Kernel', 'Public,Abstract,Sealed')",
    "  $ctor = [System.Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))",
    "  $sle = [System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')",
    "  $attr = New-Object System.Reflection.Emit.CustomAttributeBuilder($ctor, @('kernel32.dll'), @($sle), @($true))",
    "  $add = { param([string]$n, [type]$r, [type[]]$p); $m = $tb.DefineMethod($n, 'Public,Static,PinvokeImpl', $r, $p); $m.SetCustomAttribute($attr) }",
    "  & $add 'OpenProcess' ([IntPtr]) ([type[]]@([uint32], [bool], [uint32]))",
    "  & $add 'GetProcessTimes' ([bool]) ([type[]]@([IntPtr], [int64].MakeByRefType(), [int64].MakeByRefType(), [int64].MakeByRefType(), [int64].MakeByRefType()))",
    "  & $add 'IsProcessCritical' ([bool]) ([type[]]@([IntPtr], [bool].MakeByRefType()))",
    "  & $add 'TerminateProcess' ([bool]) ([type[]]@([IntPtr], [uint32]))",
    "  & $add 'CloseHandle' ([bool]) ([type[]]@([IntPtr]))",
    "  [void]$tb.CreateType()",
    "}",
    "$QUERY = [uint32]0x1000; $TERM = [uint32]0x1001; $selfPid = [uint32]$PID",
    "$held = New-Object 'System.Collections.Generic.List[IntPtr]'",
    "$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "$step = {",
    "  param([uint32]$targetPid, [int64]$expectedTicks, [int64]$minCreationFt)",
    "  if ($targetPid -eq 0 -or $targetPid -eq $selfPid -or $seen.Contains($targetPid)) { return $null }",
    "  $hQuery = [DsaWin32.Kernel]::OpenProcess($QUERY, $false, $targetPid)",
    "  if ($hQuery -eq [IntPtr]::Zero) {",
    "    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "    if ($err -eq 87) { return $null }",
    "    if ($err -eq 5) {",
    "      $rows = @(([wmisearcher]\"SELECT CreationDate FROM Win32_Process WHERE ProcessId=$targetPid\").Get())",
    "      if ($rows.Count -eq 0) { return $null }",
    "      foreach ($r in $rows) {",
    "        if (!$r.CreationDate) { throw \"Unverifiable process identity for pid $targetPid (OpenProcess denied)\" }",
    "        $wt = [int64][System.Management.ManagementDateTimeConverter]::ToDateTime($r.CreationDate).Ticks",
    "        $wd = if ($wt -ge $expectedTicks) { $wt - $expectedTicks } else { $expectedTicks - $wt }",
    "        if ($wd -le [int64]10) { throw \"OpenProcess denied for verified live pid $targetPid\" }",
    "      }",
    "      return $null",
    "    }",
    "    throw \"OpenProcess($targetPid) failed with Win32 error $err\"",
    "  }",
    "  $keepQuery = $false",
    "  try {",
    "    [int64]$creation = 0; [int64]$exit = 0; [int64]$k = 0; [int64]$u = 0",
    "    if (![DsaWin32.Kernel]::GetProcessTimes($hQuery, [ref]$creation, [ref]$exit, [ref]$k, [ref]$u) -or $creation -le 0) {",
    "      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "      throw \"GetProcessTimes($targetPid) failed with Win32 error $err\"",
    "    }",
    "    if ($minCreationFt -gt 0 -and $creation -lt $minCreationFt) { return $null }",
    "    $obsTicks = [int64][System.DateTime]::FromFileTime($creation - ($creation % [int64]10)).Ticks",
    "    $diff = if ($obsTicks -ge $expectedTicks) { $obsTicks - $expectedTicks } else { $expectedTicks - $obsTicks }",
    "    if ($diff -gt [int64]10) { return $null }",
    "    [void]$seen.Add($targetPid)",
    "    $held.Add($hQuery); $keepQuery = $true",
    "    $node = [pscustomobject]@{ Pid = $targetPid; CreationFt = $creation; Ticks = $obsTicks }",
    "    if ($exit -ne 0) { return $node }",
    "    $hTerm = [DsaWin32.Kernel]::OpenProcess($TERM, $false, $targetPid)",
    "    if ($hTerm -eq [IntPtr]::Zero) {",
    "      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "      if ($err -eq 87) { return $node }",
    "      [int64]$c2 = 0; [int64]$e2 = 0; [int64]$k2 = 0; [int64]$u2 = 0",
    "      if ([DsaWin32.Kernel]::GetProcessTimes($hQuery, [ref]$c2, [ref]$e2, [ref]$k2, [ref]$u2) -and $e2 -ne 0) { return $node }",
    "      throw \"OpenProcess(PROCESS_TERMINATE, $targetPid) failed with Win32 error $err\"",
    "    }",
    "    try {",
    "      [int64]$tc = 0; [int64]$te = 0; [int64]$tk = 0; [int64]$tu = 0",
    "      if (![DsaWin32.Kernel]::GetProcessTimes($hTerm, [ref]$tc, [ref]$te, [ref]$tk, [ref]$tu) -or $tc -ne $creation) { return $null }",
    "      if ($te -ne 0) { return $node }",
    "      [bool]$critical = $false",
    "      if (![DsaWin32.Kernel]::IsProcessCritical($hTerm, [ref]$critical) -or $critical) { throw \"Refusing to end critical or unverified process $targetPid\" }",
    "      if (![DsaWin32.Kernel]::TerminateProcess($hTerm, [uint32]1)) {",
    "        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "        [int64]$c3 = 0; [int64]$e3 = 0; [int64]$k3 = 0; [int64]$u3 = 0",
    "        if (!([DsaWin32.Kernel]::GetProcessTimes($hTerm, [ref]$c3, [ref]$e3, [ref]$k3, [ref]$u3) -and $e3 -ne 0)) {",
    "          throw \"TerminateProcess($targetPid) failed with Win32 error $err\"",
    "        }",
    "      }",
    "      return $node",
    "    } finally { [void][DsaWin32.Kernel]::CloseHandle($hTerm) }",
    "  } finally { if (!$keepQuery) { [void][DsaWin32.Kernel]::CloseHandle($hQuery) } }",
    "}",
    "try {",
    "  $inv = [Globalization.CultureInfo]::InvariantCulture",
    "  $parents = New-Object 'System.Collections.Generic.Dictionary[uint32, object]'",
    `  foreach ($entry in ('${spec}' -split ';')) {`,
    "    if (!$entry) { continue }",
    "    $parts = $entry -split ':'",
    "    $res = & $step ([uint32]::Parse($parts[0], $inv)) ([int64]::Parse($parts[1], $inv)) ([int64]0)",
    "    if ($null -ne $res) { $parents[$res.Pid] = $res }",
    "  }",
    ...(includeDescendants ? [
      "  while ($parents.Count -gt 0) {",
      "    $next = New-Object 'System.Collections.Generic.Dictionary[uint32, object]'",
      "    $scan = ([wmisearcher]'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process').Get()",
      "    foreach ($p in $scan) {",
      "      $ppid = [uint32]$p.ParentProcessId; $cpid = [uint32]$p.ProcessId",
      "      if (!$parents.ContainsKey($ppid) -or $cpid -eq 0 -or $cpid -eq $selfPid -or $seen.Contains($cpid) -or !$p.CreationDate) { continue }",
      "      $pInfo = $parents[$ppid]",
      "      $ct = [int64][System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).Ticks",
      "      if ($ct + [int64]10 -lt [int64]$pInfo.Ticks) { continue }",
      "      $res = & $step $cpid $ct ([int64]$pInfo.CreationFt)",
      "      if ($null -ne $res) { $next[$res.Pid] = $res }",
      "    }",
      "    $parents = $next",
      "  }",
    ] : []),
    "} finally { foreach ($h in $held) { [void][DsaWin32.Kernel]::CloseHandle($h) } }",
  ].join("\n");
}

async function runWinKill(targets: WinProcessIdentity | readonly WinProcessIdentity[], includeDescendants: boolean, options: WinKillOptions = {}): Promise<void> {
  const checked = normalizeWinTargets(targets);
  const name = includeDescendants ? "killTree" : "killProcess";
  if ((options.platform ?? process.platform) !== "win32" && !options.run) {
    throw new Error(`${name} is Windows-only`);
  }
  if (!checked.length) return;
  const budget = options.timeout ?? 10_000;
  if (!Number.isFinite(budget) || budget < 0) throw new Error(`Invalid ${name} timeout`);
  options.signal?.throwIfAborted();
  if (budget === 0) throw winTimeoutError(`${name} timed out after 0 ms`);
  const deadline = performance.now() + budget;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const run = options.run ?? ((script: string, opts: { timeout?: number; signal?: AbortSignal }) => powershell(script, opts));
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        const reason = options.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
        reject(reason);
        controller.abort(reason);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const err = winTimeoutError(`${name} timed out after ${budget} ms`);
        reject(err);
        controller.abort(err);
      }, budget);
    });
    void interrupted.catch(() => {});
    for (let i = 0; i < checked.length; i += KILL_BATCH_SIZE) {
      options.signal?.throwIfAborted();
      if (controller.signal.aborted) throw controller.signal.reason;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const err = winTimeoutError(`${name} timed out after ${budget} ms`);
        controller.abort(err);
        throw err;
      }
      const batch = checked.slice(i, i + KILL_BATCH_SIZE);
      const pending = Promise.resolve().then(() => run(buildWinKillScript(batch, includeDescendants), {
        timeout: Math.max(1, Math.ceil(remaining)),
        signal: controller.signal,
      }));
      void pending.catch(() => {});
      await Promise.race([pending, interrupted]);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function runWinKillSync(targets: WinProcessIdentity | readonly WinProcessIdentity[], includeDescendants: boolean, options: WinKillSyncOptions = {}): void {
  const checked = normalizeWinTargets(targets);
  const name = includeDescendants ? "killTreeSync" : "killProcessSync";
  if ((options.platform ?? process.platform) !== "win32" && !options.runSync) {
    throw new Error(`${name} is Windows-only`);
  }
  if (!checked.length) return;
  const budget = options.timeout ?? 10_000;
  if (!Number.isFinite(budget) || budget < 0) throw new Error(`Invalid ${name} timeout`);
  if (budget === 0) throw winTimeoutError(`${name} timed out after 0 ms`);
  const deadline = performance.now() + budget;
  const runSync = options.runSync ?? ((script: string, opts: { timeout?: number }) => powershellSync(script, opts));
  for (let i = 0; i < checked.length; i += KILL_BATCH_SIZE) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw winTimeoutError(`${name} timed out after ${budget} ms`);
    const batch = checked.slice(i, i + KILL_BATCH_SIZE);
    runSync(buildWinKillScript(batch, includeDescendants), { timeout: Math.max(1, Math.ceil(remaining)) });
  }
}

/** End verified Windows process(es) without touching descendants (e.g. an orchestrator host whose command calls outlive it). */
export async function killProcess(targets: WinProcessIdentity | readonly WinProcessIdentity[], options: WinKillOptions = {}): Promise<void> {
  await runWinKill(targets, false, options);
}
export function killProcessSync(targets: WinProcessIdentity | readonly WinProcessIdentity[], options: WinKillSyncOptions = {}): void {
  runWinKillSync(targets, false, options);
}

/** End verified Windows process(es) and their proven-owned live descendants. Vanished or reused PIDs are untouched. */
export async function killTree(targets: WinProcessIdentity | readonly WinProcessIdentity[], options: WinKillOptions = {}): Promise<void> {
  await runWinKill(targets, true, options);
}
export function killTreeSync(targets: WinProcessIdentity | readonly WinProcessIdentity[], options: WinKillSyncOptions = {}): void {
  runWinKillSync(targets, true, options);
}
