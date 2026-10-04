import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { singlePresentation } from "../../kernel/guards.ts";
import { journalPath, orchLedger } from "../../paths.ts";
import { CT, JT, type AttentionItem, type Entry } from "../../types.ts";

/** P15, P25: Read workflow snapshots without modifying another domain's history. */
export function workflows(home: string): { wid: string; origin?: string; entries: Entry[] }[] {
  const ledger = readJournalSnapshot(orchLedger(home));
  let names: string[];
  try { names = readdirSync(join(home, "w")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const ids = new Set([...ledger.filter(e => e.type === JT.created).map(e => String(e.wid)), ...names]);
  return [...ids].sort().map(wid => {
    const entries = readJournalSnapshot(journalPath(home, wid));
    const created = ledger.find(e => e.type === JT.created && e.wid === wid) ?? entries.find(e => e.type === JT.created);
    return { wid, origin: created?.origin as string | undefined, entries };
  });
}

/** P37: a generation opened by a send (possibly after the workflow finished) that has no seal yet is pending work. */
export function openGeneration(entries: readonly { type: string; [k: string]: unknown }[]): boolean {
  return entries.some(g => g.type === "generation" && !entries.some(s => s.type === JT.sealed && String(s.call).endsWith(`/${String(g.key)}@${String(g.gen)}`)));
}
/** P1: Workflow-side pending work shared by every starter: a workflow without JT.done or with an unsealed generation. */
export function unfinishedWorkflow(home: string): boolean {
  return workflows(home).some(w => !w.entries.some(e => e.type === JT.done) || openGeneration(w.entries));
}

/** P15, V7: Rebuild session-wide receipts, including entries hidden by compaction. */
export function presented(ctx: ExtensionContext): { id: string; rev: number }[] {
  return ctx.sessionManager.getEntries().flatMap(entry => entry.type === "custom_message" && entry.customType === CT.attention
    ? (entry.details as { items?: AttentionItem[] } | undefined)?.items ?? [] : []);
}

/** P15, V7: Select only unresolved, unpresented items owned by this session. */
export function attention(home: string, sender: string, seen: { id: string; rev: number }[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const workflow of workflows(home)) {
    if (workflow.origin !== sender) continue;
    for (const entry of workflow.entries) {
      if (entry.type !== JT.attention) continue;
      const item = entry.item as AttentionItem;
      if (workflow.entries.some(e => e.type === JT.attentionResolved && e.id === item.id && e.rev === item.rev)) continue;
      if (singlePresentation({ presented: [...seen, ...items] }, item)) items.push(item);
    }
  }
  return items;
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
