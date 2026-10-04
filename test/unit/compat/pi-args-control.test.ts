import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs } from "../../../src/compat/pi-args.ts";
import type { AgentDefinition } from "../../../src/compat/agents.ts";

const agent = { name: "a", description: "", systemPrompt: "", source: "user", filePath: "/a.md", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: true } as unknown as AgentDefinition;
test("P24: protocol control tools are added to explicit allowlists, never invent an allowlist", () => {
  const opts = { sessionPath: "/s", systemPromptPath: "/p", controlTools: ["ask", "report"] };
  const tools = (a: string[]) => a[a.indexOf("--tools") + 1];
  assert.equal(tools(buildPiArgs({ ...agent, tools: ["bash"] } as AgentDefinition, { task: "t" } as never, opts)), "bash,ask,report");
  assert.equal(tools(buildPiArgs({ ...agent, tools: [] } as AgentDefinition, { task: "t" } as never, opts)), "ask,report");
  assert.ok(!buildPiArgs(agent, { task: "t" } as never, opts).includes("--tools"));
});
