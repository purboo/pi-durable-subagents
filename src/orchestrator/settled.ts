// Settled workflows: a rebuildable cache (DSA_HOME/cache/settled/<wid>.json, never authority) that lets a start open
// the journal of a finished workflow without decoding it. The record is valid only for the journal bytes it names
// (inode, size, entry count and last line, see JournalExpectation); anything else opens the journal as before.
// It holds exactly what a start and the orchestrator's loops over every workflow read of such a workflow; every other
// use decodes the journal first (a lazy handle decodes on its first entries() or append), so code that does not know
// about it stays correct.
import { join } from "node:path";
import { rmSync } from "node:fs";
import { readCache, writeCache } from "../kernel/cache.ts";
import { journalExpectation, type JournalExpectation } from "../kernel/journal.ts";
import { cacheDir, journalPath } from "../paths.ts";
import { JT, isEntry, type Entry, type JournalHandle } from "../types.ts";
import { quiet } from "../events/pump.ts";
import { foldWaits, liveWaitCalls } from "../events/waiting.ts";
import { pendingFollowUps } from "./notes.ts";
import { revisionEntries, terminalEntry, type Workflow } from "./store.ts";
import { RECOVERY_VERSION } from "./executor/recovered.ts";
import { sweepSeed, type SweepSeed } from "./executor/sweep.ts";
import { callEntries } from "./executor/indexes.ts";

/** Bump whenever the record gains a field or settledFacts a condition: every record is then rebuilt once. */
export const SETTLED_VERSION = 2;
export interface SettledFacts {
  /** The current revision and, past the first, its `revised` entry (it names the pinned snapshot). */
  revision: number; revised?: Entry;
  /** The terminal (`workflow-done`) entry of the current revision, without its result or error: readers of a lazy
   *  workflow's end (Engine.terminal: status, ts) need neither; everything else reads the journal. */
  done: Entry;
  /** Request ids of every `resumed` entry (a replayed resume asks whether it took the workflow). */
  resumed: string[];
  /** The event log's retention verdict (events/pump.ts quiet) for these entries. */
  quiet: boolean;
  /** Calls with an execution (all recovered), and what the executor's sweep needs of their executions. */
  calls: number; sweep: SweepSeed[];
}
export interface SettledRecord extends SettledFacts { v: number; recovery: number; wid: string; journal: JournalExpectation }

export const settledPath = (home: string, wid: string) => join(cacheDir(home), "settled", `${wid}.json`);

/** Why a workflow is not settled, or its facts. Settled: it ended (its current revision is terminal) and nothing a start
 *  or a later request would act on is left: every call with an execution is fenced, ended and recovered (`recovered`:
 *  its receipt is current and it holds no writer lock), no follow-up is open or pending, every forward is retired or delivered, no
 *  worktree cleanup or reminder, gate, writer wait or fence failure is open, its finished attention is recorded (for the workflow
 *  and each generation), and no call is live for the waiting tracker. */
export function settledFacts(wf: Workflow, recovered: (call: string) => boolean): SettledFacts | string {
  const log = wf.journal.entries(), rev = revisionEntries(wf), done = terminalEntry(rev);
  if (!done) return "running";
  const has = (type: string, field: string, value: unknown) => log.some(e => e.type === type && e[field] === value);
  const sealedCalls = new Set(log.filter(e => e.type === JT.sealed).map(e => String(e.call)));
  const ended = new Set([...sealedCalls, ...log.filter(e => e.type === "retired").map(e => String(e.call))]);
  const fenced = new Set(log.filter(e => e.type === JT.fenced).map(e => String(e.exec)));
  const calls = new Set<string>();
  for (const e of log) if (e.type === JT.exec) {
    const call = String(e.call); calls.add(call);
    if (!fenced.has(String(e.exec))) return `unfenced:${String(e.exec)}`;
  }
  for (const call of calls) {
    if (!ended.has(call)) return `live:${call}`;
    if (!recovered(call)) return `unrecovered:${call}`;
  }
  // Follow-ups: every generation of the current revision ended, its finished attention recorded; none pending.
  const attention = new Set(log.filter(e => isEntry(e, JT.attention)).map(e => `${(e as Entry & { item: { id: string; rev: number } }).item.id}\0${(e as Entry & { item: { rev: number } }).item.rev}`));
  const items = new Set(log.filter(e => isEntry(e, JT.attention)).map(e => String((e as Entry & { item: { id: string } }).item.id)));
  const finished = (id: string) => items.has(id);
  for (const e of rev) if (e.type === "generation") {
    const id = `${wf.wid}@${wf.revision}/${e.key}@${e.gen}`;
    if (!ended.has(id)) return `open-generation:${id}`;
    if (sealedCalls.has(id) && !finished(`finished:${id}`)) return `unfinished-generation:${id}`;
  }
  if (rev.some(e => e.type === "forward-retired" && e.reason === "undelivered-follow-up"))
    for (const key of new Set(rev.filter(e => e.type === "call" || e.type === "generation").map(e => String(e.key))))
      if (pendingFollowUps(rev, key).length) return `pending-follow-up:${key}`;
  // A forward is settled when it was retired or its call received it (a replay then only republishes an envelope the
  // outbox still has pending, which the start's republication does for every envelope anyway).
  const settledForwards = new Set(log.filter(e => e.type === "forward-retired" || e.type === "forward-delivered").map(e => String(e.rid2)));
  for (const e of log) if (e.type === "forward" && !settledForwards.has(String(e.rid2))) return `open-forward:${String(e.rid2)}`;
  // Worktrees: a successful call's cleanup recorded; no open reminder.
  for (const call of sealedCalls) {
    const own = callEntries(wf.journal, call);
    const result = own.find(e => e.type === JT.sealed)?.result as { status?: string } | undefined;
    if (result?.status === "ok" && own.some(e => e.type === "wt-intent") && !own.some(e => e.type === "wt-removed" || e.type === "wt-kept")) return `worktree:${call}`;
  }
  const resolved = new Set(log.filter(e => e.type === JT.attentionResolved).map(e => `${String(e.id)}\0${String(e.rev)}`));
  for (const e of log) if (isEntry(e, JT.attention) && e.item.kind === "conflict" && String(e.item.id).startsWith("worktree:") && !resolved.has(`${e.item.id}\0${e.item.rev}`)) return `reminder:${e.item.id}`;
  for (const e of log) if (e.type === "gate-intent" && !has("gate", "id", e.id)) return `gate:${String(e.id)}`;
  // A writer wait not followed by its acquisition or its call's end: recovery restores it.
  for (const e of log) if (e.type === "writer-wait" && !log.some(r => r.seq > e.seq && r.call === e.call && (r.type === "writer-acquired" || r.type === JT.sealed || r.type === "retired")))
    return `writer-wait:${String(e.call)}`;
  if (log.some(e => e.type === "fence-failed" && !log.some(r => r.seq > e.seq && ((r.type === JT.fenced && r.exec === e.exec) || (r.type === "gate" && r.id === e.exec) ||
    (r.type === JT.attentionResolved && r.id === `fence:${String(e.exec)}`))))) return "fence-failed";
  // The workflow's own finished attention (Engine.attention) is recorded for its latest end.
  if (!attention.has(`finished:${wf.wid}\0${log.filter(e => e.type === JT.done).length}`)) return "finished-attention";
  if (liveWaitCalls(foldWaits(wf.wid, log)).length) return "waits";
  const revised = log.findLast(e => e.type === "revised");
  return { revision: wf.revision, ...(revised ? { revised } : {}), done: { seq: done.seq, ts: done.ts, type: done.type, status: done.status } as Entry, resumed: log.filter(e => e.type === "resumed" && e.rid !== undefined).map(e => String(e.rid)),
    quiet: quiet(wf.wid, log), calls: calls.size, sweep: sweepSeed(wf.journal) };
}

/** The settled record of `wid` when it is of this version and was written for the same workflow; not yet checked
 *  against the journal (openLazyJournal does). */
export function readSettled(home: string, wid: string): SettledRecord | undefined {
  const record = readCache(settledPath(home, wid)) as SettledRecord | undefined;
  if (!record || record.v !== SETTLED_VERSION || record.recovery !== RECOVERY_VERSION || record.wid !== wid) return undefined;
  if (!record.journal || typeof record.journal.size !== "number" || !record.done || typeof record.revision !== "number" || !Array.isArray(record.sweep) || !Array.isArray(record.resumed)) return undefined;
  for (const s of record.sweep) if (typeof s?.exec !== "string" || typeof s.call !== "string" || !Array.isArray(s.tracked) || s.tracked.some(id => typeof id !== "string" || !/^\d+ /.test(id))) return undefined;
  return record;
}
/** Write the record of a settled workflow from its decoded journal (best effort: a failure only costs a decode at the
 *  next start). Returns whether it was written; a workflow that is not settled has its record removed. */
export function writeSettled(home: string, wf: Workflow, recovered: (call: string) => boolean): boolean {
  const path = settledPath(home, wf.wid), facts = settledFacts(wf, recovered);
  const journal = typeof facts === "string" ? undefined : journalExpectation(wf.journal);
  if (typeof facts === "string" || !journal) { try { rmSync(path, { force: true }); } catch { /* a cache */ } return false; }
  const record: SettledRecord = { v: SETTLED_VERSION, recovery: RECOVERY_VERSION, wid: wf.wid, journal, ...facts };
  writeCache(path, record, journalPath(home, wf.wid));
  return true;
}
/** Whether a workflow's journal is open lazily and not decoded yet: its settled record still describes it. */
export function lazy(wf: { journal: JournalHandle; settled?: SettledFacts }): wf is { journal: JournalHandle; settled: SettledFacts } {
  return wf.journal.loaded === false && wf.settled !== undefined;
}
