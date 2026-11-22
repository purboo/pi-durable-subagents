// Windows command attempts run inside a kernel-owned group: a Job Object created for one attempt, whose only handle is
// held by a small owner process and never inherited. The command's wrapper is created suspended, assigned to the group
// and only then resumed, so nothing it starts can ever be outside the group; with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE the
// kernel terminates every process left in the group when that handle closes, which happens when the wrapper ends, when
// the owner is killed, and when the owner crashes. A command attempt therefore cannot outlive its wrapper by a
// descendant, and the orchestrator (or a successor that adopted the attempt) can never start a second attempt while
// processes of the first can still act.
//
// The owner is a standalone .NET Framework winexe compiled from the C# below with the C# compiler that ships with every
// supported Windows (csc.exe under %SystemRoot%\Microsoft.NET\Framework64 or Framework, v4.0.30319): Node has no Job
// Object API, and this adds no npm dependency and no file to the package. A PowerShell helper was tried first and does
// not work: a detached spawn gives it no console, and PowerShell 5.1 (and pwsh) then quietly exit 0 without running a
// script (PowerShell#28383; Windows CI 45039418985 measured it), while a non-detached child lands in libuv's
// kill-with-parent job and would end the attempt with the orchestrator. A compiled winexe has neither problem: it needs
// no console, Node spawns it detached with windowsHide, and the group's handle lives in it rather than in the
// orchestrator. A cmd.exe relay or a two-process handle handoff would each add a visible window or a second owner; this
// keeps one process.
//
// Each launch compiles into its own private directory inside the attempt directory (a fresh random name), so a stale
// executable from an earlier attempt can never be picked up, and nothing is shared between attempts or calls. The
// compilation runs in the foreground and is bounded: until it finishes, the attempt directory holds only inert files (a
// source file, an executable, the spec); no command is started, so an orchestrator that dies during compilation leaves
// nothing that can act. The executor's proceed/stop gate is then called once more, after the compilation and
// immediately before the spawn (no await between the two), so a revocation during the compilation starts nothing. A
// missing compiler, a compiler failure or a missing executable fails the start closed: no group, no wrapper, no command,
// and the recorded reason travels with the attempt -- kill-on-close and the single-rerun semantics are never weakened.
//
// The spec is ASCII lines of base64-encoded UTF-16LE fields (jobSpecText), so no code page, quoting rule, BOM or unpaired
// surrogate can change a Unicode path, a curly quote or an environment value; the owner decodes it with
// System.Text.Encoding.Unicode. The C# source is ASCII-only for the same reason: csc.exe reads a file without a byte order
// mark in the ANSI code page.
//
// Observation is fail-closed: before a group exists the orchestrator waits for the owner's `group` record (the suspended
// child's pid, written before the child may run) and starts no attempt when it does not arrive or cannot be read; the
// owner never resumes the child unless CreateJobObject, SetInformationJobObject, CreateProcess,
// AssignProcessToJobObject and IsProcessInJob all succeeded, and it writes `start-error` when they did not. The owner's
// own identity is recorded with the attempt, so its absence from the process table proves the group is closed.
//
// The handshake has two windows a crash or a slow machine can cut into, and both must keep a second attempt from starting
// while the first can still act. The first is the owner's own startup: no group record and no wrapper exist yet, so the
// attempt is found by the tag in the owner's command line (`DSA_EXEC=<id>`, the same tag a POSIX command carries in its
// environment) -- the owner is passed it in its argv, never only in an environment a Windows process table cannot read.
// The second is the failure path: a handshake that cannot be completed ends the owner and reports a refusal only once the
// owner has ended (its exit closes the group's only handle, so nothing of the attempt can act); when the end cannot be
// confirmed -- the kill failed, or the owner is still there at the deadline -- the attempt is adopted instead
// (JobSpawned.uncertain), its identity travels to the orchestrator, and the call keeps the attempt tracked, so nothing
// starts a second attempt until a scan finds the first one gone.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { helperEnv, killTree, systemRoot, winProcessRows, winTag, winTagArg, type WinProcessRow } from "./windows.ts";

/** The owner type: exported for the packaging check (the compiled name carries it; nothing separate is shipped). */
export const JOB_HOST_MARKER = "DsaJob";
/** The owner's source: compiled per launch into the attempt's private host directory, never written as a package file. */
export const JOB_HOST_SOURCE = `using System;
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
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    /** argv[0] is the attempt directory, argv[1] (ignored) the attempt's DSA_EXEC tag: a process-table scan finds
     *  the attempt by that tag while this host is starting, before it writes its group record. 126 means no directory,
     *  125 a failure this host recorded in start-error; otherwise the wrapper's own exit status. */
    public static int Main(string[] args)
    {
        if (args == null || args.Length < 1 || String.IsNullOrEmpty(args[0])) return 126;
        string dir = args[0];
        // Before anything else: its absence says this program never got to run; its identity is from this live handle.
        try { WriteAtomic(Path.Combine(dir, "helper-begin"), ProcessIdentity(unchecked((int)GetCurrentProcessId()), GetCurrentProcess())); } catch (Exception) { }
        string application, workingDirectory, logPath;
        string[] arguments, environment;
        try { ReadSpec(dir, out application, out workingDirectory, out logPath, out arguments, out environment); }
        catch (Exception failure)
        {
            Fail(dir, "job spec", 0, failure.GetType().Name + ": " + failure.Message);
            return 125;
        }
        int status = Run(dir, application, arguments, workingDirectory, logPath, environment);
        return status < 0 ? 125 : status;
    }

    /** The attempt's spec: ASCII lines, one base64-encoded UTF-16LE field each, so no code page, quoting rule or
     *  surrogate can change it. DSAJOB1, exe, cwd, log, argument count, arguments, environment count, NAME=value
     *  entries. */
    static void ReadSpec(string dir, out string application, out string workingDirectory, out string logPath, out string[] arguments, out string[] environment)
    {
        string path = Path.Combine(dir, "job.json");
        string[] lines = File.ReadAllLines(path, Encoding.ASCII);
        int at = 0;
        if (lines.Length < 5 || lines[at++] != "DSAJOB1") throw new FormatException("unknown job spec header");
        application = Field(lines[at++]);
        workingDirectory = Field(lines[at++]);
        logPath = Field(lines[at++]);
        arguments = Fields(lines, ref at);
        environment = Fields(lines, ref at);
        if (at != lines.Length) throw new FormatException("trailing job spec fields");
        try { File.Delete(path); } catch (Exception) { }
    }

    static string[] Fields(string[] lines, ref int at)
    {
        if (at >= lines.Length) throw new FormatException("truncated job spec");
        int count;
        if (!Int32.TryParse(lines[at++], NumberStyles.Integer, CultureInfo.InvariantCulture, out count) || count < 0 || count > 1048576)
            throw new FormatException("bad job spec count");
        if (lines.Length - at < count) throw new FormatException("truncated job spec fields");
        string[] values = new string[count];
        for (int i = 0; i < count; i++) values[i] = Field(lines[at++]);
        return values;
    }

    static string Field(string line)
    {
        return Encoding.Unicode.GetString(Convert.FromBase64String(line));
    }

    /** Run the wrapper inside a new group and return its exit status (negative: this host failed, see start-error). */
    static int Run(string dir, string application, string[] arguments, string workingDirectory, string logPath, string[] environment)
    {
        IntPtr job = IntPtr.Zero, output = IntPtr.Zero, errorHandle = IntPtr.Zero, input = IntPtr.Zero, block = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool started = false;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail(dir, "CreateJobObject", Marshal.GetLastWin32Error());
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                return Fail(dir, "SetInformationJobObject", Marshal.GetLastWin32Error());

            SECURITY_ATTRIBUTES inherit = new SECURITY_ATTRIBUTES();
            inherit.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inherit.bInheritHandle = 1;
            // Two independent handles, one for stdout and one for stderr, each opened for append only (FILE_APPEND_DATA
            // without FILE_WRITE_DATA): the kernel sends every write of each stream to the current end of the file, so
            // the two streams interleave in the log without either overwriting the other. A shared handle or a seek to
            // the end would let one stream's buffered output land on the other's (or on an earlier attempt's) bytes.
            output = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (output == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile " + logPath, Marshal.GetLastWin32Error());
            errorHandle = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (errorHandle == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile " + logPath, Marshal.GetLastWin32Error());
            // stdin is empty: the command can never read from this host's (absent) console.
            input = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (input == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile NUL", Marshal.GetLastWin32Error());

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.hStdInput = input;
            startup.hStdOutput = output;
            startup.hStdError = errorHandle;
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
            WriteAtomic(Path.Combine(dir, "group"), GroupRecord(child.dwProcessId, child.hProcess));
            if (ResumeThread(child.hThread) == 0xFFFFFFFF)
            {
                TerminateProcess(child.hProcess, 1);
                return Fail(dir, "ResumeThread", Marshal.GetLastWin32Error());
            }
            if (WaitForSingleObject(child.hProcess, INFINITE) != 0) return Fail(dir, "WaitForSingleObject", Marshal.GetLastWin32Error());
            uint code;
            if (!GetExitCodeProcess(child.hProcess, out code)) return Fail(dir, "GetExitCodeProcess", Marshal.GetLastWin32Error());
            WriteAtomic(Path.Combine(dir, "group-end"), @"{""status"":" + code.ToString(CultureInfo.InvariantCulture) + "}");
            return unchecked((int)code);
        }
        catch (Exception failure)
        {
            if (started) TerminateProcess(child.hProcess, 1);
            return Fail(dir, "job host", 0, failure.GetType().Name + ": " + failure.Message);
        }
        finally
        {
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (input != IntPtr.Zero && input != INVALID_HANDLE_VALUE) CloseHandle(input);
            if (output != IntPtr.Zero && output != INVALID_HANDLE_VALUE) CloseHandle(output);
            if (errorHandle != IntPtr.Zero && errorHandle != INVALID_HANDLE_VALUE) CloseHandle(errorHandle);
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
        try { File.WriteAllText(Path.Combine(dir, "start-error"), text); } catch (Exception) { }
        return -1;
    }

    static void WriteAtomic(string path, string text)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, text);
        if (File.Exists(path)) File.Delete(path);
        File.Move(temporary, path);
    }

    static string ProcessStart(IntPtr process)
    {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation <= 0) return "";
        try { return DateTime.FromFileTime((creation / 10) * 10).Ticks.ToString(CultureInfo.InvariantCulture); }
        catch (Exception) { return ""; }
    }

    static string ProcessIdentity(int pid, IntPtr process)
    {
        return @"{""pid"":" + pid.ToString(CultureInfo.InvariantCulture) + @",""start"":""" + ProcessStart(process) + @"""}";
    }

    static string GroupRecord(int pid, IntPtr process)
    {
        return @"{""pid"":" + pid.ToString(CultureInfo.InvariantCulture) + @",""start"":""" + ProcessStart(process) +
            @""",""group"":" + ProcessIdentity(unchecked((int)GetCurrentProcessId()), GetCurrentProcess()) + "}";
    }

    /** The child's environment (CREATE_UNICODE_ENVIRONMENT): its variables, then the empty terminator. */
    static IntPtr EnvironmentBlock(string[] pairs)
    {
        StringBuilder text = new StringBuilder();
        if (pairs != null)
            foreach (string pair in pairs)
                if (!String.IsNullOrEmpty(pair)) { text.Append(pair); text.Append((char)0); }
        if (text.Length == 0) text.Append((char)0);
        text.Append((char)0);
        return Marshal.StringToHGlobalUni(text.ToString());
    }

    /** An argv as a CreateProcess command line, by the quoting rules CommandLineToArgvW (and the C runtime) parse. */
    static string CommandLine(string application, string[] arguments)
    {
        StringBuilder text = new StringBuilder(Quote(application));
        if (arguments != null) foreach (string argument in arguments) text.Append(' ').Append(Quote(argument));
        return text.ToString();
    }

    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', (char)9, (char)10, (char)11, '"' }) < 0) return argument;
        StringBuilder text = new StringBuilder(((char)34).ToString());
        int backslashes = 0;
        for (int i = 0; i < argument.Length; i++)
        {
            char c = argument[i];
            if (c == (char)92) { backslashes++; continue; }
            if (c == '"') { text.Append((char)92, backslashes * 2 + 1); text.Append('"'); backslashes = 0; continue; }
            if (backslashes > 0) { text.Append((char)92, backslashes); backslashes = 0; }
            text.Append(c);
        }
        if (backslashes > 0) text.Append((char)92, backslashes * 2);
        text.Append('"');
        return text.ToString();
    }
}
`;
/** The compiled owner executable's file name inside the per-launch directory. */
export const JOB_HOST_EXE = "DsaJob.exe";
/** The source file's name inside the per-launch directory (inert: kept as evidence, never executed). */
export const JOB_HOST_SOURCE_FILE = "DsaJob.cs";
/** The per-launch directory's prefix inside the attempt directory. */
export const JOB_HOST_PREFIX = "job-host-";
/** The owner's own stderr (its diagnostics when the program itself cannot run; empty otherwise). */
export const JOB_HOST_LOG = "host.log";
/** Written by this process when the owner ends: its exit code (or why it could not be spawned), for the failure reason.
 *  The owner cannot report this itself -- it is the process that ended. */
export const JOB_HOST_EXIT = "host-exit";
/** What the owner reads: the program, argv, cwd, output file and complete environment of the attempt's wrapper. */
export const JOB_SPEC = "job.json";
/** The spec's first line: the owner refuses a file it does not recognize. */
export const JOB_SPEC_HEADER = "DSAJOB1";
/** Written (atomically) after the wrapper is in the group and before it may run: `{"pid":<wrapper pid>}`. */
export const JOB_GROUP = "group";
/** Written when the owner saw the wrapper end: `{"status":<wrapper exit status>}`. */
export const JOB_END = "group-end";
/** Written (atomically) when the owner could not start the wrapper: a short reason for the failed attempt. */
export const JOB_ERROR = "start-error";
/** Written by the owner's first statement: its absence proves the program never ran (a launcher problem, not a failure
 *  of this attempt), which is what a bare "the owner ended" otherwise hides. */
export const JOB_BEGIN = "helper-begin";
/** How much of an evidence file a failure reason may read; a reason is a line, never a dump. */
const REASON_BYTES = 1000;
/** How much of it a failure reason may quote, and how long the whole reason may get. */
const EVIDENCE_LIMIT = 200;
const REASON_LIMIT = 300;
/** Compiling the owner on a loaded runner: bounded, in the foreground, and finished before anything is started. */
export const JOB_COMPILE_TIMEOUT_MS = 60_000;
/** Process creation plus the owner's startup on a loaded runner; an owner that has not reported a group by then started
 *  nothing. Measured after the spawn, so the compilation is not part of it. */
const JOB_START_TIMEOUT_MS = 30_000;
/** How long an owner that cannot be confirmed retired is given to end before its attempt is adopted instead. */
const JOB_HOST_END_MS = 5_000;
/** Caps the retries of a failed process-table observation: past it the attempt is adopted rather than refused. */
const JOB_OBSERVE_MS = 10_000;
/** The .NET Framework whose C# compiler every supported Windows ships. */
const FRAMEWORK_VERSION = "v4.0.30319";


/** The wrapper's environment as the owner receives it: one ordered `NAME=value` list. Windows variable names are
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

/** The spec as text this module writes itself: the header, then one base64-encoded UTF-16LE field per line (exe, cwd,
 *  log, the argument count and arguments, the environment count and entries). Base64 is ASCII, so job.json decodes
 *  identically under any code page, and UTF-16LE carries every JS string -- a curly quote, an emoji, even an unpaired
 *  surrogate -- unchanged; the owner turns every line back with Convert.FromBase64String plus Encoding.Unicode. */
export function jobSpecText(launch: Pick<JobLaunch, "exe" | "args" | "cwd" | "log" | "env">): string {
  const env = jobEnv(launch.env);
  const lines = [JOB_SPEC_HEADER, field(launch.exe), field(launch.cwd), field(launch.log), String(launch.args.length),
    ...launch.args.map(field), String(env.length), ...env.map(field)];
  return `${lines.join("\n")}\n`;
}
const field = (text: string): string => Buffer.from(text, "utf16le").toString("base64");

/** `value` as JSON text of ASCII bytes only: like JSON.stringify, but every code unit outside 0x20..0x7e is escaped (each
 *  half of a surrogate pair on its own, which JSON allows and parses back into the same pair). Used for the owner's exit
 *  record, which this process writes itself. */
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

/** The C# compiler candidates for this environment and architecture, in preference order: every supported Windows ships
 *  the .NET Framework 4 compiler under Framework64 (x64 or ARM64) and Framework (x86). An ia32 host prefers the 32-bit
 *  one; everything else the 64-bit one, with the other as a fallback (both produce a runnable owner). Absolute paths
 *  only: %SystemRoot% is read from the environment, never the current directory or a PATH entry. */
export function frameworkCompilerCandidates(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): string[] {
  const root = systemRoot(env);
  const names = arch === "ia32" ? ["Framework", "Framework64"] : ["Framework64", "Framework"];
  return names.map(name => join(root, "Microsoft.NET", name, FRAMEWORK_VERSION, "csc.exe"));
}

/** The first candidate that exists. Nothing found is a fail-closed error (the caller starts no command): the compiler is
 *  verified by the compilation itself, which runs before any process of the attempt exists. `exists` is a test seam. */
export function frameworkCompiler(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch,
  exists: (path: string) => boolean = existsSync): string {
  const candidates = frameworkCompilerCandidates(env, arch);
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  throw new Error(`the Windows .NET Framework C# compiler is unavailable (searched ${candidates.join(", ")})`);
}

export interface JobHostPaths {
  /** The launch's private directory inside the attempt directory. */
  dir: string;
  /** The compiled owner. */
  exe: string;
  /** Its source (inert evidence). */
  source: string;
}

/** A fresh owner directory for one launch: the attempt directory plus a random name, so an executable compiled by an
 *  earlier launch is never found, let alone run, and two launches never share host files. */
export function jobHostPaths(dir: string): JobHostPaths {
  const host = join(dir, `${JOB_HOST_PREFIX}${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`);
  return { dir: host, exe: join(host, JOB_HOST_EXE), source: join(host, JOB_HOST_SOURCE_FILE) };
}

/** Compile the owner into the launch's private directory with the Windows framework compiler: foreground and bounded (no
 *  command is started, so a starter that dies here leaves only inert files), and fail-closed (a missing compiler, a
 *  compiler failure or a missing executable throws before anything of the attempt exists). */
export async function compileJobHost(dir: string, options: { compiler?: string; timeoutMs?: number } = {}): Promise<JobHostPaths> {
  const paths = jobHostPaths(dir);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.source, JOB_HOST_SOURCE, "utf8");
  const compiler = options.compiler ?? frameworkCompiler(), timeoutMs = options.timeoutMs ?? JOB_COMPILE_TIMEOUT_MS;
  // Only ASCII relative names reach the compiler, and it runs in the launch's own directory: the attempt directory (which
  // may be Unicode or curly-quoted) is the process's working directory, which Windows passes as UTF-16, so no path
  // argument needs a code-page conversion. The output is built beside the final name and renamed only after the compiler
  // exits cleanly, so a killed or failed compiler can never leave a half-written executable that a later start would run.
  const build = "DsaJob.build.exe";
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(compiler, ["/nologo", "/codepage:65001", "/target:winexe", `/out:${build}`, JOB_HOST_SOURCE_FILE],
        { cwd: paths.dir, timeout: timeoutMs, windowsHide: true, env: helperEnv(), maxBuffer: 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => error ? reject(new Error(compilerFailure(compiler, error, stdout, stderr))) : resolve());
    });
    // The executable is the one just produced: the directory is new, so this cannot be a stale binary (a compiler that
    // reports success without writing it is a failure, never a reason to look elsewhere).
    try { await rename(join(paths.dir, build), paths.exe); }
    catch { throw new Error(`the Windows .NET Framework compiler wrote no executable for ${paths.exe}`); }
    if (!existsSync(paths.exe)) throw new Error(`the Windows .NET Framework compiler wrote no executable at ${paths.exe}`);
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    await writeFile(join(dir, JOB_ERROR), clip(oneLine(reason), REASON_LIMIT), "utf8").catch(() => {});
    throw new Error(reason);
  }
  return paths;
}

/** What a failed compiler run says: its bounded own words, whether it timed out, and its exit status. */
function compilerFailure(compiler: string, error: unknown, stdout?: string, stderr?: string): string {
  const failure = error as { code?: unknown; killed?: boolean; signal?: string; message?: string };
  const note = failure.killed ? "timed out" : failure.code !== undefined ? `exit ${String(failure.code)}`
    : String(failure.signal ?? failure.message ?? error);
  const output = oneLine(String(stderr || stdout || ""));
  return `the Windows .NET Framework compiler ${compiler} failed (${note})${output ? `: ${clip(output, EVIDENCE_LIMIT)}` : ""}`;
}

/** The owner's argv: the attempt directory whose records and spec it uses (an argument, not a script path or a written-in
 *  path), then the attempt's versioned tag, which the C# ignores and a process-table scan reads while the owner starts. */
export function jobHostArgv(dir: string, exec?: string): string[] {
  return [dir, ...(exec ? [winTagArg("DSA_EXEC", exec)] : [])];
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
  /** The attempt's tag (`DSA_EXEC=<exec>`): spelled in the owner's own argv, so a scan still finds the attempt while it
   *  compiles and starts, before the group record exists. */
  exec?: string;
}
export interface JobSpawned {
  /** The program's pid (from the group record, not from this process's child). */
  pid: number;
  /** Its start token, "" when it ended before it could be observed (the group record proves it started). */
  start: string;
  /** The owner that holds the group: its identity proves the group is still open (absent from the process table: closed). */
  group?: { pid: number; start: string };
  /** Set when the attempt could not be refused: the owner did not end, so it was adopted instead of reported failed --
   *  `pid`/`start` are then the owner's identity (the group's only handle holder) and the value is the reason. The
   *  attempt must be watched until a scan confirms it retired: no second attempt may start while this one can act. */
  uncertain?: string;
  /** Resolves when the owner ends (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}
export interface JobOptions {
  /** The executor's last check (see command.ts): called once, after the compilation and immediately before the spawn. A
   *  false answer starts no process and makes spawnInJob resolve undefined. */
  proceed?: () => boolean;
  /** Test seam: the compiler to run instead of the discovered framework one. */
  compiler?: string;
  /** Test seam: how long the foreground compilation may take (default JOB_COMPILE_TIMEOUT_MS). */
  compileMs?: number;
  /** The handshake deadline (the group record), after the spawn: an owner that reported none by then started nothing. */
  timeoutMs?: number;
  /** How long a failed process-table observation is retried before the attempt is adopted (default JOB_OBSERVE_MS). */
  observeMs?: number;
  /** How long an owner that cannot be confirmed retired is given to end before its attempt is adopted (default
   *  JOB_HOST_END_MS). */
  endMs?: number;
  /** Test seam: one process-table observation (default: the real one). */
  observe?: () => Promise<WinProcessRow[]>;
  /** Test seam: end the owner (default: `taskkill /T`); rejects when the end is not confirmed. */
  endHelper?: (pid: number) => Promise<void>;
}

/** A read that failed because the owner holds the file for a moment (or is renaming it onto the name): not a failure. */
export function transientRead(error: unknown): boolean {
  return ["EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export interface GroupRecord {
  pid: number;
  start?: string;
  group?: { pid: number; start: string };
}

/** Whether an observed process-table start token names the same process instance as a handle-recorded creation time.
 *  Both are .NET local ticks; WMI's DMTF CreationDate carries whole microseconds (10 ticks), so up to 10 ticks of
 *  rounding is the same kernel timestamp while any reused pid is created strictly later. */
export function sameCreation(observed: string, recorded: string): boolean {
  if (!observed || !recorded) return false;
  if (observed === recorded) return true;
  if (!/^\d+$/.test(observed) || !/^\d+$/.test(recorded)) return false;
  const a = BigInt(observed), b = BigInt(recorded);
  return (a >= b ? a - b : b - a) <= 10n;
}

/** The group record written before ResumeThread (with legacy `{"pid":<n>}` compatibility); undefined while not ready. */
export async function readGroupRecord(dir: string): Promise<GroupRecord | undefined> {
  let text: string;
  try { text = await readFile(join(dir, JOB_GROUP), "utf8"); }
  catch (error) { if (absent(error) || transientRead(error)) return undefined; throw error; }
  let parsed: { pid?: unknown; start?: unknown; group?: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; }
  catch { throw new Error(`the command job group record cannot be read: ${text.slice(0, 200)}`); }
  if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0)
    throw new Error(`the command job group record is not a pid: ${text.slice(0, 200)}`);
  const start = typeof parsed.start === "string" && parsed.start ? parsed.start : undefined;
  const rawGroup = parsed.group && typeof parsed.group === "object"
    ? parsed.group as { pid?: unknown; start?: unknown } : undefined;
  const group = rawGroup && Number.isInteger(rawGroup.pid) && (rawGroup.pid as number) > 0 &&
    typeof rawGroup.start === "string" && rawGroup.start
    ? { pid: rawGroup.pid as number, start: rawGroup.start } : undefined;
  return { pid: parsed.pid as number, ...(start ? { start } : {}), ...(group ? { group } : {}) };
}

/** The owner's handle-recorded creation identity from `helper-begin` (undefined when absent or legacy `"begin"`). */
export async function readBeginIdentity(dir: string): Promise<{ pid: number; start: string } | undefined> {
  let text: string;
  try { text = await readFile(join(dir, JOB_BEGIN), "utf8"); }
  catch { return undefined; }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; start?: unknown };
    return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.start === "string" && parsed.start
      ? { pid: parsed.pid as number, start: parsed.start } : undefined;
  } catch { return undefined; }
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

/** Start `launch` inside a new Windows Job Object (see the module comment). Compiles the owner first (bounded, no process
 *  of the attempt exists until it finishes; a compiler failure throws, fail-closed), then calls `proceed` once more and
 *  spawns the owner immediately. Resolves undefined when `proceed` refuses after the compilation. Rejects -- with no
 *  attempt started -- when the owner cannot create the group, assign the suspended child before it runs, or report it back
 *  in time, and its end is confirmed. When an attempt cannot be refused (the owner did not end), it resolves with
 *  JobSpawned.uncertain: the attempt was started and is adopted, never silently dropped. */
export async function spawnInJob(dir: string, launch: JobLaunch, options: JobOptions = {}): Promise<JobSpawned | undefined> {
  // Evidence of an earlier attempt in the same directory must never be read as this attempt's.
  for (const name of [JOB_BEGIN, JOB_GROUP, JOB_END, JOB_ERROR, JOB_HOST_EXIT, JOB_HOST_LOG]) await rm(join(dir, name), { force: true });
  // Foreground and bounded: nothing of this attempt runs until the owner exists (a starter that dies here leaves only
  // inert files), and a missing or failing compiler refuses the start instead of weakening the group.
  const host = await compileJobHost(dir, { ...(options.compiler ? { compiler: options.compiler } : {}), ...(options.compileMs ? { timeoutMs: options.compileMs } : {}) });
  await writeFile(join(dir, JOB_SPEC), jobSpecText(launch));
  // The owner's stderr is a file, not a pipe: it outlives this process and nothing drains it.
  const errors = openSync(join(dir, JOB_HOST_LOG), "a");
  let helper: ChildProcess;
  try {
    // The executor's last check, after the compilation and immediately before the spawn: no await follows it, so a stop
    // or retirement that revoked the permission during the compilation starts no process.
    if (options.proceed && !options.proceed()) return undefined;
    helper = spawn(host.exe, jobHostArgv(dir, launch.exec),
      { detached: true, stdio: ["ignore", "ignore", errors], windowsHide: true, env: helperEnv() });
  } finally { closeSync(errors); }
  let ended = false;
  let recordedExit: Promise<void> | undefined;
  // The owner's end is durably written to JOB_HOST_EXIT before `exited` resolves, and every path that formats a
  // failure reason awaits `exited` once `ended` is set so exit evidence never races the rejection message.
  const exited = new Promise<void>(resolve => {
    const done = (record: string) => {
      ended = true;
      recordedExit ??= (async () => {
        const target = join(dir, JOB_HOST_EXIT), tmp = `${target}.tmp`;
        try { await writeFile(tmp, record, "utf8"); await rename(tmp, target); }
        catch { await writeFile(target, record, "utf8").catch(() => {}); }
      })().finally(resolve);
    };
    helper.once("exit", (code, signal) => { done(asciiJson({ code, signal })); });
    helper.once("error", error => { done(asciiJson({ error: String((error as Error)?.message ?? error) })); });
  });
  const observe = options.observe ?? (() => winProcessRows()), endHelper = options.endHelper ?? killTree,
    endMs = options.endMs ?? JOB_HOST_END_MS, observeMs = options.observeMs ?? JOB_OBSERVE_MS;
  const helperPid = helper.pid;
  /** Refuse only with a confirmed retirement; otherwise adopt the attempt (see the module comment). The owner is this
   *  process's own child, so while it has not ended its pid cannot have been reused: nothing is killed by a bare pid,
   *  and an exit during observation never binds a reused pid. */
  const refuse = async (reason: string, knownGroup?: GroupRecord): Promise<JobSpawned> => {
    let failure = "";
    if (!ended && helperPid !== undefined) {
      try { await endHelper(helperPid); }
      catch (error) { failure = `; ending the owner failed (${String((error as Error)?.message ?? error)})`; }
    }
    if (ended) await exited;
    else await Promise.race([exited, delay(endMs)]);
    if (ended) await exited;
    // The owner ended: its exit closed the group's only handle, so nothing of this attempt can act. Run none of it.
    if (ended) throw new Error(`${reason}${await startError(dir)}${failure}`);
    // Not confirmed: the owner may still create the group and run the wrapper. Adopt it instead, with its validated or
    // handle-persisted identity (its argv tag finds it otherwise), so the attempt is tracked and never duplicated.
    const group = knownGroup ?? await readGroupRecord(dir).catch(() => undefined);
    const began = group?.group ?? await readBeginIdentity(dir);
    const expectedOwnerStart = helperPid !== undefined && began?.pid === helperPid ? began.start : undefined;
    let rows: WinProcessRow[] | undefined;
    try { if (helperPid !== undefined) rows = await observe(); }
    catch { /* unobservable: fall back to the handle-recorded identity and the owner's argv tag */ }
    if (ended) {
      await exited;
      throw new Error(`${reason}${await startError(dir)}${failure}`);
    }
    let start = expectedOwnerStart ?? "";
    if (rows && helperPid !== undefined) {
      const row = rows.find(item => item.pid === helperPid);
      if (row) {
        if (expectedOwnerStart !== undefined) {
          start = sameCreation(row.start, expectedOwnerStart) ? row.start : expectedOwnerStart;
        } else if (!launch.exec || winTag(row.command, "DSA_EXEC") === launch.exec) {
          start = row.start;
        }
      }
    }
    // The owner outlives this process by design (the command must): its end is a wake-up, never a held event loop.
    helper.unref();
    return { pid: helperPid ?? 0, start, uncertain: `${reason}${await startError(dir)}${failure}`, exited };
  };
  try {
    await new Promise<void>((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
  } catch (error) {
    return refuse(`the command job host could not start (${String((error as Error)?.message ?? error)})`);
  }
  // The handshake: the group record appears before the wrapper may run, and a file the owner holds for a moment is not a
  // failure -- it is still starting or renaming the record onto its name.
  const timeoutMs = options.timeoutMs ?? JOB_START_TIMEOUT_MS, deadline = Date.now() + timeoutMs;
  let recorded: GroupRecord | undefined;
  try {
    for (;;) {
      recorded = await readGroupRecord(dir);
      if (recorded !== undefined) break;
      if (ended) {
        await exited;
        recorded = await readGroupRecord(dir);
        if (recorded !== undefined) break;
        throw new Error("the command job host ended before the command could start");
      }
      if (Date.now() >= deadline) throw new Error(`the command job host reported no group within ${timeoutMs} ms`);
      await delay(10);
    }
  } catch (error) {
    return refuse(String((error as Error)?.message ?? error), recorded);
  }
  const pid = recorded.pid;
  // One process-table observation for both identities, validated against the handle-recorded creation times from the
  // owner so an early wrapper/owner exit followed by pid reuse can never bind an unrelated process.
  let rows: WinProcessRow[];
  try { rows = await observeWithin(observe, Math.min(observeMs, deadline - Date.now())); }
  catch (error) { return refuse(`the command job group could not be observed (${String((error as Error)?.message ?? error)})`, recorded); }
  if (ended) {
    helper.unref();
    return { pid, start: "", exited };
  }
  const began = recorded.group ?? await readBeginIdentity(dir);
  const expectedOwnerStart = helperPid !== undefined && began?.pid === helperPid ? began.start : undefined;
  const ownerRow = helperPid === undefined ? undefined : rows.find(row => row.pid === helperPid);
  const ownerReplaced = Boolean(ownerRow && expectedOwnerStart !== undefined && !sameCreation(ownerRow.start, expectedOwnerStart));
  let helperStart = "";
  if (helperPid !== undefined && !ownerReplaced) {
    if (ownerRow) {
      if (expectedOwnerStart !== undefined) helperStart = ownerRow.start;
      else if (!launch.exec || winTag(ownerRow.command, "DSA_EXEC") === launch.exec) helperStart = ownerRow.start;
    } else if (expectedOwnerStart !== undefined && !existsSync(join(dir, JOB_END))) {
      helperStart = expectedOwnerStart;
    }
  }
  const childRow = ownerReplaced ? undefined : rows.find(row => row.pid === pid);
  let start = "";
  if (childRow) {
    if (recorded.start !== undefined) {
      start = sameCreation(childRow.start, recorded.start) ? childRow.start : "";
    } else if (!existsSync(join(dir, JOB_END)) &&
      ((helperPid !== undefined && childRow.ppid === helperPid) || (!!launch.exec && winTag(childRow.command, "DSA_EXEC") === launch.exec))) {
      start = childRow.start;
    }
  } else if (!ownerReplaced && recorded.start !== undefined && !existsSync(join(dir, JOB_END))) {
    start = recorded.start;
  }
  helper.unref(); // the owner outlives this process by design: its end is a wake-up, never a held event loop
  return { pid, start, ...(helperPid !== undefined && helperStart ? { group: { pid: helperPid, start: helperStart } } : {}), exited };
}

/** The reason an owner left, when it left one, appended to the failure a call reports: whether it ever ran, why its
 *  process ended, and the bounded first line of what it wrote. Nothing to say is "".
 *  Bounded and credential-free: an evidence file contributes one clipped line, and the value of a variable whose name
 *  says it holds a secret is redacted -- the owner may quote what the caller handed it. */
export async function startError(dir: string): Promise<string> {
  const [error, log, exit, began] = await Promise.all([
    read(join(dir, JOB_ERROR), "head"), read(join(dir, JOB_HOST_LOG), "tail"),
    read(join(dir, JOB_HOST_EXIT), "head"), existsSync(join(dir, JOB_BEGIN)),
  ]);
  const notes: string[] = [];
  const end = endRecord(exit);
  if (end?.error) notes.push(`the job host could not be started (${oneLine(end.error)})`);
  else if (end?.code !== undefined) notes.push(began ? `the job host exited with code ${end.code}`
    : `the job host exited with code ${end.code} before it reported starting`);
  // A recorded failure is a message (quoted from its start); the owner's own log is quoted from its end, where the
  // newest lines are. Either way it is one clipped line, with credential-shaped values redacted: the owner may quote
  // back what the caller handed it (the compiler quotes the paths it was given).
  const evidence = clip(redact(oneLine(error || log)), EVIDENCE_LIMIT, error ? "head" : "tail");
  const reason = [evidence, notes.join(", ")].filter(Boolean).join("; ");
  return reason ? `: ${clip(reason, REASON_LIMIT)}` : "";
}

/** What the recorded end of the owner says (undefined when it recorded nothing readable). */
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
