// Private workflow entries (P28): hibernated{call,qid,rev,exec};
// answer-bound{call,qid,rev,rid,rid2,message,hash}; resumed{call,rid,exec}.
import { CT, JT, attentionEntries, type Entry, type JournalHandle } from "../../types.ts";
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

/** P28: The question qid@rev of a call is still open: its attention item is its latest revision and is unresolved.
 *  A call hibernated on one question takes the answer to any of its open questions (an earlier one stays open when a
 *  steer ended its ask, or the child asked a reminder while it waited). */
export function openAsked(entries: readonly Entry[], call: string, qid: unknown, rev: unknown): boolean {
  if (typeof qid !== "string" || typeof rev !== "number") return false;
  const id = `q:${call}:${qid}`, items = attentionEntries(entries, id);
  return items.some(e => e.item.rev === rev) && !items.some(e => e.item.rev > rev) &&
    !entries.some(e => e.type === JT.attentionResolved && e.id === id && e.rev === rev);
}

/** P28: The answer bound to hibernation `sleeping`: to its question, or (bound after it) to another open question. */
export function boundAnswer(entries: readonly Entry[], sleeping: Entry): Entry | undefined {
  return entries.find(e => e.type === "answer-bound" && e.call === sleeping.call &&
    (e.qid === sleeping.qid && e.rev === sleeping.rev || e.seq > sleeping.seq));
}
