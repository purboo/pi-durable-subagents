import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic, writeFileAtomicSync } from "../../../src/kernel/fsx.ts";
import { COMMAND_EXIT, COMMAND_LOG, COMMAND_SPEC, COMMAND_WRAPPER_SOURCE, exitMeaning, readExitRecord, readTail, spawnCommand } from "../../../src/platform/command.ts";
import { JOB_END, JOB_HOST_EXIT } from "../../../src/platform/job.ts";
import { dword } from "../../../src/platform/windows.ts";
import { findOnPath } from "../../../src/platform/launch.ts";
import { captureStart } from "../../../src/platform/proctable.ts";
import { restartRefusal, restartToken } from "../../../src/orchestrator/restart.ts";
import { retiredCommandAttempts, unsealedCommandCalls } from "../../../src/orchestrator/executor/command.ts";
import type { Entry } from "../../../src/types.ts";

const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-command-"));
const unixOnly = process.platform === "win32" ? "Unix /bin/sh and POSIX PATH semantics" : false;
const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
const onPath = (name: string) => (process.env.PATH ?? "").split(":").some(d => d && existsSync(join(d, name)));
async function finished(dir: string) {
  for (let i = 0; i < 200; i++) { const r = await readExitRecord(dir); if (r) return r; await delay(25); }
  const evidence = ["group-end", "host-exit", "start-error", "host.log", COMMAND_LOG].map(name => {
    const file = join(dir, name);
    return existsSync(file) ? `${name}=${readFileSync(file, "utf8").slice(-500)}` : `${name} missing`;
  });
  throw new Error(`no exit record (${evidence.join(", ")})`);
}

test("exit statuses: 0 and plain codes stay codes; above 128 read as the signal (the shell convention)", () => {
  assert.deepEqual(exitMeaning(0), { exitCode: 0, signal: null });
  assert.deepEqual(exitMeaning(3), { exitCode: 3, signal: null });
  assert.deepEqual(exitMeaning(143), { exitCode: null, signal: "SIGTERM" });
  assert.deepEqual(exitMeaning(137), { exitCode: null, signal: "SIGKILL" });
  assert.deepEqual(exitMeaning(255), { exitCode: 255, signal: null }, "no signal 127");
  // A Windows exit status is the whole DWORD: high bit included it is a status, never 128 plus a signal number.
  assert.deepEqual(exitMeaning(0xC0000005), { exitCode: 3221225477, signal: null });
  assert.deepEqual(exitMeaning(0xffffffff), { exitCode: 4294967295, signal: null });
});

test("a Windows status is normalized to its DWORD before it is recorded or reported", () => {
  // Node hands a Windows status back as a number whose bit pattern is the kernel's exit code, on some paths as a signed
  // int32: every place that records, reads back or reports one uses the same normalization.
  for (const [raw, as] of [[0xC0000005, 3221225477], [-1073741819, 3221225477], [0, 0], [255, 255], [3221225477, 3221225477], [-1, 4294967295]] as const)
    assert.equal(dword(raw), as, `${raw} -> ${as}`);
  // The wrapper is a standalone file (written into the attempt directory, it imports nothing of this package), so it
  // spells the normalization itself: the recorded status and the wrapper's own exit are the same DWORD.
  assert.match(COMMAND_WRAPPER_SOURCE, /function dword\(code\) \{ return code >>> 0; \}/);
  assert.match(COMMAND_WRAPPER_SOURCE, /const status = code === null \? \(signal \? 128 : 1\) : dword\(code\);/);
  assert.match(COMMAND_WRAPPER_SOURCE, /record\(status\); process\.exit\(status\);/,
    "the wrapper exits with the status it recorded");
  assert.match(COMMAND_WRAPPER_SOURCE, /writeFileSync\(join\(dir, "exit\.tmp"\), String\(status\)\)/);
  assert.ok(!/: code; record/.test(COMMAND_WRAPPER_SOURCE), "a raw status is never recorded (a negative one is no record)");
});

test("an exit record is one exit status: the whole DWORD, a negative text is not a record", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readExitRecord(dir), undefined, "no record while the command runs");
  for (const status of [0, 3, 255, 0xC0000005, 0xffffffff]) {
    writeFileSync(join(dir, COMMAND_EXIT), `${status}\n`);
    assert.equal((await readExitRecord(dir))?.status, status);
  }
  // What a wrapper never writes, and what a wrapper written by another program might: not a status of this attempt.
  for (const text of ["-1073741819", "4294967296", "1e3", "0.5", "", "exit 3"]) {
    writeFileSync(join(dir, COMMAND_EXIT), text);
    assert.equal(await readExitRecord(dir), undefined, JSON.stringify(text));
  }
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
  // Spaced path + spaced arg + cmd metacharacter + pnpm-style NODE_PATH preservation through cmd.exe.
  const spacedDir = join(root, "Program Tools");
  mkdirSync(spacedDir, { recursive: true });
  const spacedScript = join(spacedDir, "print-env.mjs");
  writeFileSync(spacedScript, "console.log(JSON.stringify({ args: process.argv.slice(2), nodePath: process.env.NODE_PATH }));\n");
  const pnpmShim = join(spacedDir, "pnpm tool.cmd");
  writeFileSync(pnpmShim, `@echo off\r\nsetlocal\r\nset "NODE_PATH=C:\\custom\\pnpm_modules"\r\n"${process.execPath}" "${spacedScript}" %*\r\n`);
  const cases: [string | string[], number, RegExp][] = [
    ["echo hello", 0, /^hello\r?\n$/],
    [[process.execPath, "-e", "process.exit(4)"], 4, /^$/],
    [["no-such-program-xyz"], 127, /^$/],
    [[shim, "arg with space"], 0, /^shim arg with space\r?\n$/],
    [[pnpmShim, "arg with space", "a&b"], 0, /^\{"args":\["arg with space","a&b"\],"nodePath":"C:\\\\custom\\\\pnpm_modules"\}\r?\n$/],
  ];
  for (const [i, [command, status, output]] of cases.entries()) {
    const dir = join(root, `c${i}`);
    await spawnCommand({ command, cwd: root, dir, env: { ...process.env } });
    assert.equal((await finished(dir)).status, status, JSON.stringify(command));
    assert.match(readFileSync(join(dir, "output.log"), "utf8"), output, JSON.stringify(command));
  }
});

test("a high-bit Windows status reaches the record and the caller as the same DWORD", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // 0xC0000005 (an access violation): Node hands this status to the wrapper as a number whose bit pattern is that DWORD
  // -- negative on the paths that report it as a signed int32 -- and it must reach the record, the owner's view of the
  // wrapper's end and the caller's outcome as that one DWORD.
  const spawned = await spawnCommand({ command: [process.execPath, "-e", "process.exit(0xC0000005)"], cwd: dir, dir, env: { ...process.env } });
  assert.ok(spawned.pid > 0);
  const record = await finished(dir);
  assert.equal(record.status, 0xC0000005, "the record carries the whole DWORD, not a negative status");
  assert.deepEqual(exitMeaning(record.status), { exitCode: 0xC0000005, signal: null }, "what the caller observes");
  const keep = setInterval(() => {}, 1000);
  try { await spawned.exited; } finally { clearInterval(keep); }
  // The owner recorded the wrapper's own end from the kernel: the same DWORD, so the record and the attempt's outcome
  // cannot disagree; the owner's end is the wrapper's status too (host-exit is normalized the same way).
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0xC0000005);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_HOST_EXIT), "utf8")).code, 0xC0000005);
});

test("a Windows start opens no log descriptor: a refused start leaves no output.log", { skip: windowsOnly, timeout: 60_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  // The attempt's log belongs to the group owner (it opens two append handles of its own), so this process opens none:
  // nothing of the attempt's log exists when the start is refused before anything runs.
  const launched = await spawnCommand({ command: [process.execPath, "-e", "process.exit(0)"], cwd: dir, dir, env: { ...process.env },
    proceed: () => false });
  assert.equal(launched, undefined, "the gate refused the start");
  assert.ok(!existsSync(join(dir, COMMAND_LOG)), "no output.log: no descriptor was opened for one");
  assert.ok(!existsSync(join(dir, COMMAND_EXIT)), "nothing ran");
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

test("Windows wrapper retries transient sharing conflicts during exit publication and never writes exit directly", { timeout: 30_000 }, async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = join(root, "wrapper.mjs");
  writeFileSync(wrapper, COMMAND_WRAPPER_SOURCE);
  // Preload script patches node:fs and syncs ESM named bindings so COMMAND_WRAPPER_SOURCE itself runs under injected
  // transient sharing errors without altering the wrapper source.
  const preload = join(root, "inject-fs.mjs");
  writeFileSync(preload, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { basename } from "node:path";',
    'const plan = JSON.parse(process.env.DSA_TEST_FS_PLAN || "{}");',
    'const tracePath = process.env.DSA_TEST_FS_TRACE;',
    'const origWrite = fs.writeFileSync.bind(fs), origRename = fs.renameSync.bind(fs);',
    'const trace = { writeTargets: [], renameAttempts: 0, writeAttempts: 0 };',
    'const save = () => { if (tracePath) origWrite(tracePath, JSON.stringify(trace)); };',
    'const err = code => Object.assign(new Error(`${code}: injected conflict`), { code });',
    'fs.writeFileSync = function(p, data, opts) {',
    '  const name = basename(String(p));',
    '  if (name === "exit" || name === "exit.tmp") {',
    '    trace.writeTargets.push(name);',
    '    trace.writeAttempts += 1;',
    '    save();',
    '    const code = plan.writeErrors?.shift();',
    '    if (code) throw err(code);',
    '  }',
    '  return origWrite(p, data, opts);',
    '};',
    'fs.renameSync = function(from, to) {',
    '  if (basename(String(to)) === "exit") {',
    '    trace.renameAttempts += 1;',
    '    save();',
    '    if (plan.alwaysRenameError) throw err(plan.alwaysRenameError);',
    '    const code = plan.renameErrors?.shift();',
    '    if (code) throw err(code);',
    '  }',
    '  return origRename(from, to);',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));

  const runWithFaults = async (name: string, exitCode: number, plan: Record<string, unknown>) => {
    const dir = join(root, name); mkdirSync(dir);
    const tracePath = join(root, `${name}.trace.json`);
    writeFileSync(join(dir, COMMAND_SPEC), JSON.stringify({
      command: [process.execPath, "-e", `process.exit(${exitCode})`],
      cwd: root,
      env: { ...process.env },
    }));
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, wrapper, dir], {
        cwd: root,
        env: { ...process.env, DSA_TEST_FS_PLAN: JSON.stringify(plan), DSA_TEST_FS_TRACE: tracePath },
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { writeTargets: string[]; renameAttempts: number; writeAttempts: number };
    return { dir, code, trace, record: await readExitRecord(dir) };
  };

  // 1. Transient EBUSY/EACCES/EPERM on rename: retries rename only (never rewrites exit.tmp or writes exit directly).
  {
    const res = await runWithFaults("rename-transient", 7, { renameErrors: ["EBUSY", "EACCES", "EPERM"] });
    assert.equal(res.code, 7);
    assert.equal(res.record?.status, 7);
    assert.deepEqual(res.trace.writeTargets, ["exit.tmp"], "only writes to exit.tmp, never directly to exit");
    assert.equal(res.trace.renameAttempts, 4, "3 transient sharing failures followed by success");
    assert.ok(!existsSync(join(res.dir, "exit.tmp")), "temp file was renamed away");
  }

  // 2. Transient sharing errors on both temp write and rename: both retry and publish atomically.
  {
    const res = await runWithFaults("write-and-rename-transient", 42, {
      writeErrors: ["EACCES", "EBUSY"],
      renameErrors: ["EPERM", "EBUSY"],
    });
    assert.equal(res.code, 42);
    assert.equal(res.record?.status, 42);
    assert.deepEqual(res.trace.writeTargets, ["exit.tmp", "exit.tmp", "exit.tmp"]);
    assert.equal(res.trace.renameAttempts, 3);
    assert.ok(!existsSync(join(res.dir, "exit.tmp")));
  }

  // 3. Non-transient error (ENOSPC) fails fast without retrying, cleans up exit.tmp, and never writes exit directly.
  {
    const res = await runWithFaults("non-transient", 5, { renameErrors: ["ENOSPC"] });
    assert.equal(res.code, 5, "wrapper still exits with the command's own status");
    assert.equal(res.record, undefined, "no exit record published on failure");
    assert.deepEqual(res.trace.writeTargets, ["exit.tmp"], "never falls back to direct write to exit");
    assert.equal(res.trace.renameAttempts, 1, "non-transient error is not retried");
    assert.ok(!existsSync(join(res.dir, "exit.tmp")), "temp file is cleaned up on failure");
  }

  // 4. Persistent sharing conflict stops within bounded retries, cleans up exit.tmp, and never writes exit directly.
  {
    const started = Date.now();
    const res = await runWithFaults("persistent-busy", 9, { alwaysRenameError: "EBUSY" });
    const elapsed = Date.now() - started;
    assert.equal(res.code, 9, "wrapper still exits with the command's own status");
    assert.equal(res.record, undefined, "no direct-write fallback on exhaustion");
    assert.deepEqual(res.trace.writeTargets, ["exit.tmp"]);
    assert.ok(res.trace.renameAttempts > 1 && res.trace.renameAttempts <= 26, `bounded retries (${res.trace.renameAttempts})`);
    assert.ok(elapsed < 10_000, `bounded retry budget completed promptly (${elapsed} ms)`);
    assert.ok(!existsSync(join(res.dir, "exit.tmp")), "temp file is cleaned up after bounded exhaustion");
  }
});

test("readExitRecord retries Windows transient sharing conflicts and fails closed on missing or persistent errors", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const err = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

  // 1. Missing file returns undefined immediately without sleeping or retrying.
  let missingCalls = 0;
  assert.equal(await readExitRecord(dir, {
    platform: "win32",
    sleep: async () => { throw new Error("must not sleep on ENOENT"); },
    read: async () => { missingCalls += 1; throw err("ENOENT"); },
  }), undefined);
  assert.equal(missingCalls, 1);

  // 2. Transient EACCES / EBUSY / EPERM on Windows recovers with the exit status and mtime.
  const transientCodes = ["EACCES", "EBUSY", "EPERM"];
  let calls = 0;
  const slept: number[] = [];
  const recovered = await readExitRecord(dir, {
    platform: "win32",
    baseDelayMs: 5,
    sleep: async ms => { slept.push(ms); },
    read: async () => {
      calls += 1;
      const code = transientCodes.shift();
      if (code) throw err(code);
      return { text: "3221225477\n", at: 123456 };
    },
  });
  assert.deepEqual(recovered, { status: 0xC0000005, at: 123456 });
  assert.equal(calls, 4);
  assert.deepEqual(slept, [5, 10, 15]);

  // 3. Persistent sharing conflict exhausts bounded retries and throws.
  let persistentCalls = 0;
  await assert.rejects(readExitRecord(dir, {
    platform: "win32",
    maxAttempts: 4,
    baseDelayMs: 1,
    sleep: async () => {},
    read: async () => { persistentCalls += 1; throw err("EBUSY"); },
  }), { code: "EBUSY" });
  assert.equal(persistentCalls, 4);

  // 4. Non-sharing error (EIO) and non-Windows sharing error fail immediately without retry.
  let eioCalls = 0;
  await assert.rejects(readExitRecord(dir, {
    platform: "win32",
    sleep: async () => { throw new Error("must not retry EIO"); },
    read: async () => { eioCalls += 1; throw err("EIO"); },
  }), { code: "EIO" });
  assert.equal(eioCalls, 1);

  let posixCalls = 0;
  await assert.rejects(readExitRecord(dir, {
    platform: "linux",
    sleep: async () => { throw new Error("must not retry on POSIX"); },
    read: async () => { posixCalls += 1; throw err("EACCES"); },
  }), { code: "EACCES" });
  assert.equal(posixCalls, 1);
});

test("writeFileAtomic and writeFileAtomicSync retry Windows sharing conflicts without direct writes or partial JSON", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const err = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

  // Async: retries temp write + rename, never writes directly to target, leaves valid JSON.
  {
    const target = join(dir, "host-exit"), temp = `${target}.tmp`;
    const written: string[] = [];
    const writeErrs = ["EACCES"], renameErrs = ["EBUSY", "EPERM"];
    let renames = 0;
    await writeFileAtomic(target, '{"code":0,"signal":null}', {
      platform: "win32",
      baseDelayMs: 1,
      sleep: async () => {},
      writeFile: async (p, data) => {
        written.push(p);
        const code = writeErrs.shift();
        if (code) throw err(code);
        writeFileSync(p, data);
      },
      rename: async (from, to) => {
        renames += 1;
        const code = renameErrs.shift();
        if (code) throw err(code);
        const content = readFileSync(from, "utf8");
        writeFileSync(to, content);
        await rm(from, { force: true });
      },
    });
    assert.deepEqual(written, [temp, temp], "writes only to temp path, never directly to target");
    assert.equal(renames, 3);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { code: 0, signal: null });
    assert.ok(!existsSync(temp));
  }

  // Async exhaustion: cleans up temp file and leaves target absent (no partial write).
  {
    const target = join(dir, "host-exit-fail"), temp = `${target}.tmp`;
    let unlinked = "";
    await assert.rejects(writeFileAtomic(target, '{"code":1}', {
      platform: "win32",
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: async () => {},
      writeFile: async (p, data) => { writeFileSync(p, data); },
      rename: async () => { throw err("EPERM"); },
      unlink: async p => { unlinked = p; await rm(p, { force: true }); },
    }), { code: "EPERM" });
    assert.equal(unlinked, temp);
    assert.ok(!existsSync(temp));
    assert.ok(!existsSync(target), "target never exposed on failed publish");
  }

  // Sync: retries transient sharing conflicts cleanly and cleans up on failure.
  {
    const target = join(dir, "sync-exit"), temp = `${target}.tmp`;
    const renameErrs = ["EBUSY", "EACCES"];
    let writeCount = 0, renameCount = 0;
    writeFileAtomicSync(target, '{"status":0}', {
      platform: "win32",
      baseDelayMs: 1,
      sleepSync: () => {},
      writeFileSync: (p, data) => { writeCount += 1; assert.equal(p, temp); writeFileSync(p, data); },
      renameSync: (from, to) => {
        renameCount += 1;
        const code = renameErrs.shift();
        if (code) throw err(code);
        writeFileSync(to, readFileSync(from, "utf8"));
      },
    });
    assert.equal(writeCount, 1, "temp file is not rewritten while rename retries");
    assert.equal(renameCount, 3);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { status: 0 });
  }
});
