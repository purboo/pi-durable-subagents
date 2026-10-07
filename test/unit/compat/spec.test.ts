import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCallSpec } from "../../../src/compat/spec.ts";

const base = { agent: "worker", task: "t" };
const check = (extra: Record<string, unknown>, fanout = false) => validateCallSpec({ ...base, ...extra }, { fanout });

test("T2: a complete valid spec has no errors; undefined fields count as absent", () => {
  const full = { model: "p/m:high", cwd: "sub", timeoutMs: 1000, output: "out.md", schema: { type: "object" }, isolation: "worktree", context: "fork",
    budget: { tokens: 10 }, once: true, tools: ["read"], skills: [], gate: { command: "true", output: "json", schema: true, timeoutMs: 5 } };
  assert.deepEqual(check(full), []);
  assert.deepEqual(check({ isolation: "none", context: "fresh", gate: "npm test", budget: { costUsd: 0.5 }, model: undefined }), []);
  assert.deepEqual(check({ key: "a" }, true), []);
});

test("T2: every rule reports its exact message", () => {
  const cases: [unknown, string[]][] = [
    [null, ["call spec must be an object"]],
    [[], ["call spec must be an object"]],
    [{}, ["agent must be a non-empty string", "task must be a non-empty string"]],
    [{ agent: " ", task: 3 }, ['agent must be a non-empty string (got " ")', "task must be a non-empty string"]],
    [{ ...base, isolaton: "worktree" }, ['unknown field "isolaton"']],
    [{ ...base, model: 1, cwd: [], output: {} }, ["model must be a string (got 1)", "cwd must be a string (got [])", "output must be a string (got {})"]],
    ...([[0, "0"], [-1, "-1"], [Infinity, "Infinity"], [NaN, "NaN"], ["5", '"5"']] as const).map(([timeoutMs, shown]) => [{ ...base, timeoutMs }, [`timeoutMs must be a positive number (milliseconds) (got ${shown})`]] as [unknown, string[]]),
    [{ ...base, isolation: "docker" }, ['isolation must be "none" or "worktree" (got "docker")']],
    [{ ...base, context: "inherit" }, ['context must be "fresh" or "fork" (got "inherit")']],
    [{ ...base, once: "yes" }, ['once must be a boolean (got "yes")']],
    [{ ...base, tools: "read", skills: [1] }, ['tools must be an array of strings (got "read")', "skills must be an array of strings (got [1])"]],
    [{ ...base, budget: 5 }, ["budget must be an object {tokens?, costUsd?}"]],
    [{ ...base, budget: {} }, ["budget needs tokens or costUsd"]],
    [{ ...base, budget: { tokens: 0, costUsd: -1, usd: 1 } }, ['unknown field "budget.usd"', "budget.tokens must be a positive number (got 0)", "budget.costUsd must be a positive number (got -1)"]],
    [{ ...base, gate: "" }, ["gate must be a non-empty command"]],
    [{ ...base, gate: 1 }, ["gate must be a string or {command, output?, schema?, timeoutMs?}"]],
    [{ ...base, gate: { output: "text", timeoutMs: 0, cmd: "x" } }, ['unknown field "gate.cmd"', "gate.command must be a non-empty string", 'gate.output must be "json"', "gate.timeoutMs must be a positive number (got 0)"]],
    [{ ...base, gate: { command: "x", schema: { minimum: 1 } } }, ['gate.schema: unsupported keyword "minimum"']],
    [{ ...base, schema: { type: "object", properties: { n: { type: "number", minimum: 1 } } } }, ['schema.properties.n: unsupported keyword "minimum"']],
    [{ ...base, schema: "object" }, ["schema: must be an object or boolean"]],
    [{ ...base, key: "a" }, ["key is only allowed in tasks/chain steps"]],
  ];
  for (const [spec, errors] of cases) assert.deepEqual(validateCallSpec(spec), errors, JSON.stringify(spec));
  assert.deepEqual(check({ key: "" }, true), ["key must be a non-empty string"]);
  assert.deepEqual(check({ key: 3 }, true), ["key must be a non-empty string"]);
});
