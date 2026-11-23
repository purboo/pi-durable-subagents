// Native Windows leases: held commands run inside a per-ticket Windows Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
// whose durable handshake directory is written before the job owner starts and whose `group` record is written before
// ResumeThread, so killed wrappers retain the lease while the command runs and surviving grandchildren are ended before release.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { leaseDir, leaseJobDir, leaseState, readTickets } from "../../../src/platform/lease.ts";

const win = process.platform === "win32";
const cli = fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url));
const unixOnly = win ? false : "Windows-only lease behaviour";
async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "dsa-hold-win-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}));
  return home;
}
async function until<T>(fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) { const value = fn(); if (value) return value; if (performance.now() > end) throw new Error("Timed out"); await delay(25); }
}
interface Run { child: ChildProcess; exit: Promise<number | null>; stdout: () => string; stderr: () => string }
function run(home: string, args: string[], input?: string): Run {
  const child = spawn(process.execPath, [cli, "hold", ...args], {
    env: { ...process.env, DSA_HOME: home, NODE_TEST_CONTEXT: undefined, DSA_CALL: undefined, DSA_EXEC: undefined },
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (input !== undefined) child.stdin!.end(input);
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  return { child, exit: new Promise(resolve => child.once("exit", code => resolve(code))), stdout: () => stdout, stderr: () => stderr };
}
const granted = (home: string, resource: string, pid: number) => readTickets(home, resource).find(t => t.wrapper.pid === pid && t.grantedAt !== undefined);
const queued = (home: string, resource: string, pid: number) => readTickets(home, resource).find(t => t.wrapper.pid === pid && t.grantedAt === undefined);
/** A Node command that appends "<name>" and then runs for `ms`. */
const step = (file: string, name: string, ms = 0): string[] => [process.execPath, "-e",
  "const fs=require('fs');fs.appendFileSync(process.argv[1],process.argv[2]+'\\n');setTimeout(()=>process.exit(0),Number(process.argv[3]))", file, name, String(ms)];
/** A Node command that appends "<name>" and runs until `goFile` exists (eliminates fixed-sleep races on loaded runners). */
const gate = (file: string, name: string, goFile: string): string[] => [process.execPath, "-e",
  "const fs=require('fs');fs.appendFileSync(process.argv[1],process.argv[2]+'\\n');" +
  "const t=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(t);process.exit(0);}},15);",
  file, name, goFile];

test("Windows hold: exclusive holders run one after another; no-wait is refused while held", { skip: unixOnly, timeout: 60_000 }, async t => {
  const home = await root(t), file = join(home, "log"), go = join(home, "go-a");
  const a = run(home, ["machine", "--", ...gate(file, "a", go)]);
  try {
    await until(() => granted(home, "machine", a.child.pid!));
    const b = run(home, ["machine", "--no-wait", "--", ...step(file, "b")]);
    assert.equal(await b.exit, 75);
    assert.match(b.stderr(), /not free now/);
    await writeFile(go, "go");
    assert.equal(await a.exit, 0);
    const c = run(home, ["machine", "--", ...step(file, "c")]);
    assert.equal(await c.exit, 0);
    assert.deepEqual((await readFile(file, "utf8")).trim().split(/\r?\n/), ["a", "c"]);
    await until(async () => (await readdir(leaseDir(home, "machine"))).filter(n => n.endsWith(".json")).length === 0);
  } finally { await writeFile(go, "go").catch(() => {}); }
});

test("Windows hold: shared holders overlap, an exclusive waiter queues, later shared waiters stay behind", { skip: unixOnly, timeout: 60_000 }, async t => {
  const home = await root(t), file = join(home, "log"), go = join(home, "go-shared");
  const s1 = run(home, ["gpu", "--shared", "--", ...gate(file, "s1", go)]);
  const s2 = run(home, ["gpu", "--shared", "--", ...gate(file, "s2", go)]);
  try {
    await until(() => granted(home, "gpu", s1.child.pid!) && granted(home, "gpu", s2.child.pid!));
    await until(() => { try { return readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).length >= 2; } catch { return false; } });
    const e = run(home, ["gpu", "--", ...step(file, "e", 100)]);
    await until(() => queued(home, "gpu", e.child.pid!));
    const s3 = run(home, ["gpu", "--shared", "--", ...step(file, "s3", 50)]);
    await until(() => queued(home, "gpu", s3.child.pid!));
    await writeFile(go, "go");
    assert.deepEqual(await Promise.all([s1.exit, s2.exit, e.exit, s3.exit]), [0, 0, 0, 0]);
    const order = (await readFile(file, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(order.slice(0, 2).sort(), ["s1", "s2"], "shared holders overlap");
    assert.deepEqual(order.slice(2), ["e", "s3"], "the exclusive holder waits for both; the later shared holder waits behind it");
    const state = leaseState(home).find(r => r.resource === "gpu");
    assert.equal(state, undefined, "all tickets released");
  } finally { await writeFile(go, "go").catch(() => {}); }
});

test("Windows hold: a killed wrapper leaves the command's tree holding the lease until it ends", { skip: unixOnly, timeout: 60_000 }, async t => {
  const home = await root(t), file = join(home, "log"), go = join(home, "go-kill");
  const a = run(home, ["machine", "--", ...gate(file, "a", go)]);
  try {
    await until(() => granted(home, "machine", a.child.pid!));
    // The ticket is granted before the command starts; kill the wrapper only once the command's tree exists.
    await until(() => { try { return readFileSync(file, "utf8").includes("a"); } catch { return false; } });
    a.child.kill("SIGKILL");
    await a.exit;
    const b = run(home, ["machine", "--", ...step(file, "b")]);
    await until(() => queued(home, "machine", b.child.pid!));
    await writeFile(go, "go");
    assert.equal(await b.exit, 0);
    assert.deepEqual((await readFile(file, "utf8")).trim().split(/\r?\n/), ["a", "b"]);
  } finally { await writeFile(go, "go").catch(() => {}); }
});

test("Windows hold: surviving detached grandchildren end before release (normal and killed-wrapper)", { skip: unixOnly, timeout: 90_000 }, async t => {
  const home = await root(t);
  const spawnWithDetachedGrandchild = (pidFile: string, goFile: string): string[] => [
    process.execPath, "-e",
    [
      "const { spawn } = require('node:child_process');",
      "const { existsSync, writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref();",
      "writeFileSync(process.argv[1], String(g.pid));",
      "const tick = setInterval(() => { if (existsSync(process.argv[2])) { clearInterval(tick); process.exit(0); } }, 15);",
    ].join(""),
    pidFile, goFile,
  ];
  const verifyDeadCmd = (pidFile: string, outFile: string): string[] => [
    process.execPath, "-e",
    [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "const pid = Number(readFileSync(process.argv[1], 'utf8'));",
      "let alive = true; try { process.kill(pid, 0); } catch { alive = false; }",
      "writeFileSync(process.argv[2], alive ? 'alive' : 'dead');",
      "process.exit(alive ? 99 : 0);",
    ].join(""),
    pidFile, outFile,
  ];

  // 1. Normal exit: root exits while detached grandchild still runs -> grandchild is ended before next holder runs.
  const pid1 = join(home, "grand1.pid"), go1 = join(home, "go1"), res1 = join(home, "res1");
  const a1 = run(home, ["machine", "--", ...spawnWithDetachedGrandchild(pid1, go1)]);
  await until(() => existsSync(pid1));
  const w1 = run(home, ["machine", "--", ...verifyDeadCmd(pid1, res1)]);
  await until(() => queued(home, "machine", w1.child.pid!));
  await writeFile(go1, "go");
  assert.deepEqual(await Promise.all([a1.exit, w1.exit]), [0, 0]);
  assert.equal(await readFile(res1, "utf8"), "dead");

  // 2. Killed wrapper: wrapper is SIGKILLed while root + detached grandchild run; root exits -> grandchild ends before w2 runs.
  const pid2 = join(home, "grand2.pid"), go2 = join(home, "go2"), res2 = join(home, "res2");
  const a2 = run(home, ["machine", "--", ...spawnWithDetachedGrandchild(pid2, go2)]);
  await until(() => existsSync(pid2));
  a2.child.kill("SIGKILL");
  await a2.exit;
  const w2 = run(home, ["machine", "--", ...verifyDeadCmd(pid2, res2)]);
  await until(() => queued(home, "machine", w2.child.pid!));
  await writeFile(go2, "go");
  assert.equal(await w2.exit, 0);
  assert.equal(await readFile(res2, "utf8"), "dead");
});

test("Windows hold: durable job group precedes user code; stdio, exit code and --yield preserve contracts", { skip: unixOnly, timeout: 90_000 }, async t => {
  const home = await root(t), proof = join(home, "proof.json");
  // Verify durable ticket.jobDir + group record already exist BEFORE the command's very first action, plus stdio & exit 17.
  const check = run(home, ["machine", "--", process.execPath, "-e", [
    "const fs = require('node:fs'), path = require('node:path');",
    "const jobDir = process.argv[1], out = process.argv[2];",
    "const group = JSON.parse(fs.readFileSync(path.join(jobDir, 'group'), 'utf8'));",
    "const stdin = fs.readFileSync(0, 'utf8');",
    "fs.writeFileSync(out, JSON.stringify({ matchPid: group.pid === process.pid, hasStart: /^\\d+$/.test(group.start), hasOwner: /^\\d+$/.test(group.group?.start ?? ''), tag: process.env.DSA_HOLD, stdin }));",
    "process.stdout.write('out:' + stdin.trim());",
    "process.stderr.write('err:ok');",
    "process.exit(17);",
  ].join(""), leaseJobDir(home, "machine", 1), proof], "hello-stdin\n");
  assert.equal(await check.exit, 17);
  assert.equal(check.stdout(), "out:hello-stdin");
  assert.match(check.stderr(), /err:ok/);
  assert.deepEqual(JSON.parse(await readFile(proof, "utf8")), {
    matchPid: true, hasStart: true, hasOwner: true, tag: "machine:1", stdin: "hello-stdin\n",
  });

  // Verify --yield stops the Job Object (including detached grandchildren) and exits 75 before the waiter runs.
  const gPidFile = join(home, "yield-grand.pid"), checkOut = join(home, "yield-check");
  const y = run(home, ["machine", "--yield", "--", process.execPath, "-e", [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join(""), gPidFile]);
  await until(() => existsSync(gPidFile));
  const waiter = run(home, ["machine", "--", process.execPath, "-e", [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const pid = Number(readFileSync(process.argv[1], 'utf8'));",
    "let alive = true; try { process.kill(pid, 0); } catch { alive = false; }",
    "writeFileSync(process.argv[2], alive ? 'alive' : 'dead');",
  ].join(""), gPidFile, checkOut]);
  assert.equal(await y.exit, 75);
  assert.match(y.stderr(), /hold: yielded machine/);
  assert.equal(await waiter.exit, 0);
  assert.equal(await readFile(checkOut, "utf8"), "dead");
});
