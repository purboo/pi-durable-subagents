// Layer 1 (all platforms): process-tree resource accounting and sustained-violation detection.
// Pure and deterministic: consumes ProcInfo[] snapshots from Containment.scan / ProcessTable and timestamps.
import type { ProcInfo, ResourceLimits, ResourceStats } from "../../types.ts";
import { snapshotCapturedAt } from "../../platform/proctable.ts";

/** Default consecutive ms a resource limit must be exceeded before fencing (avoids killing brief compilation spikes). */
export const DEFAULT_RESOURCE_GRACE_MS = 5_000;
/** Minimum interval between samples before computing a CPU % delta (avoids noisy spikes on sub-200ms back-to-back scans). */
const MIN_CPU_DELTA_MS = 200;

export interface TopProcess {
  pid: number;
  rssMb: number;
  command?: string;
}

export interface ResourceViolation {
  kind: "memory" | "processes" | "cpu";
  limit: number;
  observed: number;
  peak: number;
  graceMs: number;
  processes: number;
  top: TopProcess[];
}

export interface ResourceSample {
  stats: ResourceStats;
  violation?: ResourceViolation;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const bytesToMb = (bytes: number) => bytes / (1024 * 1024);

/** Format a human-readable error message for a sealed resource-limit failure. */
export function formatResourceViolation(v: ResourceViolation): string {
  const topText = v.top.length
    ? `; top: ${v.top.map(p => `pid ${p.pid} ${round1(p.rssMb)} MiB${p.command ? ` \`${p.command.slice(0, 60)}\`` : ""}`).join(", ")}`
    : "";
  if (v.kind === "memory") {
    return `Resource limit exceeded: memory ${round1(v.observed)} MiB > ${v.limit} MiB limit (peak ${round1(v.peak)} MiB across ${v.processes} process${v.processes === 1 ? "" : "es"}${topText})`;
  }
  if (v.kind === "processes") {
    return `Resource limit exceeded: ${v.observed} processes > ${v.limit} maxProcesses limit (peak ${v.peak}${topText})`;
  }
  return `Resource limit exceeded: CPU ${Math.round(v.observed)}% > ${v.limit}% limit (peak ${Math.round(v.peak)}% across ${v.processes} process${v.processes === 1 ? "" : "es"}${topText})`;
}

/** Tracks live & peak memory, process count, and CPU % for one execution's entire process tree. */
export class ResourceMonitor {
  private limits?: ResourceLimits;
  private peakMemoryMb = 0;
  private peakProcesses = 0;
  private peakCpuPercent?: number;
  private lastStats?: ResourceStats;
  private lastSampleAt?: number;
  private prevAt?: number;
  private prevCpu = new Map<string, number>();
  private exceededSince: { memory?: number; processes?: number; cpu?: number } = {};

  constructor(limits?: ResourceLimits) {
    this.limits = limits;
  }

  /** Update active limits in place (e.g. after a live config.json reload). */
  setLimits(limits?: ResourceLimits): void {
    this.limits = limits;
    if (!limits?.memoryMb) this.exceededSince.memory = undefined;
    if (!limits?.maxProcesses) this.exceededSince.processes = undefined;
    if (!limits?.cpuPercent) this.exceededSince.cpu = undefined;
  }

  /** Most recently computed stats, if at least one sample has been recorded. */
  latest(): ResourceStats | undefined {
    return this.lastStats ? { ...this.lastStats } : undefined;
  }

  /** Feed one process-tree snapshot and current monotonic/wall timestamp in ms.
   *  `overheadPids` (command wrapper / Windows job host) are excluded from `processes` and `rssBytes` so
   *  `maxProcesses: 1` allows a single user command without counting internal harness processes. */
  sample(procs: readonly ProcInfo[], nowMs: number, overheadPids?: ReadonlySet<number>): ResourceSample {
    // Deduplicate cached ProcessTable snapshots so repeated reads of the same scan never reset CPU % to 0,
    // inflate the next real scan's CPU delta, or advance grace timers on stale spikes.
    const sampleAt = snapshotCapturedAt(procs) ?? nowMs;
    if (this.lastSampleAt !== undefined && sampleAt <= this.lastSampleAt && this.lastStats) {
      return { stats: { ...this.lastStats } };
    }
    this.lastSampleAt = sampleAt;
    const counted = overheadPids?.size ? procs.filter(p => !overheadPids.has(p.pid)) : procs;
    let totalRssBytes = 0;
    for (const p of counted) {
      if (typeof p.rssBytes === "number" && Number.isFinite(p.rssBytes) && p.rssBytes > 0) {
        totalRssBytes += p.rssBytes;
      }
    }
    const memoryMb = round1(bytesToMb(totalRssBytes));
    const processes = counted.length;
    if (memoryMb > this.peakMemoryMb) this.peakMemoryMb = memoryMb;
    if (processes > this.peakProcesses) this.peakProcesses = processes;

    let cpuPercent: number | undefined;
    const nextCpu = new Map<string, number>();
    for (const p of counted) {
      if (typeof p.cpuMs === "number" && Number.isFinite(p.cpuMs) && p.cpuMs >= 0) {
        nextCpu.set(`${p.pid}:${p.start}`, p.cpuMs);
      }
    }
    if (this.prevAt !== undefined) {
      const dt = sampleAt - this.prevAt;
      if (dt >= MIN_CPU_DELTA_MS) {
        let deltaCpuMs = 0;
        for (const [id, cpu] of nextCpu) {
          const prev = this.prevCpu.get(id);
          // Count delta for surviving processes and full observed cpuMs for freshly spawned children in this interval.
          deltaCpuMs += prev !== undefined ? Math.max(0, cpu - prev) : cpu;
        }
        cpuPercent = round1((deltaCpuMs / dt) * 100);
        if (this.peakCpuPercent === undefined || cpuPercent > this.peakCpuPercent) {
          this.peakCpuPercent = cpuPercent;
        }
        this.prevAt = sampleAt;
        this.prevCpu = nextCpu;
      } else {
        cpuPercent = this.lastStats?.cpuPercent;
      }
    } else {
      this.prevAt = sampleAt;
      this.prevCpu = nextCpu;
    }

    const stats: ResourceStats = {
      memoryMb,
      peakMemoryMb: this.peakMemoryMb,
      processes,
      peakProcesses: this.peakProcesses,
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      ...(this.peakCpuPercent !== undefined ? { peakCpuPercent: this.peakCpuPercent } : {}),
    };
    this.lastStats = stats;

    const limits = this.limits;
    if (!limits) return { stats };
    const graceMs = limits.graceMs ?? DEFAULT_RESOURCE_GRACE_MS;

    const top = (): TopProcess[] => [...counted]
      .filter(p => typeof p.rssBytes === "number" && p.rssBytes > 0)
      .sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0))
      .slice(0, 3)
      .map(p => ({ pid: p.pid, rssMb: round1(bytesToMb(p.rssBytes!)) }));

    const check = (
      kind: "memory" | "processes" | "cpu",
      observed: number | undefined,
      limit: number | undefined,
      peak: number,
    ): ResourceViolation | undefined => {
      if (limit === undefined || observed === undefined) {
        this.exceededSince[kind] = undefined;
        return undefined;
      }
      if (observed > limit) {
        this.exceededSince[kind] ??= sampleAt;
        if (sampleAt - this.exceededSince[kind]! >= graceMs) {
          return { kind, limit, observed, peak, graceMs, processes, top: top() };
        }
      } else {
        this.exceededSince[kind] = undefined;
      }
      return undefined;
    };

    // Priority: memory -> processes -> cpu (memory OOM is the most urgent threat to host stability).
    const violation =
      check("memory", memoryMb, limits.memoryMb, this.peakMemoryMb) ??
      check("processes", processes, limits.maxProcesses, this.peakProcesses) ??
      check("cpu", cpuPercent, limits.cpuPercent, this.peakCpuPercent ?? 0);

    return violation ? { stats, violation } : { stats };
  }
}
