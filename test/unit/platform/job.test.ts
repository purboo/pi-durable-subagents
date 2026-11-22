// The Windows Job Object slice of a command attempt: the wrapper is the root of a kernel-owned group, created suspended,
// assigned before it may run, and the group's only handle dies with its helper. The behavioral checks run on a Windows
// runner only (the primitive is Win32); they exercise the real PowerShell helper, a real kernel group and real
// processes. The text the helper is fed (its script, its spec) and the reason it left are checked everywhere, because
// that is where a Unicode path, a curly quote or a credential would be lost or leaked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  JOB_BEGIN, JOB_END, JOB_ERROR, JOB_GROUP, JOB_HELPER, JOB_HELPER_EXIT, JOB_HELPER_LOG, JOB_HELPER_MARKER, JOB_SCRIPT, JOB_SPEC,
  asciiJson, jobEnv, jobSpecText, spawnInJob, startError,
} from "../../../src/platform/job.ts";
import { winProcessRows } from "../../../src/platform/windows.ts";

const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-job-"));
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

test("the helper script is self-contained, ASCII, and takes its directory from the script location", () => {
  // No Windows needed: the shipped source must carry the whole helper (there is no separate file to forget in the
  // package) and must not carry the attempt directory, an encoding or a quoting rule that PowerShell 5.1 would get wrong.
  assert.ok(JOB_HELPER.includes(JOB_HELPER_MARKER));
  assert.match(JOB_HELPER, /CreateJobObjectW/);
  assert.match(JOB_HELPER, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(JOB_HELPER, /CREATE_SUSPENDED/);
  assert.match(JOB_HELPER, /AssignProcessToJobObject/);
  // The directory is argv, never text in the script: nothing to quote, nothing to case-fold, no $PSScriptRoot.
  assert.match(JOB_HELPER, /^\$Dir = \$PSScriptRoot\n/);
  assert.ok(!JOB_HELPER.includes("@@DIR@@"));
  assert.ok(!JOB_HELPER.includes("$PSScriptRoot"));
  // PowerShell 5.1 decodes a script with no byte order mark in the ANSI code page: only ASCII text is unambiguous.
  assert.match(JOB_HELPER, /^[\t\n\r\x20-\x7e]*$/, "the helper script is ASCII only");
  // job.json is UTF-8 and its bytes are decoded as such, whatever the code page says.
  assert.ok(JOB_HELPER.includes("[System.IO.File]::ReadAllText("), "the spec is read as bytes");
  assert.ok(JOB_HELPER.includes("[System.Text.Encoding]::UTF8"), "and decoded as UTF-8 explicitly");
  assert.ok(!/\bGet-Content\b/.test(JOB_HELPER), "the spec is not read through Get-Content's encoding default");
  // The here-string that carries the C# must be terminated at the start of a line, or PowerShell 5.1 never compiles it.
  assert.ok(JOB_HELPER.includes("\n'@\n"), "the Add-Type here-string is closed on its own line");
  // Both streams get their own append-only handle: independent streams, no shared file pointer to overwrite with.
  assert.match(JOB_HELPER, /FILE_APPEND_DATA/);
  assert.ok(!/\bGENERIC_WRITE\b|\bSetFilePointerEx\b/.test(JOB_HELPER), "no read/write handle seeking to the end");
  assert.equal(JOB_HELPER.match(/startup\.hStd(Output|Error)/g)?.length, 2, "stdout and stderr have their own handle");
  // A run that never reached its script is distinguishable from one that failed inside it.
  assert.ok(JOB_HELPER.indexOf(JOB_BEGIN) < JOB_HELPER.indexOf("Add-Type -TypeDefinition"), "the begin record precedes Add-Type");
});

test("the spec is ASCII JSON that decodes back to the same strings, with the environment as one ordered list", () => {
  // The environment of an attempt: Windows names are case-insensitive, so `Path` and `PATH` are one variable.
  assert.deepEqual(jobEnv({ b: "2", A: "1", a: "first", c: undefined, "": "x", "d=e": "y", f: "" }), ["b=2", "A=1", "f="]);
  const env = { PATH: "C:\\bin", ünïcode: "curly ’quoted’ \"and\" \\ back", EMPTY: "" };
  const launch = { exe: "C:\\Program Files\\node.exe", args: ["a b", 'quo"te', "trail\\", "line\nbreak", "ünïcode ’x’", "\u{1f600}"],
    cwd: "C:\\work ’dir’ ü", log: "C:\\work ’dir’ ü\\output.log", env };
  const text = jobSpecText(launch);
  // A file that is ASCII cannot be misread: no code page, no byte order mark, no BOM check can change these bytes.
  assert.match(text, /^[\x20-\x7e]*$/, "the spec is ASCII only");
  assert.equal(text, asciiJson({ exe: launch.exe, args: launch.args, cwd: launch.cwd, log: launch.log, env: jobEnv(env) }));
  // ConvertFrom-Json sees exactly what the caller meant, curly quotes, surrogates, control characters and all.
  assert.deepEqual(JSON.parse(text), { exe: launch.exe, args: launch.args, cwd: launch.cwd, log: launch.log, env: jobEnv(env) });
  assert.equal(JSON.parse(asciiJson("\u0000\u001f\u007f\u0080")), "\u0000\u001f\u007f\u0080");
  assert.throws(() => asciiJson(Number.NaN), /not JSON/);
});

test("a failure reason is one bounded line and never a credential", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // Nothing left behind: nothing to say (the caller's own message stands).
  assert.equal(await startError(dir), "");
  await writeFile(join(dir, JOB_ERROR), "CreateProcess C:\\a\\b.exe failed (error 2)");
  await writeFile(join(dir, JOB_HELPER_EXIT), asciiJson({ code: 125, signal: null }));
  await writeFile(join(dir, JOB_BEGIN), "begin");
  const reason = await startError(dir);
  assert.match(reason, /^: /);
  assert.match(reason, /CreateProcess/);
  assert.match(reason, /exited with code 125/);
  assert.ok(!reason.includes("before its script ran"), "the helper did run its script");
  // An error record is quoted from its beginning (a message), a helper log from its end (the newest lines); both bounded.
  await rm(join(dir, JOB_ERROR), { force: true });
  await writeFile(join(dir, JOB_HELPER_LOG), `${"B".repeat(4000)}\nlog-head-marker\n${"C".repeat(4000)}\nlog-tail-marker\n`);
  const fromLog = await startError(dir);
  assert.match(fromLog, /log-tail-marker/);
  assert.ok(!fromLog.includes("log-head-marker"), "a log contributes its newest lines, not its beginning");
  await writeFile(join(dir, JOB_ERROR), `start-error-marker\n${"C".repeat(4000)}\ntrailer-marker`);
  const bounded = await startError(dir);
  assert.match(bounded, /start-error-marker/);
  assert.ok(!bounded.includes("trailer-marker"), "a message is quoted from its start");
  assert.match(bounded, /exited with code 125/);
  assert.ok(bounded.length <= 302, `bounded reason, got ${bounded.length} characters`);
  // A credential the helper may have quoted back: the value of a secret-looking variable never leaves this process.
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
  // The one measured shape of an unexplained start: PowerShell with no console exits 0 and never runs its script.
  const quiet = dirOf(); t.after(() => rm(quiet, { recursive: true, force: true }));
  await writeFile(join(quiet, JOB_HELPER_EXIT), asciiJson({ code: 0, signal: null }));
  const silent = await startError(quiet);
  assert.match(silent, /exited with code 0 before its script ran/);
  assert.match(silent, /without a console runs nothing/);
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
  assert.ok(launched.pid > 0);
  // The group record is the suspended wrapper's pid, written before it may run.
  const group = JSON.parse(readFileSync(join(dir, JOB_GROUP), "utf8")) as { pid?: number };
  assert.equal(group.pid, launched.pid);
  if (launched.group) {
    assert.ok(launched.group.pid > 0 && launched.group.start);
    assert.ok(launched.group.pid !== launched.pid, "the helper is not the wrapper");
    assert.ok(launched.start, "a wrapper that is still running has an observed identity");
  }
  await launched.exited;
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 4);
  assert.equal(readFileSync(join(dir, "output.log"), "utf8").trim(), JSON.stringify(argv));
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no failure was recorded");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "the helper consumed the job spec");
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the helper ran its script");
  // The attempt directory keeps the wrapper it ran (it is written by the orchestrator on every Windows spawn).
  assert.ok(existsSync(join(dir, JOB_SCRIPT)));
  assert.match(readFileSync(join(dir, JOB_HELPER_EXIT), "utf8"), /"code":4/, "the helper's own exit is its wrapper's");
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
  await launched.exited;
  const log = readFileSync(join(dir, "output.log"), "utf8");
  for (let at = 0; at < 40; at += 1) {
    assert.equal(log.split(`line-${at}`).length - 1, 1, `line-${at} appears exactly once`);
  }
});

test("a Unicode and curly-quoted attempt directory, argv, cwd and environment arrive unchanged", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const parent = dirOf(); t.after(() => rm(parent, { recursive: true, force: true }));
  // A path PowerShell 5.1 could not have read out of an ANSI-decoded script: the directory travels as argv and the
  // paths and strings inside it as ASCII-escaped job.json.
  const dir = join(parent, "attempt \u2019\u00fc\u00f1 \u201cjob\u201d");
  mkdirSync(dir);
  const program = join(dir, "echo.mjs");
  writeFileSync(program, "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.DSA_UNICODE }));\n");
  const argv = ["\u2019curly\u2019", "\u00e9\u00e8\u00ea", "C:\\temp\u2019s\\dir"];
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, ...argv], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env, DSA_UNICODE: "v\u00e4l\u00fce \u2019x\u2019" } });
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
  const grandchild = Number(await until(() => existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined, "the grandchild pid"));
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.ok(await live(grandchild), "the grandchild runs inside the group");
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat");
  // A helper crash is not a clean end: it closes the group's only handle. BOTH processes of the group must end, or a
  // second attempt could start while the first command's descendants still act.
  assert.ok(launched.group, "the helper is still running");
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
  // report, not a requirement) may be absent. What must hold is that the command itself ran to its end without us.
  const ids = JSON.parse(reported) as { pid: number; group: { pid: number; start: string } | null };
  assert.ok(ids.pid > 0);
  if (ids.group) assert.ok(ids.group.pid > 0 && ids.group.start);
  await until(() => existsSync(join(attempt, "exit")), "the exit record of the detached command", 60_000);
  assert.equal(readFileSync(join(attempt, "exit"), "utf8").trim(), "0");
  assert.match(readFileSync(join(attempt, "output.log"), "utf8"), /finished/);
  assert.ok(!(await live(ids.pid)), "the wrapper ended with the command");
  if (ids.group) assert.ok(!(await live(ids.group.pid)), "the group's helper ended with the command");
});

test("a group that cannot be created fails closed: no process, no attempt, a recorded reason", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const reason = await spawnInJob(dir, { exe: join(dir, "no-such-program.exe"), args: [], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } }).then(() => "", (error: Error) => error.message);
  // The rejection names what went wrong: the helper's record, or -- when it wrote nothing -- why its process ended.
  assert.match(reason, /CreateProcess/);
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was recorded");
  assert.ok(!existsSync(join(dir, "exit")), "nothing ran");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /CreateProcess/);
  assert.ok(existsSync(join(dir, JOB_BEGIN)), "the helper ran its script");
  assert.match(readFileSync(join(dir, JOB_HELPER_EXIT), "utf8"), /"code":125/, "a failure the script recorded exits 125");
});
