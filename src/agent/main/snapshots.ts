import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forgetJournalSnapshot, journalAppends, readJournalFold, readJournalSnapshot, readJournalUncached, type JournalFold } from "../../kernel/journal.ts";
import { journalPath } from "../../paths.ts";
import { CT, JT, type AttentionItem, type Entry } from "../../types.ts";
import { openGeneration, readerWorkflowListing, releaseLoadedSettledJournals, releaseSettledJournals, SETTLED_RECHECK_MS, unresolvedAttention, workflowDigest, workflowDigestChecked, type WorkflowDigest } from "../../orchestrator/snapshot.ts";
import { readerHold, readerLedgerIdentity } from "../../orchestrator/reader-ledger.ts";

/** Session-outbox reader: retain only pending identities and a verified position, not sent envelopes/history. */
export class PendingOutboxReader {
  private readonly positions = new Map<string, JournalFold<Set<string>>>();
  clear(): void { this.positions.clear(); }
  read(path: string): ReadonlySet<string> {
    const prior = this.positions.get(path);
    this.positions.delete(path); // Never retry partially applied state after a failed read.
    const record = readJournalFold(path, prior, () => new Set<string>(), (pending, entry) => {
      if (entry.type === 'sent') pending.add((entry.request as { rid: string }).rid);
      else if (entry.type === 'resolved') pending.delete(String(entry.rid));
    }, { needles: ['"type":"sent"', '"type":"resolved"'] });
    // A torn tail may be repaired at unchanged size; do not reuse that file identity as a committed position.
    if (record && record.length === record.size) {
      this.positions.set(path, record);
      if (this.positions.size > 64) this.positions.delete(this.positions.keys().next().value!);
    }
    // A copy: the fold extends its state in place on the next read, so a returned set must not alias it.
    return new Set(record?.state);
  }
}

/** P15, P25: Read workflow snapshots without modifying another domain's history; a wid with an orchestrator.jsonl
 *  `pruned{wid}` entry is gone (housekeeping), even while its directory is still being removed. A settled workflow
 *  comes with its digest (`settled`) and its journal is read only if `entries` is asked for. */
export type MainWorkflow = { wid: string; origin?: string; settled?: { attention: AttentionItem[] }; readonly entries: Entry[] };
type MainPass = { mark: string; checked: number; appends: number; names: string[]; retryUnknown: boolean; ids: string[]; pending: string[]; digests: Map<string, WorkflowDigest>; result: MainWorkflow[] };
const passes = new Map<string, Map<string | undefined, MainPass>>();
export function workflows(home: string, origin?: string, fresh = false): MainWorkflow[] {
  const { record, names, checked: listed } = readerWorkflowListing(home, fresh), ix = record.state, mark = readerLedgerIdentity(record), now = Date.now();
  let byOrigin = passes.get(home);
  if (!byOrigin) passes.set(home, byOrigin = new Map());
  const prior = byOrigin.get(origin), current = !fresh && prior && prior.names === names && !prior.retryUnknown && prior.mark === mark && prior.appends === journalAppends() && now >= prior.checked && now - prior.checked < SETTLED_RECHECK_MS;
  if (current && !prior.pending.length) {
    releaseLoadedSettledJournals();
    return prior.result;
  }
  const ids = current ? prior.ids : [...new Set([...[...ix.created.keys()].map(String), ...names].filter(wid => !ix.pruned.has(wid)))].sort()
    .filter(wid => origin === undefined || !ix.created.has(wid) || ix.created.get(wid)?.origin === origin);
  const digests = new Map(current ? prior.digests : []), old = new Map(prior?.result.map(w => [w.wid, w])), changes = new Map<string, MainWorkflow>();
  try {
    for (const wid of current ? prior.pending : ids) {
      const pendingRevision = (ix.revisions.get(wid) ?? 0) > (prior?.digests.get(wid)?.snapshot.rev ?? 0);
      const known = ix.created.get(wid), digest = workflowDigest(home, wid, fresh || pendingRevision ? undefined : mark), path = journalPath(home, wid);
      const from = known ? known.origin : readJournalUncached(path)?.entries.find(e => e.type === JT.created)?.origin;
      if (origin !== undefined && from !== origin) { old.delete(wid); digests.set(wid, digest); continue; }
      if (prior?.digests.get(wid) === digest && old.get(wid)?.origin === from) { digests.set(wid, digest); continue; }
      digests.set(wid, digest);
      changes.set(wid, { wid, origin: from as string | undefined, ...(digest.settled ? { settled: digest.settled } : {}), get entries() {
        const entries = readJournalSnapshot(path);
        if (digest.settled) forgetJournalSnapshot(path);
        return entries;
      } });
    }
    const result = ids.map(wid => changes.get(wid) ?? old.get(wid)).filter((w): w is MainWorkflow => !!w);
    const same = prior && prior.result.length === result.length && result.every((w, i) => w === prior.result[i]);
    // Digest reuse and another reader's listing refresh cannot extend this pass's trust window.
    let checked = current ? prior.checked : Math.min(now, listed);
    const pending = ids.filter(wid => {
      const d = digests.get(wid);
      if (d?.settled) checked = Math.min(checked, workflowDigestChecked(home, wid));
      return !d?.settled || (ix.revisions.get(wid) ?? 0) > d.snapshot.rev;
    });
    byOrigin.set(origin, { mark, checked, appends: journalAppends(), names, retryUnknown: ids.some(wid => !ix.created.has(wid)), ids, pending, digests, result: same ? prior.result : result });
    return same ? prior.result : result;
  } finally { releaseSettledJournals(); }
}

export { openGeneration };
/** Whether one journal is unfinished, by file identity: a journal that has not changed is not read again. */
const decided = new Map<string, { ino: number; size: number; unfinished: boolean }>();
function unfinishedJournal(path: string, known?: { ino: number; size: number; entries: readonly Entry[] }): boolean {
  let stat;
  try { stat = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; decided.delete(path); return true; } // no done yet
  const hit = decided.get(path);
  if (hit && hit.ino === stat.ino && hit.size === stat.size) return hit.unfinished;
  // Read without keeping the entries in the shared journal cache: a pi process scans every workflow only when no
  // orchestrator runs, and keeping every journal of the machine cost it hundreds of MB.
  const read = known ?? readJournalUncached(path);
  if (!read) { decided.delete(path); return true; }
  const unfinished = !read.entries.some(e => e.type === JT.done) || openGeneration(read.entries);
  decided.set(path, { ino: read.ino, size: read.size, unfinished });
  return unfinished;
}
/** R3: Whether a journal has a started command call: a `command-intent` whose call has no seal. A hold never stops
 *  one, so an orchestrator must watch and seal it even while its workflow is held. Cached by file identity. */
const commanded = new Map<string, { ino: number; size: number; running: boolean }>();
function startedCommand(path: string, known?: { ino: number; size: number; entries: readonly Entry[] }): boolean {
  let stat;
  try { stat = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; commanded.delete(path); return false; }
  if (!stat.isFile()) { commanded.delete(path); return false; } // unreadable held work stays held
  const hit = commanded.get(path);
  if (hit && hit.ino === stat.ino && hit.size === stat.size) return hit.running;
  let read = known;
  try { read ??= readJournalUncached(path); } catch { commanded.delete(path); return false; }
  if (!read) { commanded.delete(path); return false; }
  const intents = new Set<string>();
  for (const e of read.entries) {
    if (e.type === "command-intent") intents.add(String(e.call));
    else if (e.type === JT.sealed) intents.delete(String(e.call));
  }
  commanded.set(path, { ino: read.ino, size: read.size, running: intents.size > 0 });
  return intents.size > 0;
}
/** P1: Workflow-side pending work shared by every starter: a workflow without JT.done or with an unsealed generation,
 *  unless a drain (stop-all) holds it: held work waits for an explicit resume, which starts the orchestrator itself.
 *  R3: a held workflow with a started, unsealed command call is pending all the same (the hold does not stop it).
 *  Stops at the first unfinished workflow (newest first); a held workflow is read only for a started command call
 *  (startedCommand), and an unchanged journal is not read again. */
export function unfinishedWorkflow(home: string, fresh = false): boolean {
  const { record, names } = readerWorkflowListing(home, fresh), ix = record.state, { created, pruned } = ix;
  const ids = [...new Set([...[...created.keys()].map(String), ...names].filter(wid => !pruned.has(wid)))].sort().reverse();
  for (const wid of ids) {
    const path = journalPath(home, wid);
    // The hold rule is the one workflows() applies: the ledger's `created` names the origin a drain may hold; only for
    // a wid the ledger has no `created` for is the journal read first, for a `created` entry of its own.
    const known = created.get(wid);
    if (known && readerHold(ix, wid, known.origin as string | undefined)) { if (startedCommand(path)) return true; continue; }
    let read: ReturnType<typeof readJournalUncached>;
    if (!known) {
      read = readJournalUncached(path);
      if (readerHold(ix, wid, read?.entries.find(e => e.type === JT.created)?.origin as string | undefined)) { if (startedCommand(path, read)) return true; continue; }
    }
    if (unfinishedJournal(path, read)) return true;
  }
  return false;
}

/** P15, V7: Rebuild session-wide receipts, including entries hidden by compaction. */
type Receipts = { first?: unknown; last?: unknown; length: number; items: { id: string; rev: number }[] };
const receipts = new WeakMap<object, Receipts>();
const receiptsOf = (entry: { type: string; customType?: string; details?: unknown }) => entry.type === "custom_message" && entry.customType === CT.attention
  ? (entry.details as { items?: AttentionItem[] } | undefined)?.items ?? [] : [];
export function presented(ctx: ExtensionContext): { id: string; rev: number }[] {
  // The main session is append-only between session switches: scan only the entries added since the last poll.
  const entries = ctx.sessionManager.getEntries() as unknown as { type: string; customType?: string; details?: unknown }[];
  const owner = ctx.sessionManager as object, prior = receipts.get(owner);
  const appended = prior && prior.length <= entries.length && prior.first === entries[0] && prior.last === entries[prior.length - 1];
  const items = appended ? prior.items.concat(entries.slice(prior.length).flatMap(receiptsOf)) : entries.flatMap(receiptsOf);
  receipts.set(owner, { first: entries[0], last: entries.at(-1), length: entries.length, items });
  return items;
}

/** P15, V7: Select only unresolved, unpresented items owned by this session. */
export function attention(home: string, sender: string, seen: { id: string; rev: number }[], fresh = false): AttentionItem[] {
  const items: AttentionItem[] = [], shown = new Set(seen.map(s => `${s.id}\0${s.rev}`));
  for (const workflow of workflows(home, sender, fresh)) {
    for (const item of workflow.settled?.attention ?? unresolvedAttention(workflow.entries)) {
      const key = `${item.id}\0${item.rev}`;
      if (shown.has(key)) continue; // singlePresentation: one presentation per id/rev
      shown.add(key); items.push(item);
    }
  }
  return items;
}

/** What the main agent reads for an attention item: the text, addressed. A question's own text named neither the asking
 *  call nor how to answer it, so answers went out as steers or to the wrong id. */
export function presentText(item: AttentionItem): string {
  const call = item.call ? item.call.replace(/@\d+\/([^@/]+)@\d+$/, "/$1") : undefined, where = call ?? item.wid;
  if (item.kind === "question" && call) return `Question from ${call}${item.qid ? ` (qid ${item.qid})` : ""}; reply with send kind:"answer" to:"${call}": ${item.text}`;
  return item.text.includes(item.wid) ? item.text : `${where}: ${item.text}`;
}

/** Resolutions recorded in one immutable journal snapshot, keyed by id and rev. */
const resolutions = new WeakMap<readonly Entry[], Map<string, string>>();
function resolvedIn(entries: readonly Entry[]): Map<string, string> {
  let done = resolutions.get(entries);
  if (!done) { done = new Map(entries.filter(e => e.type === JT.attentionResolved).map(e => [JSON.stringify([e.id, e.rev]), typeof e.resolution === "string" ? e.resolution : "resolved"])); resolutions.set(entries, done); }
  return done;
}
/** Preserve the reason so presentation distinguishes resumed output from a terminated execution. */
export function attentionResolution(home: string, item: AttentionItem): string | undefined {
  return resolvedIn(readJournalSnapshot(journalPath(home, item.wid))).get(JSON.stringify([item.id, item.rev]));
}
/** Successful `ask` results per child session file, read incrementally: pi renders an open question's card on every
 *  frame, and re-reading and parsing the whole child session each time stalled typing in the main session. */
type AskScan = { identity: string; offset: number; mark: Buffer; pending: string; decoder: StringDecoder; answered: Set<string> };
const asks = new Map<string, AskScan>(), ASK_SCANS = 64, MARK = 64;
function ask(scan: AskScan, line: string): void {
  if (!line.includes('"ask"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; } // a malformed line is skipped, as pi and the session tail do (E4)
  const msg = entry?.type === "message" ? entry.message : undefined;
  if (msg?.role === "toolResult" && msg.toolName === "ask" && !msg.isError) scan.answered.add(JSON.stringify([msg.details?.qid, msg.details?.rev]));
}
function answeredAsks(path: string): Set<string> | undefined {
  let stat;
  try { stat = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { asks.delete(path); return undefined; } throw error; }
  const identity = `${stat.dev}:${stat.ino}`;
  let scan = asks.get(path);
  if (scan) { asks.delete(path); asks.set(path, scan); } // least recently used first
  const fd = openSync(path, "r");
  try {
    // Appending keeps what was read: the bytes just before the old end are still there. Anything else (a replaced or
    // shorter file, other bytes before the old end) is a rewrite, read again from the start. File times are too coarse
    // to tell a quick rewrite of the same size, so the bytes are compared.
    let kept = !!scan && scan.identity === identity && stat.size >= scan.offset;
    if (kept && scan!.mark.length) {
      const now = Buffer.alloc(scan!.mark.length);
      kept = readSync(fd, now, 0, now.length, scan!.offset - now.length) === now.length && now.equals(scan!.mark);
    }
    if (kept && stat.size === scan!.offset) return scan!.answered;
    if (!kept) {
      scan = { identity, offset: 0, mark: Buffer.alloc(0), pending: "", decoder: new StringDecoder("utf8"), answered: new Set() };
      asks.set(path, scan);
      if (asks.size > ASK_SCANS) asks.delete(asks.keys().next().value!);
    }
    const s = scan!;
    const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, stat.size - s.offset)));
    while (s.offset < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - s.offset), s.offset);
      if (!n) break;
      s.offset += n; s.pending += s.decoder.write(buffer.subarray(0, n));
      s.mark = Buffer.concat([s.mark, buffer.subarray(0, n)]).subarray(-MARK);
      let end;
      while ((end = s.pending.indexOf("\n")) >= 0) { ask(s, s.pending.slice(0, end)); s.pending = s.pending.slice(end + 1); }
    }
    // A last line without its newline counts once it is complete JSON; it stays pending until the newline arrives.
    if (s.pending) ask(s, s.pending);
    return s.answered;
  } finally { closeSync(fd); }
}
/** P15: Refresh a question against durable workflow and child receipts at request time. */
export function resolved(home: string, item: AttentionItem): boolean {
  if (attentionResolution(home, item) !== undefined) return true;
  if (item.kind !== "question" || !item.session || !item.qid) return false;
  return answeredAsks(item.session)?.has(JSON.stringify([item.qid, item.rev])) ?? false;
}
