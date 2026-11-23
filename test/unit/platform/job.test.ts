// The Windows Job Object slice of a command attempt: the wrapper is the root of a kernel-owned group, created suspended,
// assigned before it may run, and the group's only handle dies with its owner -- a small .NET Framework executable
// compiled per launch with the framework's own compiler. The behavioral checks run on a Windows runner only (the
// primitive is Win32); they exercise the real compiled owner, a real kernel group and real processes. The source contract,
// the spec text and the reason an owner left are checked everywhere, because that is where a Unicode path, a curly quote,
// a stale executable or a credential would be lost or leaked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  JOB_BEGIN, JOB_END, JOB_ERROR, JOB_GROUP, JOB_HOST_EXE, JOB_HOST_EXIT, JOB_HOST_LOG, JOB_HOST_MARKER, JOB_HOST_PREFIX,
  JOB_HOST_SOURCE, JOB_SPEC, JOB_SPEC_HEADER, JOB_STOP, JobPrepareCancelled, asciiJson, compileJobHost, frameworkCompiler, frameworkCompilerCandidates, jobEnv,
  jobHostArgv, jobHostPaths, jobSpecText, prepareCancelled, prepareJob, publishBuild, readBeginIdentity, readGroupEndSync, readGroupRecord,
  readStartErrorSync, requestJobStop, spawnInJob, startError, type PublishBuild,
} from "../../../src/platform/job.ts";
import { winProcessRows } from "../../../src/platform/windows.ts";

const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
/** A compiler stand-in is a script the compiler slot runs, which needs a POSIX shebang: the compilation's surroundings
 *  (staging, cancellation, publishing) are checked there, and with the real csc.exe on Windows. */
const posixOnly = process.platform === "win32" ? "a POSIX shell-script compiler stand-in" : false;
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-job-"));
/** The spec text back into fields: the header, then base64 UTF-16LE lines (exe, cwd, log, args, env). */
function decodeSpec(text: string): { exe: string; cwd: string; log: string; args: string[]; env: string[] } {
  const lines = text.split("\n");
  assert.equal(lines.at(-1), "", "the spec ends with a newline");
  lines.pop();
  assert.equal(lines[0], JOB_SPEC_HEADER);
  let at = 1;
  const from = () => Buffer.from(lines[at++]!, "base64").toString("utf16le");
  const exe = from(), cwd = from(), log = from();
  const args = Array.from({ length: Number(lines[at++]) }, from);
  const env = Array.from({ length: Number(lines[at++]) }, from);
  assert.equal(at, lines.length, "the spec has no trailing fields");
  return { exe, cwd, log, args, env };
}
async function until<T>(get: () => Promise<T | undefined> | T | undefined, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await get(); if (value !== undefined && value !== false) return value; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
}
const live = async (pid: number) => (await winProcessRows()).some(row => row.pid === pid);
const gone = (pid: number) => until(async () => !(await live(pid)), `pid ${pid} to end`);
/** Wait for a launch's end while the test itself holds the event loop. The product unrefs the owner on purpose (its end
 *  is a wake-up, never a held event loop), so a bare `await launched.exited` leaves Node with no live handle: the loop
 *  drains, the wait never settles, and the test runner cancels the test (Node 22: `cancelledByParent`, "Promise
 *  resolution is still pending but the event loop has already resolved"). The wait owns one bounded, ref'd timer for the
 *  length of the wait -- and always clears it, so nothing is held once the launch has ended. */
async function untilEnded(launched: { exited: Promise<void> }, ms = 60_000): Promise<void> {
  let bound: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    bound = setTimeout(() => { reject(new Error(`the launch did not end within ${ms} ms`)); }, ms);
  });
  try { await Promise.race([launched.exited, gaveUp]); } finally { clearTimeout(bound); }
}

/** A program that starts a detached grandchild beating into `beat`, records its pid and then keeps running itself. */
const treeProgram = (dir: string) => {
  const beatScript = join(dir, "beat.mjs");
  writeFileSync(beatScript, "import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync(process.argv[2], '.'), 50);\n");
  const program = join(dir, "tree.mjs");
  writeFileSync(program, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const beat = process.argv[2], pidFile = process.argv[3], beatScript = process.argv[4], exit = process.argv[5];",
    "const child = spawn(process.execPath, [beatScript, beat], { detached: true, stdio: 'ignore' });",
    "child.unref();",
    "writeFileSync(pidFile, String(child.pid));",
    "if (exit === 'now') process.exit(0);",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return { program, beatScript, beat: join(dir, "beat"), pidFile: join(dir, "grandchild.pid") };
};

test("the owner source is self-contained, ASCII, and carries the Win32 group contract", () => {
  // No separate file ships: the packaged module carries the whole owner source, compiled per launch.
  assert.ok(JOB_HOST_SOURCE.includes(JOB_HOST_MARKER));
  assert.match(JOB_HOST_SOURCE, /static int Main\(string\[\] args\)/);
  assert.match(JOB_HOST_SOURCE, /CreateJobObjectW/);
  assert.match(JOB_HOST_SOURCE, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(JOB_HOST_SOURCE, /CREATE_SUSPENDED/);
  assert.match(JOB_HOST_SOURCE, /AssignProcessToJobObject/);
  assert.match(JOB_HOST_SOURCE, /IsProcessInJob/);
  // argv[0] is the attempt directory and no path is written into the source; csc.exe reads a file without a byte order
  // mark in the ANSI code page, so only ASCII text is unambiguous.
  assert.ok(!JOB_HOST_SOURCE.includes("@@DIR@@"));
  assert.match(JOB_HOST_SOURCE, /^[\t\n\r\x20-\x7e]*$/, "the owner source is ASCII only");
  // Every evidence file the orchestrator reads is named by the owner itself (a rename here would break recovery).
  for (const name of [JOB_SPEC, JOB_BEGIN, JOB_GROUP, JOB_END, JOB_ERROR, JOB_STOP]) assert.ok(JOB_HOST_SOURCE.includes(`"${name}"`), name);
  // stdin is empty; two independent append-only handles mean one stream cannot overwrite the other.
  assert.match(JOB_HOST_SOURCE, /CreateFileW\("NUL"/);
  assert.match(JOB_HOST_SOURCE, /FILE_APPEND_DATA/);
  assert.ok(!/GENERIC_WRITE|SetFilePointerEx/.test(JOB_HOST_SOURCE), "no read/write handle seeking to the end");
  assert.equal(JOB_HOST_SOURCE.match(/startup\.StartupInfo\.hStd(Output|Error)/g)?.length, 2, "stdout and stderr have their own handle");
  assert.equal(JOB_HOST_SOURCE.match(/startup\.StartupInfo\.hStdInput/g)?.length, 1, "stdin is the empty NUL handle");
  // The wrapper inherits exactly the three standard handles (STARTUPINFOEX + a one-entry handle list), not every
  // inheritable handle the owner happens to hold: the list names all three, and inheritHandles stays true for it.
  assert.match(JOB_HOST_SOURCE, /struct STARTUPINFOEX/);
  assert.match(JOB_HOST_SOURCE, /ref STARTUPINFOEX startup/);
  assert.match(JOB_HOST_SOURCE, /EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(JOB_HOST_SOURCE, /CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT \| DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP \| EXTENDED_STARTUPINFO_PRESENT;/,
    "the creation carries the extended startup info");
  assert.match(JOB_HOST_SOURCE, /startup\.StartupInfo\.cb = Marshal\.SizeOf\(typeof\(STARTUPINFOEX\)\)/,
    "the extended structure's size, which is what the flag requires");
  assert.match(JOB_HOST_SOURCE, /startup\.lpAttributeList = list;/);
  assert.match(JOB_HOST_SOURCE, /InitializeProcThreadAttributeList/);
  assert.match(JOB_HOST_SOURCE, /UpdateProcThreadAttribute\(list, 0, new IntPtr\(PROC_THREAD_ATTRIBUTE_HANDLE_LIST\)/,
    "one attribute: the handle list");
  assert.match(JOB_HOST_SOURCE, /DeleteProcThreadAttributeList/);
  assert.equal(JOB_HOST_SOURCE.match(/Marshal\.WriteIntPtr\(inheritable/g)?.length, 3, "the list names the three handles");
  assert.match(JOB_HOST_SOURCE, /IntPtr\.Zero, IntPtr\.Zero, true, flags, block,/, "inheritHandles stays true, restricted by the list");
  // The owner's own copies of those handles are closed as soon as the kernel has passed them on: the log is not held
  // open by a program that only started the command, and the suspended child is not waited on with open stdio here.
  for (const name of ["input", "output", "errorHandle"]) {
    const at = JOB_HOST_SOURCE.indexOf(`CloseHandle(${name}); ${name} = IntPtr.Zero;`);
    assert.ok(at > JOB_HOST_SOURCE.indexOf("CreateProcessW(application"), `${name} is closed after the creation`);
    assert.ok(at < JOB_HOST_SOURCE.indexOf("AssignProcessToJobObject(job, child.hProcess)"),
      `${name} is closed before the child may run`);
    assert.ok(at < JOB_HOST_SOURCE.indexOf("WaitForSingleObject(child.hProcess"), `${name} is not held until the command ends`);
  }
  // A spec field with an embedded NUL is refused while the spec is decoded: no Win32 API ever sees a truncated path.
  assert.match(JOB_HOST_SOURCE, /IndexOf\(\(char\)0\) >= 0\) throw new FormatException/);
  assert.ok(JOB_HOST_SOURCE.indexOf("a job spec field contains a NUL character") < JOB_HOST_SOURCE.indexOf("job = CreateJobObjectW"),
    "the NUL check precedes anything Win32 is handed");
  // Every field is decoded to its exact UTF-16 code units: each byte pair becomes one char, so no decoder fallback can
  // replace an unpaired surrogate; a field that is not a whole number of code units is refused instead of truncated.
  assert.match(JOB_HOST_SOURCE, /char\[\] units = new char\[bytes\.Length \/ 2\];/);
  assert.match(JOB_HOST_SOURCE, /if \(units\.Length > 0\) Buffer\.BlockCopy\(bytes, 0, units, 0, bytes\.Length\);/);
  assert.ok(!/Encoding\.Unicode/.test(JOB_HOST_SOURCE), "no decoding fallback can replace a code unit");
  assert.match(JOB_HOST_SOURCE, /if \(\(bytes\.Length & 1\) != 0\) throw new FormatException\("a job spec field is not a whole number of UTF-16 code units"\);/);
  assert.ok(JOB_HOST_SOURCE.indexOf("bytes.Length & 1") < JOB_HOST_SOURCE.indexOf("a job spec field contains a NUL character"),
    "the field shape is refused before anything is read out of it");
  // The wrapper's status is the full DWORD; 125/126 stay this host's own "nothing ran" codes.
  assert.match(JOB_HOST_SOURCE, /bool Run\(.*out uint status\)/);
  assert.match(JOB_HOST_SOURCE, /unchecked\(\(int\)status\)/);
  assert.ok(!/status < 0 \? 125 : status/.test(JOB_HOST_SOURCE), "a status above 0x7fffffff is never re-read as a failure");
  assert.match(JOB_HOST_SOURCE, /status = code;/);
  assert.match(JOB_HOST_SOURCE, /static bool Fail\(/);
  // Inherited-stdio mode (empty logPath, used by `hold`) duplicates std handles and releases the owner's own copies.
  assert.match(JOB_HOST_SOURCE, /if \(String\.IsNullOrEmpty\(logPath\)\)/);
  assert.match(JOB_HOST_SOURCE, /DuplicateHandle\(current, raw, current, out handle, 0, true, DUPLICATE_SAME_ACCESS\)/);
  assert.match(JOB_HOST_SOURCE, /if \(String\.IsNullOrEmpty\(logPath\)\) ReleaseOwnStdHandles\(\);/);
  // Controlled stop polling: polls WaitForSingleObject(child.hProcess, 50) for `stop` on WAIT_TIMEOUT (258),
  // calls DrainJob(job), and skips writing `group-end` when stopped while preserving normal WAIT_OBJECT_0 exit.
  assert.match(JOB_HOST_SOURCE, /WAIT_OBJECT_0 = 0x00000000/);
  assert.match(JOB_HOST_SOURCE, /WAIT_TIMEOUT = 0x00000102/);
  assert.match(JOB_HOST_SOURCE, /WaitForSingleObject\(child\.hProcess, 50\)/);
  assert.ok(!/WaitForSingleObject\(child\.hProcess, INFINITE\)/.test(JOB_HOST_SOURCE), "wait loop polls for stop instead of blocking INFINITE");
  assert.match(JOB_HOST_SOURCE, /string stopPath = Path\.Combine\(dir, "stop"\);/);
  assert.match(JOB_HOST_SOURCE, /if \(File\.Exists\(stopPath\)\) \{ stopped = true; break; \}/);
  assert.match(JOB_HOST_SOURCE, /if \(!stopped\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*WriteAtomic\(Path\.Combine\(dir, "group-end"\)/);
  // Surviving grandchildren are terminated and drained to ActiveProcesses == 0 before group-end is recorded.
  const drainAt = JOB_HOST_SOURCE.indexOf("DrainJob(job);");
  assert.ok(drainAt > JOB_HOST_SOURCE.indexOf("GetExitCodeProcess(child.hProcess, out code)"));
  assert.ok(drainAt < JOB_HOST_SOURCE.indexOf('"group-end"'));
  assert.match(JOB_HOST_SOURCE, /TerminateJobObject\(job, 1\);/);
  assert.match(JOB_HOST_SOURCE, /info\.ActiveProcesses == 0/);
  // Atomic publication uses MoveFileExW(MOVEFILE_REPLACE_EXISTING) with bounded retries on Win32 sharing conflicts
  // (never deleting the target first or falling back to a direct target write), including for start-error.
  assert.match(JOB_HOST_SOURCE, /MoveFileExW\(temporary, path, MOVEFILE_REPLACE_EXISTING\)/);
  assert.ok(!/if \(File\.Exists\(path\)\) File\.Delete\(path\);/.test(JOB_HOST_SOURCE), "atomic replace never leaves a deleted-target window");
  assert.match(JOB_HOST_SOURCE, /ERROR_SHARING_VIOLATION/);
  assert.match(JOB_HOST_SOURCE, /ERROR_LOCK_VIOLATION/);
  assert.match(JOB_HOST_SOURCE, /WriteAtomic\(Path\.Combine\(dir, "start-error"\), text\)/);
  assert.deepEqual(jobHostArgv("C:\\attempt", "e1", "machine:2"), [
    "C:\\attempt",
    `DSA_EXEC=v1~${Buffer.from("e1", "utf8").toString("base64url")}`,
    `DSA_HOLD=v1~${Buffer.from("machine:2", "utf8").toString("base64url")}`,
  ]);
  // A run that never reached the program is distinguishable from one that failed inside it.
  assert.ok(JOB_HOST_SOURCE.indexOf(JOB_BEGIN) < JOB_HOST_SOURCE.indexOf("job = CreateJobObjectW"), "the begin record precedes any group");
  // No PowerShell anywhere in the launch path (the reason the previous helper could not start detached).
  assert.ok(!/Add-Type|ConvertFrom-Json|PSScriptRoot|PowerShell/i.test(JOB_HOST_SOURCE));
  // A fresh private directory per launch: a previously compiled executable can never be reused, even in one attempt dir.
  const dir = "C:\\attempt";
  const first = jobHostPaths(dir), second = jobHostPaths(dir);
  assert.notEqual(first.dir, second.dir, "each launch gets its own owner directory");
  assert.ok(first.dir.startsWith(join(dir, JOB_HOST_PREFIX)));
  assert.equal(first.exe, join(first.dir, JOB_HOST_EXE));
});

test("the framework compiler is resolved from verified absolute paths", () => {
  const env = { SystemRoot: "C:\\Windows" };
  const candidate = (framework: string) => join("C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
  for (const arch of ["x64", "arm64"]) assert.deepEqual(frameworkCompilerCandidates(env, arch),
    [candidate("Framework64"), candidate("Framework")], `${arch} prefers the 64-bit framework, with x86 as fallback`);
  assert.deepEqual(frameworkCompilerCandidates(env, "ia32"), [candidate("Framework"), candidate("Framework64")],
    "an ia32 host prefers the 32-bit framework");
  // The first candidate that exists is chosen; nothing is run, and no PATH entry is ever consulted.
  assert.equal(frameworkCompiler(env, "x64", path => path === candidate("Framework")), candidate("Framework"));
  assert.throws(() => frameworkCompiler(env, "x64", () => false),
    /is unavailable \(searched .*Framework64.*Framework/, "a missing compiler is fail-closed");
});

test("the spec is ASCII base64 fields that decode back to the same strings, with the environment as one ordered list", () => {
  // The environment of an attempt: Windows names are case-insensitive, so `Path` and `PATH` are one variable.
  assert.deepEqual(jobEnv({ b: "2", A: "1", a: "first", c: undefined, "": "x", "d=e": "y", f: "" }), ["b=2", "A=1", "f="]);
  const env = { PATH: "C:\\bin", ünïcode: "curly ’quoted’ \"and\" \\ back", EMPTY: "" };
  const launch = { exe: "C:\\Program Files\\node.exe", args: ["a b", 'quo"te', "trail\\", "line\nbreak", "ünïcode ’x’", "\u{1f600}", "\uD800"],
    cwd: "C:\\work ’dir’ ü", log: "C:\\work ’dir’ ü\\output.log", env };
  const text = jobSpecText(launch);
  // A file that is ASCII cannot be misread: no code page, no byte order mark, no BOM check can change these bytes.
  assert.match(text, /^[\x20-\x7e\n]*$/, "the spec is ASCII only");
  assert.deepEqual(decodeSpec(text), { exe: launch.exe, cwd: launch.cwd, log: launch.log, args: launch.args, env: jobEnv(env) });
  // UTF-16LE carries every JS string, an emoji and an unpaired surrogate included.
  assert.equal(decodeSpec(jobSpecText({ ...launch, args: ["\uD800\u0000\u001f\u007f\u0080"] })).args[0], "\uD800\u0000\u001f\u007f\u0080");
  assert.equal(JSON.parse(asciiJson("\u0000\u001f\u007f\u0080")), "\u0000\u001f\u007f\u0080");
  assert.throws(() => asciiJson(Number.NaN), /not JSON/);
});

test("a failure reason is one bounded line and never a credential", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // Nothing left behind: nothing to say (the caller's own message stands).
  assert.equal(await startError(dir), "");
  await writeFile(join(dir, JOB_ERROR), "CreateProcess C:\\a\\b.exe failed (error 2)");
  await writeFile(join(dir, JOB_HOST_EXIT), asciiJson({ code: 125, signal: null }));
  await writeFile(join(dir, JOB_BEGIN), "begin");
  const reason = await startError(dir);
  assert.match(reason, /^: /);
  assert.match(reason, /CreateProcess/);
  assert.match(reason, /exited with code 125/);
  assert.ok(!reason.includes("before it reported starting"), "the owner did run");
  // An error record is quoted from its beginning (a message), an owner log from its end (the newest lines); both bounded.
  await rm(join(dir, JOB_ERROR), { force: true });
  await writeFile(join(dir, JOB_HOST_LOG), `${"B".repeat(4000)}\nlog-head-marker\n${"C".repeat(4000)}\nlog-tail-marker\n`);
  const fromLog = await startError(dir);
  assert.match(fromLog, /log-tail-marker/);
  assert.ok(!fromLog.includes("log-head-marker"), "a log contributes its newest lines, not its beginning");
  await writeFile(join(dir, JOB_ERROR), `start-error-marker\n${"C".repeat(4000)}\ntrailer-marker`);
  const bounded = await startError(dir);
  assert.match(bounded, /start-error-marker/);
  assert.ok(!bounded.includes("trailer-marker"), "a message is quoted from its start");
  assert.match(bounded, /exited with code 125/);
  assert.ok(bounded.length <= 302, `bounded reason, got ${bounded.length} characters`);
  // A credential the owner may have quoted back: the value of a secret-looking variable never leaves this process.
  await writeFile(join(dir, JOB_ERROR), [
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG secret",
    "PASSWORD: \"hunter2\"",
    "https://user:s3cr3t@example.test/path failed",
    "Authorization=Bearer abc.def.ghi",
  ].join("\n"));
  const redacted = await startError(dir);
  for (const secret of ["wJalrXUtnFEMI", "hunter2", "s3cr3t", "abc.def.ghi"]) assert.ok(!redacted.includes(secret), `leaked ${secret}`);
  assert.match(redacted, /AWS_SECRET_ACCESS_KEY=<redacted>/);
  assert.match(redacted, /https:\/\/<redacted>@example\.test\/path/);
  // An owner that never ran its program (nothing was recorded as begun) is distinguishable from one that failed inside
  // it, and a run that did begin never gets the misleading wording.
  const quiet = dirOf(); t.after(() => rm(quiet, { recursive: true, force: true }));
  await writeFile(join(quiet, JOB_HOST_EXIT), asciiJson({ code: 0, signal: null }));
  const silent = await startError(quiet);
  assert.match(silent, /exited with code 0 before it reported starting/);
  assert.ok(!silent.includes("PowerShell"), "no PowerShell in the launch path any more");
});

test("a test that awaits an unref'd launch holds the event loop itself, and its wait is bounded", async () => {
  // The owner is deliberately unref'd (see the module comment in job.ts): with nothing else ref'd, Node drains the loop
  // before the owner's exit event arrives and the awaiting test is cancelled -- the failure this file hit on Node 22
  // (`cancelledByParent`, "Promise resolution is still pending but the event loop has already resolved"). This is that
  // same wait, with a detached unref'd child and an exit promise nothing else holds: the wait's own ref'd timer is the
  // only thing keeping the test alive until the exit event arrives.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 250)"], { detached: true, stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>(resolve => { child.once("exit", () => { resolve(); }); });
  child.unref();
  const started = Date.now();
  await untilEnded({ exited });
  assert.ok(Date.now() - started >= 200, "the wait ended with the child, not with a drained event loop");
  // Bounded: a launch that never ends fails the wait with its own message instead of holding the file's whole timeout,
  // and the timer is cleared so nothing outlives the wait (a leaked timer would hold the event loop after the test).
  await assert.rejects(untilEnded({ exited: new Promise<void>(() => {}) }, 60), /the launch did not end within 60 ms/);
});

test("a job group runs a program with its argv, its output and its exit status", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "args.mjs");
  // The program outlives the observation by a moment: its identity is read from the process table right after the
  // group record, and a program that ends first has no row (the group record still proves it started).
  writeFileSync(program, "console.log(JSON.stringify(process.argv.slice(2))); setTimeout(() => process.exit(4), 600);\n");
  // Windows quoting: spaces, an embedded quote, trailing and inner backslashes, a newline, non-ASCII, a curly quote.
  const argv = ["a b", 'quo"te', "trail\\", "back\\slash", "line\nbreak", "\u00fc\u00f1\u00ee", "\u2019quoted\u2019"];
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, ...argv], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  assert.ok(launched.pid > 0);
  // The group record is the suspended wrapper's pid, written before it may run.
  const group = JSON.parse(readFileSync(join(dir, JOB_GROUP), "utf8")) as { pid?: number };
  assert.equal(group.pid, launched.pid);
  if (launched.group) {
    assert.ok(launched.group.pid > 0 && launched.group.start);
    assert.ok(launched.group.pid !== launched.pid, "the owner is not the wrapper");
    assert.ok(launched.start, "a wrapper that is still running has an observed identity");
  }
  await untilEnded(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 4);
  assert.equal(readFileSync(join(dir, "output.log"), "utf8").trim(), JSON.stringify(argv));
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no failure was recorded");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "the owner consumed the job spec");
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the owner ran");
  // The launch kept its private directory: the compiled owner and its inert source, never a shared executable.
  const hosts = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
  assert.equal(hosts.length, 1, "one compiled owner for one launch");
  assert.ok(existsSync(join(dir, hosts[0]!, JOB_HOST_EXE)), "the owner executable is kept");
  assert.ok(existsSync(join(dir, hosts[0]!, "DsaJob.cs")), "and its source");
  assert.match(readFileSync(join(dir, JOB_HOST_EXIT), "utf8"), /"code":4/, "the owner's own exit is its wrapper's");
  await gone(launched.pid);
});

test("a program's stdout and stderr both land in one log, neither overwriting the other", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "both.mjs");
  writeFileSync(program, [
    "for (let at = 0; at < 40; at += 1) {",
    "  (at % 2 ? console.error : console.log)(`line-${at}`);",
    "}",
    "setTimeout(() => process.exit(0), 200);",
  ].join("\n"));
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  await untilEnded(launched);
  const log = readFileSync(join(dir, "output.log"), "utf8");
  const lines = log.trimEnd().split(/\r?\n/).sort();
  const expected = Array.from({ length: 40 }, (_, at) => `line-${at}`).sort();
  assert.deepEqual(lines, expected);
});

test("a Unicode and curly-quoted attempt directory, argv, cwd and environment arrive unchanged", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const parent = dirOf(); t.after(() => rm(parent, { recursive: true, force: true }));
  // The directory travels as argv[0] and the paths and strings inside it as UTF-16LE spec fields: no script is written
  // with the path in it and no ANSI-decoded file carries it.
  const dir = join(parent, "attempt \u2019\u00fc\u00f1 \u201cjob\u201d");
  mkdirSync(dir);
  const program = join(dir, "echo.mjs");
  writeFileSync(program, "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.DSA_UNICODE }));\n");
  const argv = ["\u2019curly\u2019", "\u00e9\u00e8\u00ea", "C:\\temp\u2019s\\dir"];
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, ...argv], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env, DSA_UNICODE: "v\u00e4l\u00fce \u2019x\u2019" } });
  assert.ok(launched);
  await untilEnded(launched);
  const seen = JSON.parse(readFileSync(join(dir, "output.log"), "utf8").trim()) as { argv: string[]; cwd: string; env: string };
  assert.deepEqual(seen.argv, argv);
  assert.equal(seen.cwd, dir);
  assert.equal(seen.env, "v\u00e4l\u00fce \u2019x\u2019");
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
});

test("a spec field with an embedded NUL is refused before Win32 sees it", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // The owner decodes every field before it hands anything to Win32: a NUL would end a path or an environment value
  // there and the attempt would quietly run a different program with a shorter argument. It refuses the spec instead.
  const reason = await spawnInJob(dir, { exe: process.execPath, args: ["-e", "0"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env, DSA_NUL: "before\u0000after" } })
    .then(() => "", (error: Error) => error.message);
  assert.match(reason, /job spec/);
  assert.match(reason, /NUL/);
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the owner ran and refused the spec itself");
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was created");
  assert.ok(!existsSync(join(dir, JOB_END)), "no wrapper ran");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /FormatException: a job spec field contains a NUL character/);
  assert.match(readFileSync(join(dir, JOB_HOST_EXIT), "utf8"), /"code":125/, "a refused spec exits 125, the host's own code");
});

test("a spec field that is not a whole number of UTF-16 code units is refused before Win32 sees it", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await compileJobHost(dir);
  // jobSpecText writes one UTF-16 code unit per two bytes. A line that decodes to an odd number of bytes is not a string
  // any Win32 API could receive, and a decoder that kept the even prefix would truncate the field without saying so: the
  // owner refuses the spec instead, before it creates anything.
  const lines = jobSpecText({ exe: process.execPath, args: ["-e", "0"], cwd: dir, log: join(dir, "output.log"),
    env: { ...process.env } }).trimEnd().split("\n");
  lines[3] = Buffer.from([0x41, 0x00, 0x42]).toString("base64"); // the log field: one code unit and a half
  await writeFile(join(dir, JOB_SPEC), `${lines.join("\n")}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const run = spawn(host.exe, jobHostArgv(dir), { stdio: "ignore", windowsHide: true });
    run.once("exit", resolve);
    run.once("error", reject);
  });
  assert.equal(code, 125, "a refused spec is the host's own code, not a wrapper status");
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the owner ran and refused the spec itself");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /FormatException: a job spec field is not a whole number of UTF-16 code units/);
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was created");
  assert.ok(!existsSync(join(dir, JOB_END)), "no wrapper ran");
});

test("a spec field keeps an unpaired surrogate: the owner creates the path the code unit names", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "quiet.mjs");
  writeFileSync(program, "process.exit(0);\n");
  // A lone surrogate cannot be spelled through a Node path (UTF-8 has no code unit for it), so the check is which file
  // the owner created for the log: the exact code unit, or the replacement a decoding fallback writes. existsSync spells
  // the replacement, so it must find nothing although the log exists -- otherwise the surrogate was not preserved.
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir, log: join(dir, "out-\ud800.log"),
    env: { ...process.env } });
  assert.ok(launched, "a path with an unpaired surrogate is one Win32 accepts");
  await untilEnded(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0, "the wrapper ran and ended");
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "nothing failed in this host");
  assert.ok(!existsSync(join(dir, "out-\ufffd.log")), "the name on disk is the exact code unit, not its replacement");
});

test("a wrapper status above 0x7fffffff stays the wrapper's status", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "wide.mjs");
  const status = 0xC0000005; // the whole DWORD, negative as a signed int
  writeFileSync(program, `process.exit(${status});\n`);
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched, "the wrapper started, so this is not a host failure");
  await untilEnded(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, status, "the record carries the whole DWORD");
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "nothing failed in this host");
  // The owner's own exit is the same DWORD: 125 would mean this host's failure and would be indistinguishable from it.
  // Exit evidence is normalized like every recorded status (Node may report the same status as a signed int32).
  const code = (JSON.parse(readFileSync(join(dir, JOB_HOST_EXIT), "utf8")) as { code: number }).code;
  assert.equal(code, status, `the owner exits with the wrapper's status, got ${code}`);
});

test("a program is in the group before it may act, and the group's crash takes its descendants with it", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // The program's first statement detaches a grandchild that keeps beating. If the wrapper ran before it was assigned to
  // the group, that grandchild was created outside it and would survive the group.
  const { program, beatScript, beat, pidFile } = treeProgram(dir);
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, beat, pidFile, beatScript, "keep"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  const grandchild = Number(await until(() => existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined, "the grandchild pid"));
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.ok(await live(grandchild), "the grandchild runs inside the group");
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat");
  // An owner crash is not a clean end: it closes the group's only handle. BOTH processes of the group must end, or a
  // second attempt could start while the first command's descendants still act.
  assert.ok(launched.group, "the owner is still running");
  process.kill(launched.group!.pid, "SIGKILL");
  await gone(grandchild);
  await gone(launched.pid);
  const size = readFileSync(beat, "utf8").length;
  await delay(400);
  assert.equal(readFileSync(beat, "utf8").length, size, "the grandchild stops acting");
});

test("the wrapper's own death takes its descendants with it", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const { program, beatScript, beat, pidFile } = treeProgram(dir);
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, beat, pidFile, beatScript, "keep"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  const grandchild = Number(await until(() => existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined, "the grandchild pid"));
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat");
  // The wrapper dies for real (a killed process, not a clean exit): its group's handle must still close, taking the
  // detached grandchild with it -- otherwise the next attempt starts beside surviving processes of this one.
  process.kill(launched.pid, "SIGKILL");
  await gone(grandchild);
  await untilEnded(launched);
  const size = readFileSync(beat, "utf8").length;
  await delay(400);
  assert.equal(readFileSync(beat, "utf8").length, size, "the grandchild stops acting");
  assert.equal(typeof JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, "number", "the group recorded its end");
});

test("a normal end closes the group too: a descendant left behind does not outlive the wrapper", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const { program, beatScript, beat, pidFile } = treeProgram(dir);
  // The wrapper exits 0 while the grandchild it detached is still beating: the attempt is over, so nothing of it may run.
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, beat, pidFile, beatScript, "now"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  const grandchild = Number(await until(() => existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined, "the grandchild pid"));
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat").catch(() => undefined);
  await untilEnded(launched);
  await gone(grandchild);
  await gone(launched.pid);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
  const size = existsSync(beat) ? readFileSync(beat, "utf8").length : 0;
  await delay(400);
  assert.equal(existsSync(beat) ? readFileSync(beat, "utf8").length : 0, size, "the grandchild stops acting");
});

test("a launched command outlives the process that started it and records its exit", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(), cwd = join(dir, "work"); t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(cwd);
  const attempt = join(dir, "command-1");
  // A starter that IS the orchestrator of the attempt: it spawns the command through the real launcher and exits at once.
  const starter = join(dir, "starter.mjs");
  writeFileSync(starter, [
    `const { spawnCommand } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "src", "platform", "command.ts")).href)});`,
    "const [cwd, dir, exec] = process.argv.slice(2);",
    "const spawned = await spawnCommand({ command: [process.execPath, '-e', \"setTimeout(() => console.log('finished'), 700)\"], cwd, dir, env: process.env, exec });",
    "console.log(JSON.stringify({ pid: spawned.pid, group: spawned.group ?? null }));",
    "process.exit(0);",
  ].join("\n"));
  const run = spawn(process.execPath, [starter, cwd, attempt, "command:job#adopt"], { stdio: ["ignore", "pipe", "inherit"] });
  const reported = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("the starter printed nothing")), 60_000);
    run.stdout!.on("data", chunk => { text += chunk; });
    run.once("exit", () => { clearTimeout(timer); resolve(text.trim()); });
  });
  // The starter exits at once: a command that ends within the same moment has already gone unobserved, so its group (a
  // report, not a requirement) may be absent. What must hold is that the command itself ran to its end without us: the
  // compiled owner holds the group, not the starter, so its death neither ends the command nor puts it in libuv's
  // kill-with-parent job.
  const ids = JSON.parse(reported) as { pid: number; group: { pid: number; start: string } | null };
  assert.ok(ids.pid > 0);
  if (ids.group) {
    assert.ok(ids.group.pid > 0 && ids.group.start);
    assert.ok(await live(ids.group.pid), "the owner outlives the starter that compiled and spawned it");
  }
  await until(() => existsSync(join(attempt, "exit")), "the exit record of the detached command", 60_000);
  assert.equal(readFileSync(join(attempt, "exit"), "utf8").trim(), "0");
  assert.match(readFileSync(join(attempt, "output.log"), "utf8"), /finished/);
  assert.ok(!(await live(ids.pid)), "the wrapper ended with the command");
  if (ids.group) assert.ok(!(await live(ids.group.pid)), "the group's owner ended with the command");
  assert.equal(readdirSync(attempt).filter(name => name.startsWith(JOB_HOST_PREFIX)).length, 1, "the starter compiled one owner");
});

test("a group that cannot be created fails closed: no process, no attempt, a recorded reason", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const reason = await spawnInJob(dir, { exe: join(dir, "no-such-program.exe"), args: [], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } }).then(() => "", (error: Error) => error.message);
  // The rejection names what went wrong: the owner's record, or -- when it wrote nothing -- why its process ended.
  assert.match(reason, /CreateProcess/);
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was recorded");
  assert.ok(!existsSync(join(dir, "exit")), "nothing ran");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /CreateProcess/);
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the owner ran");
  assert.match(readFileSync(join(dir, JOB_HOST_EXIT), "utf8"), /"code":125/, "a failure the owner recorded exits 125");
});

test("the start is refused after the compilation, immediately before the spawn", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  let gates = 0, compiledAtGate = false;
  const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } }, {
    // The executor's last check: by the time it runs, the owner must already be compiled (the compilation is foreground)
    // and no attempt process may exist yet.
    proceed: () => {
      gates += 1;
      const hosts = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
      compiledAtGate = hosts.length === 1 && existsSync(join(dir, hosts[0]!, JOB_HOST_EXE));
      return false;
    },
  });
  assert.equal(launched, undefined, "a refused start resolves undefined");
  assert.equal(gates, 1, "the gate is called once, after the compilation");
  assert.ok(compiledAtGate, "the compilation had finished when the gate ran");
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was created");
  assert.ok(!existsSync(join(dir, JOB_END)), "no wrapper ran");
  assert.ok(!existsSync(join(dir, JOB_HOST_EXIT)), "no owner was spawned");
  assert.ok(!existsSync(join(dir, "output.log")), "the command produced no output");
});

test("a missing compiler fails the start closed: no group, no process, a recorded reason", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const reason = await spawnInJob(dir, { exe: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } }, { compiler: join(dir, "no-such-csc.exe") })
    .then(() => "", (error: Error) => error.message);
  assert.match(reason, /compiler/);
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was created");
  assert.ok(!existsSync(join(dir, JOB_END)), "no wrapper ran");
  assert.ok(!existsSync(join(dir, "output.log")), "no command was started");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /compiler/, "the failure is recorded with the attempt");
});

test("two launches in one directory never share a compiled owner", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "twice.mjs");
  writeFileSync(program, "console.log('run'); process.exit(0);\n");
  for (const n of [1, 2]) {
    const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
      log: join(dir, `output-${n}.log`), env: { ...process.env } });
    assert.ok(launched);
    await untilEnded(launched);
    assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
    assert.match(readFileSync(join(dir, `output-${n}.log`), "utf8"), /run/);
  }
  // A stale executable can never be picked up: every launch compiles into its own new directory.
  const hosts = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
  assert.equal(hosts.length, 2, "a fresh owner directory per launch");
  for (const host of hosts) assert.ok(existsSync(join(dir, host, JOB_HOST_EXE)));
});

/** A compiler stand-in: a script the compiler slot runs with csc.exe's own arguments, so a compilation can be staged,
 *  cancelled or made to fail without a .NET Framework (it runs with the launch directory as its working directory). */
async function stubCompiler(dir: string, body: string): Promise<string> {
  const path = join(dir, `csc-${randomBytes(4).toString("hex")}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
const launchFor = (dir: string) => ({ exe: "/bin/sh", args: ["-c", "exit 0"], cwd: dir, log: join(dir, "output.log"),
  env: { PATH: "/bin:/usr/bin" } });
/** A pid that is gone (POSIX: the compiler stand-in ended). */
async function ended(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

test("the owner is staged before any start: compiled, spec written, nothing started -- and released on request", { skip: posixOnly, timeout: 60_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const compiler = await stubCompiler(dir, 'import { writeFileSync } from "node:fs"; writeFileSync("DsaJob.build.exe", "MZ");');
  const staging = await prepareJob(dir, launchFor(dir), { compiler });
  // The preparation leaves exactly what a start needs: the compiled owner under its final name, its inert source, the spec.
  assert.ok(existsSync(staging.host.exe), "the owner is compiled");
  assert.equal(readFileSync(staging.host.exe, "utf8"), "MZ", "the compiler's output is published under the final name");
  assert.ok(!existsSync(join(staging.host.dir, "DsaJob.build.exe")), "the build file is renamed onto the final name");
  assert.ok(existsSync(staging.host.source));
  assert.match(readFileSync(join(dir, JOB_SPEC), "utf8"), new RegExp(`^${JOB_SPEC_HEADER}\n`));
  // And nothing that could act: no group, no owner process, no command output, no reason (nothing failed).
  for (const name of [JOB_GROUP, JOB_END, JOB_BEGIN, JOB_STOP, JOB_HOST_EXIT, JOB_ERROR, "output.log"]) assert.ok(!existsSync(join(dir, name)), `no ${name}`);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX)), [staging.host.dir.slice(dir.length + 1)]);
  await staging.release();
  assert.ok(!existsSync(staging.host.dir), "release removes the compiled owner");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "release removes the spec (it carries the attempt's environment)");
  await staging.release(); // idempotent: releasing twice cannot fail a start that never happened
});

test("a cancelled preparation ends the compiler, removes what it wrote and records nothing", { skip: posixOnly, timeout: 60_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "csc.pid");
  const compiler = await stubCompiler(dir, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const staging = prepareJob(dir, launchFor(dir), { compiler, signal: controller.signal });
  await until(() => existsSync(pidFile), "the compiler to run");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(!(await ended(pid)), "the compiler is running");
  controller.abort();
  const error = await staging.then(() => undefined, (reason: unknown) => reason);
  // A cancellation is not a failure of the attempt: it is distinguishable, nothing is recorded and nothing stays.
  assert.ok(prepareCancelled(error), `a cancelled preparation, not a failure: ${String(error)}`);
  await until(async () => ended(pid), "the compiler to end");
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no reason is recorded for a cancellation");
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX)), [], "what it wrote is removed");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "no spec is left for an attempt that did not start");
});

test("an already cancelled preparation never runs the compiler and is not a compiler failure", { timeout: 30_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  // The compiler does not exist: if the cancellation were not honoured first, this would be a fail-closed compiler error.
  const error = await prepareJob(dir, launchFor(dir), { compiler: join(dir, "no-such-csc.exe"), signal: controller.signal })
    .then(() => undefined, (reason: unknown) => reason);
  assert.ok(prepareCancelled(error), `a cancellation, not a compiler error: ${String(error)}`);
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no reason is recorded");
  assert.deepEqual(readdirSync(dir), [], "nothing was created");
});

test("a compiler that fails is fail-closed and keeps its own words", { skip: posixOnly, timeout: 60_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = join(dir, "quiet");
  await mkdirSync(budget, { recursive: true });
  const compiler = await stubCompiler(budget, 'process.stderr.write("error CS0518: boom\\n"); process.exit(1);');
  const error = await prepareJob(dir, launchFor(dir), { compiler }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(!prepareCancelled(error), "a compiler failure is not a cancellation");
  assert.match((error as Error).message, /compiler .* failed \(exit 1\): error CS0518: boom/, "the compiler's own words travel");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /boom/, "the failure travels with the attempt");
  // A compiler that reports success without writing the executable is a failure, never a reason to look elsewhere.
  const silent = await stubCompiler(budget, "process.exit(0);");
  const nothing = await prepareJob(dir, launchFor(dir), { compiler: silent }).then(() => undefined, (reason: unknown) => reason);
  assert.match((nothing as Error).message, /wrote no executable/);
});

test("publishing the compiler's output retries a transient rename and keeps the real reason when it stays failed", async () => {
  const busy = () => Object.assign(new Error("EBUSY: resource busy or locked, rename 'DsaJob.build.exe' -> 'DsaJob.exe'"), { code: "EBUSY" });
  let attempts = 0;
  await publishBuild("DsaJob.build.exe", "DsaJob.exe", { retryMs: 5, timeoutMs: 5_000,
    renameFile: async () => { attempts += 1; if (attempts < 3) throw busy(); } });
  assert.equal(attempts, 3, "a scanner holding the fresh file for a moment is retried, not reported");
  // Past the budget the actual reason is reported: a blocked rename is not a compiler that wrote nothing.
  const denial = () => Object.assign(new Error("EPERM: operation not permitted, rename 'DsaJob.build.exe' -> 'DsaJob.exe'"), { code: "EPERM" });
  await assert.rejects(publishBuild("DsaJob.build.exe", "DsaJob.exe", { retryMs: 5, timeoutMs: 30, renameFile: async () => { throw denial(); } }),
    (error: Error) => {
      assert.match(error.message, /could not be published as DsaJob\.exe/);
      assert.match(error.message, /EPERM: operation not permitted/, "the real cause is kept");
      assert.ok(!/wrote no executable/.test(error.message), "a held file is not a compiler that wrote nothing");
      return true;
    });
  // A failure no retry can fix is reported at once, with its reason.
  let calls = 0;
  await assert.rejects(publishBuild("DsaJob.build.exe", "DsaJob.exe", { retryMs: 5, timeoutMs: 5_000,
    renameFile: async () => { calls += 1; throw Object.assign(new Error("EXDEV: improper link, rename"), { code: "EXDEV" }); } }), /EXDEV/);
  assert.equal(calls, 1, "a failure that no retry can fix is not retried");
  // Only a build file that is genuinely absent reads as "wrote no executable".
  await assert.rejects(publishBuild("DsaJob.build.exe", "DsaJob.exe",
    { renameFile: async () => { throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" }); } }), /wrote no executable/);
});

// A cancelled publication is a different outcome from a publication that failed: the caller removes what the compiler
// wrote and records nothing, so a stop or a suspension cannot seal an attempt as failed for a rename it no longer needs.
test("a cancelled publication wakes the retry at once and is never reported as a publish failure", async () => {
  const controller = new AbortController(), busy = () => Object.assign(new Error("EBUSY: resource busy or locked, rename 'DsaJob.build.exe' -> 'DsaJob.exe'"), { code: "EBUSY" });
  let attempts = 0;
  const started = Date.now();
  const publishing = publishBuild("DsaJob.build.exe", "DsaJob.exe", { retryMs: 5_000, timeoutMs: 60_000, signal: controller.signal,
    renameFile: async () => { attempts += 1; setTimeout(() => controller.abort(), 10); throw busy(); } });
  const error = await publishing.then(() => undefined, (reason: unknown) => reason);
  const elapsed = Date.now() - started;
  assert.ok(prepareCancelled(error), `a cancellation, not a publish failure: ${String(error)}`);
  assert.equal((error as Error).name, "JobPrepareCancelled");
  assert.equal(attempts, 1, "the retry delay is not waited out");
  assert.doesNotMatch(String((error as Error).message), /could not be published/);
  assert.ok(elapsed < 2_000, `the retry wait is woken by the abort (${elapsed} ms against a ${5_000} ms retry delay)`);
  // A publication that was already cancelled when it started never renames at all.
  const done = new AbortController(); done.abort();
  let renamed = 0;
  const early = await publishBuild("DsaJob.build.exe", "DsaJob.exe", { signal: done.signal,
    renameFile: async () => { renamed += 1; } }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(prepareCancelled(early), `a cancellation, not a success: ${String(early)}`);
  assert.equal(renamed, 0, "nothing is published for a start that was already cancelled");
  // A rename that succeeds does not make a cancellation that arrived meanwhile a success: nothing may follow it.
  const late = new AbortController();
  const after = await publishBuild("DsaJob.build.exe", "DsaJob.exe", { signal: late.signal,
    renameFile: async () => { late.abort(); } }).then(() => undefined, (reason: unknown) => reason);
  assert.ok(prepareCancelled(after), `a cancellation that raced the rename, not a success: ${String(after)}`);
  // The distinction holds the other way too: a real publish failure is reported with its reason, never as a cancellation.
  const failed = await publishBuild("DsaJob.build.exe", "DsaJob.exe", { retryMs: 5, timeoutMs: 30, signal: new AbortController().signal,
    renameFile: async () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); } })
    .then(() => undefined, (reason: unknown) => reason);
  assert.ok(!prepareCancelled(failed), `a publish failure, not a cancellation: ${String(failed)}`);
  assert.match((failed as Error).message, /could not be published as DsaJob\.exe.*EPERM/);
});

test("a cancellation while the compiler's output is published records nothing and removes what it wrote", { skip: posixOnly, timeout: 60_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const compiler = await stubCompiler(dir, 'import { writeFileSync } from "node:fs"; writeFileSync("DsaJob.build.exe", "MZ");');
  const controller = new AbortController();
  let entered!: () => void; const publishing = new Promise<void>(resolve => { entered = resolve; });
  // The publication the compiler's success leads to: it holds the fresh file (the renamer is busy) until it is cancelled.
  const publish: PublishBuild = (_build, _exe, options) => new Promise<void>((_resolve, reject) => {
    entered();
    if (options?.signal?.aborted) return reject(new JobPrepareCancelled());
    options?.signal?.addEventListener("abort", () => reject(new JobPrepareCancelled()), { once: true });
  });
  const staging = prepareJob(dir, launchFor(dir), { compiler, publish, signal: controller.signal });
  await publishing;
  const written = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
  assert.equal(written.length, 1, "the compiler wrote its output while the publication was in flight");
  controller.abort();
  const error = await staging.then(() => undefined, (reason: unknown) => reason);
  assert.ok(prepareCancelled(error), `a cancellation, not a publish failure: ${String(error)}`);
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no reason is recorded for a cancellation");
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX)), [], "what it wrote is removed");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "no spec is left for an attempt that did not start");
});

test("a staged owner is the one the start runs, and the start checks the gate with it already compiled", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "staged.mjs");
  writeFileSync(program, "console.log('staged'); setImmediate(() => process.exit(0));\n");
  const launch = { exe: process.execPath, args: [program], cwd: dir, log: join(dir, "output.log"), env: { ...process.env } };
  const staging = await prepareJob(dir, launch);
  assert.ok(existsSync(staging.host.exe), "the owner is compiled before anything starts");
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "nothing of the attempt exists yet");
  let gateSaw = "";
  const launched = await spawnInJob(dir, launch, { prepared: staging, proceed: () => {
    gateSaw = readFileSync(join(dir, JOB_SPEC), "utf8").slice(0, JOB_SPEC_HEADER.length);
    return true;
  } });
  assert.ok(launched);
  assert.equal(gateSaw, JOB_SPEC_HEADER, "the gate runs with the spec written and the owner compiled");
  await untilEnded(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
  assert.match(readFileSync(join(dir, "output.log"), "utf8"), /staged/);
  assert.equal(readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX)).length, 1, "the staged owner was used, not a second one");
});

test("job record readers retry Windows transient sharing conflicts and fail closed on absence or persistent locks", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const err = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

  // readGroupEndSync recovers across transient EACCES/EBUSY/EPERM, returns undefined immediately on ENOENT, and fails
  // closed on persistent conflicts or malformed JSON.
  {
    const codes = ["EACCES", "EBUSY", "EPERM"];
    let calls = 0;
    const end = readGroupEndSync(dir, {
      platform: "win32",
      baseDelayMs: 1,
      sleepSync: () => {},
      readFile: () => {
        calls += 1;
        const code = codes.shift();
        if (code) throw err(code);
        return '{"status":3221225477}';
      },
    });
    assert.deepEqual(end, { status: 0xC0000005 });
    assert.equal(calls, 4);

    let enoentCalls = 0;
    assert.equal(readGroupEndSync(dir, {
      platform: "win32",
      sleepSync: () => { throw new Error("must not sleep on ENOENT"); },
      readFile: () => { enoentCalls += 1; throw err("ENOENT"); },
    }), undefined);
    assert.equal(enoentCalls, 1);

    let busyCalls = 0;
    assert.equal(readGroupEndSync(dir, {
      platform: "win32",
      maxAttempts: 3,
      baseDelayMs: 1,
      sleepSync: () => {},
      readFile: () => { busyCalls += 1; throw err("EBUSY"); },
    }), undefined);
    assert.equal(busyCalls, 3);

    assert.equal(readGroupEndSync(dir, { platform: "win32", readFile: () => '{"status":' }), undefined, "partial JSON fails closed");
  }

  // readGroupRecord, readBeginIdentity and readStartErrorSync recover from transient sharing errors.
  {
    const groupErrs = ["EBUSY", "EPERM"];
    let groupCalls = 0;
    assert.deepEqual(await readGroupRecord(dir, {
      platform: "win32",
      baseDelayMs: 1,
      sleep: async () => {},
      readFile: async () => {
        groupCalls += 1;
        const code = groupErrs.shift();
        if (code) throw err(code);
        return JSON.stringify({ pid: 42, start: "639000000000000020" });
      },
    }), { pid: 42, start: "639000000000000020" });
    assert.equal(groupCalls, 3);

    const beginErrs = ["EACCES"];
    assert.deepEqual(await readBeginIdentity(dir, {
      platform: "win32",
      baseDelayMs: 1,
      sleep: async () => {},
      readFile: async () => {
        const code = beginErrs.shift();
        if (code) throw err(code);
        return JSON.stringify({ pid: 41, start: "639000000000000010" });
      },
    }), { pid: 41, start: "639000000000000010" });

    const errCodes = ["EBUSY"];
    assert.equal(readStartErrorSync(dir, {
      platform: "win32",
      baseDelayMs: 1,
      sleepSync: () => {},
      readFile: () => {
        const code = errCodes.shift();
        if (code) throw err(code);
        return "CreateProcess failed (error 2)\n";
      },
    }), "CreateProcess failed (error 2)");
  }
});

test("requestJobStop writes the stop sentinel atomically and prepareJob clears stale stop files", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  await requestJobStop(dir);
  assert.equal(readFileSync(join(dir, JOB_STOP), "utf8"), "stop");
  assert.ok(!existsSync(join(dir, `${JOB_STOP}.tmp`)), "atomic write leaves no temporary file behind");
  if (process.platform !== "win32") {
    const compiler = await stubCompiler(dir, 'import { writeFileSync } from "node:fs"; writeFileSync("DsaJob.build.exe", "MZ");');
    const staging = await prepareJob(dir, launchFor(dir), { compiler });
    assert.ok(!existsSync(join(dir, JOB_STOP)), "prepareJob clears a stale stop sentinel before spawning a fresh attempt");
    await staging.release();
  }
});

test("requestStop drains a running job (including detached grandchildren) without writing group-end", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const { program, beatScript, beat, pidFile } = treeProgram(dir);
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, beat, pidFile, beatScript, "keep"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched);
  const grandchild = Number(await until(() => existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined, "the grandchild pid"));
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat");
  await launched.requestStop?.();
  await untilEnded(launched);
  await gone(grandchild);
  await gone(launched.pid);
  assert.ok(!existsSync(join(dir, JOB_END)), "controlled stop must not write a fake normal group-end exit status");
  const size = readFileSync(beat, "utf8").length;
  await delay(400);
  assert.equal(readFileSync(beat, "utf8").length, size, "the grandchild stops acting after controlled DrainJob");
});
