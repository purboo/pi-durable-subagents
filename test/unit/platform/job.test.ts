// The Windows Job Object slice of a command attempt: the wrapper is the root of a kernel-owned group, created suspended,
// assigned before it may run, and the group's only handle dies with its owner -- a small .NET Framework executable
// compiled per launch with the framework's own compiler. The behavioral checks run on a Windows runner only (the
// primitive is Win32); they exercise the real compiled owner, a real kernel group and real processes. The source contract,
// the spec text and the reason an owner left are checked everywhere, because that is where a Unicode path, a curly quote,
// a stale executable or a credential would be lost or leaked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  JOB_BEGIN, JOB_END, JOB_ERROR, JOB_GROUP, JOB_HOST_EXE, JOB_HOST_EXIT, JOB_HOST_LOG, JOB_HOST_MARKER, JOB_HOST_PREFIX,
  JOB_HOST_SOURCE, JOB_SPEC, JOB_SPEC_HEADER, asciiJson, frameworkCompiler, frameworkCompilerCandidates, jobEnv,
  jobHostPaths, jobSpecText, spawnInJob, startError,
} from "../../../src/platform/job.ts";
import { winProcessRows } from "../../../src/platform/windows.ts";

const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
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
  for (const name of [JOB_SPEC, JOB_BEGIN, JOB_GROUP, JOB_END, JOB_ERROR]) assert.ok(JOB_HOST_SOURCE.includes(`"${name}"`), name);
  // stdin is empty; two independent append-only handles mean one stream cannot overwrite the other.
  assert.match(JOB_HOST_SOURCE, /CreateFileW\("NUL"/);
  assert.match(JOB_HOST_SOURCE, /FILE_APPEND_DATA/);
  assert.ok(!/GENERIC_WRITE|SetFilePointerEx/.test(JOB_HOST_SOURCE), "no read/write handle seeking to the end");
  assert.equal(JOB_HOST_SOURCE.match(/startup\.hStd(Output|Error)/g)?.length, 2, "stdout and stderr have their own handle");
  assert.equal(JOB_HOST_SOURCE.match(/startup\.hStdInput/g)?.length, 1, "stdin is the empty NUL handle");
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
  await launched.exited;
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
  await launched.exited;
  const log = readFileSync(join(dir, "output.log"), "utf8");
  for (let at = 0; at < 40; at += 1) {
    assert.equal(log.split(`line-${at}`).length - 1, 1, `line-${at} appears exactly once`);
  }
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
  await launched.exited;
  const seen = JSON.parse(readFileSync(join(dir, "output.log"), "utf8").trim()) as { argv: string[]; cwd: string; env: string };
  assert.deepEqual(seen.argv, argv);
  assert.equal(seen.cwd, dir);
  assert.equal(seen.env, "v\u00e4l\u00fce \u2019x\u2019");
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
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
  await launched.exited;
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
  await launched.exited;
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
    await launched.exited;
    assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
    assert.match(readFileSync(join(dir, `output-${n}.log`), "utf8"), /run/);
  }
  // A stale executable can never be picked up: every launch compiles into its own new directory.
  const hosts = readdirSync(dir).filter(name => name.startsWith(JOB_HOST_PREFIX));
  assert.equal(hosts.length, 2, "a fresh owner directory per launch");
  for (const host of hosts) assert.ok(existsSync(join(dir, host, JOB_HOST_EXE)));
});
