// P33, FC1: the origin branch a `context: "fork"` run pins at admission.
// Without a compaction on the branch this is exactly the 1.2 rule: message and model_change entries, dsa receipts
// dropped. With one, it is the parent's effective context as pi's session-context builder (buildContextEntries /
// buildSessionProjection) computes it: entries from the latest compaction's firstKeptEntryId (system messages dropped,
// older compactions dropped because pi projects nothing for them), the compaction itself, then every later entry;
// branch summaries, custom messages and context edits are kept there because pi sends (or applies) them. The rule is
// implemented here instead of importing pi: the orchestrator must not load the optional pi peer
// (scripts/check-imports.mjs); test/unit/orchestrator/fork-context.test.ts compares it with pi's exported builder.
import { readFile } from 'node:fs/promises';
import type { RunBody } from '../types.ts';

export type OriginEntry = {
  type: string; id?: string; parentId?: string | null; customType?: string; firstKeptEntryId?: string; targetId?: string;
  message?: { role?: string; customType?: string };
};

/** The dsa receipt marker: an entry whose custom type (in its message or at its own level) names the dsa protocol. */
const receipt = (e: OriginEntry) => String(e.message?.customType ?? e.customType ?? '').startsWith('dsa-');
/** The 1.2 pin rule (uncompacted branches keep it byte for byte): message and model_change entries that are not
 *  receipts. It shares the receipt predicate, so an entry that names a dsa custom type is dropped on every branch
 *  (pi writes no custom type at the entry level of a message, so the pinned bytes do not change). */
const plain = (e: OriginEntry) => ['message', 'model_change'].includes(e.type) && !receipt(e);
/** Entries of a compacted branch's context that a fork child needs to rebuild what pi sends. */
const contextual = (e: OriginEntry) => ['message', 'model_change', 'custom_message', 'branch_summary', 'context_edit'].includes(e.type) && !receipt(e);

/** Entry types the fork session publication copies from a pinned origin. */
export const FORK_ENTRY_TYPES = new Set(['message', 'model_change', 'custom_message', 'branch_summary', 'context_edit', 'compaction']);
/** Whether prepareFork copies a pinned origin entry into the child session. */
export const forkEntry = (e: OriginEntry) => FORK_ENTRY_TYPES.has(e.type) && !receipt(e);

/** FC1: the entries of a root-to-leaf branch that the fork pins, in branch order. */
export function effectiveBranch(branch: OriginEntry[]): OriginEntry[] {
  const latest = branch.findLastIndex(e => e.type === 'compaction');
  if (latest < 0) return branch.filter(plain);
  const compaction = branch[latest]!;
  const first = branch.findIndex((e, i) => i < latest && e.id === compaction.firstKeptEntryId);
  const kept = first < 0 ? [] : branch.slice(first, latest).filter(e => contextual(e) && !(e.type === 'message' && e.message?.role === 'system'));
  const later = branch.slice(latest + 1).filter(contextual);
  const ids = new Set([...kept, ...later].map(e => e.id));
  const keep = (e: OriginEntry) => e.type !== 'context_edit' || ids.has(e.targetId);
  const keptKept = kept.filter(keep), laterKept = later.filter(keep);
  // The marker names an entry the child really carries: pi reads the kept range from it, so a marker that names a
  // dropped entry (a receipt, an edit of an entry that is not pinned, an older compaction) would drop the whole range.
  return [...keptKept, { ...compaction, firstKeptEntryId: keptKept[0]?.id ?? compaction.id }, ...laterKept];
}

/** P33, FC1: Capture the selected branch's effective context before admission and exclude extension receipts. */
export async function pinOrigin(origin: NonNullable<RunBody['origin']>): Promise<string> {
  const rows = (await readFile(origin.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as OriginEntry);
  const header = rows.find(e => e.type === 'session');
  if (!header) throw new Error('Origin session has no header');
  const byId = new Map(rows.filter(e => e.type !== 'session' && e.id).map(e => [e.id!, e]));
  let id = origin.leafId === undefined ? rows.findLast(e => e.type !== 'session' && e.id)?.id : origin.leafId;
  const branch: OriginEntry[] = [], seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw new Error('Cyclic origin branch');
    seen.add(id);
    const entry = byId.get(id); if (!entry) throw new Error('Missing origin branch entry');
    branch.unshift(entry); id = entry.parentId ?? undefined;
  }
  return [header, ...effectiveBranch(branch)].map(e => JSON.stringify(e)).join('\n') + '\n';
}
