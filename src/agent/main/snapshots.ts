import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { journalPath, orchLedger } from "../../paths.ts";
import { CT, JT, type AttentionItem, type Entry } from "../../types.ts";
import { holdOf } from "../../orchestrator/snapshot.ts";

/** P15, P25: Read workflow snapshots without modifying another domain's history; a wid with an orchestrator.jsonl
 *  `pruned{wid}` entry is gone (housekeeping), even while its directory is still being removed. */
export function workflows(home: string): { wid: string; origin?: string; entries: Entry[] }[] {
  const ledger = readJournalSnapshot(orchLedger(home));
  let names: string[];
  try { names = readdirSync(join(home, "w")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const pruned = new Set(ledger.filter(e => e.type === "pruned").map(e => String(e.wid)));
  const ids = new Set([...ledger.filter(e => e.type === JT.created).map(e => String(e.wid)), ...names].filter(wid => !pruned.has(wid)));
  const createdBy = new Map<unknown, Entry>();
  for (const e of ledger) if (e.type === JT.created && !createdBy.has(e.wid)) createdBy.set(e.wid, e);
  return [...ids].sort().map(wid => {
    const entries = readJournalSnapshot(journalPath(home, wid));
    const created = createdBy.get(wid) ?? entries.find(e => e.type === JT.created);
    return { wid, origin: created?.origin as string | undefined, entries };
  });
}

/** P37: a generation opened by a send (possibly after the workflow finished) that has no seal yet is pending work. */
export function openGeneration(entries: readonly { type: string; [k: string]: unknown }[]): boolean {
  return entries.some(g => g.type === "generation" && !entries.some(s => s.type === JT.sealed && String(s.call).endsWith(`/${String(g.key)}@${String(g.gen)}`)));
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
  for (const workflow of workflows(home)) {
    if (workflow.origin !== sender) continue;
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

/** P15: Refresh a question against durable workflow and child receipts at request time. */
export function resolved(home: string, item: AttentionItem): boolean {
  if (readJournalSnapshot(journalPath(home, item.wid)).some(e => e.type === JT.attentionResolved && e.id === item.id && e.rev === item.rev)) return true;
  if (item.kind !== "question" || !item.session || !item.qid) return false;
  let text: string;
  try { text = readFileSync(item.session, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    let entry;
    try { entry = JSON.parse(lines[index]!); }
    catch (error) { if (index >= lines.length - 2) break; throw error; }
    const msg = entry.type === "message" ? entry.message : undefined;
    if (msg?.role === "toolResult" && msg.toolName === "ask" && !msg.isError && msg.details?.qid === item.qid && msg.details?.rev === item.rev) return true;
  }
  return false;
}
