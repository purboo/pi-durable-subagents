// Private workflow entries (P28): hibernated{call,qid,rev,exec};
// answer-bound{call,qid,rev,rid,rid2,message,hash}; resumed{call,rid,exec}.
import { CT, type JournalHandle } from "../../types.ts";
import type { SessionEntry } from "./session.ts";

/** P28, V4: Find an unanswered question whose native ask tool remains blocked. */
export function openQuestion(entries: SessionEntry[]): { qid: string; rev: number; question: string } | undefined {
  const q = entries.findLast(e => e.type === "custom" && e.customType === CT.question)?.data;
  if (!q || typeof q.qid !== "string" || typeof q.rev !== "number") return;
  if (entries.some(e => {
    const details = e.message?.details ?? (e as unknown as { details?: Record<string, unknown> }).details;
    return !!details && details.qid === q.qid && details.rev === q.rev && typeof details.rid === "string";
  })) return;
  const pending = new Set<string>();
  for (const e of entries) {
    const m = e.message;
    if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "toolCall" && b.name === "ask" && b.id) pending.add(b.id);
    if (m?.role === "toolResult" && m.toolCallId) pending.delete(m.toolCallId);
  }
  if (!pending.size) return;
  return { qid: q.qid, rev: q.rev, question: String(q.question) };
}

/** P28: A hibernation remains parked until its bound answer acquires a new execution. */
export function hibernation(journal: JournalHandle, call: string) {
  return journal.entries().findLast(e => e.type === "hibernated" && e.call === call);
}
