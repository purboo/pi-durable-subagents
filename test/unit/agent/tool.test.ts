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
