import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "../../../src/agent/main/tool.ts";

test("P31a, P36, P11: run carries workflow-level budget, spawn limit and resolved input files, not as call fields", () => {
  const { body } = request({ action: "run", workflow: "flow.js", usageBudget: { tokens: 5000 }, maxCalls: 7, inputs: { plan: "plan.json" }, name: "nightly" }, "/w");
  assert.deepEqual(body, { cwd: "/w", workflow: "/w/flow.js", name: "nightly", usageBudget: { tokens: 5000 }, maxCalls: 7, inputs: { plan: "/w/plan.json" } });
  const single = request({ action: "run", agent: "worker", task: "t", usageBudget: { costUsd: 1 }, by: "user" }, "/w").body as { call: Record<string, unknown> };
  assert.deepEqual(single.call, { agent: "worker", task: "t" });
  assert.throws(() => request({ action: "run", workflow: "f.js", usageBudget: {} }, "/w"), /usageBudget/);
  assert.throws(() => request({ action: "run", workflow: "f.js", maxCalls: 0 }, "/w"), /maxCalls/);
});

test("T2/T3/T11: invalid call specs fail at the tool with every error; user keys pass through for fan-out", () => {
  assert.throws(() => request({ action: "run", agent: "w", task: "t", isolaton: "worktree", context: "inherit" }, "/w"),
    { message: 'Invalid call: unknown field "isolaton"; context must be "fresh" or "fork"' });
  assert.deepEqual(request({ action: "run", agent: "w", task: "t", key: "a" }, "/w").body, { cwd: "/w", call: { agent: "w", task: "t", key: "a" } }, "a single call may name its key");
  assert.throws(() => request({ action: "run", tasks: [{ agent: "w", task: "a" }, { agent: "w", task: "b", isolation: "vm" }] }, "/w"),
    { message: 'Invalid tasks[1]: isolation must be "none" or "worktree"' });
  assert.throws(() => request({ action: "run", chain: [{ agent: "w", task: "a", schema: { type: "string", minLength: 2 } }] }, "/w"),
    { message: 'Invalid chain[0]: schema: unsupported keyword "minLength"' });
  assert.throws(() => request({ action: "run", tasks: [{ agent: "w", task: "a", key: "k" }, { agent: "w", task: "b", key: "k" }] }, "/w"), /duplicate key "k"/);
  const { body } = request({ action: "run", chain: [{ agent: "w", task: "a", key: "plan", cwd: "" }, { agent: "w", task: "{previous}" }] }, "/w");
  assert.deepEqual(body, { cwd: "/w", chain: [{ agent: "w", task: "a", key: "plan", cwd: "/w" }, { agent: "w", task: "{previous}" }] });
});
