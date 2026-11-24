import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeKernelLimits,
  kernelLimitsSatisfied,
  linuxScopeUnit,
  mergeLimits,
  probeKernelLimits,
  winCpuRate,
  wrapLinuxScope,
} from "../../../src/platform/limits.ts";
import { JOB_SPEC_HEADER, JOB_SPEC_HEADER_V2, jobSpecText } from "../../../src/platform/job.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { parseProcessRows } from "../../../src/platform/windows.ts";

test("mergeLimits merges per-call overrides over global defaults and returns undefined when no cap is set", () => {
  assert.equal(mergeLimits(undefined, undefined), undefined);
  assert.equal(mergeLimits({ graceMs: 1000, strict: false }, undefined), undefined);
  assert.deepEqual(
    mergeLimits({ memoryMb: 4096, maxProcesses: 32, graceMs: 5000 }, { memoryMb: 1024, strict: true }),
    { memoryMb: 1024, maxProcesses: 32, graceMs: 5000, strict: true },
  );
  assert.deepEqual(mergeLimits(undefined, { cpuPercent: 200 }), { cpuPercent: 200 });
});

test("probeKernelLimits detects Linux delegated unified cgroup v2 vs hybrid/non-delegated hosts", () => {
  const delegated = probeKernelLimits({
    platform: "linux",
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: () => 1000,
    findBin: name => name === "systemd-run" ? "/usr/bin/systemd-run" : undefined,
    exists: p => p === "/run/user/1000/bus" || p === "/sys/fs/cgroup/cgroup.controllers",
    readText: p => p.endsWith("user@1000.service/cgroup.controllers") ? "cpu io memory pids\n" : "",
  });
  assert.deepEqual(delegated, {
    backend: "linux-cgroup-v2",
    memory: true,
    cpu: true,
    processes: false,
    systemdRun: "/usr/bin/systemd-run",
  });
  assert.match(describeKernelLimits(delegated), /Linux cgroup v2 \(memory, cpu\)/);

  // Hybrid cgroup (no unified /sys/fs/cgroup/cgroup.controllers) falls back cleanly.
  const hybrid = probeKernelLimits({
    platform: "linux",
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: () => 1000,
    findBin: () => "/usr/bin/systemd-run",
    exists: p => p === "/run/user/1000/bus",
  });
  assert.equal(hybrid.backend, "none");
  assert.equal(hybrid.memory, false);
  assert.match(String(hybrid.reason), /unified cgroup v2/);

  // Unified cgroup v2 without memory/cpu delegation falls back cleanly.
  const noDelegate = probeKernelLimits({
    platform: "linux",
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: () => 1000,
    findBin: () => "/usr/bin/systemd-run",
    exists: p => p === "/run/user/1000/bus" || p === "/sys/fs/cgroup/cgroup.controllers",
    readText: () => "pids\n",
  });
  assert.equal(noDelegate.backend, "none");
  assert.match(String(noDelegate.reason), /delegation/);

  // Missing user D-Bus session falls back cleanly.
  const noBus = probeKernelLimits({
    platform: "linux",
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    findBin: () => "/usr/bin/systemd-run",
    exists: () => false,
  });
  assert.equal(noBus.backend, "none");
  assert.match(String(noBus.reason), /D-Bus/);
});

test("probeKernelLimits reports Windows Job Object for commands and monitor-only for macOS / Windows agents", () => {
  const winCmd = probeKernelLimits({ platform: "win32", kind: "command" });
  assert.deepEqual(winCmd, { backend: "windows-job", memory: true, cpu: true, processes: true });
  const winAgent = probeKernelLimits({ platform: "win32", kind: "agent" });
  assert.equal(winAgent.backend, "none");
  const mac = probeKernelLimits({ platform: "darwin", kind: "agent" });
  assert.equal(mac.backend, "none");
  assert.match(String(mac.reason), /macOS/);
});

test("kernelLimitsSatisfied enforces strict mode against backend capabilities", () => {
  const none = probeKernelLimits({ platform: "darwin" });
  assert.equal(kernelLimitsSatisfied({ memoryMb: 512, strict: false }, none), undefined);
  assert.match(String(kernelLimitsSatisfied({ memoryMb: 512, strict: true }, none)), /strict resource limits requested for memoryMb/);

  const linux = { backend: "linux-cgroup-v2" as const, memory: true, cpu: true, processes: false, systemdRun: "/usr/bin/systemd-run" };
  assert.equal(kernelLimitsSatisfied({ memoryMb: 512, cpuPercent: 200, strict: true }, linux), undefined);
  // maxProcesses is not backed by Linux cgroup pids.max (which counts OS threads), so strict flags it honestly.
  assert.match(String(kernelLimitsSatisfied({ maxProcesses: 8, strict: true }, linux)), /maxProcesses/);

  const winCmd = probeKernelLimits({ platform: "win32", kind: "command" });
  assert.equal(kernelLimitsSatisfied({ memoryMb: 512, maxProcesses: 8, cpuPercent: 100, strict: true }, winCmd), undefined);
});

test("wrapLinuxScope wraps commands in transient systemd scopes only when cgroup controllers cover requested caps", () => {
  const caps = { backend: "linux-cgroup-v2" as const, memory: true, cpu: true, processes: false, systemdRun: "/usr/bin/systemd-run" };
  const wrapped = wrapLinuxScope("W@1/a@1#1.1", "/usr/bin/pi", ["--mode", "rpc"], { memoryMb: 512, cpuPercent: 150, maxProcesses: 16 }, caps);
  assert.equal(wrapped.command, "/usr/bin/systemd-run");
  assert.equal(wrapped.unit, linuxScopeUnit("W@1/a@1#1.1"));
  assert.deepEqual(wrapped.args, [
    "--user", "--scope", "--quiet", "--collect", "--unit", wrapped.unit!,
    "-p", String(`MemoryMax=${512 * 1024 * 1024}`), "-p", "MemorySwapMax=0",
    "-p", "CPUQuota=150%",
    "--", "/usr/bin/pi", "--mode", "rpc",
  ]);

  // Only maxProcesses requested -> no cgroup properties to wrap, leave original command untouched.
  const unwrapped = wrapLinuxScope("W@1/a@1#1.1", "/usr/bin/pi", ["--mode", "rpc"], { maxProcesses: 16 }, caps);
  assert.equal(unwrapped.unit, undefined);
  assert.equal(unwrapped.command, "/usr/bin/pi");
  assert.deepEqual(unwrapped.args, ["--mode", "rpc"]);
});

test("winCpuRate converts core percentage to Windows Job Object CpuRate (1..10000)", () => {
  assert.equal(winCpuRate(100, 4), 2500);
  assert.equal(winCpuRate(200, 4), 5000);
  assert.equal(winCpuRate(800, 4), 10_000);
  assert.equal(winCpuRate(0.001, 16), 1);
});

test("jobSpecText emits DSAJOB1 without limits and DSAJOB2 with encoded resource limits", () => {
  const base = { exe: "C:\\node.exe", cwd: "C:\\work", log: "C:\\out.log", args: ["a"], env: { K: "V" } };
  const plain = jobSpecText(base).trim().split("\n");
  assert.equal(plain[0], JOB_SPEC_HEADER);

  const limited = jobSpecText({ ...base, limits: { memoryMb: 256, maxProcesses: 5, cpuPercent: 100 } }).trim().split("\n");
  assert.equal(limited[0], JOB_SPEC_HEADER_V2);
  assert.equal(limited.at(-3), String(256 * 1024 * 1024));
  assert.equal(limited.at(-2), "5");
  const cpuRate = Number(limited.at(-1));
  assert.ok(Number.isInteger(cpuRate) && cpuRate >= 1 && cpuRate <= 10_000);
});

test("ProcessTable collects rssBytes on Linux, macOS (new and legacy ps formats) and Windows (6-col and legacy 5-col)", async () => {
  // Live Linux/macOS host process RSS check
  if (process.platform === "linux" || process.platform === "darwin") {
    const rows = await new ProcessTable().list(new Set(), { fresh: true });
    const self = rows.find(p => p.pid === process.pid);
    assert.ok(self, "own process must appear in ProcessTable");
    assert.ok(typeof self.rssBytes === "number" && self.rssBytes > 0, `expected positive rssBytes, got ${self.rssBytes}`);
  }

  // macOS parser: with rss column and legacy without rss column
  const macNew = new ProcessTable({
    platform: "darwin",
    ps: async () => "  101    1 Mon Nov 23 10:00:00 2026   0:01.50  32768 S    /usr/bin/node DSA_EXEC=exec1\n",
  });
  const [pNew] = await macNew.list(new Set(["exec1"]));
  assert.equal(pNew?.pid, 101);
  assert.equal(pNew?.rssBytes, 32768 * 1024);
  assert.equal(pNew?.tag, "exec1");

  const macLegacy = new ProcessTable({
    platform: "darwin",
    ps: async () => "  102    1 Mon Nov 23 10:00:00 2026   0:01.50 S    /usr/bin/node DSA_EXEC=exec2\n",
  });
  const [pOld] = await macLegacy.list(new Set(["exec2"]));
  assert.equal(pOld?.pid, 102);
  assert.equal(pOld?.rssBytes, undefined);
  assert.equal(pOld?.tag, "exec2");

  // Windows parseProcessRows: 6-column with WorkingSetSize and 5-column legacy
  const T = "639140000000000000";
  const [w6] = parseProcessRows(`6400\t4212\t${T}\t20000\t52428800\tnode.exe`);
  assert.deepEqual(w6, { pid: 6400, ppid: 4212, start: T, cpuMs: 2, rssBytes: 52428800, command: "node.exe" });
  const [w5] = parseProcessRows(`6400\t4212\t${T}\t20000\tnode.exe`);
  assert.deepEqual(w5, { pid: 6400, ppid: 4212, start: T, cpuMs: 2, command: "node.exe" });
});
