import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { COMMAND_LOG, COMMAND_SPEC, COMMAND_WRAPPER_SOURCE, exitMeaning, readExitRecord, readTail, spawnCommand } from "../../../src/platform/command.ts";
import { findOnPath } from "../../../src/platform/launch.ts";
import { captureStart } from "../../../src/platform/proctable.ts";
import { restartRefusal, restartToken } from "../../../src/orchestrator/restart.ts";
import { retiredCommandAttempts, unsealedCommandCalls } from "../../../src/orchestrator/executor/command.ts";
import type { Entry } from "../../../src/types.ts";

const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-command-"));
const unixOnly = process.platform === "win32" ? "Unix /bin/sh and POSIX PATH semantics" : false;
const onPath = (name: string) => (process.env.PATH ?? "").split(":").some(d => d && existsSync(join(d, name)));
async function finished(dir: string) {
  for (let i = 0; i < 200; i++) { const r = await readExitRecord(dir); if (r) return r; await delay(25); }
  throw new Error("no exit record");
}

test("exit statuses: 0 and plain codes stay codes; above 128 read as the signal (the shell convention)", () => {
  assert.deepEqual(exitMeaning(0), { exitCode: 0, signal: null });
  assert.deepEqual(exitMeaning(3), { exitCode: 3, signal: null });
  assert.deepEqual(exitMeaning(143), { exitCode: null, signal: "SIGTERM" });
  assert.deepEqual(exitMeaning(137), { exitCode: null, signal: "SIGKILL" });
  assert.deepEqual(exitMeaning(255), { exitCode: 255, signal: null }, "no signal 127");
});

test("the wrapper records the status of argv, string and builtin commands; output interleaves in output.log", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const cases: [string | string[], number, string][] = [
    [["sh", "-c", "echo a; echo b >&2; exit 4"], 4, "a\nb\n"],
    ["echo s; exit 0", 0, "s\n"],
    [["exit", "7"], 127, ""], // argv runs a program: a shell builtin name is looked up as one (none exists)
    [["export", "A=1"], 127, ""], // a special builtin: no system ships it as a program
    [["cd", "/"], onPath("cd") ? 0 : 127, ""], // macOS ships /usr/bin/cd (a program that runs the builtin); Linux has none
    [["/no/such/command"], 127, ""], // 127 on every /bin/sh (bash 3.2, the macOS one, reports 126 by itself)
    [["no/such/command"], 127, ""],
    ["kill -TERM $$", 143, ""],
  ];
  for (const [i, [command, status, output]] of cases.entries()) {
    const dir = join(root, `c${i}`);
    const spawned = await spawnCommand({ command, cwd: root, dir, env: { ...process.env, DSA_EXEC: `command:test#${i}` } });
    assert.ok(spawned.pid > 0);
    const record = await finished(dir);
    assert.equal(record.status, status, JSON.stringify(command));
    if (output) assert.equal(readFileSync(join(dir, "output.log"), "utf8"), output);
    assert.ok(!existsSync(join(dir, "exit.tmp")));
    // The wrapper is unref'd: a timer keeps this test's event loop alive until its exit event arrives.
    const keep = setInterval(() => {}, 1000);
    try { await spawned.exited; } finally { clearInterval(keep); }
    assert.equal(await captureStart(spawned.pid), "", "the wrapper is gone (reaped)");
  }
});

test("the wrapper records the status under any environment of the command (PATH unset or bogus, IFS, LC_*)", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  // PATH unset: the shell's default path finds `true`; a bogus PATH finds nothing.
  const envs: NodeJS.ProcessEnv[] = [{}, { PATH: "/nonexistent" }, { PATH: "/nonexistent", IFS: "/", LC_ALL: "xx_XX.bogus", LANG: "C" }];
  for (const [i, env] of envs.entries()) for (const [j, [command, status]] of ([["exit 4", 4], [["/bin/sh", "-c", "exit 5"], 5], [["true"], i === 0 ? 0 : 127]] as const).entries()) {
    const dir = join(root, `d ${i} ${j}`); // a space in the path: every expansion is quoted
    await spawnCommand({ command: command as string | string[], cwd: root, dir, env });
    assert.equal((await finished(dir)).status, status, `${JSON.stringify(env)} ${JSON.stringify(command)}`);
  }
});

test("argv looks its program up on the command's PATH (a printf program wins over the shell's builtin)", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "printf"), "#!/bin/sh\necho program \"$@\"\n", { mode: 0o755 });
  const dir = join(root, "c");
  await spawnCommand({ command: ["printf", "x"], cwd: root, dir, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal((await finished(dir)).status, 0);
  assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "program x\n");
  writeFileSync(join(bin, "noexec"), "x", { mode: 0o644 });
  const other = join(root, "n");
  await spawnCommand({ command: ["noexec"], cwd: root, dir: other, env: { PATH: bin } });
  assert.equal((await finished(other)).status, 126, "found but not executable: 126");
  const missing = join(root, "m");
  await spawnCommand({ command: ["no-such-program"], cwd: root, dir: missing, env: { PATH: bin } });
  assert.equal((await finished(missing)).status, 127, "missing: 127");
});

test("the command runs detached in its own session with stdin at /dev/null", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "c");
  // Linux ps reports the session id; macOS ps has no session id keyword, so there the process group stands in
  // (setsid makes the wrapper the leader of a new session and of a new process group).
  const key = process.platform === "linux" ? "sid" : "pgid";
  const spawned = await spawnCommand({ command: `cat; ps -o ${key}= -p $$; ps -o pid= -p $$`, cwd: root, dir, env: process.env });
  await finished(dir);
  const [sid, pid] = readFileSync(join(dir, "output.log"), "utf8").trim().split(/\s+/).map(Number);
  assert.notEqual(sid, process.pid);
  assert.ok(sid === spawned.pid, `the wrapper leads the session (${key} ${sid}, wrapper ${spawned.pid}, sh ${pid})`);
  await assert.rejects(spawnCommand({ command: "true", cwd: join(root, "missing"), dir: join(root, "d"), env: process.env }));
});

test("the output tail starts on a UTF-8 character boundary", async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "log");
  writeFileSync(file, "x" + "\u00e9".repeat(10)); // 1 + 20 bytes
  assert.equal(await readTail(file, 5), "\u00e9\u00e9"); // a cut inside the 3rd-last character drops its tail byte
  assert.equal(await readTail(file, 4), "\u00e9\u00e9");
  assert.equal(await readTail(file, 100), "x" + "\u00e9".repeat(10));
  assert.equal(await readTail(join(root, "missing")), "");
});

test("journal questions: unsealed command calls and retired attempts", () => {
  let seq = 0;
  const e = (type: string, fields: Record<string, unknown>) => ({ seq: ++seq, ts: 0, type, ...fields }) as Entry;
  const entries = [
    e("command-intent", { call: "W@1/a@1", id: "command:W@1/a@1#1", n: 1 }),
    e("command-started", { call: "W@1/a@1", id: "command:W@1/a@1#1", pid: 10, start: "s", dir: "/d" }),
    e("command-intent", { call: "W@1/b@1", id: "command:W@1/b@1#1", n: 1 }),
    e("sealed", { call: "W@1/b@1" }),
    e("command-intent", { call: "W@1/c@1", id: "command:W@1/c@1#1", n: 1 }),
    e("retired", { call: "W@1/c@1" }),
  ];
  assert.deepEqual(unsealedCommandCalls(entries), ["W@1/a@1"]);
  assert.deepEqual(retiredCommandAttempts(entries), [{ call: "W@1/c@1", id: "command:W@1/c@1#1" }]);
});

test("retired command attempts carry the Windows job group identity for their fence", () => {
  // The attempt's group (the job host that holds its Job Object) must travel with the wrapper's identity: a retired call is
  // fenced by both, so a second attempt never starts while the first attempt's group can still act.
  let seq = 0;
  const e = (type: string, fields: Record<string, unknown>) => ({ seq: ++seq, ts: 0, type, ...fields }) as Entry;
  const entries = [
    e("command-intent", { call: "W@1/a@1", id: "command:W@1/a@1#1", n: 1 }),
    e("command-started", { call: "W@1/a@1", id: "command:W@1/a@1#1", pid: 10, start: "s", dir: "/d", group: { pid: 9, start: "g" } }),
    e("retired", { call: "W@1/a@1" }),
  ];
  assert.deepEqual(retiredCommandAttempts(entries),
    [{ call: "W@1/a@1", id: "command:W@1/a@1#1", pid: 10, start: "s", group: { pid: 9, start: "g" } }]);
});

test("restart refusal: command calls are never in the busy list or token; a refusal names how many keep running", () => {
  const now = Date.now(), home = dirOf();
  const live = [{ wid: "W1", key: "a", gen: 1, callId: "W1@1/a@1", exec: "W1@1/a@1#1.1", since: now, phase: "child" as const }];
  const text = restartRefusal(home, live, {}, false, now, 2)!;
  assert.match(text, /^busy: 1 running execution /);
  assert.match(text, /\nnot fenced: 2 command calls keep running across the restart\n/);
  assert.match(text, new RegExp(`token: ${restartToken(live)}`));
  assert.match(restartRefusal(home, live, {}, false, now, 1)!, /\nnot fenced: 1 command call keeps running across the restart\n/);
  assert.doesNotMatch(restartRefusal(home, live, {}, false, now)!, /command call/);
  assert.equal(restartRefusal(home, [], {}, false, now, 3), undefined, "only command calls: no refusal");
});

test("a command runs with Unicode in its argv and environment, under the environment it is given (nothing inherited)", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin);
  // A program only on the command's PATH, with a non-ASCII name: the name and the argv reach it unchanged.
  writeFileSync(join(bin, "grüße"), '#!/bin/sh\nprintf "%s|%s\\n" "$1" "$GRUSS"\n', { mode: 0o755 });
  const dir = join(root, "c");
  await spawnCommand({ command: ["grüße", "你 好 ✓"], cwd: root, dir, env: { PATH: `${bin}:/usr/bin:/bin`, GRUSS: "héllo wörld" } });
  assert.equal((await finished(dir)).status, 0);
  assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "你 好 ✓|héllo wörld\n");
  // A string command with Unicode too: it runs through the platform shell as one command line.
  const shellDir = join(root, "d");
  await spawnCommand({ command: "printf '%s' 'ünïcode ✓'", cwd: root, dir: shellDir, env: { PATH: "/usr/bin:/bin" } });
  assert.equal((await finished(shellDir)).status, 0);
  assert.equal(readFileSync(join(shellDir, "output.log"), "utf8"), "ünïcode ✓");
  // The command's environment is exactly the one the call gives it: this process's variables are not inherited.
  process.env.DSA_TEST_PARENT_ONLY = "parent";
  try {
    const parent = join(root, "e");
    await spawnCommand({ command: ["/bin/sh", "-c", 'printf "%s" "$DSA_TEST_PARENT_ONLY"'], cwd: root, dir: parent, env: { PATH: "/usr/bin:/bin" } });
    assert.equal((await finished(parent)).status, 0);
    assert.equal(readFileSync(join(parent, "output.log"), "utf8"), "");
  } finally { delete process.env.DSA_TEST_PARENT_ONLY; }
});

test("Windows: a command finds its program on the spec env's PATH (also spelled Path) with Unicode argv, not the parent's", { skip: process.platform !== "win32" }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  for (const d of [first, second]) mkdirSync(d, { recursive: true });
  const script = join(first, "tool.js");
  writeFileSync(script, 'process.stdout.write(JSON.stringify({args: process.argv.slice(2), gruss: process.env.GRUSS, path: process.env.PATH}))\n');
  writeFileSync(join(first, "tool.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  // The shim on this process's PATH: a command that read the parent's PATH would run this one instead.
  writeFileSync(join(second, "tool.cmd"), "@echo off\r\necho second\r\n");
  const old = process.env.PATH;
  process.env.PATH = second; t.after(() => { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; });
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const dir = join(root, "c");
  await spawnCommand({ command: ["tool", "你 好", "a b"], cwd: root, dir,
    env: { Path: first, GRUSS: "héllo wörld", COMSPEC: join(systemRoot, "System32", "cmd.exe") } });
  assert.equal((await finished(dir)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "output.log"), "utf8")), { args: ["你 好", "a b"], gruss: "héllo wörld", path: first });
  // A string command still runs through the command processor the call names (COMSPEC is the same ComSpec as ComSpec).
  const shellDir = join(root, "d");
  await spawnCommand({ command: "echo done", cwd: root, dir: shellDir,
    env: { Path: first, SystemRoot: systemRoot, COMSPEC: join(systemRoot, "System32", "cmd.exe") } });
  assert.equal((await finished(shellDir)).status, 0);
  assert.match(readFileSync(join(shellDir, "output.log"), "utf8"), /^done\r?\n$/);
});

test("Windows command wrapper: cmd strings, argv programs, missing programs and a .cmd shim", { skip: process.platform !== "win32" }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const shim = join(root, "shim.cmd");
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" -e "console.log('shim', process.argv[1])" %*\r\n`);
  const cases: [string | string[], number, RegExp][] = [
    ["echo hello", 0, /^hello\r?\n$/],
    [[process.execPath, "-e", "process.exit(4)"], 4, /^$/],
    [["no-such-program-xyz"], 127, /^$/],
    [[shim, "arg with space"], 0, /^shim arg with space\r?\n$/],
  ];
  for (const [i, [command, status, output]] of cases.entries()) {
    const dir = join(root, `c${i}`);
    await spawnCommand({ command, cwd: root, dir, env: { ...process.env } });
    assert.equal((await finished(dir)).status, status, JSON.stringify(command));
    assert.match(readFileSync(join(dir, "output.log"), "utf8"), output, JSON.stringify(command));
  }
});

// The wrapper Windows runs, exercised on a host that is not Windows: its argv branch is platform-neutral, and a POSIX
// `sh` stands in for cmd.exe as the string command's shell. What it must get right is the environment it hands the
// command: one definition per Windows name (ComSpec/COMSPEC, PATHEXT), the command's own definition winning over the
// wrapper process's, and the string command running through that ComSpec.
test("the Windows wrapper merges the command's environment by name and runs a string command through its ComSpec", { skip: unixOnly }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = join(root, "wrapper.mjs"); writeFileSync(wrapper, COMMAND_WRAPPER_SOURCE);
  /** Run the wrapper the way the orchestrator does: node, the attempt directory, stdout and stderr on output.log. */
  const run = async (name: string, spec: { command: string | string[]; env: NodeJS.ProcessEnv }, wrapperEnv: NodeJS.ProcessEnv = process.env) => {
    const dir = join(root, name); mkdirSync(dir);
    writeFileSync(join(dir, COMMAND_SPEC), JSON.stringify({ ...spec, cwd: root }));
    const fd = openSync(join(dir, COMMAND_LOG), "a");
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [wrapper, dir], { cwd: root, env: wrapperEnv, stdio: ["ignore", fd, fd] });
        child.once("error", reject); child.once("exit", resolve);
      });
    } finally { closeSync(fd); }
    assert.ok(!existsSync(join(dir, COMMAND_SPEC)), `${name}: the spec is removed before the command runs`);
    return { code, status: (await readExitRecord(dir))?.status, output: readFileSync(join(dir, COMMAND_LOG), "utf8") };
  };
  // ComSpec is the command's, whatever its spelling, and the child sees one definition of it.
  const names = 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /^(comspec|pathext)$/i.test(k)).sort().map(k => [k, process.env[k]])))';
  const merged = await run("merged", { command: [process.execPath, "-e", names],
    env: { COMSPEC: "C:\\call\\cmd.exe", PATH: "/usr/bin:/bin", PathExt: ".CMD" } }, { ...process.env, ComSpec: "/nonexistent/parent-cmd" });
  assert.deepEqual([merged.code, merged.status], [0, 0]);
  assert.equal(merged.output, JSON.stringify([["ComSpec", "C:\\call\\cmd.exe"], ["PATHEXT", ".CMD"]]), "one definition each, the command's own");
  // A string command runs through the command's ComSpec (a shell this host has), not the wrapper process's.
  const shell = findOnPath("sh", "/bin:/usr/bin");
  assert.ok(shell, "a POSIX sh stands in for cmd.exe");
  const through = await run("through-comspec", { command: "printf %s ok", env: { COMSPEC: shell, PATH: "/bin:/usr/bin" } }, { ...process.env, ComSpec: "/nonexistent/parent-cmd" });
  assert.deepEqual([through.code, through.status, through.output], [0, 0, "ok"]);
  // A block that spells one name twice reaches the child as one variable (the later definition wins).
  const pathNames = 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /^path$/i.test(k)).map(k => [k, process.env[k]])))';
  const collapsed = await run("collapsed", { command: [process.execPath, "-e", pathNames], env: { Path: "/one", PATH: "/two" } });
  assert.deepEqual([collapsed.code, collapsed.status, collapsed.output], [0, 0, JSON.stringify([["PATH", "/two"]])]);
  // A ComSpec that cannot start is 127 before the command runs, and the wrapper still records it.
  const missing = await run("missing-comspec", { command: "printf %s no", env: { COMSPEC: "/nonexistent/call-cmd", PATH: "/bin:/usr/bin" } });
  assert.deepEqual([missing.code, missing.status, missing.output], [127, 127, ""], "no shell, no command, but the status is recorded");
});
