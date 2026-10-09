// Restart: exit the running orchestrator so the installed version takes over, without interrupting running calls.
// The orchestrator decides (request kind "restart", RestartBody): it stops launching executions, refuses while any runs
// (unless forced), and otherwise exits and starts its successor. An orchestrator older than this request kind (its
// `orchestrator` record has no `restart: true`) would keep the request as an invalid inbox file and never idle-exit, so it
// is never sent one: the client checks the journals itself and ends it with SIGTERM (its shutdown fences what still runs,
// and recovery resumes it) — a check without the orchestrator's launch gate, so a launch can slip in between.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath, orchLedger } from "../paths.ts";
import { JT, type RestartBody, type RestartInitiator } from "../types.ts";
import { restartInputError, restartRefusal, type RestartExecution } from "../orchestrator/restart.ts";
import { emptyLedger, foldLedger } from "../orchestrator/ledger.ts";
import { allWorkflows, liveCalls, processAlive } from "../orchestrator/snapshot.ts";

export interface OrchestratorProcess { version: string; pid: number; start?: string; ts: number; restart?: true }

/** The orchestrator that runs now: the last `orchestrator` record without an exit, whose process lives. */
export function currentOrchestrator(home: string): OrchestratorProcess | undefined {
  const o = foldLedger(emptyLedger(), readJournalSnapshot(orchLedger(home))).orchestrator;
  return o && !o.exited && processAlive(o.pid, o.start) ? { version: o.version, pid: o.pid, ...(o.start ? { start: o.start } : {}), ts: o.ts, ...(o.restart ? { restart: true as const } : {}) } : undefined;
}

/** Best-effort provenance; never read the live DSA home to identify the invoking process. */
export function cliInitiator(env: NodeJS.ProcessEnv): RestartInitiator {
  if (env.DSA_CALL) return { call: env.DSA_CALL };
  let parent = "";
  try {
    parent = process.platform === "linux" ? readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").replace(/\0/g, " ").trim()
      : process.platform === "darwin" ? execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024 }).trim() : "";
  } catch { /* Parent may have exited or /proc may be unavailable. */ }
  return { cli: { user: userInfo().username, host: hostname(), ppid: process.ppid, parent: parent.slice(0, 200) } };
}

/** Calls whose execution runs per the journals: running, asking without having hibernated, or an unresolved gate. */
export function journalLiveCalls(home: string): RestartExecution[] {
  return allWorkflows(home).flatMap(wf => {
    const entries = readJournalSnapshot(journalPath(home, wf.wid));
    const done = new Set(entries.filter(e => e.type === "gate").map(e => String(e.id)));
    const sealed = new Set(entries.filter(e => e.type === JT.sealed).map(e => String(e.call)));
    const gates = new Map(entries.filter(e => e.type === "gate-intent" && !done.has(String(e.id)) && !sealed.has(String(e.call))).map(e => [String(e.call), e]));
    const running = liveCalls(wf).filter(c => !gates.has(c.callId) && c.exec !== undefined && (c.phase === "running" || (c.phase === "asking" && !c.hibernated)))
      .map(c => ({ wid: wf.wid, key: c.key, gen: c.gen, callId: c.callId, exec: c.exec!, since: c.startedAt ?? wf.startedAt ?? Date.now(), phase: "child" as const, origin: wf.origin }));
    const gating = [...gates].map(([call, e]) => ({ wid: wf.wid, key: call.slice(call.indexOf("/") + 1, call.lastIndexOf("@")), gen: Number(call.slice(call.lastIndexOf("@") + 1)), callId: call, exec: String(e.id), since: e.ts, phase: "gate" as const, origin: wf.origin }));
    return [...running, ...gating];
  });
}

/** Legacy has no launch gate: check immediately before SIGTERM; a launch can still slip between (documented). */
export function legacyRestart(home: string, old: OrchestratorProcess, body: RestartBody, options: { subagent?: boolean; tool?: boolean } = {}): { applied: true } | { applied: false; reason: string } {
  const reason = restartInputError(body, options.subagent) ?? restartRefusal(home, journalLiveCalls(home), body, options.tool);
  if (reason) return { applied: false, reason };
  try { process.kill(old.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  return { applied: true };
}

/** Wait (bounded) until the process ends; false when it still runs at the deadline. */
/** The orchestrator that decided request `rid`: the last start recorded before its resolution. */
export function decidedBy(home: string, rid: string): OrchestratorProcess | undefined {
  const entries = readJournalSnapshot(orchLedger(home));
  const at = entries.findIndex(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
  const o = at < 0 ? undefined : entries.slice(0, at).findLast(e => e.type === 'orchestrator');
  return o ? { version: String(o.version), pid: Number(o.pid), ...(o.start ? { start: String(o.start) } : {}), ts: o.ts, ...(o.restart ? { restart: true as const } : {}) } : undefined;
}

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
