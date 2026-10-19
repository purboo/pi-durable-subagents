// What the periodic observation of a live call needs from its native session, folded incrementally: readSessionState
// extends its entries array with the same entry objects when the file grew, so a fold over a prefix is reused and
// only appended entries are visited. A session read from scratch (rewritten, replaced) restarts the fold. Each fold
// equals what the whole-array function it replaces computes over the same entries (see the tests).
import { CT, askFields, type StructuredAskFields } from "../../types.ts";
import { askOf, cutAskResult, receiptId, type SessionEntry } from "./session.ts";
import { messageUsage, type Usage } from "./usage.ts";

export type Question = StructuredAskFields & { qid: string; rev: number; question: unknown };
export interface SessionDigest {
  /** Usage of every assistant message in segments opened by this call (sessionUsage), in session order. */
  usage: { id: string; usage: Usage }[];
  /** First receipt entry of each request id, without identity-conflict rejections (collectReceipts, forwardsDelivered). */
  receipts: Map<string, SessionEntry>;
  /** Well-formed question entries (custom question with a string qid and numeric rev) in segments opened by this call's
   *  executions, in session order. A question an earlier generation (or another call) asked is not this call's: its
   *  child recovers only its own questions (child/history.ts) and rejects an answer to another as stale. */
  questions: Question[];
  /** JSON [qid, rev] of every entry whose details carry qid and rev and that is a receipt (an answer). */
  answered: Set<string>;
  /** JSON [qid, rev] of every question a receipt names as superseded (details.superseded, D2). */
  superseded: Set<string>;
  /** Index of the last custom question entry (any data), as findLastIndex finds it. */
  lastQuestion: number;
  /** Last index of an entry with customType question per data.qid (any type), for "asked after the segment". */
  questionAt: Map<unknown, number>;
  /** Last index of the custom exec entry of each execution. */
  execAt: Map<unknown, number>;
  /** First toolResult entry of each toolCallId. */
  results: Map<string, SessionEntry>;
}
export const answerKey = (qid: unknown, rev: unknown) => JSON.stringify([qid, rev]);
/** D2: the questions an answer receipt superseded (`details.superseded`: the blocked or hibernated asker's question). */
export function supersededBy(details: { superseded?: unknown } | undefined): { qid: string; rev: number }[] {
  return Array.isArray(details?.superseded) ? details.superseded.filter(q => typeof q?.qid === "string" && typeof q?.rev === "number") : [];
}

/** A fold of one session for one call, extended over appended entries. */
export class SessionFold {
  private call: string;
  private entries?: readonly SessionEntry[];
  private first?: SessionEntry;
  private last?: SessionEntry;
  private count = 0;
  private own = false;
  /** Entries visited since the fold started (a test counter: it grows with appended entries, not with the session). */
  visited = 0;
  state: SessionDigest;
  constructor(call: string) { this.call = call; this.state = SessionFold.empty(); }
  private static empty(): SessionDigest {
    return { usage: [], receipts: new Map(), questions: [], answered: new Set(), superseded: new Set(), lastQuestion: -1, questionAt: new Map(), execAt: new Map(), results: new Map() };
  }
  update(entries: readonly SessionEntry[]): SessionDigest {
    if (entries === this.entries) return this.state;
    const extended = this.count <= entries.length && (this.count === 0 || entries[0] === this.first && entries[this.count - 1] === this.last);
    if (!extended) { this.state = SessionFold.empty(); this.count = 0; this.own = false; }
    const s = this.state;
    for (; this.count < entries.length; this.count++) {
      const e = entries[this.count]!, i = this.count;
      this.visited++;
      if (e.type === "custom" && e.customType === CT.exec) {
        this.own = typeof e.data?.exec === "string" && e.data.exec.startsWith(`${this.call}#`);
        s.execAt.set(e.data?.exec, i);
      }
      const u = this.own && e.message && messageUsage(e.message as Record<string, unknown>);
      if (u) s.usage.push(u);
      const rid = receiptId(e);
      if (rid && !s.receipts.has(rid) && !(e.customType === CT.rejected && e.data?.reason === "identity-conflict")) s.receipts.set(rid, e);
      if (e.customType === CT.question) {
        s.questionAt.set(e.data?.qid, i);
        if (e.type === "custom") {
          s.lastQuestion = i;
          if (this.own && e.data && typeof e.data.qid === "string" && typeof e.data.rev === "number") s.questions.push({ qid: e.data.qid, rev: e.data.rev, question: e.data.question, ...askFields(e.data) });
        }
      }
      const details = e.message?.details ?? e.details;
      if (details && rid !== undefined) s.answered.add(answerKey(details.qid, details.rev));
      if (rid !== undefined) for (const q of supersededBy(details)) s.superseded.add(answerKey(q.qid, q.rev));
      const m = e.message;
      if (m?.role === "toolResult" && typeof m.toolCallId === "string" && !s.results.has(m.toolCallId)) s.results.set(m.toolCallId, e);
    }
    this.entries = entries; this.first = entries[0]; this.last = entries[this.count - 1];
    return s;
  }
}

/** openQuestion (hibernate.ts) from a digest of the same entries. */
export function digestOpenQuestion(entries: readonly SessionEntry[], s: SessionDigest): Question & { question: string } | undefined {
  const at = s.lastQuestion, q = entries[at]?.data;
  if (!q || typeof q.qid !== "string" || typeof q.rev !== "number") return;
  if (s.answered.has(answerKey(q.qid, q.rev)) || s.superseded.has(answerKey(q.qid, q.rev))) return;
  const ask = askOf(entries, at);
  const result = ask === undefined ? undefined : s.results.get(ask);
  if (ask === undefined || result && !cutAskResult(result.message)) return;
  return { qid: q.qid, rev: q.rev, question: String(q.question), ...askFields(q) };
}
