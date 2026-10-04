import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { chaos } from "../../../src/cli/chaos/index.ts";

const exec = promisify(execFile);
test("AC2 / AC4: all nine faults use real main, orchestrator, evaluator and child sessions", { timeout: 240_000 }, async t => {
  let output = "";
  const code = await chaos(["--keep", "--json"], process.env, text => { output += text; });
  const report = JSON.parse(output); t.diagnostic(`durable evidence: ${report.evidence}`);
  assert.equal(code, 0, output); assert.equal(report.results.length, 9);
  assert.ok(report.results.reduce((sum: number, r: { wakes: number }) => sum + r.wakes, 0) >= 9, "idle completions must count as native pi wakes");
  for (const result of report.results) {
    assert.equal(result.passed, true); assert.equal(result.duplicateRuns, 0);
    assert.equal(result.lostResults, 0); assert.equal(result.restartedFromScratch, 0);
    assert.ok(result.wakes <= 6 + result.questions);
    assert.match(readFileSync(join(result.evidence, "main.jsonl"), "utf8"), /"toolName":"subagents"/);
    assert.ok(existsSync(join(result.evidence, "hosts.jsonl")));
  }
});
test("CLI entry runs one offline scenario and prints a readable kept-root summary", { timeout: 60_000 }, async t => {
  const { stdout, stderr } = await exec(process.execPath, ["src/cli/main.ts", "chaos", "--scenario", "3", "--keep"], { timeout: 55_000 });
  assert.equal(stderr, ""); assert.match(stdout, /duplicate runs \.{8} 0/);
  assert.match(stdout, /scenario 3 .* pass/); assert.match(stdout, /kept: \/.*dsa-chaos-/);
  t.diagnostic(stdout.trim());
});
