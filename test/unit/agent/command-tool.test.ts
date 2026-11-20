// Command calls at the tool: a single command call is a launch form of its own, run-level defaults apply per step kind,
// a command beside a list is refused, and agent checks skip command steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAgents, request } from "../../../src/agent/main/tool.ts";
import { parameters } from "../../../src/agent/main/schema.ts";
import type { RunBody } from "../../../src/types.ts";

test("command call: a single command is a launch form of its own, with and without action", { skip: process.platform === "win32" ? "expected POSIX paths; Windows resolves them against the drive" : false }, () => {
  for (const args of [{ command: ["npm", "test"], cwd: "repo", timeoutMs: 5 }, { action: "run", command: ["npm", "test"], cwd: "repo", timeoutMs: 5 }]) {
    const normalized = request(args, "/w");
    assert.equal(normalized.kind, "run");
    assert.deepEqual(normalized.body, { cwd: "/w", call: { command: ["npm", "test"], cwd: "/w/repo", timeoutMs: 5 } });
  }
  assert.deepEqual(request({ command: "sleep 1; exit 3", env: { A: "b" }, rerun: true, writer: true, key: "wait" }, "/w").body,
    { cwd: "/w", call: { command: "sleep 1; exit 3", env: { A: "b" }, rerun: true, writer: true, key: "wait" } });
  // Validation is the pinned one: agent-only fields are refused, so is a command beside another launch form.
  assert.throws(() => request({ command: "true", model: "p/m" }, "/w"), { message: "Invalid call: model is not allowed in a command call" });
  assert.throws(() => request({ command: "true", agent: "a", task: "t" }, "/w"), /agent is not allowed in a command call; task is not allowed in a command call/);
  assert.throws(() => request({ command: "true", workflow: "x.js" }, "/w"), /action is required/);
  assert.throws(() => request({ action: "run", command: "true", source: "return 1" }, "/w"), /run requires exactly one of workflow, source, tasks, chain, agent\/task or command/);
  assert.throws(() => request({ action: "run", agent: "a", task: "t", env: { A: "b" } }, "/w"), /env is only allowed in a command call/);
});

test("command call: beside tasks/chain it is refused with what to do", () => {
  for (const args of [{ tasks: [{ agent: "a", task: "t" }], command: "true" }, { action: "run", tasks: [{ agent: "a", task: "t" }], command: ["true"] }])
    assert.throws(() => request(args, "/w"), { message: "command cannot be set beside tasks: put it in a step ({command, ...}); a top-level command is a single command call" });
  assert.throws(() => request({ chain: [{ command: "true" }], command: "true" }, "/w"), /^Error: command cannot be set beside chain: put it in a step/);
});

test("command steps: agent-only run-level defaults skip them; env and rerun apply to command steps only; timeoutMs and writer to both", () => {
  const { body } = request({ tasks: [{ task: "review" }, { command: ["make"], key: "build" }, { command: "true", timeoutMs: 7, env: { OWN: "1" } }],
    agent: "reviewer", model: "p/m", budget: { tokens: 9 }, isolation: "worktree", context: "fresh", tools: ["read"], skills: ["s"], once: true,
    timeoutMs: 1000, writer: false, env: { CI: "1" }, rerun: true }, "/w");
  assert.deepEqual((body as RunBody).tasks, [
    { agent: "reviewer", task: "review", model: "p/m", budget: { tokens: 9 }, isolation: "worktree", context: "fresh", tools: ["read"], skills: ["s"], once: true, timeoutMs: 1000, writer: false },
    { command: ["make"], key: "build", timeoutMs: 1000, writer: false, env: { CI: "1" }, rerun: true },
    { command: "true", timeoutMs: 7, env: { OWN: "1" }, writer: false, rerun: true }]);
  const chain = request({ chain: [{ command: "make test" }, { agent: "w", task: "fix: {previous}" }], model: "p/m" }, "/w").body as RunBody;
  assert.deepEqual(chain.chain, [{ command: "make test" }, { agent: "w", task: "fix: {previous}", model: "p/m" }]);
  // A step that sets an agent-only field itself stays invalid, and a run-level env with only agent steps does nothing.
  assert.throws(() => request({ tasks: [{ command: "true", model: "p/own" }] }, "/w"), { message: "Invalid tasks[0]: model is not allowed in a command call" });
  assert.throws(() => request({ tasks: [{ agent: "a", task: "t", rerun: true }] }, "/w"), { message: "Invalid tasks[0]: rerun is only allowed in a command call" });
  assert.deepEqual((request({ tasks: [{ agent: "a", task: "t" }], env: { A: "b" }, rerun: true }, "/w").body as RunBody).tasks, [{ agent: "a", task: "t" }]);
  // A run-level default that does not fit a command step is still validated for the agent steps it applies to.
  assert.throws(() => request({ tasks: [{ command: "true" }], env: { DSA_X: "1" } }, "/w"), { message: "Invalid tasks[0]: env name DSA_X is reserved (DSA_*)" });
});

test("checkAgents ignores command steps and still refuses unknown agents beside them", () => {
  const none = () => assert.fail("no agent lookup without agent calls");
  checkAgents({ cwd: "/w", call: { command: ["true"] } } as unknown as RunBody, none);
  checkAgents({ cwd: "/w", tasks: [{ command: "a" }, { command: ["b"] }] } as unknown as RunBody, none);
  checkAgents({ cwd: "/w", chain: [{ command: "make" }, { agent: "worker", task: "t" }] } as unknown as RunBody, () => ["worker"]);
  assert.throws(() => checkAgents({ cwd: "/w", chain: [{ command: "make" }, { agent: "nope", task: "t" }] } as unknown as RunBody, () => ["worker"]),
    { message: "Unknown agent: nope. Available agents: worker" });
});

test("tool schema documents the command call fields", () => {
  const props = (parameters as unknown as { properties: Record<string, { description?: string; anyOf?: unknown[] }> }).properties;
  for (const name of ["command", "env", "rerun"]) assert.ok(props[name], `parameter ${name}`);
  assert.match(props.command!.description!, /exitCode, signal, durationMs/);
  assert.match(props.command!.description!, /16 KiB/);
  assert.match(JSON.stringify(props.tasks), /command specs \{command, cwd\?, timeoutMs\?, env\?, rerun\?, writer\?, key\?\}/);
});
