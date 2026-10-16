// Command calls: the workflow journal records the executor writes for them (documented in index.ts) and the questions
// the engine and recovery ask of them. Pure functions of the journal's entries.
import { JT, type Entry } from "../../types.ts";

export const COMMAND_INTENT = "command-intent";
export const COMMAND_STARTED = "command-started";
export const COMMAND_SPAWN_FAILED = "command-spawn-failed";
export const COMMAND_TIMEOUT = "command-timeout";
export const COMMAND_WITHDRAWN = "command-withdrawn";
/** The attempt id (and process tag DSA_EXEC) of attempt `n` of a command call. */
export const commandId = (call: string, n: number) => `command:${call}#${n}`;
/** The attempt directory name (under the call dir) of attempt `n`. */
export const commandDirName = (n: number) => `command-${n}`;

/** Command calls with an attempt and no seal, not retired: a command that may run (the orchestrator adopts it). */
export function unsealedCommandCalls(entries: readonly Entry[]): string[] {
  const calls = new Set<string>();
  for (const e of entries) if (e.type === COMMAND_INTENT) calls.add(String(e.call));
  if (!calls.size) return [];
  for (const e of entries) if ((e.type === JT.sealed || e.type === "retired") && calls.has(String(e.call))) calls.delete(String(e.call));
  return [...calls];
}
/** F4: Command calls with a live attempt: the call's latest `command-intent` has no later `command-withdrawn` with the
 *  same id (a process was, or may be being, started for it), and the call has neither `sealed` nor `retired`. Leftover
 *  processes of a retired call are ended by the next start's sweep; they do not make a call live. */
export function liveCommandCalls(entries: readonly Entry[]): string[] {
  const latest = new Map<string, string>(), withdrawn = new Set<string>(), ended = new Set<string>();
  for (const e of entries) {
    if (e.type === COMMAND_INTENT) { latest.set(String(e.call), String(e.id)); withdrawn.delete(String(e.id)); }
    else if (e.type === COMMAND_WITHDRAWN) withdrawn.add(String(e.id));
    else if (e.type === JT.sealed || e.type === "retired") ended.add(String(e.call));
  }
  return [...latest].filter(([call, id]) => !ended.has(call) && !withdrawn.has(id)).map(([call]) => call);
}
/** Retired command calls without a seal: their processes, if any still run, are ended at the next start. */
export function retiredCommandAttempts(entries: readonly Entry[]): { call: string; id: string; pid?: number; start?: string }[] {
  const retired = new Set(entries.filter(e => e.type === "retired").map(e => String(e.call)));
  const sealed = new Set(entries.filter(e => e.type === JT.sealed).map(e => String(e.call)));
  const result: { call: string; id: string; pid?: number; start?: string }[] = [];
  for (const e of entries) if (e.type === COMMAND_INTENT && retired.has(String(e.call)) && !sealed.has(String(e.call))) {
    const started = entries.findLast(s => s.type === COMMAND_STARTED && s.id === e.id);
    result.push({ call: String(e.call), id: String(e.id), ...(started ? { pid: Number(started.pid), start: String(started.start) } : {}) });
  }
  return result;
}
