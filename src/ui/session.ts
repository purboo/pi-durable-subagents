// Read-only session tailing (C5, P21): incomplete trailing records are never displayed.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CT } from "../types.ts";
import type { Live } from "../agent/child/live.ts";

/** C5: Incrementally read complete pi session records, resetting after replacement or truncation. */
export class SessionTail {
  private identity = "";
  private offset = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private entries: SessionEntry[] = [];
  private failure?: Error;
  read(path: string): readonly SessionEntry[] {
    let stat;
    try { stat = statSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.reset(); return [];
    }
    const identity = `${path}:${stat.dev}:${stat.ino}`;
    if (identity !== this.identity || stat.size < this.offset) { this.reset(); this.identity = identity; }
    if (this.failure) throw this.failure;
    if (stat.size === this.offset) return this.entries;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - this.offset));
      while (this.offset < stat.size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!n) break;
        this.offset += n; this.pending += this.decoder.write(buffer.subarray(0, n));
        let end;
        while ((end = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
          if (!line.trim()) continue;
          // E4, like pi and the orchestrator: a malformed interior line is skipped, never a reason to stop following.
          try { this.entries.push(JSON.parse(line) as SessionEntry); } catch { /* skipped */ }
        }
      }
    } catch (error) { this.failure = error as Error; throw error; }
    finally { closeSync(fd); }
    return this.entries;
  }
  private reset() { this.identity = ""; this.offset = 0; this.pending = ""; this.entries = []; this.failure = undefined; this.decoder = new StringDecoder("utf8"); }
}

/** C5: Select the native session's current branch without showing abandoned conversation turns. */
export function sessionBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const last = entries.findLast(e => "id" in e);
  if (!last || !entries.some(e => "parentId" in e)) return [...entries];
  const byId = new Map(entries.map(e => [e.id, e]));
  const branch: SessionEntry[] = [], seen = new Set<string>();
  let current: SessionEntry | undefined = last;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); branch.push(current); current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

/** UI §3: Show the newest heading or complete thought, never an incomplete sentence. */
export function thoughtSummary(text: string): string {
  const headings = [...text.matchAll(/\*\*([^*\n]+)\*\*|^#{1,6}\s+(.+)$/gm)];
  if (headings.length) return (headings.at(-1)![1] ?? headings.at(-1)![2]!).trim();
  return text.match(/[^.!?。！？]+[.!?。！？](?=\s|$)/gu)?.at(-1)?.trim() ?? "";
}

/** UI §2–3, P31: Derive model, thinking, tool activity and the call's own tool-call count solely from committed session entries. */
export function sessionFacts(entries: readonly SessionEntry[], call: string) {
  let model: string | undefined, thinking = "off", activity: string | undefined, lastActivity = 0, task = "", count = 0, own = false;
  let latest = ""; // the newest thing the agent said, thought or saw, for the overview (UI §2)
  let context: number | undefined; // tokens in the agent's context at its latest response, as pi's footer counts them
  const firstLine = (text: string) => text.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  const lastLine = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean).at(-1) ?? "";
  const tools = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  for (const e of entries) {
    // Only segments opened by this call's executions count; inherited fork/continuation context does not (P31).
    if (e.type === "custom" && e.customType === CT.exec) own = String((e.data as { exec?: unknown } | undefined)?.exec ?? "").startsWith(`${call}#`);
    if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change") thinking = e.thinkingLevel;
    if (e.type === "custom" && e.customType === CT.model) {
      const d = e.data as { provider?: string; model?: string; thinking?: string };
      if (d?.provider && d.model) model = `${d.provider}/${d.model}`;
      if (d?.thinking) thinking = d.thinking;
    }
    if (e.type === "custom_message" && e.customType === CT.msg && (e.details as { kind?: string })?.kind === "task" && !task) {
      task = typeof e.content === "string" ? e.content : e.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    }
    if (e.type !== "message") continue;
    lastActivity = Math.max(lastActivity, Date.parse(e.timestamp) || 0);
    const m = e.message;
    if (m.role === "assistant") {
      model = `${m.provider}/${m.model}`;
      const u = m.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | undefined;
      const total = u ? u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
      if (total > 0) context = total;
      for (const b of m.content) {
        if (b.type === "toolCall") { tools.set(b.id, b); if (own) count++; }
        else if (b.type === "text" && lastLine(b.text)) latest = lastLine(b.text);
        else if (b.type === "thinking" && thoughtSummary(b.thinking ?? "")) latest = `thinking: ${thoughtSummary(b.thinking ?? "")}`;
      }
    } else if (m.role === "toolResult") {
      tools.delete(m.toolCallId);
      const out = firstLine(m.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n"));
      if (out) latest = `${m.toolName}: ${out}`;
    }
  }
  const tool = [...tools.values()].at(-1);
  if (tool) {
    const a = tool.arguments, path = String(a.path ?? a.file_path ?? "");
    activity = tool.name === "read" ? `reading ${path}` : ["edit", "write"].includes(tool.name) ? `editing ${path}` :
      tool.name === "bash" ? `running ${String(a.command ?? "")}` : `running ${tool.name}`;
  }
  return { model, thinking, activity, lastActivity, task, tools: count, latest, ...(context !== undefined ? { context } : {}), live: undefined as Live | undefined };
}
