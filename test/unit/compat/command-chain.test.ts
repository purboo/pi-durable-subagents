// Command steps in compiled fanouts: a command step runs unchanged (no {previous}), an agent step after it gets its output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { FANOUT_BODIES, compileFanout } from "../../../src/compat/fanout.ts";
import { plannedFromScript } from "../../../src/orchestrator/snapshot.ts";
import type { CallResult, CallSpec } from "../../../src/types.ts";

const ok = (key: string, output: string): CallResult => ({ key, gen: 1, status: "ok", ok: true, output });

test("chain: a command step runs unchanged, an agent step after it gets the command's output as {previous}", async () => {
  const compiled = compileFanout({ chain: [
    { command: ["echo", "{previous}"], key: "build" } as unknown as CallSpec, { agent: "w", task: "fix: {previous}" },
    { command: "grep -c {previous} log" } as CallSpec, { agent: "w", task: "again: {previous}" },
  ] });
  const calls: { key: string; spec: CallSpec }[] = [];
  const run = async (key: string, spec: CallSpec) => {
    calls.push({ key, spec });
    return ok(key, spec.command !== undefined ? `out of ${key}` : `agent ${key}`);
  };
  const results = await runInNewContext(`(async () => {${compiled.source}})()`, { runs: { run }, emit: () => assert.fail("no skips") });
  assert.equal(results.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { key: "build", spec: { command: ["echo", "{previous}"] } },
    { key: "chain:1", spec: { agent: "w", task: "fix: out of build" } },
    { key: "chain:2", spec: { command: "grep -c {previous} log" } },
    { key: "chain:3", spec: { agent: "w", task: "again: out of chain:2" } }]);
});

test("chain: a failed command step skips the rest; tasks with command steps pass them through", async () => {
  const chain = compileFanout({ chain: [{ command: "false" } as CallSpec, { agent: "w", task: "{previous}" }] });
  const events: unknown[] = [];
  const results = await runInNewContext(`(async () => {${chain.source}})()`, {
    runs: { run: async (key: string) => ({ ...ok(key, "Command exited 1"), ok: false, status: "failed" }) }, emit: (e: unknown) => events.push(e) });
  assert.deepEqual(JSON.parse(JSON.stringify(results)).map((r: CallResult) => r.status), ["failed", "skipped"]);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ type: "skipped", keys: ["chain:1"] }]);
  const tasks = compileFanout({ tasks: [{ command: ["a"], env: { X: "1" } } as unknown as CallSpec, { agent: "w", task: "t" }] });
  let seen: unknown;
  await runInNewContext(`(async () => {${tasks.source}})()`, { runs: { all: async (list: unknown[]) => { seen = list; return []; } } });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ command: ["a"], env: { X: "1" }, key: "tasks:0" }, { agent: "w", task: "t", key: "tasks:1" }]);
  assert.throws(() => compileFanout({ chain: [{ command: "true", task: "x" } as CallSpec] }), /Invalid chain step 0: task is not allowed in a command call/);
});

test("planned totals still recognize chains pinned before command calls", () => {
  const steps = [{ key: "chain:0", spec: { agent: "x", task: "t" } }, { key: "chain:1", spec: { agent: "x", task: "{previous}" } }];
  // The chain body of 1.0.43 and earlier, as pinned in existing workflows.
  const legacy = `const steps = ${JSON.stringify(steps)};\n` + FANOUT_BODIES[2];
  assert.match(legacy, /runs\.run\(key, \{\.\.\.spec, task: spec\.task\.replaceAll/);
  assert.equal(plannedFromScript(legacy), 2);
  assert.equal(plannedFromScript(compileFanout({ chain: [{ command: "true" } as CallSpec, { agent: "x", task: "t" }] }).source), 2);
});
