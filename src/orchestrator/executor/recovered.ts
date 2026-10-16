// Private journal entry: recovered{call,v}: the recovery of a sealed or retired call ran to its end (every repair, its
// inbox cleanup) with recovery version `v`. A later start skips reading that call (its session included) while the entry
// is of the current version and no later journal entry concerns the call (see concernedCalls); otherwise it recovers the
// call as before and records the entry again.
import type { Entry, JournalHandle } from "../../types.ts";
import { entriesOf, forwardOf } from "./indexes.ts";

/** Bump whenever the recovery of a sealed or retired call gains a step: every call is then recovered once more. */
export const RECOVERY_VERSION = 1;
export const RECOVERED = "recovered";

const CALL = /^(.*)@(\d+)\/(.*)@(\d+)$/;
const digit = (code: number) => code >= 48 && code <= 57;
/** The calls among `among` (call ids of workflow `wid`) that entry `e` concerns: one whose id appears in any string of
 *  the entry (fields such as call, exec, dest, target, from, an attention item or its id; an id followed by a digit is a
 *  longer generation, not this one), a `call`/`generation` of the same key, and the destination of the forward a
 *  `rid2` names. Receipts themselves concern nothing. Conservative: a false match only costs one more read. */
export function concernedCalls(e: Entry, wid: string, among: ReadonlySet<string>, forwardDest?: (rid2: string) => string | undefined,
  lengths: readonly number[] = [...new Set([...among].map(c => c.length))]): Set<string> {
  const found = new Set<string>();
  if (e.type === RECOVERED || !among.size) return found;
  const marker = `${wid}@`;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (let p = value.indexOf(marker); p >= 0; p = value.indexOf(marker, p + 1))
        for (const length of lengths) {
          if (p + length > value.length) continue;
          const id = value.substr(p, length);
          if (among.has(id) && !digit(value.charCodeAt(p + length))) found.add(id);
        }
    } else if (Array.isArray(value)) for (const v of value) visit(v);
    else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
  };
  visit(e);
  if ((e.type === "generation" || e.type === "call") && e.key !== undefined)
    for (const call of among) if (CALL.exec(call)?.[3] === String(e.key)) found.add(call);
  if (typeof e.rid2 === "string" && forwardDest) {
    const dest = forwardDest(e.rid2);
    if (dest !== undefined && among.has(dest)) found.add(dest);
  }
  return found;
}
/** Whether entry `e` of workflow `wid`'s journal concerns `call` (concernedCalls for one call). */
export function concerns(e: Entry, call: string, forwardDest?: (rid2: string) => string | undefined): boolean {
  const wid = CALL.exec(call)?.[1] ?? call;
  return concernedCalls(e, wid, new Set([call]), forwardDest).size > 0;
}

const complete = new WeakMap<JournalHandle, { length: number; calls: ReadonlySet<string> }>();
/** The calls of workflow `wid` whose recovery is complete: their latest `recovered` entry has the current version and
 *  no later entry concerns them. One pass over the entries after the earliest such receipt; cached per journal length. */
export function completeCalls(journal: JournalHandle, wid: string): ReadonlySet<string> {
  const entries = journal.committed?.() ?? journal.entries(), cached = complete.get(journal);
  if (cached && cached.length === entries.length) return cached.calls;
  const receipts = new Map<string, number>();
  for (const r of entriesOf(journal, RECOVERED)) {
    const call = String(r.call);
    if (r.v === RECOVERY_VERSION) receipts.set(call, r.seq); else receipts.delete(call);
  }
  const calls = new Set(receipts.keys());
  if (calls.size) {
    const lengths = [...new Set([...calls].map(c => c.length))], dest = (rid2: string) => {
      const d = forwardOf(journal, rid2)?.dest;
      return typeof d === "string" ? d : undefined;
    };
    const from = Math.min(...receipts.values());
    // seq is dense from 1: the entries after the earliest receipt start at index `from`.
    for (let i = entries[from - 1]?.seq === from ? from : 0; i < entries.length && calls.size; i++) {
      const e = entries[i]!;
      if (e.seq <= from) continue;
      for (const call of concernedCalls(e, wid, calls, dest, lengths)) if (receipts.get(call)! < e.seq) calls.delete(call);
    }
  }
  complete.set(journal, { length: entries.length, calls });
  return calls;
}
