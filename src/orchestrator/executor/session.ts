import { open } from "node:fs/promises";
import { CT } from "../../types.ts";
import type { Model } from "../../compat/model.ts";

interface Block { type?: string; text?: string; id?: string; name?: string }
interface Message { role?: string; content?: string | Block[]; stopReason?: string; toolCallId?: string; details?: Record<string, unknown>; usage?: { input?: number; output?: number; cost?: { total?: number } } }
export interface SessionEntry {
  type: string; id?: string; customType?: string; data?: Record<string, unknown>; message?: Message;
  provider?: string; modelId?: string; details?: Record<string, unknown>;
}
export interface SessionState { entries: SessionEntry[]; corrupt: readonly number[] }
// A child session is append-only while observed (pi appends whole lines), so a cached state is extended by parsing only
// the bytes appended since the last read; a different inode or a shorter file is read from scratch (like journal snapshots).
const cache = new Map<string, { ino: number; size: number; length: number; lines: number; state: SessionState }>();
const EMPTY: SessionState = { entries: [], corrupt: [] };
/** C5, E4, F3: Read complete native entries incrementally; an unfinished trailing line is ignored and a malformed
 *  complete line is skipped (pi's own loader does the same), reported by its 1-based line number in `corrupt`. */
export async function readSessionState(path: string): Promise<SessionState> {
  const file = await open(path, "r").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!file) { cache.delete(path); return EMPTY; }
  try {
    const { ino, size } = await file.stat(), cached = cache.get(path);
    if (cached && cached.ino === ino && cached.size === size) return cached.state;
    const prior = cached && cached.ino === ino && size > cached.size ? cached : undefined, from = prior?.length ?? 0;
    const bytes = Buffer.alloc(size - from);
    for (let read = 0; read < bytes.length;) { const { bytesRead } = await file.read(bytes, read, bytes.length - read, from + read); if (!bytesRead) break; read += bytesRead; }
    const entries: SessionEntry[] = [], corrupt: number[] = [];
    let offset = 0, lines = prior?.lines ?? 0;
    for (let end = bytes.indexOf(10); end >= 0; offset = end + 1, end = bytes.indexOf(10, offset)) {
      lines++;
      const line = bytes.subarray(offset, end).toString("utf8");
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as SessionEntry); } catch { corrupt.push(lines); }
    }
    const state = prior && !entries.length && !corrupt.length ? prior.state : {
      entries: prior ? prior.state.entries.concat(entries) : entries, corrupt: prior ? prior.state.corrupt.concat(corrupt) : corrupt };
    cache.set(path, { ino, size, length: from + offset, lines, state });
    return state;
  } finally { await file.close(); }
}
/** C5: Complete native session entries (see readSessionState). The result is shared: never mutate it. */
export async function readSession(path: string): Promise<SessionEntry[]> {
  return (await readSessionState(path)).entries;
}
/** F3: Drop the cached state of a session that is no longer observed. */
export function forgetSession(path: string): void { cache.delete(path); }
/** P4, P27: Native message receipts and control resolutions share one identity lookup. */
export function receiptId(entry: SessionEntry): string | undefined {
  const rid = entry.message?.details?.rid ?? (entry.type === "custom_message" ? entry.details?.rid : undefined) ??
    (entry.type === "custom" && [CT.rejected, CT.withdrawn, CT.model].includes(entry.customType as typeof CT.rejected) ? entry.data?.rid : undefined);
  return typeof rid === "string" ? rid : undefined;
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
