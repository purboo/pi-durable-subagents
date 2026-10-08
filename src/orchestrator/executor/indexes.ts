// A1: Append-only indexes fold committed entries once; failed appends never enter the view.
import type { Entry, JournalHandle, ProcInfo } from "../../types.ts";
const indexes = new WeakMap<JournalHandle, { count: number; types: Map<string, Entry[]>; execs: Map<string, Map<string, Entry[]>> }>();
export function entriesOf(journal: JournalHandle, type: string, exec?: string): readonly Entry[] {
  let index = indexes.get(journal);
  if (!index) { index = { count: 0, types: new Map(), execs: new Map() }; indexes.set(journal, index); }
  const entries = journal.entries();
  while (index.count < entries.length) {
    const e = entries[index.count++]!, bucket = index.types.get(e.type) ?? [];
    if (!index.types.has(e.type)) index.types.set(e.type, bucket);
    bucket.push(e);
    if (typeof e.exec === "string") {
      const byExec = index.execs.get(e.type) ?? new Map<string, Entry[]>();
      if (!index.execs.has(e.type)) index.execs.set(e.type, byExec);
      const owned = byExec.get(e.exec) ?? [];
      if (!byExec.has(e.exec)) byExec.set(e.exec, owned);
      owned.push(e);
    }
  }
  return (exec === undefined ? index.types.get(type) : index.execs.get(type)?.get(exec)) ?? [];
}

const identities = new WeakMap<JournalHandle, Map<string, { count: number; rows: ProcInfo[]; ids: Set<string> }>>();
export function trackedState(journal: JournalHandle, exec: string) {
  let byExec = identities.get(journal);
  if (!byExec) { byExec = new Map(); identities.set(journal, byExec); }
  let state = byExec.get(exec);
  if (!state) { state = { count: 0, rows: [], ids: new Set() }; byExec.set(exec, state); }
  const entries = entriesOf(journal, "tracked", exec);
  while (state.count < entries.length) {
    const e = entries[state.count++]!, pid = Number(e.pid), start = String(e.start), id = `${pid}:${start}`;
    if (!state.ids.has(id)) { state.ids.add(id); state.rows.push({ pid, ppid: 0, start }); }
  }
  return state;
}

const usage = new WeakMap<JournalHandle, { count: number; calls: Map<string, Set<string>> }>();
export function usageIds(journal: JournalHandle, call: string): ReadonlySet<string> {
  let state = usage.get(journal);
  if (!state) { state = { count: 0, calls: new Map() }; usage.set(journal, state); }
  const entries = entriesOf(journal, "usage");
  while (state.count < entries.length) {
    const e = entries[state.count++]!, key = String(e.call), ids = state.calls.get(key) ?? new Set<string>();
    if (!state.calls.has(key)) state.calls.set(key, ids);
    ids.add(String(e.id));
  }
  return state.calls.get(call) ?? new Set<string>();
}
