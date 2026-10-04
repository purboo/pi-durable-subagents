import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "../../../src/agent/main/tool.ts";

// Public normalization is also exercised through real pi in main.test.ts.
test("run normalizes task/chain cwd and rejects ambiguous or incomplete launches", () => {
  for (const key of ["tasks", "chain"] as const) {
    assert.deepEqual(request({ action: "run", [key]: [{ agent: "worker", task: "work", cwd: "sub" }] }, "/project"),
      { kind: "run", body: { cwd: "/project", [key]: [{ agent: "worker", task: "work", cwd: "/project/sub" }] } });
  }
  assert.deepEqual(request({ action: "run", source: "return args", args: 1, name: "inline" }, "/project"),
    { kind: "run", body: { cwd: "/project", source: "return args", args: 1, name: "inline" } });
  for (const args of [{}, { workflow: "a", tasks: [] }, { agent: "worker" }, { tasks: [] }, { chain: [{}] }]) {
    assert.throws(() => request({ action: "run", ...args }, "/project"));
  }
  assert.throws(() => request({ action: "send", to: "w/a", kind: "answer", message: "a", qid: "q", rev: 0 }, "/project"));
  assert.throws(() => request({ action: "send", to: "w/a", kind: "steer", message: "a", replaces: [3] }, "/project"));
  assert.deepEqual(request({ action: "send", to: "w/a", kind: "model", model: "probe/scripted" }, "/project"),
    { kind: "send", body: { to: "w/a", kind: "model", model: "probe/scripted" }, cond: {}, replaces: undefined });
});
