import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { journalPath, orchLedger } from "../../paths.ts";
import { CT, JT, type AttentionItem, type Entry } from "../../types.ts";
import { holdOf, ledgerIndex } from "../../orchestrator/snapshot.ts";

/** P15, P25: Read workflow snapshots without modifying another domain's history; a wid with an orchestrator.jsonl
 *  `pruned{wid}` entry is gone (housekeeping), even while its directory is still being removed. */
export function workflows(home: string, origin?: string): { wid: string; origin?: string; entries: Entry[] }[] {
  const ledger = readJournalSnapshot(orchLedger(home)), { created: createdBy, pruned } = ledgerIndex(ledger);
  let names: string[];
  try { names = readdirSync(join(home, "w")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const ids = new Set([...[...createdBy.keys()].map(String), ...names].filter(wid => !pruned.has(wid)));
  const result: { wid: string; origin?: string; entries: Entry[] }[] = [];
  for (const wid of [...ids].sort()) {
    // With an origin wanted, a workflow the ledger attributes to another session is skipped without reading its journal.
    const known = createdBy.get(wid);
    if (origin !== undefined && known && known.origin !== origin) continue;
    const entries = readJournalSnapshot(journalPath(home, wid));
    const created = known ?? entries.find(e => e.type === JT.created);
    if (origin !== undefined && created?.origin !== origin) continue;
    result.push({ wid, origin: created?.origin as string | undefined, entries });
  }
  return result;
}

/** P37: a generation opened by a send (possibly after the workflow finished) that has no seal yet is pending work. */
const opened = new WeakMap<object, { length: number; open: boolean }>();
export function openGeneration(entries: readonly { type: string; [k: string]: unknown }[]): boolean {
  const hit = opened.get(entries);
  if (hit?.length === entries.length) return hit.open;
  // Sealed call ids end in `/<key>@<gen>`; collect every such suffix once instead of rescanning per generation.
  const sealed = new Set<string>();
  for (const s of entries) if (s.type === JT.sealed) { const call = String(s.call); for (let i = call.indexOf("/"); i >= 0; i = call.indexOf("/", i + 1)) sealed.add(call.slice(i)); }
  const open = entries.some(g => g.type === "generation" && !sealed.has(`/${String(g.key)}@${String(g.gen)}`));
  opened.set(entries, { length: entries.length, open });
  return open;
}
/** P1: Workflow-side pending work shared by every starter: a workflow without JT.done or with an unsealed generation,
 *  unless a drain (stop-all) holds it: held work waits for an explicit resume, which starts the orchestrator itself. */
export function unfinishedWorkflow(home: string): boolean {
  const ledger = readJournalSnapshot(orchLedger(home));
  return workflows(home).some(w => (!w.entries.some(e => e.type === JT.done) || openGeneration(w.entries)) && !holdOf(ledger, w.wid, w.origin));
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

const open = new WeakMap<readonly Entry[], AttentionItem[]>();
/** The unresolved attention items of one immutable journal snapshot, computed once per snapshot. */
function unresolved(entries: readonly Entry[]): AttentionItem[] {
  let items = open.get(entries);
  if (items) return items;
  const done = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => `${e.id}\0${e.rev}`));
  items = entries.filter(e => e.type === JT.attention).map(e => e.item as AttentionItem).filter(item => !done.has(`${item.id}\0${item.rev}`));
  open.set(entries, items);
  return items;
}
/** P15, V7: Select only unresolved, unpresented items owned by this session. */
export function attention(home: string, sender: string, seen: { id: string; rev: number }[]): AttentionItem[] {
  const items: AttentionItem[] = [], shown = new Set(seen.map(s => `${s.id}\0${s.rev}`));
  for (const workflow of workflows(home, sender)) {
    for (const item of unresolved(workflow.entries)) {
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
const resolutions = new WeakMap<readonly Entry[], Set<string>>();
function resolvedIn(entries: readonly Entry[]): Set<string> {
  let done = resolutions.get(entries);
  if (!done) { done = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => JSON.stringify([e.id, e.rev]))); resolutions.set(entries, done); }
  return done;
}
/** Successful `ask` results per child session file, read incrementally: pi renders an open question's card on every
 *  frame, and re-reading and parsing the whole child session each time stalled typing in the main session. */
type AskScan = { identity: string; offset: number; pending: string; decoder: StringDecoder; answered: Set<string> };
const asks = new Map<string, AskScan>();
function answeredAsks(path: string): Set<string> | undefined {
  let stat;
  try { stat = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { asks.delete(path); return undefined; } throw error; }
  const identity = `${stat.dev}:${stat.ino}`;
  let scan = asks.get(path);
  if (!scan || scan.identity !== identity || stat.size < scan.offset) {
    scan = { identity, offset: 0, pending: "", decoder: new StringDecoder("utf8"), answered: new Set() };
    asks.set(path, scan);
  }
  if (stat.size === scan.offset) return scan.answered;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - scan.offset));
    while (scan.offset < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - scan.offset), scan.offset);
      if (!n) break;
      scan.offset += n; scan.pending += scan.decoder.write(buffer.subarray(0, n));
      let end;
      while ((end = scan.pending.indexOf("\n")) >= 0) {
        const line = scan.pending.slice(0, end); scan.pending = scan.pending.slice(end + 1);
        // Only complete lines are parsed; a malformed one is skipped, as pi and the session tail do (E4).
        if (!line.includes('"ask"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const msg = entry?.type === "message" ? entry.message : undefined;
        if (msg?.role === "toolResult" && msg.toolName === "ask" && !msg.isError) scan.answered.add(JSON.stringify([msg.details?.qid, msg.details?.rev]));
      }
    }
  } finally { closeSync(fd); }
  return scan.answered;
}
/** P15: Refresh a question against durable workflow and child receipts at request time. */
export function resolved(home: string, item: AttentionItem): boolean {
  if (resolvedIn(readJournalSnapshot(journalPath(home, item.wid))).has(JSON.stringify([item.id, item.rev]))) return true;
  if (item.kind !== "question" || !item.session || !item.qid) return false;
  return answeredAsks(item.session)?.has(JSON.stringify([item.qid, item.rev])) ?? false;
}
