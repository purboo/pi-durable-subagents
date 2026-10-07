import test from "node:test";
import assert from "node:assert/strict";
import { callLine, resultLines } from "../../../src/ui/tool.ts";

test("UI §5: tool calls render as one line, never the raw script or prompts", () => {
  assert.equal(callLine({ action: "run", tasks: [{ agent: "reviewer", task: "x" }, { agent: "reviewer", task: "y" }, { agent: "scout", task: "z" }] }), "run 3 in parallel (reviewer×2, scout)");
  assert.equal(callLine({ action: "run", chain: [{ agent: "worker" }, { agent: "reviewer" }] }), "run chain of 2 (worker → reviewer)");
  assert.equal(callLine({ action: "run", name: "fix", source: "a\nb\nc" }), "run fix · workflow script (3 lines)");
  assert.equal(callLine({ action: "run", agent: "worker", task: "Fix the tests\nmore detail" }), "run worker: Fix the tests");
  assert.equal(callLine({ action: "send", kind: "steer", to: "W/k", message: "use TOML" }), "send steer → W/k: use TOML");
});

test("UI §5: results collapse to started / applied / rejected / one line per workflow", () => {
  assert.deepEqual(resultLines({ wid: "01ABC" }), ["started workflow 01ABC"]);
  assert.deepEqual(resultLines({ wid: "01ABC", paused: "Subagents are paused" }), ["started workflow 01ABC", "⚠ Subagents are paused"]);
  assert.deepEqual(resultLines({ applied: false, reason: "terminal:done — start a new run", rid: "r" }), ["✗ not applied: the workflow already ended (done); start a new run instead"]);
  assert.deepEqual(resultLines({ workflows: [{ wid: "01M4698PE75Q18ZYH588ZW6DNW", status: "running", calls: [{ phase: "sealed", status: "failed" }, { phase: "running" }], attention: [{ kind: "question" }] }] }),
    ["01M4698PE7… · running · 1/2 done · 1 not ok · 1 asking"]);
  // The tool's brief status, one call's detail, and the plain words for rejections the model now gets.
  assert.deepEqual(resultLines({ active: [{ wid: "01R", name: "wave", status: "running", progress: "2/4", calls: [{ status: "failed" }, {}], asking: [{}], alerts: [{}] }],
    finished: ["a", "b"], olderFinished: 3, paused: "1 workflow of this session is paused", hint: "h" }),
    ["⚠ 1 workflow of this session is paused", "wave · running · 2/4 done · 1 not ok · 1 asking · 1 alert", "5 finished"]);
  assert.deepEqual(resultLines({ active: [], finished: [], hint: "h" }), ["nothing running"]);
  assert.deepEqual(resultLines({ wid: "01R", key: "done", phase: "sealed", model: "p/m", result: { status: "ok" } }), ["done · ok · p/m"]);
  assert.deepEqual(resultLines({ applied: false, reason: "nothing-to-resume: nothing of this session is paused; paused in other sessions: 01B (x) — resume wid=<wid> continues one" }),
    ["✗ not applied: nothing of this session is paused, so there is nothing to resume; paused in other sessions: 01B (x)"]);
  assert.deepEqual(resultLines({ applied: false, reason: "nothing-to-resume" }), ["✗ not applied: nothing of this session is paused, so there is nothing to resume"]);
});
