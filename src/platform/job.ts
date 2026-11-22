// Windows command attempts run inside a kernel-owned group: a Job Object created for one attempt, whose only handle is
// held by a small helper process and never inherited. The command's wrapper is created suspended, assigned to the group
// and only then resumed, so nothing it starts can ever be outside the group; with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE the
// kernel terminates every process left in the group when that handle closes, which happens when the wrapper ends, when
// the helper is killed, and when the helper crashes. A command attempt therefore cannot outlive its wrapper by a
// descendant, and the orchestrator (or a successor that adopted the attempt) can never start a second attempt while
// processes of the first can still act.
//
// The helper is PowerShell 5.1 (shipped with every supported Windows; no native binary to build or ship) compiling a
// small C# block in memory with Add-Type: Node has no Job Object API and this adds no npm dependency. Its script is
// written into the attempt directory once per attempt (a command line would hit Windows' 32 KiB limit) and run with
// `-File`; the attempt directory is the script's only argument, so no path is ever written into the script and none of
// its text is quoted or case-folded by PowerShell. The script itself is pure ASCII (a test asserts it), because
// PowerShell 5.1 reads a file with no byte order mark in the ANSI code page: only the attempt directory, the argv and
// the environment can be Unicode, and those travel as arguments and through job.json (see jobSpecText). The C# is
// compiled on each attempt (about a second), which a command call's lifetime amortizes.
//
// The helper is spawned hidden, and this is the repair's open point: PowerShell 5.1 (and pwsh) quietly abort with
// exit code 0, no stderr and no script run when they have no console (PowerShell#28383; Windows CI 45039418985 measured
// it: the same script started the wrapper and recorded the group when it had a console and produced nothing at all
// detached). DETACHED_PROCESS is exactly what a detached spawn asks for, but a non-detached child is assigned to
// libuv's kill-with-parent job, so an attempt would die with the orchestrator -- the property this module exists for.
// Both cannot hold from the orchestrator alone: a helper with a console of its own and no job has to be created with
// CREATE_NO_WINDOW/CREATE_NEW_CONSOLE, which Node cannot ask for. The repair needs one of: a first helper (hidden
// console, doomed with the orchestrator) that creates a hidden-console successor holding the group's handle, or a
// `cmd /c start /wait /min` relay (visible minimized window), each of which changes who owns the group.
//
// Observation is fail-closed: before a group exists the orchestrator waits for the helper's `group` record (the suspended
// child's pid, written before the child may run) and starts no attempt when it does not arrive or cannot be read; the
// helper never resumes the child unless CreateJobObject, SetInformationJobObject, CreateProcess, AssignProcessToJobObject
// and IsProcessInJob all succeeded, and it writes `start-error` when they did not. The helper's own identity is recorded
// with the attempt, so its absence from the process table proves the group is closed.
//
// The handshake has two windows a crash or a slow machine can cut into, and both must keep a second attempt from starting
// while the first can still act. The first is the helper's own startup (PowerShell parsing the script and compiling the
// C#): no group record and no wrapper exist yet, so the attempt is found by the tag in the helper's command line
// (`DSA_EXEC=<id>`, the same tag a POSIX command carries in its environment) -- the helper is passed it in its argv, never
// only in an environment a Windows process table cannot read. The second is the failure path: a handshake that cannot be
// completed ends the helper and reports a refusal only once the helper has ended (its exit closes the group's only handle,
// so nothing of the attempt can act); when the end cannot be confirmed -- the kill failed, or the helper is still there at
// the deadline -- the attempt is adopted instead (JobSpawned.uncertain), its identity travels to the orchestrator, and the
// call keeps the attempt tracked, so nothing starts a second attempt until a scan finds the first one gone.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { helperEnv, killTree, powershellPath, winProcessRows, type WinProcessRow } from "./windows.ts";

/** The helper type: exported for the packaging check (the script is compiled into dist/platform/job.js, never a file). */
export const JOB_HELPER_MARKER = "DsaJob";
/** The helper script, written into the attempt directory before each attempt and run with `powershell.exe -File`. */
export const JOB_SCRIPT = "job.ps1";
/** The helper's own stderr (its diagnostics when the script itself cannot run; empty otherwise). */
export const JOB_HELPER_LOG = "helper.log";
/** What the helper reads: the program, argv, cwd, output file and complete environment of the attempt's wrapper. */
export const JOB_SPEC = "job.json";
/** Written (atomically) after the wrapper is in the group and before it may run: `{"pid":<wrapper pid>}`. */
export const JOB_GROUP = "group";
/** Written when the helper saw the wrapper end: `{"status":<wrapper exit status>}`. */
export const JOB_END = "group-end";
/** Written (atomically) when the helper could not start the wrapper: a short reason for the failed attempt. */
export const JOB_ERROR = "start-error";
/** Written by the helper's first statement, before Add-Type: its absence proves the script never ran (a launcher or
 *  PowerShell problem, not a failure of this attempt), which is what a bare "the helper ended" otherwise hides. */
export const JOB_BEGIN = "helper-begin";
/** Written by this process when the helper ends: its exit code (or why it could not be spawned), for the failure
 *  reason. The helper cannot report this itself -- it is the process that ended. */
export const JOB_HELPER_EXIT = "helper-exit";
/** How much of an evidence file a failure reason may read; a reason is a line, never a dump. */
const REASON_BYTES = 1000;
/** How much of it a failure reason may quote, and how long the whole reason may get. */
const EVIDENCE_LIMIT = 200;
const REASON_LIMIT = 300;
/** Add-Type plus process creation on a loaded runner; a helper that has not reported a group by then started nothing. */
const JOB_START_TIMEOUT_MS = 30_000;
/** How long a helper that cannot be confirmed retired is given to end before its attempt is adopted instead. */
const JOB_HELPER_END_MS = 5_000;
/** Caps the retries of a failed process-table observation: past it the attempt is adopted rather than refused. */
const JOB_OBSERVE_MS = 10_000;

const C_SHARP = `
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DsaJob
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint DETACHED_PROCESS = 0x00000008;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_APPEND_DATA = 0x00000004;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    const uint INFINITE = 0xFFFFFFFF;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);

    /** Run the wrapper inside a new group and return its exit status (negative: the helper failed, see start-error). */
    public static int Run(string dir, string application, string[] arguments, string workingDirectory, string logPath, string[] environment)
    {
        IntPtr job = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero, block = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool started = false;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail(dir, "CreateJobObject", Marshal.GetLastWin32Error());
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                return Fail(dir, "SetInformationJobObject", Marshal.GetLastWin32Error());

            var inherit = new SECURITY_ATTRIBUTES();
            inherit.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inherit.bInheritHandle = 1;
            // Two independent handles, one for stdout and one for stderr, each opened for append only (FILE_APPEND_DATA
            // without FILE_WRITE_DATA): the kernel sends every write of each stream to the current end of the file, so
            // the two streams interleave in the log without either overwriting the other. A shared handle or a seek to
            // the end would let one stream's buffered output land on the other's (or on an earlier attempt's) bytes.
            output = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (output == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile " + logPath, Marshal.GetLastWin32Error());
            error = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (error == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile " + logPath, Marshal.GetLastWin32Error());
            input = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (input == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile NUL", Marshal.GetLastWin32Error());

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.hStdInput = input;
            startup.hStdOutput = output;
            startup.hStdError = error;
            block = EnvironmentBlock(environment);
            uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
            if (!CreateProcessW(application, CommandLine(application, arguments), IntPtr.Zero, IntPtr.Zero, true, flags, block,
                    workingDirectory, ref startup, out child))
                return Fail(dir, "CreateProcess " + application, Marshal.GetLastWin32Error());
            started = true;

            // The wrapper is still suspended: nothing it could start runs before it belongs to the group.
            if (!AssignProcessToJobObject(job, child.hProcess))
            {
                TerminateProcess(child.hProcess, 1);
                return Fail(dir, "AssignProcessToJobObject", Marshal.GetLastWin32Error());
            }
            bool assigned;
            if (!IsProcessInJob(child.hProcess, job, out assigned) || !assigned)
            {
                TerminateProcess(child.hProcess, 1);
                return Fail(dir, "IsProcessInJob", Marshal.GetLastWin32Error());
            }
            // Before the child's first instruction: the orchestrator waits for this record before it counts the attempt.
            WriteAtomic(Path.Combine(dir, "group"), "{\\"pid\\":" + child.dwProcessId.ToString(CultureInfo.InvariantCulture) + "}");
            if (ResumeThread(child.hThread) == 0xFFFFFFFF)
            {
                TerminateProcess(child.hProcess, 1);
                return Fail(dir, "ResumeThread", Marshal.GetLastWin32Error());
            }
            if (WaitForSingleObject(child.hProcess, INFINITE) != 0) return Fail(dir, "WaitForSingleObject", Marshal.GetLastWin32Error());
            uint status;
            if (!GetExitCodeProcess(child.hProcess, out status)) return Fail(dir, "GetExitCodeProcess", Marshal.GetLastWin32Error());
            WriteAtomic(Path.Combine(dir, "group-end"), "{\\"status\\":" + status.ToString(CultureInfo.InvariantCulture) + "}");
            return unchecked((int)status);
        }
        catch (Exception error)
        {
            if (started) TerminateProcess(child.hProcess, 1);
            return Fail(dir, "job helper", 0, error.GetType().Name + ": " + error.Message);
        }
        finally
        {
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (input != IntPtr.Zero && input != INVALID_HANDLE_VALUE) CloseHandle(input);
            if (output != IntPtr.Zero && output != INVALID_HANDLE_VALUE) CloseHandle(output);
            if (error != IntPtr.Zero && error != INVALID_HANDLE_VALUE) CloseHandle(error);
            if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            // The group's only handle (non-inherited): closing it kills every process the command left behind.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    static int Fail(string dir, string what, int code)
    {
        return Fail(dir, what, code, null);
    }

    static int Fail(string dir, string what, int code, string detail)
    {
        string text = what + " failed (error " + code.ToString(CultureInfo.InvariantCulture) + ")" + (detail == null ? "" : ": " + detail);
        try { File.WriteAllText(Path.Combine(dir, "start-error"), text); } catch { }
        return -1;
    }

    static void WriteAtomic(string path, string text)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, text);
        if (File.Exists(path)) File.Delete(path);
        File.Move(temporary, path);
    }

    /** The child's environment (CREATE_UNICODE_ENVIRONMENT): its variables, then the empty terminator. */
    static IntPtr EnvironmentBlock(string[] pairs)
    {
        var text = new StringBuilder();
        if (pairs != null)
            foreach (string pair in pairs)
                if (!string.IsNullOrEmpty(pair)) { text.Append(pair); text.Append('\\0'); }
        if (text.Length == 0) text.Append('\\0');
        text.Append('\\0');
        return Marshal.StringToHGlobalUni(text.ToString());
    }

    /** An argv as a CreateProcess command line, by the quoting rules CommandLineToArgvW (and the C runtime) parse. */
    static string CommandLine(string application, string[] arguments)
    {
        var text = new StringBuilder(Quote(application));
        if (arguments != null) foreach (string argument in arguments) text.Append(' ').Append(Quote(argument));
        return text.ToString();
    }

    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\\t', '\\n', '\\v', '"' }) < 0) return argument;
        var text = new StringBuilder("\\\"");
        int backslashes = 0;
        for (int i = 0; i < argument.Length; i++)
        {
            char c = argument[i];
            if (c == '\\\\') { backslashes++; continue; }
            if (c == '"') { text.Append('\\\\', backslashes * 2 + 1); text.Append('"'); backslashes = 0; continue; }
            if (backslashes > 0) { text.Append('\\\\', backslashes); backslashes = 0; }
            text.Append(c);
        }
        if (backslashes > 0) text.Append('\\\\', backslashes * 2);
        text.Append('"');
        return text.ToString();
    }
}
`;

/** The helper script: PowerShell 5.1 compiling {@link C_SHARP}, then running the wrapper in a new group. It takes the
 *  attempt directory as its only argument (`-File <script> <dir>`, bound to `$Dir`): the directory is never written into
 *  the script, so a Unicode or curly-quoted path needs no quoting and the script stays ASCII -- see the module comment.
 *  Exit codes are the launcher's evidence: 125 is a failure the script recorded, 126 is a missing attempt directory. */
export const JOB_HELPER = `$Dir = $PSScriptRoot
if (-not $Dir) { exit 126 }
$ErrorActionPreference = 'Stop'
$status = 125
try {
  # Before Add-Type, so its absence says the script itself never ran.
  [System.IO.File]::WriteAllText((Join-Path $Dir '${JOB_BEGIN}'), 'begin')
  Add-Type -TypeDefinition @'
${C_SHARP}
'@
  # UTF-8 explicitly: PowerShell 5.1 decodes a file it reads without a byte order mark as ANSI, which would mangle a
  # Unicode or curly-quoted argument.
  $spec = [System.IO.File]::ReadAllText((Join-Path $Dir '${JOB_SPEC}'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Remove-Item -LiteralPath (Join-Path $Dir '${JOB_SPEC}') -Force -ErrorAction SilentlyContinue
  $status = [DsaJob]::Run($Dir, [string]$spec.exe, [string[]]$spec.args, [string]$spec.cwd, [string]$spec.log, [string[]]$spec.env)
} catch {
  try { [System.IO.File]::WriteAllText((Join-Path $Dir '${JOB_ERROR}'), [string]$_) } catch { }
  $status = 125
}
if ($status -lt 0) { exit 125 }
exit $status
`;

/** The wrapper's environment as the helper receives it: one ordered `NAME=value` list. Windows variable names are
 *  case-insensitive, so names that differ only in case name one variable: the first spelling wins, with its position in
 *  the list, so the block is ordered and has no duplicates the kernel could resolve differently from the caller. A name
 *  that cannot be written is dropped (empty, or with `=` in it) instead of corrupting the block. */
export function jobEnv(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>(), pairs: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name || name.includes("=") || value === undefined) continue;
    const fold = name.toUpperCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    pairs.push(`${name}=${value}`);
  }
  return pairs;
}

/** The spec as JSON text this module writes itself, every code unit outside ASCII escaped (`\uXXXX`). PowerShell 5.1
 *  reads job.json as ANSI (see JOB_HELPER), so UTF-8 bytes of a Unicode path, a curly quote or a non-ASCII environment
 *  value would arrive mangled; ASCII-only text decodes identically under every code page and ConvertFrom-Json turns the
 *  escapes back into the very same UTF-16 string. */
export function jobSpecText(launch: Pick<JobLaunch, "exe" | "args" | "cwd" | "log" | "env">): string {
  return asciiJson({ exe: launch.exe, args: launch.args, cwd: launch.cwd, log: launch.log, env: jobEnv(launch.env) });
}

/** `value` as JSON text of ASCII bytes only: like JSON.stringify, but every code unit outside 0x20..0x7e is escaped (each
 *  half of a surrogate pair on its own, which JSON allows and parses back into the same pair). */
export function asciiJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError(`not JSON: ${value}`); return String(value); }
  if (typeof value === "string") return asciiString(value);
  if (Array.isArray(value)) return `[${value.map(item => asciiJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.map(([name, item]) => `${asciiString(name)}:${asciiJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`not JSON: ${typeof value}`);
}

const ASCII_ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
function asciiString(text: string): string {
  let out = '"';
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    out += unit === 0x22 || unit === 0x5c ? ASCII_ESCAPES[text[at]!]!
      : unit < 0x20 || unit > 0x7e ? `\\u${unit.toString(16).padStart(4, "0")}`
      : text[at]!;
  }
  return `${out}"`;
}

export interface JobLaunch {
  /** The program to run suspended, assigned to the group, then resumed (the command's wrapper). */
  exe: string;
  args: readonly string[];
  cwd: string;
  /** stdout and stderr of the program: one file, append (the command's output.log). */
  log: string;
  /** Its complete environment. */
  env: NodeJS.ProcessEnv;
  /** The attempt's tag (`DSA_EXEC=<exec>`): spelled in the helper's own argv, so a scan still finds the attempt while the
   *  helper compiles, before the group record exists. */
  exec?: string;
}
export interface JobSpawned {
  /** The program's pid (from the group record, not from this process's child). */
  pid: number;
  /** Its start token, "" when it ended before it could be observed (the group record proves it started). */
  start: string;
  /** The helper that owns the group: its identity proves the group is still open (absent from the process table: closed). */
  group?: { pid: number; start: string };
  /** Set when the attempt could not be refused: the helper did not end, so it was adopted instead of reported failed --
   *  `pid`/`start` are then the helper's identity (the group's only handle holder) and the value is the reason. The
   *  attempt must be watched until a scan confirms it retired: no second attempt may start while this one can act. */
  uncertain?: string;
  /** Resolves when the helper ends (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}
export interface JobOptions {
  /** The handshake deadline (the group record): a helper that reported none by then started nothing. */
  timeoutMs?: number;
  /** How long a failed process-table observation is retried before the attempt is adopted (default JOB_OBSERVE_MS). */
  observeMs?: number;
  /** How long a helper that cannot be confirmed retired is given to end before its attempt is adopted (default
   *  JOB_HELPER_END_MS). */
  endMs?: number;
  /** Test seam: one process-table observation (default: the real one). */
  observe?: () => Promise<WinProcessRow[]>;
  /** Test seam: end the helper (default: `taskkill /T`); rejects when the end is not confirmed. */
  endHelper?: (pid: number) => Promise<void>;
}

/** The helper's argv: the script it runs, then the attempt's tag. PowerShell binds the extra argument to `$args`, which
 *  the script ignores; the tag is what a scan finds while the helper compile is still under way. */
export function jobHelperArgv(script: string, exec?: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ...(exec ? [`DSA_EXEC=${exec}`] : [])];
}
/** A read that failed because the helper holds the file for a moment (or is renaming it onto the name): not a failure. */
export function transientRead(error: unknown): boolean {
  return ["EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** The group record's pid: undefined while the helper has not written it yet (missing, or not readable for a moment). */
async function groupPid(dir: string): Promise<number | undefined> {
  let text: string;
  try { text = await readFile(join(dir, JOB_GROUP), "utf8"); }
  catch (error) { if (absent(error) || transientRead(error)) return undefined; throw error; }
  let recorded: unknown;
  try { recorded = (JSON.parse(text) as { pid?: unknown }).pid; }
  catch { throw new Error(`the command job group record cannot be read: ${text.slice(0, 200)}`); }
  if (!Number.isInteger(recorded) || (recorded as number) <= 0) throw new Error(`the command job group record is not a pid: ${text.slice(0, 200)}`);
  return recorded as number;
}
/** One process-table observation, retried for a while: a PowerShell/CIM read fails transiently on a loaded machine, and
 *  a failed observation must never be read as "no process" (that would let a second attempt start). */
async function observeWithin(observe: () => Promise<WinProcessRow[]>, budgetMs: number): Promise<WinProcessRow[]> {
  const end = Date.now() + Math.max(250, budgetMs);
  for (;;) {
    try { return await observe(); }
    catch (error) { if (Date.now() + 250 >= end) throw error; await delay(250); }
  }
}

/** Start `launch` inside a new Windows Job Object (see the module comment). Rejects -- with no attempt started -- when
 *  the helper cannot create the group, assign the suspended child before it runs, or report it back in time, and its end
 *  is confirmed. When an attempt cannot be refused (the helper did not end), it resolves with JobSpawned.uncertain: the
 *  attempt was started and is adopted, never silently dropped. */
export async function spawnInJob(dir: string, launch: JobLaunch, options: JobOptions = {}): Promise<JobSpawned> {
  // Evidence of an earlier attempt in the same directory must never be read as this attempt's.
  for (const name of [JOB_BEGIN, JOB_GROUP, JOB_END, JOB_ERROR, JOB_HELPER_EXIT, JOB_HELPER_LOG]) await rm(join(dir, name), { force: true });
  const script = join(dir, JOB_SCRIPT);
  await writeFile(script, JOB_HELPER);
  await writeFile(join(dir, JOB_SPEC), jobSpecText(launch));
  // The helper's stderr is a file, not a pipe: it outlives this process and nothing drains it.
  const errors = openSync(join(dir, JOB_HELPER_LOG), "a");
  let helper: ChildProcess;
  try {
    helper = spawn(powershellPath(), jobHelperArgv(script, launch.exec),
      { detached: true, stdio: ["ignore", "ignore", errors], windowsHide: true, env: helperEnv() });
  } finally { closeSync(errors); }
  let ended = false;
  // The helper's end is recorded before the wake-up resolves, so a failure reason can say why nothing was attempted even
  // when the helper itself wrote nothing.
  const exited = new Promise<void>(resolve => {
    const done = async (record: string) => {
      ended = true;
      await writeFile(join(dir, JOB_HELPER_EXIT), record, "utf8").catch(() => {});
      resolve();
    };
    helper.once("exit", (code, signal) => { void done(asciiJson({ code, signal })); });
    helper.once("error", error => { void done(asciiJson({ error: String((error as Error)?.message ?? error) })); });
  });
  const observe = options.observe ?? (() => winProcessRows()), endHelper = options.endHelper ?? killTree,
    endMs = options.endMs ?? JOB_HELPER_END_MS, observeMs = options.observeMs ?? JOB_OBSERVE_MS;
  const helperPid = helper.pid;
  /** Refuse only with a confirmed retirement; otherwise adopt the attempt (see the module comment). The helper is this
   *  process's own child, so while it has not ended its pid cannot have been reused: nothing is killed by a bare pid. */
  const refuse = async (reason: string): Promise<JobSpawned> => {
    let failure = "";
    if (!ended && helperPid !== undefined) {
      try { await endHelper(helperPid); }
      catch (error) { failure = `; ending the helper failed (${String((error as Error)?.message ?? error)})`; }
    }
    if (!ended) await Promise.race([exited, delay(endMs)]);
    const detail = `${reason}${await startError(dir)}${failure}`;
    // The helper ended: its exit closed the group's only handle, so nothing of this attempt can act. Run none of it.
    if (ended) throw new Error(detail);
    // Not confirmed: the helper may still create the group and run the wrapper. Adopt it instead, with its identity when
    // one observation can read it (its tag in argv finds it otherwise), so the attempt is tracked and never duplicated.
    let start = "";
    try { start = helperPid === undefined ? "" : (await observe()).find(row => row.pid === helperPid)?.start ?? ""; }
    catch { /* unobservable: the attempt's tag in the helper's argv still finds it */ }
    // The helper outlives this process by design (the command must): its end is a wake-up, never a held event loop.
    helper.unref();
    return { pid: helperPid ?? 0, start, uncertain: detail, exited };
  };
  try {
    await new Promise<void>((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
  } catch (error) {
    return refuse(`the command job helper could not start (${String((error as Error)?.message ?? error)})`);
  }
  // The handshake: the group record appears before the wrapper may run, and a file the helper holds for a moment is not a
  // failure -- it is still compiling or renaming the record onto its name.
  const timeoutMs = options.timeoutMs ?? JOB_START_TIMEOUT_MS, deadline = Date.now() + timeoutMs;
  let pid = 0;
  try {
    for (;;) {
      const recorded = await groupPid(dir);
      if (recorded !== undefined) { pid = recorded; break; }
      if (ended) throw new Error("the command job helper ended before the command could start");
      if (Date.now() >= deadline) throw new Error(`the command job helper reported no group within ${timeoutMs} ms`);
      await delay(10);
    }
  } catch (error) {
    return refuse(String((error as Error)?.message ?? error));
  }
  // One process-table observation for both identities. The group record already proves the wrapper started, so a missing
  // row is a retired process, never a guess at its identity. A read that cannot be completed is retried and then adopted
  // (the record's pid is known, the identity is found again by the tag): it never counts as proof that nothing runs.
  let starts: Map<number, string>;
  try { starts = new Map((await observeWithin(observe, Math.min(observeMs, deadline - Date.now()))).map(row => [row.pid, row.start])); }
  catch (error) { return refuse(`the command job group could not be observed (${String((error as Error)?.message ?? error)})`); }
  const start = starts.get(pid) ?? "";
  // The helper is the group's only handle holder: its row means the group is open, its absence means the kernel closed it.
  const helperStart = helperPid === undefined ? "" : starts.get(helperPid) ?? "";
  helper.unref(); // the helper outlives this process by design: its end is a wake-up, never a held event loop
  return { pid, start, ...(helperPid !== undefined && helperStart ? { group: { pid: helperPid, start: helperStart } } : {}), exited };
}

/** The reason a helper left, when it left one, appended to the failure a call reports: whether its script ever ran, why
 *  its process ended, and the bounded first line of what it wrote. Nothing to say is "".
 *  Bounded and credential-free: an evidence file contributes one clipped line, and the value of a variable whose name
 *  says it holds a secret is redacted -- the helper may quote what the caller handed it. */
export async function startError(dir: string): Promise<string> {
  const [error, log, exit, began] = await Promise.all([
    read(join(dir, JOB_ERROR), "head"), read(join(dir, JOB_HELPER_LOG), "tail"),
    read(join(dir, JOB_HELPER_EXIT), "head"), existsSync(join(dir, JOB_BEGIN)),
  ]);
  const notes: string[] = [];
  const end = endRecord(exit);
  if (end?.error) notes.push(`the helper could not be started (${oneLine(end.error)})`);
  else if (end?.code !== undefined) {
    notes.push(began ? `the helper exited with code ${end.code}` : `the helper exited with code ${end.code} before its script ran`);
    // The one measured shape of "nothing to say": PowerShell started without a console (PowerShell#28383).
    if (!began && end.code === 0) notes.push("PowerShell without a console runs nothing and exits 0");
  }
  // A recorded failure is a message (quoted from its start); the helper's own log is quoted from its end, where the
  // newest lines are. Either way it is one clipped line, with credential-shaped values redacted: the helper may quote
  // back what the caller handed it.
  const evidence = clip(redact(oneLine(error || log)), EVIDENCE_LIMIT, error ? "head" : "tail");
  const reason = [evidence, notes.join(", ")].filter(Boolean).join("; ");
  return reason ? `: ${clip(reason, REASON_LIMIT)}` : "";
}

/** What the recorded end of the helper says (undefined when it recorded nothing readable). */
function endRecord(text: string): { code?: number; signal?: string; error?: string } | undefined {
  if (!text.trim()) return undefined;
  let record: { code?: unknown; signal?: unknown; error?: unknown };
  try { record = JSON.parse(text) as typeof record; } catch { return undefined; }
  if (typeof record.error === "string" && record.error) return { error: record.error };
  const code = typeof record.code === "number" && Number.isInteger(record.code) ? record.code : undefined;
  const signal = typeof record.signal === "string" && record.signal ? record.signal : undefined;
  return code === undefined && signal === undefined ? undefined : { code, signal };
}

/** At most {@link REASON_BYTES} of a file -- its beginning (a message) or its end (a log's newest lines) -- as UTF-8.
 *  "" when the file is absent, so evidence never grows a reason. */
async function read(path: string, part: "head" | "tail"): Promise<string> {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!file) return "";
  try {
    const { size } = await file.stat(), length = Math.min(size, REASON_BYTES);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, part === "head" ? 0 : size - length);
    return buffer.toString("utf8").replace(/^\uFEFF/, "");
  } finally { await file.close(); }
}

/** Shapes a failure reason never repeats: an assignment to a name that says it holds a secret, and user info in a URL. */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+)/gi, "$1<redacted>"],
  [/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1<redacted>@"],
];
function redact(text: string): string { let out = text; for (const [pattern, instead] of SECRETS) out = out.replace(pattern, instead); return out; }
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** At most `limit` characters, keeping the beginning (a message) or the end (a log's newest lines). */
const clip = (text: string, limit: number, part: "head" | "tail" = "head"): string => text.length <= limit ? text
  : part === "head" ? `${text.slice(0, limit - 1)}…` : `…${text.slice(-(limit - 1))}`;
