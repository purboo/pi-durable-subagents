// `drill failover` end to end: the public CLI entry in its own process, with pi from this repository on PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { orchLedger } from "../../../src/paths.ts";
import { REPO } from "../../harness/pi.ts";

const exec = promisify(execFile);
test("drill failover --json: every step passes and the temporary root is removed", { timeout: 150_000 }, async t => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}` };
  for (const key of ["DSA_EXEC", "DSA_CALL", "DSA_HOME", "DSA_JOURNAL", "DSA_INBOX", "DSA_MODEL"]) delete env[key];
  const { stdout, stderr } = await exec(process.execPath, [join(REPO, "src/cli/main.ts"), "drill", "failover", "--json"], { env, cwd: REPO, timeout: 140_000 });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  t.diagnostic(report.steps.map((s: { step: number; ms: number; detail: string }) => `${s.step} ${s.ms}ms ${s.detail}`).join("\n"));
  assert.equal(report.drill, "failover");
  assert.deepEqual(report.steps.map((s: { step: number; ok: boolean }) => [s.step, s.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true]], JSON.stringify(report.steps));
  assert.equal(report.passed, true);
  assert.ok(report.ms < 120_000, `took ${report.ms} ms`);
  assert.equal(report.evidence, undefined);
});
test("drill failover --keep prints each step, the kept root and one summary line", { timeout: 150_000 }, async t => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}` };
  for (const key of ["DSA_EXEC", "DSA_CALL", "DSA_HOME", "DSA_JOURNAL", "DSA_INBOX", "DSA_MODEL"]) delete env[key];
  const { stdout } = await exec(process.execPath, [join(REPO, "src/cli/main.ts"), "drill", "failover", "--keep"], { env, cwd: REPO, timeout: 140_000 });
  t.diagnostic(stdout);
  for (let n = 1; n <= 5; n++) assert.match(stdout, new RegExp(`^  ${n}\\. pass `, "m"));
  const kept = /^  kept: (\S+)$/m.exec(stdout)?.[1];
  assert.ok(kept && existsSync(join(kept, "report.json")), stdout);
  assert.match(stdout.trim().split("\n").at(-1)!, /^failover drill: pass \(5\/5 steps, [\d.]+ s\)$/);
  const { rm } = await import("node:fs/promises"); await rm(kept!, { recursive: true, force: true });
});
for (const [signal, keep, code] of [["SIGINT", false, 130], ["SIGTERM", true, 143]] as const)
  test(`drill failover interrupted by ${signal}${keep ? " with --keep" : ""}: stops its orchestrator, ${keep ? "keeps and prints" : "removes"} the root, exits ${code}`, { timeout: 90_000 }, async t => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}` };
    for (const key of ["DSA_EXEC", "DSA_CALL", "DSA_HOME", "DSA_JOURNAL", "DSA_INBOX", "DSA_MODEL"]) delete env[key];
    const child = spawn(process.execPath, [join(REPO, "src/cli/main.ts"), "drill", "failover", ...(keep ? ["--keep"] : [])], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const exited = new Promise<number | null>(resolve => child.once("close", resolve));
    const until = async <T>(get: () => T, label: string) => {
      const end = Date.now() + 60_000;
      for (;;) { const v = get(); if (v) return v; if (Date.now() > end) { child.kill("SIGKILL"); throw new Error(`${label}: ${out}`); } await delay(50); }
    };
    const home = await until(() => /isolated home (\S+), probe/.exec(out)?.[1], "drill started");
    // Interrupt once the drill's orchestrator runs, so the cleanup has something of its own to stop.
    const pid = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === "orchestrator")?.pid, "orchestrator started");
    child.kill(signal);
    assert.equal(await exited, code, out);
    t.diagnostic(out);
    assert.match(out, new RegExp(`failover drill: interrupted by ${signal}`));
    assert.throws(() => process.kill(Number(pid), 0), "the drill's orchestrator was stopped");
    const root = join(home, "..");
    if (keep) { assert.match(out, new RegExp(`kept: ${root}`)); assert.ok(existsSync(root)); await rm(root, { recursive: true, force: true }); }
    else assert.ok(!existsSync(root), `root left behind: ${root}`);
  });
