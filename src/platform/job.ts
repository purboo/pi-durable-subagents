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
// `-File`, so no quoting of it is involved. The C# is compiled on each attempt (about a second), which a command call's
// lifetime amortizes.
//
// Observation is fail-closed: before a group exists the orchestrator waits for the helper's `group` record (the suspended
// child's pid, written before the child may run) and starts no attempt when it does not arrive or cannot be read; the
// helper never resumes the child unless CreateJobObject, SetInformationJobObject, CreateProcess, AssignProcessToJobObject
// and IsProcessInJob all succeeded, and it writes `start-error` when they did not. The helper's own identity is recorded
// with the attempt, so its absence from the process table proves the group is closed.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { helperEnv, killTree, powershellPath, winProcessRows } from "./windows.ts";

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
/** Add-Type plus process creation on a loaded runner; a helper that has not reported a group by then started nothing. */
const JOB_START_TIMEOUT_MS = 30_000;

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
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    const uint FILE_END = 2;
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFilePointerEx(IntPtr file, long distance, out long position, uint moveMethod);

    /** Run the wrapper inside a new group and return its exit status (negative: the helper failed, see start-error). */
    public static int Run(string dir, string application, string[] arguments, string workingDirectory, string logPath, string[] environment)
    {
        IntPtr job = IntPtr.Zero, log = IntPtr.Zero, input = IntPtr.Zero, block = IntPtr.Zero;
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
            log = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (log == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile " + logPath, Marshal.GetLastWin32Error());
            long end;
            SetFilePointerEx(log, 0, out end, FILE_END);
            input = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (input == INVALID_HANDLE_VALUE) return Fail(dir, "CreateFile NUL", Marshal.GetLastWin32Error());

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.hStdInput = input;
            startup.hStdOutput = log;
            startup.hStdError = log;
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
            if (log != IntPtr.Zero && log != INVALID_HANDLE_VALUE) CloseHandle(log);
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

/** The helper script: PowerShell 5.1 compiling {@link C_SHARP}, then running the wrapper in a new group. */
export const JOB_HELPER = `$ErrorActionPreference = 'Stop'
$dir = '@@DIR@@'
$status = 125
try {
  Add-Type -TypeDefinition @'
${C_SHARP}
'@
  $spec = Get-Content -LiteralPath (Join-Path $dir 'job.json') -Raw | ConvertFrom-Json
  Remove-Item -LiteralPath (Join-Path $dir 'job.json') -Force -ErrorAction SilentlyContinue
  $pairs = @()
  if ($spec.env) { foreach ($p in $spec.env.psobject.Properties) { $pairs += ($p.Name + '=' + [string]$p.Value) } }
  $status = [DsaJob]::Run($dir, [string]$spec.exe, [string[]]$spec.args, [string]$spec.cwd, [string]$spec.log, [string[]]$pairs)
} catch {
  try { [System.IO.File]::WriteAllText((Join-Path $dir 'start-error'), [string]$_) } catch { }
  $status = 125
}
if ($status -lt 0) { exit 125 }
exit $status
`;

/** The helper script with the attempt directory (and only that) spelled in; a PowerShell single-quoted string. */
export function jobHelperScript(dir: string): string { return JOB_HELPER.replace("@@DIR@@", dir.replace(/'/g, "''")); }

export interface JobLaunch {
  /** The program to run suspended, assigned to the group, then resumed (the command's wrapper). */
  exe: string;
  args: readonly string[];
  cwd: string;
  /** stdout and stderr of the program: one file, append (the command's output.log). */
  log: string;
  /** Its complete environment. */
  env: NodeJS.ProcessEnv;
}
export interface JobSpawned {
  /** The program's pid (from the group record, not from this process's child). */
  pid: number;
  /** Its start token, "" when it ended before it could be observed (the group record proves it started). */
  start: string;
  /** The helper that owns the group: its identity proves the group is still open (absent from the process table: closed). */
  group?: { pid: number; start: string };
  /** Resolves when the helper ends (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}

/** Start `launch` inside a new Windows Job Object (see the module comment). Rejects -- with no attempt started -- when
 *  the helper cannot create the group, assign the suspended child before it runs, or report it back in time. */
export async function spawnInJob(dir: string, launch: JobLaunch, options: { timeoutMs?: number } = {}): Promise<JobSpawned> {
  // Evidence of an earlier attempt in the same directory must never be read as this attempt's.
  for (const name of [JOB_GROUP, JOB_END, JOB_ERROR, JOB_HELPER_LOG]) await rm(join(dir, name), { force: true });
  const script = join(dir, JOB_SCRIPT);
  await writeFile(script, jobHelperScript(dir));
  await writeFile(join(dir, JOB_SPEC), JSON.stringify(launch));
  // The helper's stderr is a file, not a pipe: it outlives this process and nothing drains it.
  const errors = openSync(join(dir, JOB_HELPER_LOG), "a");
  let helper: ChildProcess;
  try {
    helper = spawn(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { detached: true, stdio: ["ignore", "ignore", errors], windowsHide: true, env: helperEnv() });
  } finally { closeSync(errors); }
  let ended = false;
  const exited = new Promise<void>(resolve => {
    const done = () => { ended = true; resolve(); };
    helper.once("exit", done);
    helper.once("error", done);
  });
  /** Fail closed: end the group (killing the helper closes it), reap it, and report why nothing may be attempted. */
  const refuse = async (reason: string): Promise<never> => {
    if (!ended) {
      await killTree(helper.pid ?? 0).catch(() => {});
      await Promise.race([exited, delay(5000)]);
    }
    throw new Error(`${reason}${await startError(dir)}`);
  };
  try {
    await new Promise<void>((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
  } catch (error) {
    return refuse(`the command job helper could not start (${String((error as Error)?.message ?? error)})`);
  }
  const timeoutMs = options.timeoutMs ?? JOB_START_TIMEOUT_MS, deadline = Date.now() + timeoutMs;
  let pid = 0;
  try {
    for (;;) {
      const text = await readFile(join(dir, JOB_GROUP), "utf8")
        .catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (text !== undefined) {
        let recorded: unknown;
        try { recorded = (JSON.parse(text) as { pid?: unknown }).pid; }
        catch { throw new Error(`the command job group record cannot be read: ${text.slice(0, 200)}`); }
        if (!Number.isInteger(recorded) || (recorded as number) <= 0) throw new Error(`the command job group record is not a pid: ${text.slice(0, 200)}`);
        pid = recorded as number;
        break;
      }
      if (ended) throw new Error("the command job helper ended before the command could start");
      if (Date.now() >= deadline) throw new Error(`the command job helper reported no group within ${timeoutMs} ms`);
      await delay(10);
    }
  } catch (error) {
    return refuse(String((error as Error)?.message ?? error));
  }
  // One process-table observation for both identities. It is the only evidence that the attempt can be fenced later, so
  // an unobservable attempt is not recorded: the group is ended and the call fails instead of running unfenced. A missing
  // row is a retired process (the group record already proved the wrapper started), never a guess at its identity.
  let starts: Map<number, string>;
  try { starts = new Map((await winProcessRows()).map(row => [row.pid, row.start])); }
  catch (error) { return refuse(`the command job group could not be observed (${String((error as Error)?.message ?? error)})`); }
  const start = starts.get(pid) ?? "";
  // The helper is the group's only handle holder: its row means the group is open, its absence means the kernel closed it.
  const helperPid = helper.pid, helperStart = helperPid === undefined ? "" : starts.get(helperPid) ?? "";
  helper.unref();
  return { pid, start, ...(helperPid !== undefined && helperStart ? { group: { pid: helperPid, start: helperStart } } : {}), exited };
}

/** The helper's reason, when it wrote one: appended to the failure the call reports. */
async function startError(dir: string): Promise<string> {
  const text = (await readFile(join(dir, JOB_ERROR), "utf8").catch(() => "")) +
    (await readFile(join(dir, JOB_HELPER_LOG), "utf8").catch(() => ""));
  const reason = text.trim().replace(/\s+/g, " ");
  return reason ? `: ${reason.slice(0, 300)}` : "";
}
