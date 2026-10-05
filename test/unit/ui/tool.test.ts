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
  assert.deepEqual(resultLines({ applied: false, reason: "terminal:done — start a new run", rid: "r" }), ["✗ not applied: terminal:done — start a new run"]);
  assert.deepEqual(resultLines({ workflows: [{ wid: "01M4698PE75Q18ZYH588ZW6DNW", status: "running", calls: [{ phase: "sealed", status: "failed" }, { phase: "running" }], attention: [{ kind: "question" }] }] }),
    ["01M4698PE7… · running · 1/2 done · 1 not ok · 1 asking"]);
});
