// Pi-side ledger state: only projections used by readers, never decoded ledger history or run bodies.
import { forgetJournalSnapshot, readJournalFold, type JournalFold } from "../kernel/journal.ts";
import { orchLedger } from "../paths.ts";
import { JT, type Entry } from "../types.ts";
import { applyLedger, emptyLedger, type LedgerState } from "./ledger.ts";
import { labelsOf } from "../events/derive.ts";

type Created = Pick<Entry, "seq" | "ts"> & { wid: unknown; rid: unknown; origin: unknown };
type Drain = Pick<Entry, "seq" | "ts" | "type">;
export interface ReaderLedger {
  created: Map<unknown, Created>;
  /** Last creation per wid for status fallback; the first creation is used for membership and hold semantics. */
  origins: Map<string, unknown>;
  intents: Map<string, unknown>;
  revisions: Map<string, number>;
  pruned: Set<string>;
  labels: Map<string, Record<string, string>>; runLabels: Map<string, Record<string, string>>;
  sessions: Map<string, string>; runSessions: Map<string, string>;
  global?: Drain; byWid: Map<unknown, Drain>; byOrigin: Map<unknown, Drain>; lastDrain?: Drain;
  state: LedgerState;
  createdRids: Map<unknown, { wid: unknown }>;
  decisions: Map<string, { type: "applied" | "rejected"; reason?: string }>;
  /** UI controls consume the first resolution, including an identity-conflict refusal. */
  resolutions: Map<string, { seq: number; type: "applied" | "rejected"; reason?: string }>;
  sendNotes: Map<unknown, Entry>;
}
export function emptyReaderLedger(): ReaderLedger {
  return { created: new Map(), origins: new Map(), intents: new Map(), revisions: new Map(), pruned: new Set(), labels: new Map(), runLabels: new Map(), sessions: new Map(), runSessions: new Map(),
    byWid: new Map(), byOrigin: new Map(), state: emptyLedger(), createdRids: new Map(), decisions: new Map(), resolutions: new Map(), sendNotes: new Map() };
}
export function applyReaderLedger(ix: ReaderLedger, e: Entry): void {
  if (e.type === JT.created) {
    if (!ix.created.has(e.wid)) ix.created.set(e.wid, { seq: e.seq, ts: e.ts, wid: e.wid, rid: e.rid, origin: e.origin });
    ix.origins.set(String(e.wid), e.origin);
    if (!ix.createdRids.has(e.rid)) ix.createdRids.set(e.rid, { wid: e.wid });
    const labels = ix.runLabels.get(String(e.rid)), session = ix.runSessions.get(String(e.rid));
    if (labels) { if (!ix.labels.has(String(e.wid))) ix.labels.set(String(e.wid), labels); ix.runLabels.delete(String(e.rid)); }
    if (session) { if (!ix.sessions.has(String(e.wid))) ix.sessions.set(String(e.wid), session); ix.runSessions.delete(String(e.rid)); }
  } else if (e.type === "create-intent") {
    if (!ix.intents.has(String(e.wid))) ix.intents.set(String(e.wid), e.origin);
  } else if (e.type === "revise-intent") {
    const revision = Number(e.revision), wid = String(e.wid);
    if (Number.isFinite(revision)) ix.revisions.set(wid, Math.max(revision, ix.revisions.get(wid) ?? 0));
  } else if (e.type === "request") {
    const r = e.request as { rid?: unknown; kind?: unknown; body?: unknown } | undefined;
    const labels = r?.kind === "run" ? labelsOf(r.body) : undefined;
    if (labels && typeof r?.rid === "string") ix.runLabels.set(r.rid, labels);
    const session = r?.kind === "run" ? (r.body as { session?: unknown } | null)?.session : undefined;
    if (typeof session === "string" && session && typeof r?.rid === "string") ix.runSessions.set(r.rid, session);
  } else if (e.type === "pruned") {
    ix.pruned.add(String(e.wid)); ix.labels.delete(String(e.wid)); ix.sessions.delete(String(e.wid));
  } else if (e.type === "drain" || e.type === "undrain") {
    const drain = { seq: e.seq, ts: e.ts, type: e.type };
    if (e.type === "drain") ix.lastDrain = drain;
    if (e.wid === undefined && e.origin === undefined) ix.global = drain;
    if (e.wid !== undefined) ix.byWid.set(e.wid, drain);
    if (e.origin !== undefined) ix.byOrigin.set(e.origin, drain);
  }
  if (e.type === JT.rejected) { ix.runLabels.delete(String(e.rid)); ix.runSessions.delete(String(e.rid)); }
  if (e.type === JT.applied || e.type === JT.rejected) {
    const resolution = { type: e.type, ...(e.type === JT.rejected ? { reason: String(e.reason) } : {}) };
    if (!ix.resolutions.has(e.rid as string)) ix.resolutions.set(e.rid as string, { seq: e.seq, ...resolution });
    if (!(e.type === JT.rejected && e.reason === "identity-conflict") && !ix.decisions.has(e.rid as string)) ix.decisions.set(e.rid as string, resolution);
  }
  if (e.type === "send-note") ix.sendNotes.set(e.rid, { seq: e.seq, ts: e.ts, type: e.type, rid: e.rid, model: e.model, effect: e.effect, pool: e.pool, delivery: e.delivery });
  // applyLedger is shared with the orchestrator; reader projections discard execution-only switch history/skips.
  // A holder needs only pool/slot/exec, not any extra payload the entry might carry.
  if (e.type === "hold") applyLedger(ix.state, { seq: e.seq, ts: e.ts, type: e.type, pool: e.pool, slot: e.slot, exec: e.exec });
  else if (e.type !== "switch-observed" && e.type !== "skip" && e.type !== "writer-hold" && e.type !== "writer-release") applyLedger(ix.state, e);
  ix.state.seen++;
}
export function readerHold(ix: ReaderLedger, wid: string, origin?: string): Drain | undefined {
  const candidates = [ix.global, ix.byWid.get(wid), origin !== undefined ? ix.byOrigin.get(origin) : undefined];
  const last = candidates.reduce<Drain | undefined>((a, b) => b && (!a || b.seq > a.seq) ? b : a, undefined);
  const created = ix.created.get(wid);
  return last?.type === "drain" && (!created || created.seq < last.seq) ? last : undefined;
}
const readers = new Map<string, JournalFold<ReaderLedger>>();
export function readerLedger(home: string): JournalFold<ReaderLedger> {
  const path = orchLedger(home);
  // Drop any raw snapshot loaded by another read path in this process. This reader never creates one itself.
  forgetJournalSnapshot(path);
  try {
    const record = readJournalFold(path, readers.get(path), emptyReaderLedger, applyReaderLedger);
    if (record) { readers.set(path, record); return record; }
    readers.delete(path);
    return { dev: 0, ino: 0, size: 0, length: 0, seen: 0, state: emptyReaderLedger() };
  } catch (error) { readers.delete(path); throw error; } // a partial fold is never retried as an accepted prefix
}
export const readerLedgerIdentity = (record: Pick<JournalFold<ReaderLedger>, "dev" | "ino" | "size">): string => `${record.dev}:${record.ino}:${record.size}`;
