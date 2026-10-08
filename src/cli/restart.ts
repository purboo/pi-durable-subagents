// Restart: exit the running orchestrator so the installed version takes over, without interrupting running calls.
// The orchestrator decides (request kind "restart", RestartBody): it stops launching executions, refuses while any runs
// (unless forced), and otherwise exits and starts its successor. An orchestrator older than this request kind (its
// `orchestrator` record has no `restart: true`) would keep the request as an invalid inbox file and never idle-exit, so it
// is never sent one: the client checks the journals itself and ends it with SIGTERM (its shutdown fences what still runs,
// and recovery resumes it) — a check without the orchestrator's launch gate, so a launch can slip in between.
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { orchLedger } from "../paths.ts";
import { emptyLedger, foldLedger } from "../orchestrator/ledger.ts";
import { allWorkflows, liveCalls, processAlive } from "../orchestrator/snapshot.ts";

export interface OrchestratorProcess { version: string; pid: number; start?: string; ts: number; restart?: true }

/** The orchestrator that runs now: the last `orchestrator` record without an exit, whose process lives. */
export function currentOrchestrator(home: string): OrchestratorProcess | undefined {
  const o = foldLedger(emptyLedger(), readJournalSnapshot(orchLedger(home))).orchestrator;
  return o && !o.exited && processAlive(o.pid, o.start) ? { version: o.version, pid: o.pid, ...(o.start ? { start: o.start } : {}), ts: o.ts, ...(o.restart ? { restart: true as const } : {}) } : undefined;
}

/** Calls whose execution runs per the journals: running, or asking without having hibernated (its child still runs). */
export function journalLiveCalls(home: string, now = Date.now()): string[] {
  const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
  return allWorkflows(home).flatMap(wf => liveCalls(wf)
    .filter(c => c.phase === "running" || (c.phase === "asking" && c.exec !== undefined && !c.hibernated))
    .map(c => `${wf.wid}/${c.key}${c.startedAt ? ` ${age(now - c.startedAt)}` : ""}${wf.origin ? ` from ${wf.origin}` : ""}`));
}

/** For an orchestrator without the restart request kind: refuse while calls run (unless forced), else SIGTERM it. */
export function legacyRestart(home: string, old: OrchestratorProcess, force: boolean): { applied: true } | { applied: false; reason: string } {
  const live = journalLiveCalls(home);
  if (live.length && !force) {
    const shown = live.slice(0, 8).join("; ") + (live.length > 8 ? `; +${live.length - 8} more` : "");
    return { applied: false, reason: `busy: ${live.length} running call${live.length === 1 ? "" : "s"} on orchestrator ${old.version} (pid ${old.pid}): ${shown} — retry when they finish (or drain first), or force to fence them; they resume on the new orchestrator` };
  }
  try { process.kill(old.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  return { applied: true };
}

/** Wait (bounded) until the process ends; false when it still runs at the deadline. */
export async function waitExit(old: OrchestratorProcess, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processAlive(old.pid, old.start)) {
    if (performance.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

/** Wait (bounded) for an orchestrator other than `old` to record its start; undefined at the deadline. */
export async function waitSuccessor(home: string, old: OrchestratorProcess | undefined, timeoutMs: number): Promise<OrchestratorProcess | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const now = currentOrchestrator(home);
    if (now && (!old || now.pid !== old.pid || now.ts !== old.ts)) return now;
    if (performance.now() >= deadline) return undefined;
    await delay(100);
  }
}
