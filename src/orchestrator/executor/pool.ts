import { parseModel, sameModel, type Model } from "../../compat/model.ts";
import type { Entry, JournalHandle } from "../../types.ts";
import type { CallTicket } from "../contract.ts";

/** A parent model request keeps its pin after it was applied, including in continued generations. */
export function parentPinned(t: CallTicket): boolean {
  if (t.model) return true;
  const log = t.journal.entries(), calls = new Set<string>([t.callId]);
  if (t.continueFrom) calls.add(t.continueFrom);
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.type === "generation" && calls.has(`${t.wid}@${e.revision}/${e.key}@${e.gen}`)) {
      if (typeof e.model === "string") return true;
      calls.add(String(e.from));
    }
  }
  return log.some(e => {
    if (e.type !== "forward" || !calls.has(String(e.dest)) || e.failover || (e.envelope as { kind?: string })?.kind !== "model") return false;
    if (log.some(r => r.type === "forward-delivered" && r.rid2 === e.rid2 && r.reason !== undefined)) return false;
    return !log.some(r => r.type === "forward" && r.dest === e.dest && (r.envelope as { kind?: string })?.kind === "withdraw" &&
      (r.envelope as { body?: { rids?: string[] } }).body?.rids?.includes(String(e.rid2)));
  });
}

/** Other providers with the same id first, then pool order; admission still checks afterMs and slots. */
export function spillCandidates(pinned: Model, candidates: Model[]): Model[] {
  const others = candidates.filter(m => m.provider !== pinned.provider);
  const name = (m: Model) => parseModel(m.id).id.split("/").at(-1)!.toLowerCase();
  return [...others.filter(m => name(m) === name(pinned)), ...others.filter(m => name(m) !== name(pinned))];
}

export const MODEL_RETRY_MS = 600_000;
export function modelFailures(journal: JournalHandle, call: string): Entry[] {
  const execs = new Set(journal.entries().filter(e => e.type === "exec" && e.call === call).map(e => e.exec));
  return journal.entries().filter(e => e.type === "model-unavailable" && execs.has(e.exec));
}
export function failedModel(failures: Entry[], model: Model): boolean {
  return failures.some(e => sameModel(e.selected as Model, model) && Number(e.until) > Date.now());
}
