// Native Windows leases: the command tree replaces the POSIX process group, and DSA_HOLD is not readable from another
// process, so the ticket's wrapper/command identities and their descendants decide liveness.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { leaseDir, leaseState, readTickets } from "../../../src/platform/lease.ts";

const win = process.platform === "win32";
const cli = fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url));
const unixOnly = win ? false : "Windows-only lease behaviour";
async function root(t: test.TestContext) { const home = await mkdtemp(join(tmpdir(), "dsa-hold-win-")); t.after(() => rm(home, { recursive: true, force: true })); return home; }
async function until<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) { const value = fn(); if (value) return value; if (performance.now() > end) throw new Error("Timed out"); await delay(25); }
}
interface Run { child: ChildProcess; exit: Promise<number | null>; stderr: () => string }
function run(home: string, args: string[]): Run {
  const child = spawn(process.execPath, [cli, "hold", ...args], { env: { ...process.env, DSA_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  return { child, exit: new Promise(resolve => child.once("exit", code => resolve(code))), stderr: () => stderr };
}
const granted = (home: string, resource: string, pid: number) => readTickets(home, resource).find(t => t.wrapper.pid === pid && t.grantedAt !== undefined);
const queued = (home: string, resource: string, pid: number) => readTickets(home, resource).find(t => t.wrapper.pid === pid && t.grantedAt === undefined);
/** A Node command that appends "<name>" and then runs for `ms`. */
const step = (file: string, name: string, ms = 0): string[] => [process.execPath, "-e",
  "const fs=require('fs');fs.appendFileSync(process.argv[1],process.argv[2]+'\\n');setTimeout(()=>process.exit(0),Number(process.argv[3]))", file, name, String(ms)];

test("Windows hold: exclusive holders run one after another; no-wait is refused while held", { skip: unixOnly, timeout: 30_000 }, async t => {
  const home = await root(t), file = join(home, "log");
  const a = run(home, ["machine", "--", ...step(file, "a", 900)]);
  await until(() => granted(home, "machine", a.child.pid!));
  const b = run(home, ["machine", "--no-wait", "--", ...step(file, "b")]);
  assert.equal(await b.exit, 75);
  assert.match(b.stderr(), /not free now/);
  assert.equal(await a.exit, 0);
  const c = run(home, ["machine", "--", ...step(file, "c")]);
  assert.equal(await c.exit, 0);
  assert.deepEqual((await readFile(file, "utf8")).trim().split(/\r?\n/), ["a", "c"]);
  await until(async () => (await readdir(leaseDir(home, "machine"))).filter(n => n.endsWith(".json")).length === 0);
});

test("Windows hold: shared holders overlap, an exclusive waiter queues, later shared waiters stay behind", { skip: unixOnly, timeout: 30_000 }, async t => {
  const home = await root(t), file = join(home, "log");
  const s1 = run(home, ["gpu", "--shared", "--", ...step(file, "s1", 900)]);
  const s2 = run(home, ["gpu", "--shared", "--", ...step(file, "s2", 900)]);
  await until(() => granted(home, "gpu", s1.child.pid!) && granted(home, "gpu", s2.child.pid!));
  const e = run(home, ["gpu", "--", ...step(file, "e", 100)]);
  await until(() => queued(home, "gpu", e.child.pid!));
  const s3 = run(home, ["gpu", "--shared", "--", ...step(file, "s3", 50)]);
  await until(() => queued(home, "gpu", s3.child.pid!));
  assert.deepEqual(await Promise.all([s1.exit, s2.exit, e.exit, s3.exit]), [0, 0, 0, 0]);
  const order = (await readFile(file, "utf8")).trim().split(/\r?\n/);
  assert.deepEqual(order.slice(0, 2).sort(), ["s1", "s2"], "shared holders overlap");
  assert.deepEqual(order.slice(2), ["e", "s3"], "the exclusive holder waits for both; the later shared holder waits behind it");
  const state = leaseState(home).find(r => r.resource === "gpu");
  assert.equal(state, undefined, "all tickets released");
});

test("Windows hold: a killed wrapper leaves the command's tree holding the lease until it ends", { skip: unixOnly, timeout: 30_000 }, async t => {
  const home = await root(t), file = join(home, "log");
  const a = run(home, ["machine", "--", ...step(file, "a", 1200)]);
  await until(() => granted(home, "machine", a.child.pid!));
  // The ticket is granted before the command starts; kill the wrapper only once the command's tree exists.
  await until(() => { try { return readFileSync(file, "utf8").includes("a"); } catch { return false; } });
  a.child.kill("SIGKILL");
  await a.exit;
  const b = run(home, ["machine", "--", ...step(file, "b")]);
  await until(() => queued(home, "machine", b.child.pid!));
  assert.equal(await b.exit, 0);
  assert.deepEqual((await readFile(file, "utf8")).trim().split(/\r?\n/), ["a", "b"]);
});
