import { readFile } from "node:fs/promises";
import { CT } from "../../types.ts";
import type { Model } from "../../compat/model.ts";

interface Block { type?: string; text?: string; id?: string; name?: string }
interface Message { role?: string; content?: string | Block[]; stopReason?: string; toolCallId?: string; details?: Record<string, unknown>; usage?: { input?: number; output?: number; cost?: { total?: number } } }
export interface SessionEntry {
  type: string; id?: string; customType?: string; data?: Record<string, unknown>; message?: Message;
  provider?: string; modelId?: string;
}
/** C5: Read complete native session entries, ignoring only an unfinished trailing line. */
export async function readSession(path: string): Promise<SessionEntry[]> {
  const bytes = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  const lines = bytes.split("\n");
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line) as SessionEntry);
}
/** P9: Derive evidence only after this execution's own launch receipt. */
export function evidence(entries: SessionEntry[], exec: string) {
  const start = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.exec && e.data?.exec === exec);
  const segment = start < 0 ? [] : entries.slice(start + 1);
  const report = segment.findLast(e => e.type === "custom" && e.customType === CT.report && e.data?.exec === exec && ["ok", "failed"].includes(String(e.data.outcome)))?.data;
  const tools = new Map<string, string>();
  let text = "";
  const usage = { input: 0, output: 0, costUsd: 0 };
  for (const e of segment) {
    const m = e.message;
    if (m?.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) if (b.type === "toolCall" && b.id) tools.set(b.id, b.name ?? b.id);
      if (m.stopReason !== "aborted" && m.stopReason !== "error" && m.stopReason !== "toolUse") {
        const value = typeof m.content === "string" ? m.content : blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
        if (value.trim()) text = value;
      }
      usage.input += m.usage?.input ?? 0; usage.output += m.usage?.output ?? 0; usage.costUsd += m.usage?.cost?.total ?? 0;
    }
    if (m?.role === "toolResult" && m.toolCallId) tools.delete(m.toolCallId);
  }
  const budget = segment.some(e => e.type === "custom" && e.customType === CT.budget && e.data?.exec === exec);
  return { report, budget, text, dangling: [...tools].map(([id, name]) => `${name} (${id})`), usage };
}
/** P13, C8: Restore the effective provider from the native session's model changes. */
export function sessionModel(entries: SessionEntry[]): Model | undefined {
  const last = entries.findLast(e => e.type === "model_change" && e.provider && e.modelId);
  return last ? { provider: last.provider!, id: last.modelId! } : undefined;
}
