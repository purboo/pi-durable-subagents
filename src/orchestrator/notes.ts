// Pending notes (send kind "notify" to a call that is not running). Workflow journal entries:
// pending-note {rid, call, key, message}: a notify recorded for a sealed call (by the orchestrator), or one accepted for a
// running call and not delivered before it sealed (by the executor, at the seal, before its forward is retired). One per rid.
// generation {..., notes: rid[]}: the follow-up that opened this generation carries those notes in its opening message;
// a note is pending while no generation of its revision names it.
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

/** The opening message of a follow-up that carries pending notes: every note in order, then the follow-up's own message. */
export function withNotes(notes: readonly string[], message: string): string {
  if (!notes.length) return message;
  const items = notes.map(n => `- ${n.replace(/\n/g, "\n  ")}`).join("\n");
  return `Notes recorded after your last turn:\n${items}\n\n${message}`;
}
