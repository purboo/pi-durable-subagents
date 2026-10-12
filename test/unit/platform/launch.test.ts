// Starting the orchestrator: pi resolved by the starter, a systemd scope of its own when one is available.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { findOnPath, launchOrchestrator, PiNotFound, resolvePi, scopeRunner, SCOPE_ARGS, type Spawner } from "../../../src/platform/launch.ts";
import { startOrchestrator } from "../../../src/cli/control.ts";
import { orchLedger } from "../../../src/paths.ts";
import { serviceFiles } from "../../../src/cli/service.ts";

async function root(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dsa-launch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function executable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n") {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name); await writeFile(file, body); await chmod(file, 0o755); return file;
}
/** A spawner that records its calls; `fail` names commands whose launch errors (as a missing binary does). */
function recorder(fail: (command: string) => boolean = () => false) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, env: options.env ?? {} });
    const child = Object.assign(new EventEmitter(), { pid: 4242 + calls.length, unref() {} });
    queueMicrotask(() => fail(command) ? child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })) : child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

test("pi resolves from DSA_PI_BIN (an executable file) or the first pi on PATH, unresolved", async t => {
  const dir = await root(t), real = await executable(join(dir, "store"), "pi-real");
  await mkdir(join(dir, "shims")); await symlink(real, join(dir, "shims", "pi"));
  await executable(join(dir, "later"), "pi");
  await mkdir(join(dir, "empty"));
  await writeFile(join(dir, "empty", "pi"), "not executable");
  const PATH = [join(dir, "empty"), join(dir, "shims"), join(dir, "later")].join(":");
  // A package-manager shim stays the shim (its target may change on an update).
  assert.deepEqual(resolvePi({ PATH }), { path: join(dir, "shims", "pi"), source: "PATH" });
  assert.equal(findOnPath("pi", join(dir, "empty")), undefined, "a file without the executable bit is no pi");
  assert.deepEqual(resolvePi({ PATH, DSA_PI_BIN: real }), { path: real, source: "DSA_PI_BIN" });
  assert.match(String(resolvePi({ PATH, DSA_PI_BIN: join(dir, "empty", "pi") }).problem), /DSA_PI_BIN=.* is not an absolute path to an executable file/);
  assert.match(String(resolvePi({ PATH, DSA_PI_BIN: "pi" }).problem), /not an absolute path/);
  assert.match(String(resolvePi({ PATH: join(dir, "empty") }).problem), /pi was not found on PATH \(.*empty\) and DSA_PI_BIN is not set/);
  assert.match(String(resolvePi({}).problem), /PATH \(unset\)/);
});

test("the CLI starter refuses to start an orchestrator without pi and starts none; the error names PATH and DSA_PI_BIN", async t => {
  const home = await root(t), empty = join(home, "empty"); await mkdir(empty);
  const error = await startOrchestrator(home, { PATH: empty, HOME: home }).then(() => undefined, (e: Error) => e);
  assert.ok(error instanceof PiNotFound, String(error));
  assert.match(error.message, /^cannot start the orchestrator: pi was not found on PATH .* and DSA_PI_BIN is not set\. Set DSA_PI_BIN/);
  assert.match(error.message, /stays pending: it runs when an orchestrator starts from an environment that has pi/);
  // The refusal comes before any launch: nothing was started that could create the ledger later.
  assert.equal(existsSync(orchLedger(home)), false, "no orchestrator ran");
  // The pi-session starter's mode (requirePi off) starts it anyway, without DSA_PI_BIN.
  const { calls, spawn } = recorder();
  await launchOrchestrator("/entry.js", { PATH: empty }, { home, spawn, platform: "darwin" });
  assert.equal(calls.length, 1); assert.equal(calls[0]!.env.DSA_PI_BIN, undefined);
});

test("the starter passes the resolved pi as DSA_PI_BIN and never the starting session", async t => {
  const dir = await root(t), bin = join(dir, "bin"), pi = await executable(bin, "pi");
  const { calls, spawn } = recorder();
  const launched = await launchOrchestrator("/entry.js", { PATH: bin, DSA_SESSION: "s1", OTHER: "x" }, { home: "/h", spawn, platform: "darwin", requirePi: true, node: "/node" });
  assert.deepEqual(launched, { pid: 4243, scope: false, pi });
  assert.deepEqual(calls.map(c => [c.command, c.args]), [["/node", ["/entry.js"]]]);
  assert.deepEqual(calls[0]!.env, { PATH: bin, OTHER: "x", DSA_HOME: "/h", DSA_PI_BIN: pi });
});

test("scope launch selection: systemd-run on Linux with a user manager when its probe works, else a detached process", async t => {
  const dir = await root(t), bin = join(dir, "bin"), runner = await executable(bin, "systemd-run");
  await executable(bin, "pi");
  const env = { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" };
  const probes: string[][] = [];
  const probe = (ok: boolean) => async (command: string, args: string[], options: { timeoutMs: number }) => { probes.push([command, ...args]); assert.ok(options.timeoutMs <= 5000); return ok; };
  // Works: the scope runs node with the entry.
  let r = recorder();
  assert.deepEqual(await launchOrchestrator("/entry.js", env, { home: "/h", node: "/node", platform: "linux", probe: probe(true), spawn: r.spawn }), { pid: 4243, scope: true, pi: join(bin, "pi") });
  assert.deepEqual(probes, [[runner, ...SCOPE_ARGS, "true"]]);
  assert.deepEqual(r.calls.map(c => [c.command, c.args]), [[runner, ["--user", "--scope", "--quiet", "--collect", "--description", "pi-durable-subagents orchestrator", "--", "/node", "/entry.js"]]]);
  assert.equal(r.calls[0]!.env.DSA_HOME, "/h");
  // A failing probe: the plain detached process.
  r = recorder();
  assert.equal((await launchOrchestrator("/entry.js", env, { home: "/h", node: "/node", platform: "linux", probe: probe(false), spawn: r.spawn })).scope, false);
  assert.deepEqual(r.calls.map(c => c.command), ["/node"]);
  // The probe worked but the scope launch failed: the plain detached process.
  r = recorder(command => command === runner);
  assert.equal((await launchOrchestrator("/entry.js", env, { home: "/h", node: "/node", platform: "linux", probe: probe(true), spawn: r.spawn })).scope, false);
  assert.deepEqual(r.calls.map(c => c.command), [runner, "/node"]);
  // Never probed: DSA_SCOPE=off, another platform, no XDG_RUNTIME_DIR, no systemd-run on PATH.
  probes.length = 0;
  assert.equal(await scopeRunner({ ...env, DSA_SCOPE: "off" }, { platform: "linux", probe: probe(true) }), undefined);
  assert.equal(await scopeRunner(env, { platform: "darwin", probe: probe(true) }), undefined);
  assert.equal(await scopeRunner({ PATH: bin }, { platform: "linux", probe: probe(true) }), undefined);
  assert.equal(await scopeRunner({ ...env, PATH: join(dir, "none") }, { platform: "linux", probe: probe(true) }), undefined);
  assert.deepEqual(probes, []);
  // A probe that throws counts as failing.
  assert.equal(await scopeRunner(env, { platform: "linux", probe: async () => { throw new Error("boom"); } }), undefined);
});

const cgroupOf = (pid: number | "self") => readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(l => l.startsWith("0::"));
test("on this host: the orchestrator runs in its own scope, outside the starter's cgroup", {
  skip: process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR || !findOnPath("systemd-run", process.env.PATH) || !cgroupOf("self") ? "needs Linux with a systemd user manager (cgroup v2)" : false,
  timeout: 20000 }, async t => {
  const dir = await root(t), out = join(dir, "out.txt");
  // A stand-in orchestrator: records its pid and cgroup, then waits to be stopped.
  const entry = join(dir, "entry.mjs");
  await writeFile(entry, `import { readFileSync, renameSync, writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(out + ".tmp")}, process.pid + "\\n" + readFileSync("/proc/self/cgroup", "utf8"));\n` +
    `renameSync(${JSON.stringify(out + ".tmp")}, ${JSON.stringify(out)});\nsetInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, DSA_PI_BIN: process.execPath };
  delete env.DSA_SCOPE;
  const launched = await launchOrchestrator(entry, env, { home: dir });
  t.after(() => { try { process.kill(launched.pid, "SIGKILL"); } catch { /* exited */ } });
  if (!launched.scope) return t.skip("systemd-run --user --scope is not usable here");
  const deadline = Date.now() + 10_000;
  while (!existsSync(out) && Date.now() < deadline) await delay(20);
  const [pid, ...cgroup] = (await readFile(out, "utf8")).split("\n");
  assert.equal(Number(pid), launched.pid, "the scope execs the orchestrator: its pid is the one returned");
  const own = cgroup.find(l => l.startsWith("0::"))!;
  assert.notEqual(own, cgroupOf("self"));
  assert.match(own, /\.scope$/);
  process.kill(launched.pid, "SIGTERM");
  const gone = Date.now() + 5000;
  while (Date.now() < gone) { try { process.kill(launched.pid, 0); } catch { break; } await delay(20); }
});

test("the starter service carries the pi resolved at install as DSA_PI_BIN", async () => {
  const [unit] = serviceFiles("/home/u", "/state", "/cli.js", "linux", "/node", "/opt/bin/pi");
  assert.match(unit!.content, /\nEnvironment="DSA_PI_BIN=\/opt\/bin\/pi"\n/);
  assert.doesNotMatch(serviceFiles("/home/u", "/state", "/cli.js", "linux", "/node")[0]!.content, /DSA_PI_BIN/);
  assert.match(serviceFiles("/home/u", "/state", "/cli.js", "darwin", "/node", "/opt/bin/pi")[0]!.content, /<key>DSA_PI_BIN<\/key><string>\/opt\/bin\/pi<\/string>/);
});
