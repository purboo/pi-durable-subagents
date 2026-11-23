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
// compilation is the expensive part of a command start, so it is staged (prepareJob) *before* the attempt's durable
// intent is recorded: bounded and cancellable, and until it finishes the attempt directory holds only inert files (a source
// file, an executable, the spec) and the journal holds no intent, so an orchestrator that dies while the compiler runs
// leaves nothing that can act and an attempt that is unambiguously prelaunch. A stop, a retirement or the orchestrator's
// exit during the compilation cancels it (the compiler process is ended and what it wrote is removed) and is never
// recorded as a failure of the attempt. The executor's proceed/stop gate is still called once more, after the
// preparation and immediately before the spawn (no await between the two), so a revocation during the compilation starts
// nothing. A missing compiler, a compiler failure or a missing executable fails the start closed: no group, no wrapper,
// no command, and the recorded reason travels with the attempt -- kill-on-close and the single-rerun semantics are never
// weakened.
//
// The spec is ASCII lines of base64-encoded UTF-16LE fields (jobSpecText), so no code page, quoting rule, BOM or unpaired
// surrogate can change a Unicode path, a curly quote or an environment value; the owner turns every line back into its
// exact UTF-16 code units -- each byte pair is one char, never through a decoder fallback that could substitute -- and
// refuses a field that is not a whole number of code units, or that carries a NUL. The C# source is ASCII-only for the
// same reason: csc.exe reads a file without a byte order mark in the ANSI code page.
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
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { retryWinSharing, retryWinSharingSync, writeFileAtomic, type RetryWinSharingOptions } from "../kernel/fsx.ts";
import { dword, helperEnv, isWinStart, killProcess, sameCreation, systemRoot, winProcessRows, winTag, winTagArg, type WinProcessRow } from "./windows.ts";
export { sameCreation };

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
    // The wrapper inherits the three standard handles by name (a one-entry proc-thread attribute list), never "every
    // inheritable handle this host happens to hold".
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
    const int ERROR_ACCESS_DENIED = 5;
    const int ERROR_INVALID_HANDLE = 6;
    const int ERROR_SHARING_VIOLATION = 32;
    const int ERROR_LOCK_VIOLATION = 33;
    const int ERROR_BUSY = 170;
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_APPEND_DATA = 0x00000004;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    const uint WAIT_OBJECT_0 = 0x00000000;
    const uint WAIT_TIMEOUT = 0x00000102;
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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
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

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle, IntPtr hTargetProcessHandle,
        out IntPtr lpTargetHandle, uint dwDesiredAccess, bool bInheritHandle, uint dwOptions);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileExW(string existingFileName, string newFileName, uint flags);
    [DllImport("kernel32.dll")]
    static extern void Sleep(uint milliseconds);

    /** argv[0] is the attempt directory, argv[1] (ignored) the attempt's DSA_EXEC tag: a process-table scan finds
     *  the attempt by that tag while this host is starting, before it writes its group record. 126 means no directory,
     *  125 a failure this host recorded in start-error; otherwise the wrapper's own exit status, the whole DWORD. */
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
        // The wrapper's status is the kernel's DWORD and nothing else: a status above 0x7fffffff stays that status
        // instead of turning into this host's own failure code. 125/126 are only ever written by a host that recorded
        // why it did not get to run (or did not get) the wrapper, so a caller can tell the two apart.
        uint status;
        return Run(dir, application, arguments, workingDirectory, logPath, environment, out status) ? unchecked((int)status) : 125;
    }

    /** The attempt's spec: ASCII lines, one base64-encoded UTF-16LE field each, so no code page, quoting rule or
     *  surrogate can change it (Field decodes each one to its exact code units). DSAJOB1, exe, cwd, log, argument count,
     *  arguments, environment count, NAME=value entries. */
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
        byte[] bytes = Convert.FromBase64String(line);
        // A field is a whole number of UTF-16 code units, and jobSpecText wrote each pair as the code unit itself. An
        // odd byte count is not a string any Win32 API could receive: refuse the spec instead of keeping the even
        // prefix (a silently truncated path or argument). Nothing has been started yet.
        if ((bytes.Length & 1) != 0) throw new FormatException("a job spec field is not a whole number of UTF-16 code units");
        // Each byte pair is one char, copied as such: no decoding fallback can replace an unpaired surrogate the caller
        // meant to pass, and the field reaches Win32 exactly as the caller wrote it.
        char[] units = new char[bytes.Length / 2];
        if (units.Length > 0) Buffer.BlockCopy(bytes, 0, units, 0, bytes.Length);
        string value = new string(units);
        // A NUL would end the field where a Win32 API (CreateProcess, the environment block) reads it, so a path or an
        // argument would silently become a shorter one. Refuse the spec instead: nothing has been started yet.
        if (value.IndexOf((char)0) >= 0) throw new FormatException("a job spec field contains a NUL character");
        return value;
    }

    /** Run the wrapper inside a new group. True means the wrapper ran and the returned status is the full exit code the
     *  kernel gave it; false means this host failed, wrote start-error and started nothing (or killed what it started). */
    static bool Run(string dir, string application, string[] arguments, string workingDirectory, string logPath, string[] environment, out uint status)
    {
        status = 0;
        IntPtr job = IntPtr.Zero, output = IntPtr.Zero, errorHandle = IntPtr.Zero, input = IntPtr.Zero, block = IntPtr.Zero;
        IntPtr list = IntPtr.Zero, inheritable = IntPtr.Zero;
        // DeleteProcThreadAttributeList takes only a list InitializeProcThreadAttributeList produced.
        bool listReady = false;
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
            if (String.IsNullOrEmpty(logPath))
            {
                string stepName;
                if (!OpenInheritedOrNul(STD_INPUT_HANDLE, GENERIC_READ, ref inherit, out input, out stepName))
                    return Fail(dir, stepName, Marshal.GetLastWin32Error());
                if (!OpenInheritedOrNul(STD_OUTPUT_HANDLE, FILE_APPEND_DATA, ref inherit, out output, out stepName))
                    return Fail(dir, stepName, Marshal.GetLastWin32Error());
                if (!OpenInheritedOrNul(STD_ERROR_HANDLE, FILE_APPEND_DATA, ref inherit, out errorHandle, out stepName))
                    return Fail(dir, stepName, Marshal.GetLastWin32Error());
            }
            else
            {
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
            }

            // inheritHandles is true because the wrapper needs its standard handles, so the handle list is what says
            // which: without it the child inherits every inheritable handle this host holds (the .NET runtime and the
            // host that started it may keep some open), and a descriptor the command never asked for would reach it.
            // The list names exactly the three standard handles, so the command's handle set is the one declared here.
            IntPtr listSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
            if (listSize == IntPtr.Zero) return Fail(dir, "InitializeProcThreadAttributeList", Marshal.GetLastWin32Error());
            list = Marshal.AllocHGlobal(listSize);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize))
                return Fail(dir, "InitializeProcThreadAttributeList", Marshal.GetLastWin32Error());
            listReady = true;
            // The list is an array of HANDLEs; the three are the ones the child's STARTUPINFO names below.
            inheritable = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(inheritable, 0, input);
            Marshal.WriteIntPtr(inheritable, IntPtr.Size, output);
            Marshal.WriteIntPtr(inheritable, IntPtr.Size * 2, errorHandle);
            if (!UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), inheritable, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                return Fail(dir, "UpdateProcThreadAttribute", Marshal.GetLastWin32Error());

            STARTUPINFOEX startup = new STARTUPINFOEX();
            // With EXTENDED_STARTUPINFO_PRESENT the size is the extended structure's, not STARTUPINFO's.
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = output;
            startup.StartupInfo.hStdError = errorHandle;
            startup.lpAttributeList = list;
            block = EnvironmentBlock(environment);
            uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT;
            if (!CreateProcessW(application, CommandLine(application, arguments), IntPtr.Zero, IntPtr.Zero, true, flags, block,
                    workingDirectory, ref startup, out child))
                return Fail(dir, "CreateProcess " + application, Marshal.GetLastWin32Error());
            started = true;
            // The child holds its own copies now, so this host's are closed at once instead of when the command ends:
            // the output file and NUL are open for exactly as long as the kernel needed to hand them over, and a stopped
            // command never leaves its log held open by a process that only started it. The attribute list is done too.
            CloseHandle(input); input = IntPtr.Zero;
            CloseHandle(output); output = IntPtr.Zero;
            CloseHandle(errorHandle); errorHandle = IntPtr.Zero;
            if (String.IsNullOrEmpty(logPath)) ReleaseOwnStdHandles();
            DeleteProcThreadAttributeList(list); listReady = false;
            Marshal.FreeHGlobal(list); list = IntPtr.Zero;
            Marshal.FreeHGlobal(inheritable); inheritable = IntPtr.Zero;

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
            string stopPath = Path.Combine(dir, "stop");
            bool stopped = false;
            for (;;)
            {
                uint waited = WaitForSingleObject(child.hProcess, 50);
                if (waited == WAIT_OBJECT_0) break;
                if (waited != WAIT_TIMEOUT) return Fail(dir, "WaitForSingleObject", Marshal.GetLastWin32Error());
                if (File.Exists(stopPath)) { stopped = true; break; }
            }
            uint code = 1;
            if (!stopped && !GetExitCodeProcess(child.hProcess, out code)) return Fail(dir, "GetExitCodeProcess", Marshal.GetLastWin32Error());
            DrainJob(job);
            if (!stopped)
            {
                // The record and the returned status carry the whole DWORD, above 0x7fffffff included: it is the wrapper's.
                WriteAtomic(Path.Combine(dir, "group-end"), @"{""status"":" + code.ToString(CultureInfo.InvariantCulture) + "}");
            }
            status = code;
            return true;
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
            if (listReady) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (inheritable != IntPtr.Zero) Marshal.FreeHGlobal(inheritable);
            if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            // The group's only handle (non-inherited): closing it kills every process the command left behind.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    static bool OpenInheritedOrNul(int stdWhich, uint nulAccess, ref SECURITY_ATTRIBUTES inherit, out IntPtr handle, out string stepName)
    {
        handle = IntPtr.Zero;
        stepName = "DuplicateHandle";
        IntPtr raw = GetStdHandle(stdWhich);
        if (raw != IntPtr.Zero && raw != INVALID_HANDLE_VALUE)
        {
            IntPtr current = GetCurrentProcess();
            if (DuplicateHandle(current, raw, current, out handle, 0, true, DUPLICATE_SAME_ACCESS))
                return true;
            int err = Marshal.GetLastWin32Error();
            if (err != ERROR_INVALID_HANDLE) return false;
        }
        stepName = "CreateFile NUL";
        handle = CreateFileW("NUL", nulAccess, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        return handle != INVALID_HANDLE_VALUE;
    }

    static void ReleaseOwnStdHandles()
    {
        IntPtr hIn = GetStdHandle(STD_INPUT_HANDLE);
        IntPtr hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        IntPtr hErr = GetStdHandle(STD_ERROR_HANDLE);
        SetStdHandle(STD_INPUT_HANDLE, IntPtr.Zero);
        SetStdHandle(STD_OUTPUT_HANDLE, IntPtr.Zero);
        SetStdHandle(STD_ERROR_HANDLE, IntPtr.Zero);
        if (hIn != IntPtr.Zero && hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
        if (hOut != IntPtr.Zero && hOut != INVALID_HANDLE_VALUE && hOut != hIn) CloseHandle(hOut);
        if (hErr != IntPtr.Zero && hErr != INVALID_HANDLE_VALUE && hErr != hIn && hErr != hOut) CloseHandle(hErr);
    }

    static void DrainJob(IntPtr job)
    {
        TerminateJobObject(job, 1);
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        int start = Environment.TickCount;
        for (;;)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, size, IntPtr.Zero)) break;
            if (info.ActiveProcesses == 0) break;
            if (unchecked(Environment.TickCount - start) >= 5000) break;
            Sleep(10);
        }
    }

    /** Record why this host did not start the wrapper and answer false (see Run): the negative return this code used to
     *  carry could be confused with a wrapper status above 0x7fffffff. */
    static bool Fail(string dir, string what, int code)
    {
        return Fail(dir, what, code, null);
    }

    static bool Fail(string dir, string what, int code, string detail)
    {
        string text = what + " failed (error " + code.ToString(CultureInfo.InvariantCulture) + ")" + (detail == null ? "" : ": " + detail);
        try { WriteAtomic(Path.Combine(dir, "start-error"), text); } catch (Exception) { }
        return false;
    }

    static bool IsTransientSharingError(int win32Error)
    {
        return win32Error == ERROR_ACCESS_DENIED || win32Error == ERROR_SHARING_VIOLATION ||
            win32Error == ERROR_LOCK_VIOLATION || win32Error == ERROR_BUSY;
    }

    static bool IsTransientSharingException(Exception error)
    {
        if (error is UnauthorizedAccessException) return true;
        IOException io = error as IOException;
        if (io == null) return false;
        int code = Marshal.GetHRForException(io) & 0xFFFF;
        return IsTransientSharingError(code);
    }

    static void WriteAtomic(string path, string text)
    {
        string temporary = path + ".tmp";
        int deadline = unchecked(Environment.TickCount + 2500);
        try
        {
            for (int attempt = 0; ; attempt++)
            {
                try { File.WriteAllText(temporary, text); break; }
                catch (Exception error)
                {
                    if (!IsTransientSharingException(error) || attempt >= 25) throw;
                    int left = unchecked(deadline - Environment.TickCount);
                    if (left <= 0) throw;
                    int wait = (attempt + 1) * 10;
                    if (wait > 100) wait = 100;
                    if (wait > left) wait = left;
                    Sleep((uint)wait);
                }
            }
            for (int attempt = 0; ; attempt++)
            {
                if (MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING)) return;
                int err = Marshal.GetLastWin32Error();
                if (!IsTransientSharingError(err) || attempt >= 25)
                    throw new IOException("MoveFileExW failed (error " + err.ToString(CultureInfo.InvariantCulture) + ")");
                int left = unchecked(deadline - Environment.TickCount);
                if (left <= 0)
                    throw new IOException("MoveFileExW failed (error " + err.ToString(CultureInfo.InvariantCulture) + ")");
                int wait = (attempt + 1) * 10;
                if (wait > 100) wait = 100;
                if (wait > left) wait = left;
                Sleep((uint)wait);
            }
        }
        catch (Exception)
        {
            try { File.Delete(temporary); } catch (Exception) { }
            throw;
        }
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
/** Written by this process when the owner ends: its exit code -- the whole DWORD, normalized as every status here is,
 *  so it agrees with the group record and with what a caller observes -- or why it could not be spawned, for the failure
 *  reason. The owner cannot report this itself -- it is the process that ended. */
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
/** Written (atomically) by a caller requesting a controlled stop so the owner calls DrainJob and exits without `group-end`. */
export const JOB_STOP = "stop";
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
/** Publishing the compiler's output under its final name: a scanner or indexer may hold the fresh file for a moment, so a
 *  transient rename failure is retried for this long before it is reported. */
const JOB_PUBLISH_MS = 5_000;
const JOB_PUBLISH_RETRY_MS = 100;
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
 *  surrogate -- unchanged: the owner turns every line back with Convert.FromBase64String and takes each byte pair as one
 *  code unit, and refuses a field that is not a whole number of them. */
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

/** A preparation cancelled while it ran: a stop, a retirement, a suspension or the orchestrator's exit arrived during the
 *  compilation. Nothing of the attempt exists (no group, no wrapper, no command) and nothing of it was recorded, so this is
 *  not a failure of the attempt and must never be sealed as one. */
export class JobPrepareCancelled extends Error {
  constructor() { super("the command job host preparation was cancelled"); this.name = "JobPrepareCancelled"; }
}
/** Whether `error` is such a cancellation (the caller decides what canceled it: a stop seals stopped, a retirement or an
 *  exit ends the run and the call resumes on recovery). */
export const prepareCancelled = (error: unknown): boolean =>
  error instanceof JobPrepareCancelled || (error as { name?: unknown } | undefined)?.name === "JobPrepareCancelled";

/** A launch's preparation, staged before the attempt's durable intent: the owner is compiled and the spec written, and
 *  nothing has been started. `release` removes what it wrote (idempotent; there is no process to end). */
export interface JobPrep {
  /** The launch's private owner directory. */
  host: JobHostPaths;
  /** The attempt directory the owner reads its spec and records from. */
  dir: string;
  release(): Promise<void>;
}

/** Prepare one launch without starting anything: clear an earlier attempt's evidence from the directory, compile the owner
 *  (bounded and cancellable: a crash or a cancellation leaves only inert files, and a cancellation removes even those),
 *  and write the spec the owner reads. A rejection is either fail-closed (`JOB_ERROR` recorded, the attempt cannot start)
 *  or a {@link JobPrepareCancelled} (nothing was recorded and nothing stays). */
export async function prepareJob(dir: string, launch: JobLaunch,
  options: { compiler?: string; compileMs?: number; signal?: AbortSignal; publish?: PublishBuild } = {}): Promise<JobPrep> {
  // Evidence of an earlier attempt in the same directory must never be read as this attempt's.
  for (const name of [JOB_BEGIN, JOB_GROUP, JOB_END, JOB_ERROR, JOB_STOP, JOB_HOST_EXIT, JOB_HOST_LOG]) await rm(join(dir, name), { force: true });
  const host = await compileJobHost(dir, { ...(options.compiler ? { compiler: options.compiler } : {}),
    ...(options.compileMs ? { timeoutMs: options.compileMs } : {}), ...(options.signal ? { signal: options.signal } : {}),
    ...(options.publish ? { publish: options.publish } : {}) });
  const release = async () => { await rm(host.dir, { recursive: true, force: true }); await rm(join(dir, JOB_SPEC), { force: true }); };
  if (options.signal?.aborted) { await release(); throw new JobPrepareCancelled(); }
  await writeFile(join(dir, JOB_SPEC), jobSpecText(launch));
  return { host, dir, release };
}

/** Compile the owner into the launch's private directory with the Windows framework compiler: foreground and bounded (no
 *  command is started, so a starter that dies here leaves only inert files), and fail-closed (a missing compiler, a
 *  compiler failure or a missing executable throws before anything of the attempt exists). `signal` cancels it: the
 *  compiler is ended, what it wrote is removed and the rejection is a {@link JobPrepareCancelled}, which is not a failure
 *  of the attempt (nothing of it exists, and it is never recorded as one). A cancellation during the publication of the
 *  compiler's output is the same cancellation: the retries stop at once, what the compiler wrote is removed and nothing is
 *  recorded as a publish failure. */
export async function compileJobHost(dir: string, options: { compiler?: string; timeoutMs?: number; signal?: AbortSignal; publish?: PublishBuild } = {}): Promise<JobHostPaths> {
  const paths = jobHostPaths(dir), signal = options.signal;
  await mkdir(paths.dir, { recursive: true });
  /** A cancelled preparation leaves nothing behind: no compiled owner, no source, no reason (nothing failed). */
  const cancelled = async (): Promise<JobPrepareCancelled> => {
    await rm(paths.dir, { recursive: true, force: true }).catch(() => {});
    return new JobPrepareCancelled();
  };
  if (signal?.aborted) throw await cancelled();
  await writeFile(paths.source, JOB_HOST_SOURCE, "utf8");
  const compiler = options.compiler ?? frameworkCompiler(), timeoutMs = options.timeoutMs ?? JOB_COMPILE_TIMEOUT_MS;
  // Only ASCII relative names reach the compiler, and it runs in the launch's own directory: the attempt directory (which
  // may be Unicode or curly-quoted) is the process's working directory, which Windows passes as UTF-16, so no path
  // argument needs a code-page conversion. The output is built beside the final name and renamed only after the compiler
  // exits cleanly, so a killed or failed compiler can never leave a half-written executable that a later start would run.
  const build = "DsaJob.build.exe";
  let stdout = "", stderr = "";
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(compiler, ["/nologo", "/codepage:65001", "/target:winexe", `/out:${build}`, JOB_HOST_SOURCE_FILE],
          { cwd: paths.dir, timeout: timeoutMs, windowsHide: true, env: helperEnv(), maxBuffer: 1024 * 1024, encoding: "utf8",
            ...(signal ? { signal } : {}) },
          (error, out, err) => { stdout = String(out ?? ""); stderr = String(err ?? ""); if (error) reject(error); else resolve(); });
      });
    } catch (error) {
      // A compiler this process ended because the start was cancelled wrote nothing that counts, and the start was never
      // recorded: this is not the attempt's failure, so it is not written to the attempt either.
      if (signal?.aborted || prepareCancelled(error)) throw await cancelled();
      throw new Error(compilerFailure(compiler, error, stdout, stderr));
    }
    if (signal?.aborted) throw await cancelled();
    // The executable is the one just produced: the directory is new, so this cannot be a stale binary (a compiler that
    // reports success without writing it is a failure, never a reason to look elsewhere).
    try { await (options.publish ?? publishBuild)(join(paths.dir, build), paths.exe, { ...(signal ? { signal } : {}) }); }
    catch (error) {
      // A publication ended by the cancellation is the cancellation (nothing was started, nothing is recorded): only a
      // publish that failed on its own is fail-closed.
      if (prepareCancelled(error) || signal?.aborted) throw await cancelled();
      throw error;
    }
    if (signal?.aborted) throw await cancelled();
    if (!existsSync(paths.exe)) throw new Error(`the Windows .NET Framework compiler wrote no executable at ${paths.exe}`);
  } catch (error) {
    if (prepareCancelled(error)) throw error;
    const reason = String((error as Error)?.message ?? error);
    await writeFileAtomic(join(dir, JOB_ERROR), clip(oneLine(reason), REASON_LIMIT), { encoding: "utf8" }).catch(() => {});
    throw new Error(reason);
  }
  return paths;
}

/** Publish the compiler's output under its final name: the rename is atomic, so a retry can never expose a half-written
 *  executable, and Windows scanners and indexers hold a fresh file for a moment (a transient code). A failure that stays
 *  is reported with its own reason, and only a build file that is genuinely absent reads as "wrote no executable" --
 *  reporting every rename failure that way hides the real cause. `signal` cancels it: the retries and their delay end at
 *  once with a {@link JobPrepareCancelled}, which is a cancellation and never a publish failure (the caller removes what
 *  the compiler wrote). `renameFile` and the timings are test seams. */
export async function publishBuild(build: string, exe: string,
  options: { timeoutMs?: number; retryMs?: number; renameFile?: (from: string, to: string) => Promise<void>; signal?: AbortSignal } = {}): Promise<void> {
  const renameFile = options.renameFile ?? rename, retryMs = options.retryMs ?? JOB_PUBLISH_RETRY_MS,
    budgetMs = options.timeoutMs ?? JOB_PUBLISH_MS, signal = options.signal, end = Date.now() + budgetMs;
  /** A cancelled publication is not a failure to publish: nothing is recorded about it and the output is not needed. */
  const cancelled = () => new JobPrepareCancelled();
  for (;;) {
    if (signal?.aborted) throw cancelled();
    let failure: unknown;
    try { await renameFile(build, exe); } catch (error) { failure = error; }
    if (failure === undefined) {
      // The rename succeeded, but a cancellation that arrived while it ran still wins: nothing may follow it (the caller
      // removes what the compiler wrote).
      if (signal?.aborted) throw cancelled();
      return;
    }
    // A rename that failed while the start was cancelled is that cancellation, not its own reason: the classification
    // below (absent, transient, otherwise) describes a publish the attempt still needs, and it is not needed here.
    if (signal?.aborted) throw cancelled();
    const reason = String((failure as Error)?.message ?? failure);
    if (absent(failure)) throw new Error(`the Windows .NET Framework compiler wrote no executable for ${exe}`);
    if (!transientRead(failure)) throw new Error(`the Windows .NET Framework compiler output could not be published as ${exe}: ${reason}`);
    if (Date.now() + retryMs >= end) throw new Error(`the Windows .NET Framework compiler output could not be published as ${exe} within ${budgetMs} ms: ${reason}`);
    // The retry delay is woken by the signal: a cancellation does not wait out the rest of the budget.
    if (!await wokenBy(retryMs, signal)) throw cancelled();
  }
}
export type PublishBuild = typeof publishBuild;

/** Wait `ms`, or end at once when `signal` aborts: a cancelled preparation wakes promptly instead of sitting out a retry
 *  delay (which is bounded only by the publish budget). Resolves false when the signal aborted first. */
function wokenBy(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return delay(ms).then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    let settled = false, timer: ReturnType<typeof setTimeout>;
    const done = (waited: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(waited);
    };
    const aborted = () => done(false);
    timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", aborted, { once: true });
    // An abort between the check above and the listener: the event would never reach it.
    if (signal.aborted) done(false);
  });
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
 *  path), then the attempt's versioned tag(s), which the C# ignores and a process-table scan reads while the owner starts. */
export function jobHostArgv(dir: string, exec?: string, hold?: string): string[] {
  return [dir, ...(exec ? [winTagArg("DSA_EXEC", exec)] : []), ...(hold ? [winTagArg("DSA_HOLD", hold)] : [])];
}

function matchesOwnerTag(command: string | undefined, launch: Pick<JobLaunch, "exec" | "hold">): boolean {
  if (launch.exec && winTag(command, "DSA_EXEC") !== launch.exec) return false;
  if (launch.hold && winTag(command, "DSA_HOLD") !== launch.hold) return false;
  return true;
}

export interface JobLaunch {
  /** The program to run suspended, assigned to the group, then resumed (the command's wrapper). */
  exe: string;
  args: readonly string[];
  cwd: string;
  /** stdout and stderr of the program: one file, append (the command's output.log), or "" to inherit the owner's stdio. */
  log: string;
  /** Its complete environment. */
  env: NodeJS.ProcessEnv;
  /** The attempt's tag (`DSA_EXEC=<exec>`): spelled in the owner's own argv, so a scan still finds the attempt while it
   *  compiles and starts, before the group record exists. */
  exec?: string;
  /** Resource lease tag (`DSA_HOLD=<resource:seq>`): spelled in the owner's own argv so a killed hold wrapper's job
   *  is discoverable before the group record exists. */
  hold?: string;
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
  /** Terminate the live owner through this process's direct ChildProcess handle (closing the Job Object). */
  killOwner?: () => boolean;
  /** Request a controlled stop (`stop` sentinel file) so `DsaJob.exe` drains the Job Object before exiting. */
  requestStop?: () => Promise<void>;
  /** Resolves when the owner ends (a wake-up only: the exit record is the outcome). */
  exited: Promise<void>;
}
export type JobOwnerStdio = ["ignore" | "inherit" | number, "ignore" | "inherit" | number, "ignore" | "inherit" | number];
export interface JobOptions {
  /** The executor's last check (see command.ts): called once, after the preparation and immediately before the spawn. A
   *  false answer starts no process and makes spawnInJob resolve undefined. */
  proceed?: () => boolean;
  /** A staged preparation (prepareJob, called before the attempt's durable intent): the owner is compiled and the spec
   *  written, so the only steps left before the spawn are the last check and the spawn itself. */
  prepared?: JobPrep;
  /** Cancels a preparation this call stages itself (a staged one was already prepared under its own signal). */
  signal?: AbortSignal;
  /** Stdio passed to the owner itself (default: ignore stdin/stdout, append stderr to host.log). */
  stdio?: JobOwnerStdio;
  /** Whether to unref the owner handle once started (default: true; `hold` passes false while awaiting completion). */
  unref?: boolean;
  /** Called immediately once the owner ChildProcess exists with a direct-handle termination callback. */
  onOwnerSpawned?: (killOwner: () => boolean) => void;
  /** Test seam: the compiler to run instead of the discovered framework one. */
  compiler?: string;
  /** Test seam: how long the foreground compilation may take (default JOB_COMPILE_TIMEOUT_MS). */
  compileMs?: number;
  /** Test seam: publishing the compiler's output (default publishBuild). */
  publish?: PublishBuild;
  /** The handshake deadline (the group record), after the spawn: an owner that reported none by then started nothing. */
  timeoutMs?: number;
  /** How long a failed process-table observation is retried before the attempt is adopted (default JOB_OBSERVE_MS). */
  observeMs?: number;
  /** How long an owner that cannot be confirmed retired is given to end before its attempt is adopted (default
   *  JOB_HOST_END_MS). */
  endMs?: number;
  /** Test seam: one process-table observation (default: the real one). */
  observe?: () => Promise<WinProcessRow[]>;
  /** Test seam: end the owner (default: direct ChildProcess handle kill + handle-verified fallback); rejects when the end is not confirmed. */
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

function parseGroupText(text: string): GroupRecord {
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

/** The group record written before ResumeThread (with legacy `{"pid":<n>}` compatibility); undefined while not ready. */
export async function readGroupRecord(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => Promise<string> } = {}): Promise<GroupRecord | undefined> {
  const readFn = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  let text: string;
  try { text = await retryWinSharing(() => readFn(join(dir, JOB_GROUP)), { timeoutMs: 250, maxAttempts: 6, ...options }); }
  catch (error) { if (absent(error) || transientRead(error)) return undefined; throw error; }
  return parseGroupText(text);
}

export type SyncGroupState = { state: "absent" } | { state: "transient" } | { state: "ready"; record: GroupRecord };

/** Synchronous group-record reader for lease liveness checks; distinguishes transient rename locks from absence. */
export function readGroupRecordStateSync(dir: string): SyncGroupState {
  let text: string;
  try { text = readFileSync(join(dir, JOB_GROUP), "utf8"); }
  catch (error) {
    if (absent(error)) return { state: "absent" };
    if (transientRead(error)) return { state: "transient" };
    return { state: "absent" };
  }
  try { return { state: "ready", record: parseGroupText(text) }; }
  catch { return { state: "absent" }; }
}

/** Synchronous group-record reader for recovery/sweep callers (`gateJobProcesses`); retries briefly on Windows
 *  transient sharing locks (unlike {@link readGroupRecordStateSync}, which stays single-shot non-blocking for leases). */
export function readGroupRecordSync(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => string } = {}): GroupRecord | undefined {
  const readFn = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let text: string;
  try {
    text = retryWinSharingSync(() => readFn(join(dir, JOB_GROUP)), { timeoutMs: 250, maxAttempts: 5, ...options });
  } catch {
    return undefined;
  }
  try { return parseGroupText(text); }
  catch { return undefined; }
}

function parseBeginText(text: string): { pid: number; start: string } | undefined {
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; start?: unknown };
    return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.start === "string" && parsed.start
      ? { pid: parsed.pid as number, start: parsed.start } : undefined;
  } catch { return undefined; }
}

/** The owner's handle-recorded creation identity from `helper-begin` (undefined when absent or legacy `"begin"`). */
export async function readBeginIdentity(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => Promise<string> } = {}): Promise<{ pid: number; start: string } | undefined> {
  const readFn = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  let text: string;
  try { text = await retryWinSharing(() => readFn(join(dir, JOB_BEGIN)), { timeoutMs: 500, maxAttempts: 10, ...options }); }
  catch { return undefined; }
  return parseBeginText(text);
}

export function readBeginIdentitySync(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => string } = {}): { pid: number; start: string } | undefined {
  try {
    const readFn = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    return parseBeginText(retryWinSharingSync(() => readFn(join(dir, JOB_BEGIN)), { timeoutMs: 500, maxAttempts: 10, ...options }));
  } catch { return undefined; }
}

export function readGroupEndSync(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => string } = {}): { status: number } | undefined {
  try {
    const readFn = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const parsed = JSON.parse(retryWinSharingSync(() => readFn(join(dir, JOB_END)), { timeoutMs: 1_000, maxAttempts: 15, ...options })) as { status?: unknown };
    return typeof parsed.status === "number" && Number.isInteger(parsed.status) && parsed.status >= 0 && parsed.status <= 0xffffffff
      ? { status: parsed.status } : undefined;
  } catch { return undefined; }
}

export function readStartErrorSync(dir: string, options: RetryWinSharingOptions & { readFile?: (path: string) => string } = {}): string | undefined {
  try {
    const readFn = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const text = retryWinSharingSync(() => readFn(join(dir, JOB_ERROR)), { timeoutMs: 500, maxAttempts: 10, ...options }).trim();
    return text || undefined;
  } catch { return undefined; }
}

/** Ask a live job owner (`DsaJob.exe`) to drain its Job Object (`DrainJob`) and exit without writing `group-end`. */
export async function requestJobStop(dir: string): Promise<void> {
  await writeFileAtomic(join(dir, JOB_STOP), "stop", {
    encoding: "utf8",
    timeoutMs: 2_500,
    maxAttempts: 25,
  }).catch(() => {});
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

/** Start `launch` inside a new Windows Job Object (see the module comment). Prepares the owner first (a staged preparation
 *  is used as given; otherwise it is staged here: bounded, no process of the attempt exists until it finishes; a compiler
 *  failure throws, fail-closed), then calls `proceed` once more and spawns the owner immediately. Resolves undefined when
 *  `proceed` refuses after the preparation. Rejects -- with no attempt started -- when the owner cannot create the group,
 *  assign the suspended child before it runs, or report it back in time, and its end is confirmed. When an attempt cannot
 *  be refused (the owner did not end), it resolves with JobSpawned.uncertain: the attempt was started and is adopted,
 *  never silently dropped. */
export async function spawnInJob(dir: string, launch: JobLaunch, options: JobOptions = {}): Promise<JobSpawned | undefined> {
  // A staged preparation was made before the attempt's durable intent (prepareJob clears the earlier evidence and writes
  // the spec); one this call stages itself does the same here.
  const host = (options.prepared ?? await prepareJob(dir, launch, { ...(options.compiler ? { compiler: options.compiler } : {}),
    ...(options.compileMs ? { compileMs: options.compileMs } : {}), ...(options.signal ? { signal: options.signal } : {}),
    ...(options.publish ? { publish: options.publish } : {}) })).host;
  // The owner's stderr is a file by default (it outlives the orchestrator and nothing drains it); `hold` passes its own stdio.
  const errors = options.stdio ? undefined : openSync(join(dir, JOB_HOST_LOG), "a");
  let helper: ChildProcess;
  try {
    // The executor's last check, after the preparation and immediately before the spawn: no await follows it, so a stop
    // or retirement that revoked the permission during the compilation starts no process.
    if (options.proceed && !options.proceed()) return undefined;
    helper = spawn(host.exe, jobHostArgv(dir, launch.exec, launch.hold),
      { detached: true, stdio: options.stdio ?? ["ignore", "ignore", errors!], windowsHide: true, env: helperEnv() });
  } finally { if (errors !== undefined) closeSync(errors); }
  let ended = false;
  const killOwner = (): boolean => !ended && helper.exitCode === null && helper.signalCode === null && helper.kill("SIGKILL");
  const requestStop = async (): Promise<void> => {
    if (ended) return;
    await requestJobStop(dir);
  };
  options.onOwnerSpawned?.(killOwner);
  let recordedExit: Promise<void> | undefined;
  // The owner's end is durably written to JOB_HOST_EXIT before `exited` resolves, and every path that formats a
  // failure reason awaits `exited` once `ended` is set so exit evidence never races the rejection message. Published
  // atomically (temp-then-rename with bounded Windows sharing retries, never a direct target write that could expose
  // partial JSON to concurrent readers).
  const exited = new Promise<void>(resolve => {
    const done = (record: string) => {
      ended = true;
      recordedExit ??= writeFileAtomic(join(dir, JOB_HOST_EXIT), record, {
        encoding: "utf8",
        timeoutMs: 2_500,
        maxAttempts: 25,
      }).catch(() => {}).finally(resolve);
    };
    helper.once("exit", (code, signal) => { done(asciiJson({ code: code === null ? null : dword(code), signal })); });
    helper.once("error", error => { done(asciiJson({ error: String((error as Error)?.message ?? error) })); });
  });
  const defaultEndHelper = async (pid: number): Promise<void> => {
    if (!ended && helper.exitCode === null && helper.signalCode === null && helper.kill("SIGKILL")) return;
    if (ended) return;
    const began = await readBeginIdentity(dir);
    if (began && began.pid === pid && isWinStart(began.start)) await killProcess({ pid, start: began.start });
  };
  const observe = options.observe ?? (() => winProcessRows()), endHelper = options.endHelper ?? defaultEndHelper,
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
        } else if (matchesOwnerTag(row.command, launch)) {
          start = row.start;
        }
      }
    }
    // The owner outlives this process by design (the command must): its end is a wake-up, never a held event loop.
    if (options.unref !== false) helper.unref();
    return { pid: helperPid ?? 0, start, uncertain: `${reason}${await startError(dir)}${failure}`, killOwner, requestStop, exited };
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
    if (options.unref !== false) helper.unref();
    return { pid, start: "", killOwner, requestStop, exited };
  }
  const began = recorded.group ?? await readBeginIdentity(dir);
  const expectedOwnerStart = helperPid !== undefined && began?.pid === helperPid ? began.start : undefined;
  const ownerRow = helperPid === undefined ? undefined : rows.find(row => row.pid === helperPid);
  const ownerReplaced = Boolean(ownerRow && expectedOwnerStart !== undefined && !sameCreation(ownerRow.start, expectedOwnerStart));
  let helperStart = "";
  if (helperPid !== undefined && !ownerReplaced) {
    if (ownerRow) {
      if (expectedOwnerStart !== undefined) helperStart = ownerRow.start;
      else if (matchesOwnerTag(ownerRow.command, launch)) helperStart = ownerRow.start;
    } else if (expectedOwnerStart !== undefined && !existsSync(join(dir, JOB_END))) {
      helperStart = expectedOwnerStart;
    }
  }
  const childRow = ownerReplaced ? undefined : rows.find(row => row.pid === pid);
  // Whether the owner recorded the wrapper's end (group-end). Without it the wrapper's exit was never recorded (the owner
  // was ended while the wrapper ran, say), so the only identity of the attempt is the creation time the owner took from
  // the wrapper's own process handle before it resumed it (the group record).
  const endRecorded = existsSync(join(dir, JOB_END));
  let start = "";
  if (childRow) {
    if (recorded.start !== undefined) {
      // The observed row is the wrapper only when its ticks are the recorded instance's. A row that disagrees is another
      // process that reused the pid: its ticks are never taken. Without an end record that row also proves the wrapper
      // exited, so the handle-recorded identity is the attempt's -- recorded as is, never replaced by the recycled row.
      start = sameCreation(childRow.start, recorded.start) ? childRow.start : endRecorded ? "" : recorded.start;
    } else if (!endRecorded &&
      ((helperPid !== undefined && childRow.ppid === helperPid) || (!!launch.exec && winTag(childRow.command, "DSA_EXEC") === launch.exec))) {
      start = childRow.start;
    }
  } else if (!ownerReplaced && recorded.start !== undefined && !endRecorded) {
    start = recorded.start;
  }
  if (options.unref !== false) helper.unref(); // the owner outlives this process by design: its end is a wake-up, never a held event loop
  return { pid, start, ...(helperPid !== undefined && helperStart ? { group: { pid: helperPid, start: helperStart } } : {}), killOwner, requestStop, exited };
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
 *  "" when the file is absent or transiently unreadable after bounded retries, so evidence never grows a reason. */
async function read(path: string, part: "head" | "tail"): Promise<string> {
  const file = await retryWinSharing(() => open(path, "r"), { timeoutMs: 1_000, maxAttempts: 15 })
    .catch((error: NodeJS.ErrnoException) => { if (absent(error) || transientRead(error)) return undefined; throw error; });
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
