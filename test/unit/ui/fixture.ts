import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../harness/pi.ts";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CallSnapshot, WorkflowSnapshot } from "../../../src/orchestrator/snapshot.ts";

export const root = tempRoot("dsa-ui-");
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.DSA_HOME = join(root, "dsa");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
export const now = 1_800_000_000_000;
export const clean = () => rmSync(root, { recursive: true, force: true });
export const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as Theme;
export const tui = { terminal: { rows: 45, columns: 100 }, requestRender() {} } as TUI;
export const models = [
  { provider: "openai", id: "gpt-6", name: "GPT-6" },
  { provider: "bedrock-claude", id: "claude-opus", name: "Opus 5.5" },
];
export const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "test" }, modelRegistry: { find: (p: string, id: string) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models } } as unknown as ExtensionContext;
export const state = () => ({ folded: new Set<string>(), done: new Map<string, number>(), viewed: new Set<string>(), finished: false });
export function call(key: string, extra: Partial<CallSnapshot> = {}): CallSnapshot {
  return { key, gen: 1, callId: `w@1/${key}@1`, agent: "worker", phase: "running", startedAt: now - 180_000, lastActivity: now - 20_000, model: "openai/gpt-6", ...extra };
}
export function workflow(calls: CallSnapshot[], extra: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return { wid: "w", rev: 1, name: "exec-0927", origin: "main:test", status: "running", startedAt: now - 3720_000, calls, attention: [], counts: { queued: 0, running: calls.length, asking: 0, sealed: 0 }, ...extra };
}
export function session(): SessionEntry[] {
  const stamp = new Date(now - 20_000).toISOString();
  const entries = [
    { type: "custom", customType: "dsa-exec", data: { exec: "w@1/E02@1#1.1" } },
    { type: "model_change", provider: "openai", modelId: "gpt-6" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "custom_message", customType: "dsa-msg", content: "Review the scheduler and fix the lease expiry test.", display: true, details: { kind: "task" } },
    { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-6", api: "openai-responses", timestamp: now - 20_000, stopReason: "toolUse", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [
      { type: "thinking", thinking: "**Checking SDK import path**\nThe lease expires at the boundary. Checking the tests now" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test -- sched" } },
    ] } },
    { type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "3 failing: lease expires early" }], isError: true, timestamp: now - 20_000 } },
  ];
  return entries.map((e, i) => ({ ...e, id: String(i), parentId: i ? String(i - 1) : null, timestamp: stamp })) as SessionEntry[];
}
export function writeSession(path: string, entries = session()) {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}
