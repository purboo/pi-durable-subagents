// What the running orchestrator costs, for `status --json` and `doctor`: the orchestrator writes these counters of its
// own process to $DSA_HOME/orchestrator-stats.json every STATS_EVERY_MS (atomic replace, no fsync: a lost write only
// shows older numbers). Readers show them only when the pid in the file is the orchestrator the ledger records as running.
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STATS_EVERY_MS = 10_000;
export interface OrchestratorStats {
  /** The orchestrator process and when it wrote these numbers (ms). */
  pid: number; at: number;
  /** Workflows it holds (not pruned), and those with live work (not resting: running, or a follow-up/execution open). */
  workflows: number; liveWorkflows: number;
  /** Workflow journals whose file descriptor is open now (finished workflows rest theirs). */
  openJournals: number;
  /** Intake passes (inbox and ledger scans that ran) per second over the last minute. */
  passesPerSecond: number;
  /** Bytes the process read since it started (/proc/self/io rchar; absent where unavailable). */
  readBytes?: number;
}
export const statsPath = (home: string) => join(home, "orchestrator-stats.json");

/** /proc/self/io rchar, or undefined where there is none. */
export function readBytes(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try { const match = /^rchar:\s*(\d+)$/m.exec(readFileSync("/proc/self/io", "utf8")); return match ? Number(match[1]) : undefined; }
  catch { return undefined; }
}
export async function writeStats(home: string, stats: OrchestratorStats): Promise<void> {
  const path = statsPath(home), temp = join(home, `.orchestrator-stats.${process.pid}.tmp`);
  try { await writeFile(temp, JSON.stringify(stats)); await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}
/** The stats file of orchestrator `pid`, or undefined (missing, unreadable, or written by another process). */
export function readStats(home: string, pid: number | undefined): OrchestratorStats | undefined {
  if (pid === undefined) return undefined;
  try {
    const stats = JSON.parse(readFileSync(statsPath(home), "utf8")) as OrchestratorStats;
    return stats && typeof stats === "object" && stats.pid === pid && typeof stats.workflows === "number" ? stats : undefined;
  } catch { return undefined; }
}
const megabytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} KB`;
/** One line: "3 live / 190 workflows, 3 journals open, 0.4 passes/s, read 12 MB". */
export function statsLine(s: OrchestratorStats): string {
  return `${s.liveWorkflows} live / ${s.workflows} workflows, ${s.openJournals} journal${s.openJournals === 1 ? "" : "s"} open, ${s.passesPerSecond} passes/s` +
    (s.readBytes !== undefined ? `, read ${megabytes(s.readBytes)}` : "");
}
