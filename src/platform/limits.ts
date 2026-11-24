// OS-level kernel resource-limit detection and launch wrapping (Layer 2).
// Layer 1 (process-tree monitor + fence in orchestrator/executor/resources.ts) always runs on every platform;
// Layer 2 adds kernel-level hard limits where available:
//   - Linux: transient user systemd scope under delegated unified cgroup v2 (MemoryMax, CPUQuota).
//     (Linux cgroup pids.max / TasksMax counts OS threads, not processes, so maxProcesses stays in Layer 1.)
//   - Windows: Job Object hard limits (JobMemoryLimit, ActiveProcessLimit, CpuRateControl) for command calls
//     via DsaJob.exe (platform/job.ts).
//   - macOS: no unprivileged kernel process-tree memory/CPU hard limit; Layer 1 monitor enforces limits.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { contentHash } from "../kernel/ids.ts";
import type { ResourceLimits } from "../types.ts";
import { findOnPath } from "./launch.ts";

const exec = promisify(execFile);

export interface KernelLimitCapabilities {
  backend: "linux-cgroup-v2" | "windows-job" | "none";
  /** Whether kernel memory hard limits can be enforced for this call kind. */
  memory: boolean;
  /** Whether kernel CPU hard caps can be enforced for this call kind. */
  cpu: boolean;
  /** Whether kernel active-process hard caps can be enforced for this call kind. */
  processes: boolean;
  /** Resolved systemd-run path on Linux when backend === "linux-cgroup-v2". */
  systemdRun?: string;
  /** Human-readable explanation when kernel hard limits are unavailable or partial. */
  reason?: string;
}

export interface KernelProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  kind?: "agent" | "command";
  /** Test seams. */
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  uid?: () => number | undefined;
  findBin?: (name: string, pathEnv?: string) => string | undefined;
}

/** Merge global config.json `limits` with per-call `spec.limits`. Returns undefined when no resource cap is active. */
export function mergeLimits(globalLimits?: ResourceLimits, callLimits?: ResourceLimits): ResourceLimits | undefined {
  if (!globalLimits && !callLimits) return undefined;
  const merged: ResourceLimits = { ...globalLimits, ...callLimits };
  if (merged.memoryMb === undefined && merged.maxProcesses === undefined && merged.cpuPercent === undefined) return undefined;
  return merged;
}

/** Whether a limits object specifies at least one concrete resource cap. */
export const hasActiveLimits = (limits?: ResourceLimits): limits is ResourceLimits =>
  !!limits && (limits.memoryMb !== undefined || limits.maxProcesses !== undefined || limits.cpuPercent !== undefined);

/** Stable, systemd-safe transient scope unit name for one execution. */
export function linuxScopeUnit(exec: string): string {
  return `dsa-exec-${contentHash([exec]).slice(0, 16)}.scope`;
}

/** Convert cpuPercent (% of one CPU core, e.g. 200 = 2 cores) to Windows Job Object CpuRate (1..10000 = 0.01%..100% of machine). */
export function winCpuRate(cpuPercent: number, coreCount = Math.max(1, cpus().length)): number {
  const cores = Math.max(1, coreCount);
  const ratio = (cpuPercent / (cores * 100)) * 10_000;
  return Math.max(1, Math.min(10_000, Math.round(ratio)));
}

/** Fast, pure-fs capability probe for OS kernel hard limits. Safe to call in doctor and before launch. */
export function probeKernelLimits(options: KernelProbeOptions = {}): KernelLimitCapabilities {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const kind = options.kind ?? "agent";
  if (platform === "darwin") {
    return {
      backend: "none", memory: false, cpu: false, processes: false,
      reason: "macOS does not provide unprivileged OS kernel memory/CPU hard limits for process trees",
    };
  }
  if (platform === "win32") {
    if (kind === "command") {
      return { backend: "windows-job", memory: true, cpu: true, processes: true };
    }
    return {
      backend: "none", memory: false, cpu: false, processes: false,
      reason: "Windows Job Object kernel hard limits currently apply to command calls; agent calls use process-tree monitoring",
    };
  }
  if (platform !== "linux") {
    return { backend: "none", memory: false, cpu: false, processes: false, reason: `no OS kernel resource limit backend on ${platform}` };
  }

  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((p: string) => readFileSync(p, "utf8"));
  const findBin = options.findBin ?? ((name: string, pathEnv?: string) => findOnPath(name, pathEnv, { platform: "linux" }));
  const uid = options.uid ? options.uid() : process.getuid?.();

  const systemdRun = findBin("systemd-run", env.PATH);
  if (!systemdRun) {
    return { backend: "none", memory: false, cpu: false, processes: false, reason: "systemd-run not found on PATH" };
  }
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const hasBus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) || Boolean(runtimeDir && exists(join(runtimeDir, "bus")));
  if (!hasBus) {
    return { backend: "none", memory: false, cpu: false, processes: false, reason: "no user systemd D-Bus session (XDG_RUNTIME_DIR/bus unavailable)" };
  }
  if (!exists("/sys/fs/cgroup/cgroup.controllers")) {
    return {
      backend: "none", memory: false, cpu: false, processes: false,
      reason: "host is not running unified cgroup v2 (/sys/fs/cgroup/cgroup.controllers missing)",
    };
  }
  const controllers = new Set<string>();
  const candidateFiles: string[] = [];
  if (uid !== undefined) {
    candidateFiles.push(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`);
  }
  try {
    const selfCg = readText("/proc/self/cgroup");
    const v2 = selfCg.split("\n").find(l => l.startsWith("0::"));
    if (v2) {
      const rel = v2.slice(3).trim();
      if (rel) candidateFiles.push(`/sys/fs/cgroup${rel}/cgroup.controllers`);
    }
  } catch { /* ignore */ }
  for (const file of candidateFiles) {
    try {
      for (const c of readText(file).trim().split(/\s+/).filter(Boolean)) controllers.add(c);
      if (controllers.size) break;
    } catch { /* try next */ }
  }
  const memory = controllers.has("memory");
  const cpu = controllers.has("cpu");
  if (!memory && !cpu) {
    return {
      backend: "none", memory: false, cpu: false, processes: false,
      reason: "Linux user cgroup v2 delegation does not expose memory/cpu controllers (enable Delegate=cpu cpuset io memory pids on user@.service)",
    };
  }
  return {
    backend: "linux-cgroup-v2",
    memory,
    cpu,
    // Linux cgroup pids.max / TasksMax counts OS threads, not processes; keep maxProcesses on process-tree monitor.
    processes: false,
    systemdRun,
    ...(!memory || !cpu ? { reason: `Linux user cgroup v2 delegated controllers: ${[...controllers].sort().join(", ")}` } : {}),
  };
}

/** Check whether `strict: true` is satisfied by the OS kernel backend for all requested limits. Returns error text or undefined. */
export function kernelLimitsSatisfied(limits: ResourceLimits, caps: KernelLimitCapabilities): string | undefined {
  if (!limits.strict) return undefined;
  const missing: string[] = [];
  if (limits.memoryMb !== undefined && !caps.memory) missing.push("memoryMb");
  if (limits.cpuPercent !== undefined && !caps.cpu) missing.push("cpuPercent");
  if (limits.maxProcesses !== undefined && !caps.processes) missing.push("maxProcesses");
  if (!missing.length) return undefined;
  return `strict resource limits requested for ${missing.join(", ")}, but OS kernel enforcement is unavailable${caps.reason ? `: ${caps.reason}` : ""}`;
}

export interface WrappedLinuxScope {
  command: string;
  args: string[];
  /** Present when wrapped in a transient systemd scope unit. */
  unit?: string;
}

/** Wrap a Linux spawn command in `systemd-run --user --scope` when cgroup v2 controllers cover at least one requested limit. */
export function wrapLinuxScope(
  exec: string,
  command: string,
  args: readonly string[],
  limits: ResourceLimits | undefined,
  caps: KernelLimitCapabilities,
): WrappedLinuxScope {
  if (!limits || caps.backend !== "linux-cgroup-v2" || !caps.systemdRun) {
    return { command, args: [...args] };
  }
  const props: string[] = [];
  if (limits.memoryMb !== undefined && caps.memory) {
    const bytes = Math.max(1024 * 1024, Math.round(limits.memoryMb * 1024 * 1024));
    props.push("-p", `MemoryMax=${bytes}`, "-p", "MemorySwapMax=0");
  }
  if (limits.cpuPercent !== undefined && caps.cpu) {
    const pct = Math.max(1, Math.round(limits.cpuPercent));
    props.push("-p", `CPUQuota=${pct}%`);
  }
  if (!props.length) return { command, args: [...args] };
  const unit = linuxScopeUnit(exec);
  return {
    command: caps.systemdRun,
    args: ["--user", "--scope", "--quiet", "--collect", "--unit", unit, ...props, "--", command, ...args],
    unit,
  };
}

/** Check whether a transient Linux systemd scope ended because of cgroup OOM-kill. Best effort; never throws. */
export async function checkLinuxScopeOom(unit: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!unit || process.platform !== "linux") return false;
  const systemctl = findOnPath("systemctl", env.PATH, { platform: "linux" });
  if (!systemctl) return false;
  try {
    const { stdout } = await exec(systemctl, ["--user", "show", "-p", "Result", "--value", unit], { env, timeout: 1500 });
    return stdout.trim() === "oom-kill";
  } catch {
    return false;
  }
}

/** Concise one-line description for `doctor` and diagnostics. */
export function describeKernelLimits(caps: KernelLimitCapabilities): string {
  if (caps.backend === "linux-cgroup-v2") {
    const active = [caps.memory ? "memory" : "", caps.cpu ? "cpu" : ""].filter(Boolean).join(", ");
    return `process-tree monitor + Linux cgroup v2 (${active})`;
  }
  if (caps.backend === "windows-job") {
    return "process-tree monitor + Windows Job Object (memory, cpu, processes for command calls)";
  }
  return `process-tree monitor only (${caps.reason ?? "OS kernel hard limits unavailable"})`;
}
