// The Windows Job Object slice of a command attempt: the wrapper is the root of a kernel-owned group, created suspended,
// assigned before it may run, and the group's only handle dies with its helper. These checks run on a Windows runner only
// (the primitive is Win32); they exercise the real PowerShell helper, a real kernel group and real processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { JOB_END, JOB_ERROR, JOB_GROUP, JOB_HELPER, JOB_HELPER_MARKER, JOB_SCRIPT, JOB_SPEC, jobHelperScript, spawnInJob } from "../../../src/platform/job.ts";
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

test("the helper script is self-contained and spells the attempt directory safely", () => {
  // No Windows needed: the shipped source must carry the whole helper (there is no separate file to forget in the package).
  assert.ok(JOB_HELPER.includes(JOB_HELPER_MARKER));
  assert.match(JOB_HELPER, /CreateJobObjectW/);
  assert.match(JOB_HELPER, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(JOB_HELPER, /CREATE_SUSPENDED/);
  assert.match(JOB_HELPER, /AssignProcessToJobObject/);
  const script = jobHelperScript("C:\\dsa\\it's a dir");
  assert.ok(!script.includes("@@DIR@@"));
  assert.ok(script.includes("$dir = 'C:\\dsa\\it''s a dir'"), script.slice(0, 200));
  assert.ok(script.includes("Add-Type -TypeDefinition @'"));
});

test("a job group runs a program with its argv, its output and its exit status", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "args.mjs");
  writeFileSync(program, "console.log(JSON.stringify(process.argv.slice(2))); process.exit(4);\n");
  // Windows quoting: spaces, an embedded quote, trailing and inner backslashes, a newline, non-ASCII.
  const argv = ["a b", 'quo"te', "trail\\", "back\\slash", "line\nbreak", "\u00fc\u00f1\u00ee"];
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, ...argv], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  assert.ok(launched.pid > 0);
  assert.ok(launched.group, "the group owner is reported");
  assert.ok(launched.group!.pid > 0 && launched.group!.start);
  assert.ok(launched.group!.pid !== launched.pid, "the helper is not the wrapper");
  // The group record is the suspended wrapper's pid, written before it may run.
  const group = JSON.parse(readFileSync(join(dir, JOB_GROUP), "utf8")) as { pid?: number };
  assert.equal(group.pid, launched.pid);
  await launched.exited;
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 4);
  assert.equal(readFileSync(join(dir, "output.log"), "utf8").trim(), JSON.stringify(argv));
  assert.ok(!existsSync(join(dir, JOB_ERROR)), "no failure was recorded");
  assert.ok(!existsSync(join(dir, JOB_SPEC)), "the helper consumed the job spec");
  // The attempt directory keeps the wrapper it ran (it is written by the orchestrator on every Windows spawn).
  assert.ok(existsSync(join(dir, JOB_SCRIPT)));
  await gone(launched.pid);
});

test("a program is in the group before it may act, and the group's crash takes its descendants with it", { skip: windowsOnly, timeout: 180_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // The program's first statement detaches a grandchild that keeps beating. If the wrapper ran before it was assigned to
  // the group, that grandchild was created outside it and would survive the group.
  const beat = join(dir, "beat"), grandchildPid = join(dir, "grandchild.pid"), beatScript = join(dir, "beat.mjs");
  writeFileSync(beatScript, "import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync(process.argv[2], '.'), 50);\n");
  const program = join(dir, "tree.mjs");
  writeFileSync(program, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const beat = process.argv[2], pidFile = process.argv[3], beatScript = process.argv[4];",
    "const child = spawn(process.execPath, [beatScript, beat], { detached: true, stdio: 'ignore' });",
    "child.unref();",
    "writeFileSync(pidFile, String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program, beat, grandchildPid, beatScript], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } });
  const grandchild = Number(await until(() => existsSync(grandchildPid) ? readFileSync(grandchildPid, "utf8") : undefined, "the grandchild pid"));
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.ok(await live(grandchild), "the grandchild runs inside the group");
  await until(() => existsSync(beat) && readFileSync(beat, "utf8").length > 0, "the grandchild to beat");
  // A helper crash is not a clean end: it closes the group's only handle. BOTH processes of the group must end, or a
  // second attempt could start while the first command's descendants still act.
  process.kill(launched.group!.pid, "SIGKILL");
  await gone(grandchild);
  await gone(launched.pid);
  const size = readFileSync(beat, "utf8").length;
  await delay(400);
  assert.equal(readFileSync(beat, "utf8").length, size, "the grandchild stops acting");
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
  const ids = JSON.parse(reported) as { pid: number; group: { pid: number } | null };
  assert.ok(ids.pid > 0 && ids.group && ids.group.pid > 0);
  await until(() => existsSync(join(attempt, "exit")), "the exit record of the detached command", 60_000);
  assert.equal(readFileSync(join(attempt, "exit"), "utf8").trim(), "0");
  assert.match(readFileSync(join(attempt, "output.log"), "utf8"), /finished/);
  assert.ok(!(await live(ids.pid)) && !(await live(ids.group!.pid)), "the group and its helper ended with the command");
});

test("a group that cannot be created fails closed: no process, no attempt, a recorded reason", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(spawnInJob(dir, { exe: join(dir, "no-such-program.exe"), args: [], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env } }), /CreateProcess/);
  assert.ok(!existsSync(join(dir, JOB_GROUP)), "no group was recorded");
  assert.match(readFileSync(join(dir, JOB_ERROR), "utf8"), /CreateProcess/);
  assert.ok(!existsSync(join(dir, "exit")), "nothing ran");
});
