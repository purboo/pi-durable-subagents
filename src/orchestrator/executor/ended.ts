import type { Containment, JournalHandle, ProcInfo } from "../../types.ts";
import type { FenceOptions } from "../../platform/containment.ts";
import { commandLine } from "../../platform/cmdline.ts";

export interface FenceAgentOptions {
  /** Test seam: read a target's diagnostic argv without probing host PIDs (default: `commandLine`). */
  readCommand?: (pid: number, signal?: AbortSignal) => Promise<string>;
}

/** EX1 / WK8: Agent fences only. The direct child's tracked identity is retained across recovery (old journals: first tracked). */
export async function fenceAgent(containment: Pick<Containment, "fence">, journal: JournalHandle, exec: string, tracked: readonly ProcInfo[],
  child?: Pick<ProcInfo, "pid" | "start">, opts: FenceAgentOptions = {}): Promise<void> {
  const read = opts.readCommand ?? commandLine;
  const options: FenceOptions = { beforeKill: async (targets, signal) => {
    const identities = journal.entries().filter(e => e.type === "tracked" && e.exec === exec);
    const direct = child ?? identities.find(e => e.child === true) ?? identities[0];
    // R-11-3: a crash after spawn but before tracked leaves no provable direct identity. Roots of the target
    // forest may be pi or orphaned descendants: omit all roots rather than ever reporting the direct child.
    const pids = new Set(targets.map(p => p.pid));
    const others = direct ? targets.filter(p => p.pid !== direct.pid || p.start !== direct.start)
      : targets.filter(p => pids.has(p.ppid));
    if (!others.length || signal.aborted) return;
    const procs = await Promise.all(others.slice(0, 20).map(async p => ({ pid: p.pid, command: await read(p.pid, signal) })));
    // The timeout cancels command reads and prevents an outstanding read from appending after the kill/seal.
    if (signal.aborted) return;
    await journal.append("ended", { exec, call: exec.slice(0, exec.lastIndexOf("#")), procs,
      ...(others.length > procs.length ? { more: others.length - procs.length } : {}) });
  } };
  await containment.fence(exec, tracked, options);
}
