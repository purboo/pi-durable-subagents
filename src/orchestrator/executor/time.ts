// Private journal entries (P18, V6): time{exec,active}; active is cumulative per execution.
import { performance } from "node:perf_hooks";
import type { Entry, ProcInfo } from "../../types.ts";

/** P18: Measure evidence-backed active time, excluding blocked asks and unobserved tails. */
export class ActiveTime {
  active = 0;
  last: number;
  private anchor: number;
  private tools = new Map<string, string>();
  private cpu = new Map<string, number>();
  constructor(now = performance.now()) { this.last = this.anchor = now; }
  get asking() { return [...this.tools.values()].includes("ask"); }
  /** P18: Every RPC event is evidence; ask transitions exclude the entire blocked interval. */
  event(event: Record<string, unknown>, now = performance.now()) {
    this.evidence(now);
    const id = String(event.toolCallId ?? "");
    if (event.type === "tool_execution_start") this.tools.set(id, String(event.toolName));
    if (event.type === "tool_execution_end") this.tools.delete(id);
  }
  /** P18: Session growth or live CPU progress advances the horizon, never wall-clock polling alone. */
  evidence(now = performance.now()) {
    if (!this.asking) this.active += Math.max(0, now - this.anchor);
    this.anchor = this.last = Math.max(this.anchor, now);
  }
  /** P18, C2: Track each stable process identity; only open tools make CPU progress evidence. */
  scan(rows: ProcInfo[], now = performance.now()) {
    let progress = false;
    for (const row of rows) {
      const id = `${row.pid}:${row.start}`, before = this.cpu.get(id) ?? 0;
      if (row.cpuMs !== undefined) { if (row.cpuMs > before) progress = true; this.cpu.set(id, row.cpuMs); }
    }
    if (progress && this.tools.size && !this.asking) this.evidence(now);
    return progress && this.tools.size > 0 && !this.asking;
  }
}
/** P18: Recover only committed checkpoints; each execution contributes its latest total once. */
export function activeTotal(entries: readonly Entry[], call: string): number {
  const totals = new Map<string, number>();
  for (const e of entries) if (e.type === "time" && String(e.exec).startsWith(`${call}#`)) totals.set(String(e.exec), Number(e.active));
  return [...totals.values()].reduce((a, b) => a + b, 0);
}
