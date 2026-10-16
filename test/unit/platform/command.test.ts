import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exitMeaning, readExitRecord, readTail, spawnCommand } from "../../../src/platform/command.ts";
import { captureStart } from "../../../src/platform/proctable.ts";
import { restartRefusal, restartToken } from "../../../src/orchestrator/restart.ts";
import { retiredCommandAttempts, unsealedCommandCalls } from "../../../src/orchestrator/executor/command.ts";
import type { Entry } from "../../../src/types.ts";

const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-command-"));
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

test("the wrapper records the status of argv, string and builtin commands; output interleaves in output.log", async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const cases: [string | string[], number, string][] = [
    [["sh", "-c", "echo a; echo b >&2; exit 4"], 4, "a\nb\n"],
    ["echo s; exit 0", 0, "s\n"],
    [["exit", "7"], 127, ""], // argv runs a program: a shell builtin name is looked up as one (none exists)
    [["cd", "/"], 127, ""],
    [["/no/such/command"], 127, ""],
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
    await spawned.exited;
    assert.equal(await captureStart(spawned.pid), "", "the wrapper is gone (reaped)");
  }
});

test("the wrapper records the status under any environment of the command (PATH unset or bogus, IFS, LC_*)", async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  // PATH unset: the shell's default path finds `true`; a bogus PATH finds nothing.
  const envs: NodeJS.ProcessEnv[] = [{}, { PATH: "/nonexistent" }, { PATH: "/nonexistent", IFS: "/", LC_ALL: "xx_XX.bogus", LANG: "C" }];
  for (const [i, env] of envs.entries()) for (const [j, [command, status]] of ([["exit 4", 4], [["/bin/sh", "-c", "exit 5"], 5], [["true"], i === 0 ? 0 : 127]] as const).entries()) {
    const dir = join(root, `d ${i} ${j}`); // a space in the path: every expansion is quoted
    await spawnCommand({ command: command as string | string[], cwd: root, dir, env });
    assert.equal((await finished(dir)).status, status, `${JSON.stringify(env)} ${JSON.stringify(command)}`);
  }
});

test("argv looks its program up on the command's PATH (a printf program wins over the shell's builtin)", async t => {
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

test("the command runs detached in its own session with stdin at /dev/null", async t => {
  const root = dirOf(); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "c");
  const spawned = await spawnCommand({ command: "cat; ps -o sid= -p $$; ps -o pid= -p $$", cwd: root, dir, env: process.env });
  await finished(dir);
  const [sid, pid] = readFileSync(join(dir, "output.log"), "utf8").trim().split(/\s+/).map(Number);
  assert.notEqual(sid, process.pid);
  assert.ok(sid === spawned.pid, `the wrapper leads the session (sid ${sid}, wrapper ${spawned.pid}, sh ${pid})`);
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
