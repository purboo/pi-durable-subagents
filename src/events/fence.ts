// Which fences interrupted work, shared by `describe` (lastFence) and the event deriver (`fenced`). Read-only over
// committed journal entries; `limit` restricts the view to the first `limit` entries (the deriver may read only entries
// before the one it derives, so a re-derivation after a crash sees the same history).
import { JT, type Entry } from "../types.ts";

export type FenceReason = "restart-force" | "orchestrator-crash" | "process-died";

/** Executions whose fence did NOT interrupt work: every execution ends with a fence; one interrupted work only when
 *  the execution neither settled (its turn ended) before it nor hibernated (it waits for an answer), and was not sealed
 *  on purpose: a seal ends an execution on purpose unless its outcome is `unknown` (a `once` call cut off in a tool) or
 *  the execution was recorded as lost (the loss bound sealed it), which are interruptions themselves. A seal for an
 *  execution that never ran (a launch failure) or that the call's stop, timeout or budget ended is on purpose. */
export function endedExecs(journal: readonly Entry[], limit = journal.length): Set<string> {
  const lost = new Set<string>(), fencedAt = new Map<string, number>(), ended = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const e = journal[i]!;
    if (e.type === "loss") lost.add(String(e.exec));
    else if (e.type === JT.fenced) fencedAt.set(String(e.exec), e.seq);
  }
  for (let i = 0; i < limit; i++) {
    const e = journal[i]!, exec = String(e.exec);
    // Recovery records `hibernated` after the fence for an execution cut off while only its question's ask ran (P28):
    // it was waiting, not working, so that is no interruption either.
    if (e.type === "hibernated") ended.add(exec);
    else if (e.type === "settled") { if (e.seq < (fencedAt.get(exec) ?? Infinity)) ended.add(exec); }
    else if (e.type === JT.sealed && (e.result as { status?: string } | undefined)?.status !== "unknown" && !lost.has(exec)) ended.add(exec);
  }
  return ended;
}

/** Best effort: why `fence` (a `fenced` entry that interrupted work) happened. restart-force: a forced restart listed
 *  the execution as live; orchestrator-crash: the execution was launched before an orchestrator start that is not
 *  preceded by a clean exit and fenced after it (startup recovery); otherwise process-died (the child or its host went
 *  away, or a drain fenced it). */
export function fenceReason(journal: readonly Entry[], orch: readonly Entry[], fence: Entry): FenceReason {
  const exec = String(fence.exec), at = Number(fence.ts);
  if (orch.some(e => e.type === "restart" && e.force === true && Array.isArray(e.live) && e.live.includes(exec))) return "restart-force";
  const launched = journal.find(e => e.type === JT.exec && e.exec === exec), starts = orch.filter(e => e.type === "orchestrator");
  const recovery = starts.findLast(s => Number(s.ts) <= at);
  if (launched && recovery && Number(launched.ts) < Number(recovery.ts)) {
    const prior = orch.filter(e => Number(e.seq) < Number(recovery.seq));
    const lastStart = prior.findLast(e => e.type === "orchestrator"), cleanExit = lastStart && prior.some(e => e.type === "orchestrator-exit" && Number(e.seq) > Number(lastStart.seq));
    if (!cleanExit) return "orchestrator-crash";
  }
  return "process-died";
}

/** The fence of `exec` among the first `limit` entries when it interrupted work, else undefined. */
export function interruptingFence(journal: readonly Entry[], exec: string, limit = journal.length): Entry | undefined {
  let fence: Entry | undefined;
  for (let i = limit - 1; i >= 0 && !fence; i--) { const e = journal[i]!; if (e.type === JT.fenced && e.exec === exec) fence = e; }
  return fence && !endedExecs(journal, limit).has(exec) ? fence : undefined;
}
