import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { ASK_CUT, CT } from "../../types.ts";
import type { Model } from "../../compat/model.ts";

interface Block { type?: string; text?: string; id?: string; name?: string }
interface Message { role?: string; content?: string | Block[]; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean; details?: Record<string, unknown>; usage?: { input?: number; output?: number; cost?: { total?: number } } }
export interface SessionEntry {
  type: string; id?: string; customType?: string; data?: Record<string, unknown>; message?: Message;
  provider?: string; modelId?: string; details?: Record<string, unknown>;
}
export interface SessionState { entries: SessionEntry[]; corrupt: readonly number[] }
// A child session is append-only while observed (pi appends whole lines), so a cached state is extended by parsing only
// the bytes appended since the last read. A different inode, a shorter file or a changed first 4 KiB (pi rewrites a
// session in place when it migrates or initializes it) is read from scratch.
const HEAD = 4096;
const cache = new Map<string, { ino: number; size: number; length: number; lines: number; head: string; headLength: number; state: SessionState }>();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const EMPTY: SessionState = { entries: [], corrupt: [] };
/** C5, E4, F3: Read complete native entries incrementally; an unfinished trailing line is ignored and a malformed
 *  complete line is skipped (pi's own loader does the same), reported by its 1-based line number in `corrupt`. */
export async function readSessionState(path: string): Promise<SessionState> {
  const file = await open(path, "r").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!file) { cache.delete(path); return EMPTY; }
  try {
    const { ino, size } = await file.stat();
    const head = Buffer.alloc(Math.min(HEAD, size));
    for (let read = 0; read < head.length;) { const { bytesRead } = await file.read(head, read, head.length - read, read); if (!bytesRead) break; read += bytesRead; }
    let cached = cache.get(path);
    if (cached && (cached.ino !== ino || size < cached.size || digest(head.subarray(0, cached.headLength)) !== cached.head)) cached = undefined;
    if (cached && cached.size === size) return cached.state;
    const prior = cached, from = prior?.length ?? 0;
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
    cache.set(path, { ino, size, length: from + offset, lines, head: digest(head), headLength: head.length, state });
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
/** P28: an `ask` result the child wrote because its session shut down or its run was aborted, which is no answer. */
export function cutAskResult(m: Message | undefined): boolean {
  if (m?.role !== "toolResult" || !m.isError) return false;
  const text = typeof m.content === "string" ? m.content : (m.content ?? []).map(b => b.text ?? "").join("");
  return text === ASK_CUT.shutdown || text === ASK_CUT.aborted;
}
/** P28: the `ask` tool call that wrote the question at `index` (the child appends a question while that ask runs, after
 *  the assistant message that called it; asks are sequential, so it is the last ask called before the question). */
export function askOf(entries: readonly SessionEntry[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const m = entries[i]!.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ask = m.content.findLast(b => b.type === "toolCall" && b.name === "ask" && b.id);
    if (ask) return ask.id;
  }
  return undefined;
}
/** P9: Derive evidence only after this execution's own launch receipt. */
export function evidence(entries: SessionEntry[], exec: string) {
  const start = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.exec && e.data?.exec === exec);
  const segment = start < 0 ? [] : entries.slice(start + 1);
  const report = segment.findLast(e => e.type === "custom" && e.customType === CT.report && e.data?.exec === exec && ["ok", "failed"].includes(String(e.data.outcome)))?.data;
  const tools = new Map<string, string>();
  // P28: only an ask that wrote a question can be cut off while waiting; one aborted before that is an ordinary result.
  const asked = new Set(segment.flatMap((e, i) => e.type === "custom" && e.customType === CT.question ? [askOf(segment, i)] : []));
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
    // P28: an ask cut off by shutdown or abort while its question waited keeps an unknown outcome, like one with no result.
    if (m?.role === "toolResult" && m.toolCallId && !(asked.has(m.toolCallId) && cutAskResult(m))) tools.delete(m.toolCallId);
  }
  const budget = segment.some(e => e.type === "custom" && e.customType === CT.budget && e.data?.exec === exec);
  const last = segment.findLast(e => e.message?.role === "assistant")?.message;
  const error = last?.stopReason === "error" ? last.errorMessage : undefined;
  return { report, budget, text, error, dangling: [...tools].map(([id, name]) => `${name} (${id})`), usage };
}
/** Only explicit payment failures are terminal; rate limits, overload and transport errors still retry, and a used-up
 *  usage window (`quotaExhausted`) waits for the provider or moves to another one. */
export function fatalProviderError(text: string): boolean {
  return /\b402\b|insufficient[_ ]?(quota|balance|funds)|billing|credit balance|余额/i.test(text);
}
/** A provider's usage window is used up: its requests are refused (and not counted) until the window resets, hours
 *  later. Seen as a gateway's `503 No available accounts` once pi's own retries are spent, or a usage-limit message.
 *  The provider is then avoided until a probe finds it accepting requests again. */
export function quotaExhausted(text: string): boolean {
  if (fatalProviderError(text)) return false;
  if (/no available accounts?/i.test(text)) return true;
  // A request rate limit clears in seconds ("rate limit exceeded; resets in 1 second", "quota exceeded for requests
  // per minute"): pi's retries and the lost-execution path handle it; it must not take the provider out for minutes.
  if (/rate.?limit|too many requests|request limit|per (second|minute)|\b[RT]PM\b|resets? in \d+ ?(ms|s|secs?|seconds?|minutes?)\b/i.test(text)) return false;
  return /usage limit|quota (exceeded|exhausted)|exceeded your (current )?(usage|quota)|limit (reached|exceeded)[^.]*resets?\b|额度/i.test(text);
}
/** A refusal of the request's content (terms of service, usage or content policy): the same request is refused again,
 *  on this provider and usually on another, so it is reported at once instead of retried as a lost execution. */
export function refusedByProvider(text: string): boolean {
  // A content filter that is down ("temporarily unavailable, please retry") is a transient failure, not a refusal.
  if (/temporar|unavailable|try again|retry|timed? ?out|overloaded/i.test(text)) return false;
  return /terms of service|usage polic(y|ies)|acceptable use|content[_ ]?(policy|filter|management policy)|safety (system|filter)|flagged as (unsafe|harmful)/i.test(text);
}
/** P13, C8: Restore the effective provider as pi does: from the last model change or assistant message. */
export function sessionModel(entries: SessionEntry[]): Model | undefined {
  // pi restores the model of the last model change or assistant message: a relaunch with `--model` on an existing
  // session records no model change, so only the answer tells which model the session went on with.
  const last = entries.findLast(e => e.type === "model_change" && e.provider && e.modelId
    || e.type === "message" && e.message?.role === "assistant" && !!(e.message as { provider?: string }).provider && !!(e.message as { model?: string }).model);
  if (!last) return undefined;
  if (last.type === "model_change") return { provider: last.provider!, id: last.modelId! };
  const m = last.message as { provider: string; model: string };
  return { provider: m.provider, id: m.model };
}
