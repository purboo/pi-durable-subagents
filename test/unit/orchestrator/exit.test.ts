// The orchestrator records why it exits and which pi it launches; doctor shows both; its start removes stale temp files.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { findOnPath } from "../../../src/platform/launch.ts";
import { binDir, orchLedger } from "../../../src/paths.ts";
import { main } from "../../../src/orchestrator/main.ts";
import { doctor, renderDoctor } from "../../../src/cli/doctor.ts";
import { writeShim } from "../../../src/platform/lease.ts";
import { fakeExecutor } from "./engine/fake.ts";

async function home(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dsa-exit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function withEnv(t: TestContext, values: Record<string, string | undefined>) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
const discovery = (h: string) => ({ home: h, agentDir: join(h, "config"), globalNpmRoot: null });
const last = (h: string, type: string) => readJournalSnapshot(orchLedger(h)).findLast(e => e.type === type);

test("an idle exit is recorded as idle, with the pi resolved at start", { timeout: 20000 }, async t => {
  const h = await home(t), pi = join(h, "tools", "pi");
  await mkdir(join(h, "tools")); await writeFile(pi, "#!/bin/sh\n"); await chmod(pi, 0o755);
  // An invalid DSA_PI_BIN falls back to this PATH in the orchestrator.
  withEnv(t, { DSA_PI_BIN: join(h, "missing"), PATH: `${join(h, "tools")}:${process.env.PATH}` });
  await main({ home: h, config: { k: { idleExitMs: 50 } }, executor: ledgers => fakeExecutor(ledgers), discovery: discovery(h) });
  assert.equal(last(h, "orchestrator")!.pi, pi);
  const exit = last(h, "orchestrator-exit")!;
  assert.equal(exit.reason, "idle"); assert.equal(exit.pid, process.pid);
  const report = await doctor(h, { HOME: h });
  assert.equal(report.pi, pi);
  assert.equal(report.lastExit?.reason, "idle");
  assert.match(renderDoctor(report), /orchestrator: not running; last exit: idle 0m ago/);
  assert.match(renderDoctor(report), new RegExp(`^pi: ${pi}$`, "m"));
});

test("a signal exit is recorded with the signal's name; without pi the start records pi: null", { timeout: 20000 }, async t => {
  const h = await home(t), tools = join(h, "tools");
  // A PATH without pi that still has what the OS lock needs (perl or python3 for flock).
  await mkdir(tools);
  for (const name of ["perl", "python3"]) { const found = findOnPath(name, process.env.PATH); if (found) await symlink(found, join(tools, name)); }
  withEnv(t, { DSA_PI_BIN: undefined, PATH: tools });
  t.mock.method(console, "error", () => {});
  const controller = new AbortController();
  const run = main({ home: h, signal: controller.signal, config: { k: { idleExitMs: 60_000 } }, executor: ledgers => fakeExecutor(ledgers), discovery: discovery(h) });
  for (let i = 0; i < 500 && !last(h, "orchestrator"); i++) await delay(10);
  controller.abort("SIGTERM"); await run;
  assert.equal(last(h, "orchestrator")!.pi, null);
  const exit = last(h, "orchestrator-exit")!;
  assert.equal(exit.reason, "signal"); assert.equal(exit.signal, "SIGTERM");
  const text = renderDoctor(await doctor(h, { HOME: h }));
  assert.match(text, /last exit: signal SIGTERM/);
  assert.match(text, /^pi: not found .*DSA_PI_BIN/m);
});

test("an orchestrator that ended without an exit record shows as killed or crashed", { timeout: 10000 }, async t => {
  const h = await home(t);
  const ledger = await openJournal(orchLedger(h));
  await ledger.append("orchestrator", { version: "1.0.0", pid: 999_999_999, pi: "/x/pi" }); await ledger.close();
  const report = await doctor(h, { HOME: h });
  assert.equal(report.lastExit?.reason, "unrecorded");
  assert.match(renderDoctor(report), /no exit recorded \(killed or crashed\)/);
});

test("the start removes temp files in bin older than 10 minutes and keeps newer ones", { timeout: 20000 }, async t => {
  const h = await home(t), bin = binDir(h);
  await mkdir(bin, { recursive: true });
  const old = join(bin, "pi-durable-subagents.123.tmp"), fresh = join(bin, "pi-durable-subagents.456.tmp");
  await writeFile(old, ""); await writeFile(fresh, "");
  const hourAgo = new Date(Date.now() - 3_600_000); await utimes(old, hourAgo, hourAgo);
  await main({ home: h, config: { k: { idleExitMs: 50 } }, executor: ledgers => fakeExecutor(ledgers), discovery: discovery(h) });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("writeShim removes its temp file when the write fails", async t => {
  const h = await home(t), bin = join(h, "bin");
  // The shim's name is a non-empty directory: the rename over it fails after the temp file was written.
  await mkdir(join(bin, "pi-durable-subagents", "x"), { recursive: true });
  assert.throws(() => writeShim(bin, process.execPath, "/entry.js"));
  assert.deepEqual(readdirSync(bin).filter(n => n.endsWith(".tmp")), []);
  // And a working write leaves none either.
  await rm(join(bin, "pi-durable-subagents"), { recursive: true });
  writeShim(bin, process.execPath, "/entry.js");
  assert.deepEqual(readdirSync(bin), ["pi-durable-subagents"]);
});
