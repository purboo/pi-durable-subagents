import { test } from "node:test";
import assert from "node:assert/strict";
import { request, sendReceipt } from "../../../src/agent/main/tool.ts";
import { parameters } from "../../../src/agent/main/schema.ts";
import { registerMain } from "../../../src/agent/main.ts";
import { tempRoot } from "../../harness/pi.ts";

test("v12 §2: omitted action infers only a single launch form; invalid omission lists actions", () => {
  assert.ok(!((parameters as { required?: string[] }).required ?? []).includes("action"));
  for (const args of [
    { agent: "worker", task: "work" }, { tasks: [{ agent: "worker", task: "work" }] },
    { chain: [{ agent: "worker", task: "work" }] }, { workflow: "flow.js" }, { source: "return 1" },
  ]) assert.equal(request(args, "/w").kind, "run");
  for (const args of [{}, { agent: "a", task: "work", source: "return 1" }, { tasks: [], chain: [] }, { to: "w/k", kind: "steer", message: "hi" }]) {
    assert.throws(() => request(args, "/w"), /action is required: run, agents, send, stop, revise, status, resume, drain, restart/);
  }
  assert.throws(() => request({ action: "impossible" }, "/w"), /Unsupported action: impossible; use run, agents/);
});

test("v12 §6: tool description teaches discovery, addresses, verb meaning and list controls", () => {
  const root = tempRoot("dsa-description-");
  const old = { HOME: process.env.HOME, DSA_HOME: process.env.DSA_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  let description = "";
  try {
    process.env.HOME = root; process.env.DSA_HOME = root; process.env.PI_CODING_AGENT_DIR = root; process.env.PI_OFFLINE = "1";
    registerMain({ on() {}, registerTool(tool: { description: string }) { description = tool.description; } } as unknown as Parameters<typeof registerMain>[0]);
  } finally {
    for (const [name, value] of Object.entries(old)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const phrase of ["agents:", "Available agents:", "<wid>/<key>", "single-call", "steer", "follow-up", "answer", "model", "stop", "drain", "resume", "status", "↓", "Enter", "s steer", "x stop", "m model", "a answer", "f follow-up", "Never force without the user's explicit approval", "force:'<token>'", "Subagents cannot force"]) {
    assert.ok(description.includes(phrase), `missing ${phrase}`);
  }
});

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
    { message: 'Invalid call: unknown field "isolaton"; context must be "fresh" or "fork" (got \"inherit\")' });
  assert.deepEqual(request({ action: "run", agent: "w", task: "t", key: "a" }, "/w").body, { cwd: "/w", call: { agent: "w", task: "t", key: "a" } }, "a single call may name its key");
  assert.throws(() => request({ action: "run", tasks: [{ agent: "w", task: "a" }, { agent: "w", task: "b", isolation: "vm" }] }, "/w"),
    { message: 'Invalid tasks[1]: isolation must be "none" or "worktree" (got "vm")' });
  assert.throws(() => request({ action: "run", chain: [{ agent: "w", task: "a", schema: { type: "string", minLength: 2 } }] }, "/w"),
    { message: 'Invalid chain[0]: schema: unsupported keyword "minLength"' });
  assert.throws(() => request({ action: "run", tasks: [{ agent: "w", task: "a", key: "k" }, { agent: "w", task: "b", key: "k" }] }, "/w"), /duplicate key "k"/);
  const { body } = request({ action: "run", chain: [{ agent: "w", task: "a", key: "plan", cwd: "" }, { agent: "w", task: "{previous}" }] }, "/w");
  assert.deepEqual(body, { cwd: "/w", chain: [{ agent: "w", task: "a", key: "plan", cwd: "/w" }, { agent: "w", task: "{previous}" }] });
});

test("a top-level cwd is the run's directory: relative workflow, inputs and calls resolve against it", () => {
  const wf = request({ workflow: "flows/x.js", cwd: "../repo", inputs: { plan: "plan.md" } }, "/w/session");
  assert.deepEqual(wf.body, { cwd: "/w/repo", workflow: "/w/repo/flows/x.js", inputs: { plan: "/w/repo/plan.md" } });
  const tasks = request({ tasks: [{ agent: "a", task: "t" }, { agent: "a", task: "u", cwd: "sub" }], cwd: "/abs" }, "/w") as { body: { cwd: string; tasks: { cwd?: string }[] } };
  assert.equal(tasks.body.cwd, "/abs"); assert.equal(tasks.body.tasks[1]!.cwd, "/abs/sub");
  // A single agent/task call keeps cwd as the call's own directory, as before.
  const single = request({ agent: "a", task: "t", cwd: "sub" }, "/w") as { body: { cwd: string; call: { cwd?: string } } };
  assert.deepEqual([single.body.cwd, single.body.call.cwd], ["/w", "/w/sub"]);
  assert.equal((request({ workflow: "x.js" }, "/w").body as { workflow: string }).workflow, "/w/x.js");
});

test("run-level call fields: defaults for every tasks/chain step (a step's own value wins); an error where they cannot apply", () => {
  const { body } = request({ tasks: [{ agent: "a", task: "t" }, { agent: "a", task: "u", model: "p/own", timeoutMs: 5 }], model: "p/m", timeoutMs: 600000, budget: { tokens: 9 } }, "/w");
  assert.deepEqual((body as { tasks: unknown[] }).tasks, [
    { agent: "a", task: "t", model: "p/m", timeoutMs: 600000, budget: { tokens: 9 } },
    { agent: "a", task: "u", model: "p/own", timeoutMs: 5, budget: { tokens: 9 } }]);
  const chain = request({ chain: [{ agent: "a", task: "t" }], isolation: "worktree" }, "/w").body as { chain: unknown[] };
  assert.deepEqual(chain.chain, [{ agent: "a", task: "t", isolation: "worktree" }]);
  // A run-level default is validated per step, with the received value in the error.
  assert.throws(() => request({ tasks: [{ agent: "a", task: "t" }], timeoutMs: "600000" }, "/w"),
    { message: 'Invalid tasks[0]: timeoutMs must be a positive number (milliseconds) (got "600000")' });
  assert.throws(() => request({ tasks: [{ agent: "a", task: "t" }], output: "o.md", key: "k" }, "/w"), /"output", "key" cannot be set for a whole tasks run; set them in each step/);
  assert.throws(() => request({ workflow: "x.js", model: "p/m" }, "/w"), /"model" cannot be set for a workflow run; set it in the script's runs.run\(key, spec\) calls/);
  assert.throws(() => request({ source: "emit(1)", timeoutMs: 5 }, "/w"), /"timeoutMs" cannot be set for a source run/);
  // A single call keeps its fields as before.
  assert.deepEqual(request({ agent: "a", task: "t", model: "p/m", timeoutMs: 5 }, "/w").body, { cwd: "/w", call: { agent: "a", task: "t", model: "p/m", timeoutMs: 5 } });
});

test("a top-level agent without task is the default agent of every tasks/chain step; a step's own agent wins", () => {
  const tasks = request({ tasks: [{ task: "t" }, { agent: "own", task: "u" }], agent: "reviewer", model: "p/m" }, "/w");
  assert.equal(tasks.kind, "run", "action is inferred: agent beside tasks is not a second launch form");
  assert.deepEqual((tasks.body as { tasks: unknown[] }).tasks, [{ agent: "reviewer", task: "t", model: "p/m" }, { agent: "own", task: "u", model: "p/m" }]);
  const chain = request({ action: "run", chain: [{ task: "a" }, { task: "{previous}" }], agent: "w" }, "/w").body as { chain: unknown[] };
  assert.deepEqual(chain.chain, [{ agent: "w", task: "a" }, { agent: "w", task: "{previous}" }]);
  // The same input normalizes to the same body (and so the same spec digest).
  assert.deepEqual(request({ tasks: [{ task: "t" }], agent: "r" }, "/w").body, request({ tasks: [{ task: "t" }], agent: "r" }, "/w").body);
  // A step without an agent after defaults keeps its error.
  assert.throws(() => request({ tasks: [{ task: "t" }] }, "/w"), /Invalid tasks\[0\]/);
  // agent+task beside a list is refused with what to do; so is a task alone.
  // With or without action: the guiding message, never the generic "action is required".
  for (const args of [{ action: "run", tasks: [{ task: "t" }], agent: "a", task: "x" }, { action: "run", chain: [{ agent: "a", task: "t" }], task: "x" },
    { tasks: [{ task: "t" }], agent: "a", task: "x" }, { chain: [{ agent: "a", task: "t" }], task: "x" }])
    assert.throws(() => request(args, "/w"), /task cannot be set beside (tasks|chain): agent\+task is a single call; give each step its own task/);
  // A workflow or source run still takes no agent.
  assert.throws(() => request({ action: "run", workflow: "x.js", agent: "a" }, "/w"), /run requires exactly one of/);
});

test("P12: a follow-up may name a model; a send naming one is answered with the model and when it applies", () => {
  assert.deepEqual(request({ action: "send", to: "w/a", kind: "follow-up", message: "go on", model: "p/m:high" }, "/w").body, { to: "w/a", kind: "follow-up", model: "p/m:high", message: "go on" });
  assert.deepEqual(request({ action: "send", to: "w/a", kind: "follow-up", message: "go on" }, "/w").body, { to: "w/a", kind: "follow-up", message: "go on" });
  assert.deepEqual(request({ action: "send", to: "w/a", kind: "model", model: "p/m" }, "/w").body, { to: "w/a", kind: "model", model: "p/m" });
  const ledger = [{ type: "send-note", seq: 1, ts: 1, rid: "r1", model: "p/m", effect: "next-execution" }] as unknown as Parameters<typeof sendReceipt>[0];
  assert.deepEqual(sendReceipt(ledger, "r1"), { model: "p/m", effect: "next-execution" });
  assert.deepEqual(sendReceipt(ledger, "r2"), {});
});

test("restart: force names the refusal's token with a reason; force:true and invalid reasons are refused at the tool", () => {
  assert.deepEqual(request({ action: "restart" }, "/w"), { kind: "restart", body: {} });
  assert.deepEqual(request({ action: "restart", reason: "upgrade" }, "/w"), { kind: "restart", body: { reason: "upgrade" } });
  assert.deepEqual(request({ action: "restart", force: "0123456789ab", reason: "user approved upgrade" }, "/w"), { kind: "restart", body: { token: "0123456789ab", reason: "user approved upgrade" } });
  assert.deepEqual(request({ action: "restart", force: false }, "/w"), { kind: "restart", body: {} });
  assert.throws(() => request({ action: "restart", force: true, reason: "why" }, "/w"), /force:true is refused; show the user the running executions from a restart refusal, then use force:"<token>" and reason:"<why>" only with explicit user approval/);
  assert.throws(() => request({ action: "restart", force: "0123456789ab" }, "/w"), /reason must be non-empty/);
  assert.throws(() => request({ action: "restart", force: "0123456789ab", reason: " " }, "/w"), /reason must be non-empty/);
  assert.throws(() => request({ action: "restart", force: "0123456789ab", reason: "x".repeat(501) }, "/w"), /at most 500 characters/);
  assert.throws(() => request({ action: "restart", force: "not-a-token", reason: "why" }, "/w"), /12-hex token/);
  assert.throws(() => request({ action: "restart", force: 1, reason: "why" }, "/w"), /force must be the token/);
  assert.ok(parameters.properties.force && parameters.properties.reason);
  assert.match(JSON.stringify(parameters.properties.force), /explicit approval/);
});
