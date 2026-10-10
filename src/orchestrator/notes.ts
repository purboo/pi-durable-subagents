// Pending notes (send kind "notify" to a call that is not running). Workflow journal entries:
// pending-note {rid, call, key, message}: a notify recorded for a sealed call (by the orchestrator), or one accepted for a
// running call and not delivered before it sealed (by the executor, at the seal, before its forward is retired). One per rid.
// generation {..., notes: rid[]}: the follow-up that opened this generation carries those notes in its opening message;
// a note is pending while no generation of its revision names it.
// forward-retired {rid, rid2, reason: "undelivered-follow-up"}: a follow-up forwarded into running work that sealed first
// (by the executor, at the seal); generation {..., follows: rid[]} takes such follow-ups along, after its notes.
import type { Entry } from "../types.ts";

/** The journal entry type of a pending note. */
export const PENDING_NOTE = "pending-note";

/** The pending notes of a call key in one revision's entries, in the order they were recorded. */
export function pendingNotes(log: readonly Entry[], key: string): Entry[] {
  const consumed = new Set(log.filter(e => e.type === "generation").flatMap(e => Array.isArray(e.notes) ? e.notes.map(String) : []));
  return log.filter(e => e.type === PENDING_NOTE && e.key === key && !consumed.has(String(e.rid)));
}

/** A notify forwarded to `call` whose fate is not known yet (neither delivered nor retired): at its seal the executor may
 *  still turn it into a pending note, so a follow-up (or another note) waits for that first. */
export function unsettledNotify(log: readonly Entry[], call: string): boolean {
  return log.some(e => e.type === "forward" && e.dest === call && (e.envelope as { kind?: string } | undefined)?.kind === "notify" &&
    !log.some(r => r.rid2 === e.rid2 && (r.type === "forward-retired" || r.type === "forward-delivered")));
}

/** The `forward-retired` reason of a follow-up forwarded into running work that sealed before taking it (not stopped,
 *  not withdrawn): it is pending, like a note, and opens the next generation (by itself, or with a later follow-up). */
export const UNDELIVERED_FOLLOW_UP = "undelivered-follow-up";

/** The request rids a generation entry carries: the follow-up that opened it and the undelivered ones it took along. */
export function generationRids(e: Entry): string[] {
  return [String(e.rid), ...(Array.isArray(e.follows) ? e.follows.map(String) : [])];
}

/** The undelivered follow-ups of a call key in one revision's entries, in the order they were forwarded: each one's
 *  request rid and message, while no generation names its rid. */
export function pendingFollowUps(log: readonly Entry[], key: string): { rid: string; message: string; from: string }[] {
  const taken = new Set(log.filter(e => e.type === "generation").flatMap(generationRids));
  const retired = new Set(log.filter(e => e.type === "forward-retired" && e.reason === UNDELIVERED_FOLLOW_UP).map(e => String(e.rid2)));
  const keyOf = (call: string) => call.slice(call.indexOf("/") + 1, call.lastIndexOf("@"));
  return log.filter(e => e.type === "forward" && retired.has(String(e.rid2)) && keyOf(String(e.dest)) === key && !taken.has(String(e.rid)))
    .map(e => ({ rid: String(e.rid), from: String(e.dest), message: String(((e.envelope as { body?: { message?: unknown } } | undefined)?.body?.message) ?? "") }));
}

/** A notify or follow-up forwarded to `call` whose fate is not known yet: at its seal the executor may still turn it into
 *  a pending note or an undelivered follow-up, so a follow-up waits for that first. */
export function unsettledForward(log: readonly Entry[], call: string): boolean {
  return log.some(e => e.type === "forward" && e.dest === call && ["notify", "follow-up"].includes(String((e.envelope as { kind?: string } | undefined)?.kind)) &&
    !log.some(r => r.rid2 === e.rid2 && (r.type === "forward-retired" || r.type === "forward-delivered")));
}

/** The opening message of a follow-up that also takes undelivered follow-ups along: notes first, then each message in
 *  the order sent, separated by a blank line. */
export function openingMessage(notes: readonly string[], messages: readonly string[]): string {
  return withNotes(notes, messages.filter(m => m !== "").join("\n\n"));
}

/** The opening message of a follow-up that carries pending notes: every note in order, then the follow-up's own message. */
export function withNotes(notes: readonly string[], message: string): string {
  if (!notes.length) return message;
  const items = notes.map(n => `- ${n.replace(/\n/g, "\n  ")}`).join("\n");
  return `Notes recorded after your last turn:\n${items}\n\n${message}`;
}
