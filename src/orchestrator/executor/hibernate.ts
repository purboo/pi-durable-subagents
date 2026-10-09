// Private workflow entries (P28): hibernated{call,qid,rev,exec};
// answer-bound{call,qid,rev,rid,rid2,message,hash}; resumed{call,rid,exec}.
import { CT, type JournalHandle } from "../../types.ts";
import { askOf, cutAskResult, receiptId, type SessionEntry } from "./session.ts";

/** P28, V4: Find an unanswered question whose native ask tool remains blocked. */
export function openQuestion(entries: SessionEntry[]): { qid: string; rev: number; question: string } | undefined {
  const at = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.question), q = entries[at]?.data;
  if (!q || typeof q.qid !== "string" || typeof q.rev !== "number") return;
  if (entries.some(e => {
    const details = e.message?.details ?? e.details;
    return !!details && details.qid === q.qid && details.rev === q.rev && receiptId(e) !== undefined;
  })) return;
  // Only the ask that wrote this question counts: it is still blocked when it has no result, or only the error it ended
  // with when its session shut down or its run was aborted. An earlier ask cut off that way does not keep a later
  // question (ended by a steer, say) open.
  const ask = askOf(entries, at);
  const result = ask === undefined ? undefined : entries.find(e => e.message?.role === "toolResult" && e.message.toolCallId === ask);
  if (ask === undefined || result && !cutAskResult(result.message)) return;
  return { qid: q.qid, rev: q.rev, question: String(q.question) };
}

/** P28: A hibernation remains parked until its bound answer acquires a new execution. */
export function hibernation(journal: JournalHandle, call: string) {
  return journal.entries().findLast(e => e.type === "hibernated" && e.call === call);
}
