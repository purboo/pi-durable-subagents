import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir } from "../../../../src/paths.ts";
import { formatResourceViolation, ResourceMonitor } from "../../../../src/orchestrator/executor/resources.ts";
import { observeExecution } from "../../../../src/orchestrator/executor/observe.ts";
import { compactWorkflow, snapshotFromEntries, statusBrief } from "../../../../src/orchestrator/snapshot.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { Containment } from "../../../../src/platform/containment.ts";
import { attachCapturedAt, ProcessTable } from "../../../../src/platform/proctable.ts";
import { probeKernelLimits } from "../../../../src/platform/limits.ts";
import { request } from "../../../../src/agent/main/tool.ts";
import { doctor, renderDoctor } from "../../../../src/cli/doctor.ts";
import type { CallTicket, OrchestratorConfig } from "../../../../src/orchestrator/contract.ts";
import { JT, type ProcInfo } from "../../../../src/types.ts";

const MB = 1024 * 1024;

test("ResourceMonitor sums RSS across process tree, respects graceMs, and resets on recovery", () => {
  const mon = new ResourceMonitor({ memoryMb: 500, graceMs: 3000 });
  const proc = (pid: number, mb: number): ProcInfo => ({ pid, ppid: 1, start: `s${pid}`, rssBytes: mb * MB, cpuMs: 0 });

  // Under limit (300 MiB)
  let r = mon.sample([proc(10, 200), proc(11, 100)], 1000);
  assert.equal(r.violation, undefined);
  assert.equal(r.stats.memoryMb, 300);
  assert.equal(r.stats.peakMemoryMb, 300);
  assert.equal(r.stats.processes, 2);

  // Brief spike above 500 MiB (650 MiB) for 2000 ms (< graceMs 3000 ms)
  r = mon.sample([proc(10, 200), proc(11, 450)], 2000);
  assert.equal(r.violation, undefined);
  r = mon.sample([proc(10, 200), proc(11, 450)], 4000);
  assert.equal(r.violation, undefined);
  assert.equal(r.stats.peakMemoryMb, 650);

  // Drops back below limit -> resets grace timer
  r = mon.sample([proc(10, 200), proc(11, 150)], 4500);
  assert.equal(r.violation, undefined);

  // Sustained breach above 500 MiB across 3000 ms -> violation with top processes sorted descending
  r = mon.sample([proc(10, 200), proc(11, 350), proc(12, 100)], 5000);
  assert.equal(r.violation, undefined);
  r = mon.sample([proc(10, 200), proc(11, 350), proc(12, 100)], 8000);
  assert.ok(r.violation);
  assert.equal(r.violation.kind, "memory");
  assert.equal(r.violation.limit, 500);
  assert.equal(r.violation.observed, 650);
  assert.deepEqual(r.violation.top.map(t => t.pid), [11, 10, 12]);
  assert.match(formatResourceViolation(r.violation), /memory 650 MiB > 500 MiB limit.*pid 11 350 MiB/);
});

test("ResourceMonitor enforces maxProcesses, cpuPercent, overheadPids exclusion and live setLimits", () => {
  const mon = new ResourceMonitor({ maxProcesses: 2, cpuPercent: 150, graceMs: 1000 });
  const overhead = new Set([1]);
  const procs = (tCpu: number, count: number): ProcInfo[] => [
    { pid: 1, ppid: 0, start: "wrap", rssBytes: 50 * MB, cpuMs: 5000 }, // excluded harness process
    ...Array.from({ length: count }, (_, i) => ({ pid: 10 + i, ppid: 1, start: `c${i}`, rssBytes: 10 * MB, cpuMs: tCpu })),
  ];

  // Baseline sample (2 user procs + 1 excluded wrapper -> processes === 2, within limit)
  let r = mon.sample(procs(100, 2), 1000, overhead);
  assert.equal(r.violation, undefined);
  assert.equal(r.stats.processes, 2);
  assert.equal(r.stats.memoryMb, 20);

  // CPU spike: 2 procs each burn 1000ms CPU over 1000ms wall time -> 200% > 150%
  r = mon.sample(procs(1100, 2), 2000, overhead);
  assert.equal(r.violation, undefined);
  assert.equal(r.stats.cpuPercent, 200);
  r = mon.sample(procs(2100, 2), 3000, overhead);
  assert.ok(r.violation);
  assert.equal(r.violation.kind, "cpu");
  assert.match(formatResourceViolation(r.violation), /CPU 200% > 150% limit/);

  // Raising cpuPercent clears CPU timer; spawning 3rd user proc triggers maxProcesses
  mon.setLimits({ maxProcesses: 2, cpuPercent: 400, graceMs: 0 });
  r = mon.sample(procs(2200, 3), 4000, overhead);
  assert.ok(r.violation);
  assert.equal(r.violation.kind, "processes");
  assert.equal(r.violation.observed, 3);
});

test("ResourceMonitor deduplicates cached ProcessTable snapshots via capturedAt", () => {
  const mon = new ResourceMonitor({ cpuPercent: 150, memoryMb: 500, graceMs: 1000 });
  const snap = (cpuMs: number, mb: number, capturedAt: number) =>
    attachCapturedAt([{ pid: 10, ppid: 1, start: "s10", rssBytes: mb * MB, cpuMs }], capturedAt);

  // First real scan at t=1000
  let r = mon.sample(snap(0, 100, 1000), 1000);
  assert.equal(r.violation, undefined);

  // Second real scan at t=2000: 2000ms CPU in 1000ms wall -> 200% (> 150%), starts grace timer at t=2000
  const s2 = snap(2000, 100, 2000);
  r = mon.sample(s2, 2000);
  assert.equal(r.stats.cpuPercent, 200);
  assert.equal(r.violation, undefined);

  // Repeated reads of cached snapshot s2 at t=2400 and t=2800 must NOT reset cpuPercent to 0% or break next delta
  assert.equal(mon.sample(s2, 2400).violation, undefined);
  assert.equal(mon.sample(s2, 2800).violation, undefined);

  // Third real scan at t=3000: 2000ms CPU in 1000ms wall -> exact 200% (NOT 5x inflated!), crosses 1000ms grace
  r = mon.sample(snap(4000, 100, 3000), 3000);
  assert.equal(r.stats.cpuPercent, 200);
  assert.ok(r.violation);
  assert.equal(r.violation.kind, "cpu");
});

test("observeExecution records resource-limit, fences, and surfaces resources in snapshot/statusBrief", { timeout: 10_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-res-obs-")), wid = ulid();
  const wfDir = join(home, "w", wid);
  await mkdir(wfDir, { recursive: true });
  const journal = await openJournal(join(wfDir, "journal.jsonl"));
  const callId = `${wid}@1/a@1`, exec = `${callId}#1.1`;
  await journal.append("wf-created", { wid, revision: 1, origin: "main:s1", cwd: home });
  await journal.append("call", { call: callId, key: "a", gen: 1, spec: { agent: "test", task: "t", limits: { memoryMb: 100, graceMs: 0 } } });
  await journal.append(JT.exec, { call: callId, exec });
  await journal.append("selected", { exec, model: { provider: "p", id: "m" } });
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });

  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key: "a", gen: 1, callId, cwd: home, journal,
    spec: { agent: "test", task: "t", limits: { memoryMb: 100, graceMs: 0 } },
    agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
  };
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
  let fenced = false;
  t.after(async () => {
    stdout.destroy(); stdin.destroy(); stderr.destroy();
    await journal.close();
    await rm(home, { recursive: true, force: true });
  });

  await observeExecution({
    home, config: { k: { trackerMs: 25, checkpointMs: 10 } }, ticket, exec,
    child: { pid: 100, start: "s1", stdin, stdout, stderr, exited: new Promise(() => {}) },
    serial: fn => fn(), setWake: () => {}, interrupted: () => false,
    track: async () => [
      { pid: 100, ppid: 1, start: "s1", rssBytes: 40 * MB, cpuMs: 10 },
      { pid: 101, ppid: 100, start: "s2", rssBytes: 120 * MB, cpuMs: 20 },
    ],
    fence: async () => { fenced = true; },
    questions: async () => {}, recordUsage: async () => {}, switched: async () => {}, pendingSwitch: () => undefined,
    limits: () => ticket.spec.limits,
    readCommand: async pid => pid === 101 ? "cargo test --all" : "pi --mode rpc",
  });

  assert.equal(fenced, true, "execution must be fenced on resource limit violation");
  const hit = journal.entries().find(e => e.type === "resource-limit" && e.exec === exec);
  assert.ok(hit, "resource-limit journal entry must be recorded");
  assert.equal(hit.kind, "memory");
  assert.match(String(hit.message), /160 MiB > 100 MiB limit.*cargo test --all/);

  // Snapshot and statusBrief surface checkpointed resources cleanly.
  const snap = snapshotFromEntries(wid, journal.entries());
  assert.equal(snap.calls[0]?.resources?.peakMemoryMb, 160);
  assert.equal(snap.calls[0]?.resources?.processes, 2);
  const compact = compactWorkflow(snap);
  assert.equal(compact.calls[0]?.resources?.memoryMb, 160);
  const brief = statusBrief(home, { origin: "main:s1" });
  assert.match(String(brief.active[0]?.calls[0]?.memory), /160 MiB \(peak 160 MiB, 2 procs\)/);
});

test("real command call enforces memoryMb and maxProcesses limits, seals failed without rerunning, and honors strict mode", { timeout: 45_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-res-cmd-"));
  const orch = await openJournal(join(home, "orchestrator.jsonl"));
  const containment = new Containment(new ProcessTable());
  const config: OrchestratorConfig = { k: { trackerMs: 100 } };
  const executor = createExecutor({ home, orch, config }, { containment });
  t.after(async () => {
    await executor.shutdown();
    await orch.close();
    await rm(home, { recursive: true, force: true });
  });

  const makeTicket = async (key: string, spec: CallTicket["spec"]): Promise<CallTicket> => {
    const wid = ulid(), wfDir = join(home, "w", wid);
    await mkdir(wfDir, { recursive: true });
    const journal = await openJournal(join(wfDir, "journal.jsonl"));
    t.after(() => journal.close());
    const callId = `${wid}@1/${key}@1`;
    await journal.append("wf-created", { wid, revision: 1, origin: "main:s", cwd: home });
    await journal.append("call", { call: callId, key, gen: 1, spec });
    return {
      wid, widRev: `${wid}@1`, key, gen: 1, callId, cwd: home, journal, spec,
      agent: { name: "", description: "", body: "", sourcePath: "", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
    };
  };

  // 1. Real memory breach: allocate ~64 MiB buffer under a 25 MiB cap (rerun: true must NOT retry it).
  const memTicket = await makeTicket("mem", {
    agent: "", task: "",
    command: [process.execPath, "-e", "const b = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => { console.log(b[0]); }, 25000);"],
    rerun: true,
    limits: { memoryMb: 25, graceMs: 0 },
  });
  const memRes = await executor.run(memTicket);
  assert.equal(memRes.status, "failed");
  assert.match(String(memRes.error), /Resource limit exceeded: (?:memory .* > 25 MiB limit|killed by .* (?:OOM|memory limit))/);
  // Must have only 1 command-intent (never reran despite rerun: true).
  assert.equal(memTicket.journal.entries().filter(e => e.type === "command-intent").length, 1);

  // 2. Real maxProcesses breach: parent spawns 2 sleeping children under maxProcesses: 1.
  const procTicket = await makeTicket("procs", {
    agent: "", task: "",
    command: [process.execPath, "-e", "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(()=>{},25000)']); spawn(process.execPath, ['-e', 'setTimeout(()=>{},25000)']); setTimeout(()=>{}, 25000);"],
    limits: { maxProcesses: 1, graceMs: 0 },
  });
  const procRes = await executor.run(procTicket);
  assert.equal(procRes.status, "failed");
  if (process.platform !== "win32") {
    assert.match(String(procRes.error), /Resource limit exceeded: .* > 1 maxProcesses limit/);
  }

  // 3. Strict mode on a host without kernel enforcement refuses before launching.
  const caps = probeKernelLimits({ kind: "command" });
  if (!caps.memory) {
    const strictTicket = await makeTicket("strict", {
      agent: "", task: "",
      command: [process.execPath, "-e", "console.log('should not run')"],
      limits: { memoryMb: 64, strict: true },
    });
    const strictRes = await executor.run(strictTicket);
    assert.equal(strictRes.status, "failed");
    assert.match(String(strictRes.error), /strict resource limits requested for memoryMb/);
    assert.equal(strictTicket.journal.entries().filter(e => e.type === "command-intent").length, 0);
  }
});

test("request() propagates limits to single calls and tasks/chain step defaults, and doctor reports backend", async t => {
  const single = request({ agent: "worker", task: "t", limits: { memoryMb: 512, maxProcesses: 8 } }, "/tmp");
  assert.deepEqual((single.body as { call?: { limits?: unknown } }).call?.limits, { memoryMb: 512, maxProcesses: 8 });

  const fanout = request({
    tasks: [
      { agent: "worker", task: "a" },
      { agent: "worker", task: "b", limits: { memoryMb: 256 } },
      { command: ["echo", "hi"] },
    ],
    limits: { memoryMb: 1024, maxProcesses: 16 },
  }, "/tmp");
  const steps = (fanout.body as { tasks?: { limits?: unknown }[] }).tasks!;
  assert.deepEqual(steps[0]?.limits, { memoryMb: 1024, maxProcesses: 16 });
  assert.deepEqual(steps[1]?.limits, { memoryMb: 256 });
  assert.deepEqual(steps[2]?.limits, { memoryMb: 1024, maxProcesses: 16 });

  const home = await mkdtemp(join(tmpdir(), "dsa-doc-lim-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const report = await doctor(home);
  assert.match(report.resourceLimits, /process-tree monitor/);
  assert.match(renderDoctor(report), /^resource limits: /m);
});
