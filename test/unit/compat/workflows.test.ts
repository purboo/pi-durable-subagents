import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parseModel, resolveModel, thinkingLevels } from "../../../src/compat/model.ts";
import { compileFanout } from "../../../src/compat/fanout.ts";
import { buildCallResult } from "../../../src/compat/result.ts";
import { buildPiArgs } from "../../../src/compat/pi-args.ts";
import { parseAgent } from "../../../src/compat/agents.ts";
import type { CallResult, CallSpec } from "../../../src/types.ts";

const ok = (key: string, output: string): CallResult => ({ key, gen: 1, status: "ok", ok: true, output });

test("model parsing preserves provider paths and non-thinking colons, resolves ordered pools", () => {
  for (const thinking of thinkingLevels) assert.deepEqual(parseModel(`provider/group/id:${thinking}`), { provider: "provider", id: "group/id", thinking });
  assert.deepEqual(parseModel("ollama/model:latest"), { provider: "ollama", id: "model:latest" });
  assert.deepEqual(parseModel("sonnet"), { id: "sonnet" });
  assert.deepEqual(resolveModel("fast", { fast: ["p/a:low", "backup"], backup: ["q/b"] }), [{ provider: "p", id: "a", thinking: "low" }, { provider: "q", id: "b" }]);
  assert.throws(() => resolveModel("x", { x: ["y"], y: ["x"] }), /Cyclic/);
  assert.throws(() => resolveModel("x", { x: [] }), /Empty/);
  for (const invalid of ["", "/id", "p/", "bad model", ":high"]) assert.throws(() => parseModel(invalid));
});

test("P34 parallel source proposes all keys before exposure and preserves input order", async () => {
  const input = { tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] };
  const compiled = compileFanout(input);
  assert.deepEqual(compiled, compileFanout(input));
  const calls: string[] = [], resolve: ((result: CallResult) => void)[] = [];
  const run = (key: string) => { calls.push(key); return new Promise<CallResult>(r => resolve.push(r)); };
  const result = runInNewContext(`(async () => {${compiled.source}})()`, { runs: { all: (tasks: { key: string }[]) => Promise.all(tasks.map(t => run(t.key))) } });
  assert.deepEqual(calls, ["tasks:0", "tasks:1"]);
  resolve[1]!(ok("tasks:1", "second")); resolve[0]!(ok("tasks:0", "first"));
  assert.deepEqual(JSON.parse(JSON.stringify(await result)).map((r: CallResult) => r.output), ["first", "second"]);
  input.tasks[0]!.task = "mutated";
  assert.equal(compiled.steps[0]?.spec.task, "a");
});

test("P34 chain substitutes literal full output, stops proposals on failure and emits skipped keys", async () => {
  const compiled = compileFanout({ chain: [
    { agent: "worker", task: "{previous}start" }, { agent: "worker", task: "before {previous} / {previous}" },
    { agent: "worker", task: "never" }, { agent: "worker", task: "never either" },
  ] });
  const calls: { key: string; spec: CallSpec }[] = [], events: unknown[] = [];
  const run = async (key: string, spec: CallSpec) => {
    calls.push({ key, spec });
    return key === "chain:0" ? ok(key, "$&\nLEAF: success") : { ...ok(key, "failure"), ok: false, status: "failed" };
  };
  const execute = () => runInNewContext(`(async () => {${compiled.source}})()`, { runs: { run }, emit: (e: unknown) => events.push(e) });
  const results = JSON.parse(JSON.stringify(await execute()));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.spec.task, "start");
  assert.equal(calls[1]?.spec.task, "before $&\nLEAF: success / $&\nLEAF: success");
  assert.deepEqual(results.slice(2), ["chain:2", "chain:3"].map(key => ({ key, gen: 0, status: "skipped", ok: false, output: "" })));
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ type: "skipped", keys: ["chain:2", "chain:3"] }]);
  calls.length = 0; events.length = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(await execute())), results);
});

test("P34 empty and successful chains, inert source data and invalid fanout", async () => {
  for (const chain of [[], [{ agent: "a", task: '`); throw new Error("injected"); //\n${process.exit()}' }]]) {
    const compiled = compileFanout({ chain });
    const results = await runInNewContext(`(async () => {${compiled.source}})()`, { runs: { run: async (key: string, spec: CallSpec) => ok(key, spec.task) }, emit: () => assert.fail("no skips") });
    assert.equal(results.length, chain.length);
    if (chain.length) assert.equal(results[0].output, chain[0]!.task);
  }
  assert.throws(() => compileFanout({ tasks: [], chain: [] } as never));
  assert.throws(() => compileFanout({ chain: [{ agent: "", task: "" }] }));
});

test("T11: user keys are honored in tasks and chain, defaults stay positional, and keys never reach the call spec", async () => {
  const tasks = compileFanout({ tasks: [{ agent: "w", task: "a", key: "scout" }, { agent: "w", task: "b" }] });
  assert.deepEqual(tasks.steps, [{ key: "scout", spec: { agent: "w", task: "a" } }, { key: "tasks:1", spec: { agent: "w", task: "b" } }]);
  const proposed: unknown[] = [];
  await runInNewContext(`(async () => {${tasks.source}})()`, { runs: { all: async (calls: unknown[]) => { proposed.push(...calls); return []; } } });
  assert.deepEqual(JSON.parse(JSON.stringify(proposed)), [{ agent: "w", task: "a", key: "scout" }, { agent: "w", task: "b", key: "tasks:1" }]);
  const chain = compileFanout({ chain: [{ agent: "w", task: "a" }, { agent: "w", task: "b", key: "review" }, { agent: "w", task: "c", key: "ship" }] });
  const calls: [string, CallSpec][] = [];
  const results = await runInNewContext(`(async () => {${chain.source}})()`, { emit: () => {}, runs: { run: async (key: string, spec: CallSpec) => {
    calls.push([key, spec]); return key === "review" ? { ...ok(key, "x"), ok: false, status: "failed" } : ok(key, "x");
  } } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["chain:0", { agent: "w", task: "a" }], ["review", { agent: "w", task: "b" }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(results.at(-1))), { key: "ship", gen: 0, status: "skipped", ok: false, output: "" });
  assert.throws(() => compileFanout({ tasks: [{ agent: "w", task: "a", key: "x" }, { agent: "w", task: "b", key: "x" }] }), /Invalid tasks step 1: duplicate key "x"/);
  assert.throws(() => compileFanout({ chain: [{ agent: "w", task: "a", key: "chain:1" }, { agent: "w", task: "b" }] }), /Invalid chain step 1: duplicate key "chain:1"/);
  assert.throws(() => compileFanout({ tasks: [{ agent: "w", task: "a", key: " " }] }), /Invalid tasks step 0: key must be a non-empty string/);
  assert.throws(() => compileFanout({ tasks: [{ agent: "w", task: "a", isolaton: "worktree" } as CallSpec] }), /Invalid tasks step 0: unknown field "isolaton"/);
});

test("P24/AC3 results retain large full output, report data, and legacy final-line parsing", () => {
  const output = "text\n".repeat(30_000) + "LEAF: accepted";
  const input = { key: "a", gen: 1, status: "ok" as const, output };
  assert.equal(buildCallResult(input).output, output);
  const result = buildCallResult({ ...input, report: { data: { accepted: true } } });
  assert.equal(result.output, '{"accepted":true}\n' + output);
  assert.equal(result.output.split("\n").at(-1), "LEAF: accepted");
  assert.deepEqual(result.data, { accepted: true });
  for (const status of ["ok", "failed", "stopped", "timeout", "budget", "unknown", "gate-failed", "skipped", "parked"] as const) assert.equal(buildCallResult({ ...input, status }).ok, status === "ok");
  assert.equal(buildCallResult({ ...input, report: { text: "REPORT", data: null } }).output, "REPORT\n" + output);
});

test("C5/C8 Pi args use flags verified by pi 1.0.2 --help; continuation omits model and thinking", () => {
  const agent = parseAgent("---\nname: worker\ndescription: worker\nmodel: p/id:high\ntools: read, grep\nskill: review\n---\nprompt", "/tmp/worker.md")!;
  const options = { sessionPath: "/tmp/session.jsonl", systemPromptPath: "/tmp/prompt.md", resolveSkill: (s: string) => `/pinned/${s}` };
  const args = buildPiArgs(agent, { agent: "worker", task: "ignored by RPC args" }, options);
  assert.deepEqual(args, ["--mode", "rpc", "--session", "/tmp/session.jsonl", "--system-prompt", "/tmp/prompt.md", "--tools", "read,grep", "--no-context-files", "--no-skills", "--skill", "/pinned/review", "--model", "p/id", "--thinking", "high"]);
  const continued = buildPiArgs(agent, { agent: "worker", task: "", model: "q/other:max", tools: [], skills: [] }, { ...options, continuation: true });
  assert.ok(!continued.includes("--model") && !continued.includes("--thinking"));
  assert.ok(continued.includes("--no-tools") && !continued.includes("--skill"));
  const append = buildPiArgs({ ...agent, systemPromptMode: "append", inheritSkills: true, inheritProjectContext: true }, { agent: "worker", task: "" }, options);
  assert.ok(append.includes("--append-system-prompt") && !append.includes("--no-skills") && !append.includes("--no-context-files"));
  assert.throws(() => buildPiArgs({ ...agent, model: undefined, thinking: "invalid" }, { agent: "worker", task: "" }, options));
});
