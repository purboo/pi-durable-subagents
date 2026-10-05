import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { Containment } from "../../../../src/platform/containment.ts";
import { serialContainment, skipLostCandidate, sweepExecutions } from "../../../../src/orchestrator/executor/sweep.ts";
import { JT, type ProcInfo } from "../../../../src/types.ts";
import { setTimeout as delay } from "node:timers/promises";

test("K7 three consecutive candidate losses skip ten minutes; replay is idempotent", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-skip-"));
  const journal = await openJournal(join(root, "workflow")), orch = await openJournal(join(root, "orch"));
  t.after(async () => { await journal.close(); await orch.close(); await rm(root, { recursive: true, force: true }); });
  for (let i = 1; i <= 3; i++) {
    const exec = `call#1.${i}`;
    await journal.append("selected", { exec, pool: "pool", model: { provider: "p", id: "m" } });
    await skipLostCandidate(journal, orch, exec);
    await skipLostCandidate(journal, orch, exec);
    assert.equal(orch.entries().filter(e => e.type === "skip").length, i < 3 ? 0 : 1);
  }
  const skip = orch.entries().find(e => e.type === "skip")!;
  assert.equal(skip.model, "p/m"); assert.equal(skip.pool, "pool");
  assert.ok(Number(skip.until) - skip.ts >= 599900);
  await orch.append("candidate-success", { pool: "pool", model: "p/m", exec: "success" });
  await journal.append("selected", { exec: "fourth", pool: "pool", model: { provider: "p", id: "m" } });
  await skipLostCandidate(journal, orch, "fourth");
  assert.equal(orch.entries().filter(e => e.type === "skip").length, 1);
});

test("P23 sweep kills a tagged straggler launched after a durable fence", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-sweep-"));
  const journal = await openJournal(join(root, "workflow")), containment = new Containment(), exec = `sweep-${process.pid}-${Date.now()}`;
  t.after(async () => { await containment.fence(exec, []); await journal.close(); await rm(root, { recursive: true, force: true }); });
  await journal.append(JT.exec, { exec, call: "c" }); await journal.append(JT.fenced, { exec });
  const child = await containment.spawn({ exec, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root, env: {} });
  await sweepExecutions([journal], new Containment());
  assert.equal((await child.exited).signal, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("F1 F2 one scan per sweep; a failing exec is reported and never stops the others; failed fences are retried", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-sweep-"));
  const journal = await openJournal(join(root, "workflow"));
  t.after(async () => { await journal.close(); await rm(root, { recursive: true, force: true }); });
  for (const [exec, call] of [["x#1.1", "x"], ["y#1.1", "y"], ["z#1.1", "z"], ["w#1.1", "w"], ["v#1.1", "v"], ["m#1.1", "m"]]) await journal.append(JT.exec, { exec, call });
  await journal.append(JT.fenced, { exec: "x#1.1" }); await journal.append(JT.fenced, { exec: "y#1.1" }); await journal.append("retired", { call: "z" });
  await journal.append("fence-failed", { exec: "w#1.1", error: "Fence timeout" }); await journal.append("tracked", { exec: "w#1.1", pid: 1, start: "s" });
  const scans: string[][] = [], fences: string[] = [];
  const containment = {
    async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { scans.push([...known.keys()].sort()); return new Map([["x#1.1", [{ pid: 2, ppid: 0, start: "t" }]], ["z#1.1", [{ pid: 3, ppid: 0, start: "u" }]]]); },
    async fence(exec: string, tracked: readonly ProcInfo[]) { fences.push(exec); if (exec === "x#1.1") throw new Error("Fence timeout: x#1.1"); if (exec === "w#1.1") assert.equal(tracked[0]!.pid, 1); },
  };
  const fenced: string[] = [], failed: string[] = [];
  await sweepExecutions([journal], containment, { failing: exec => exec === "m#1.1", fenced: async (_j, exec, call, was) => { fenced.push(`${exec}:${call}:${was}`); }, failed: async (_j, exec) => { failed.push(exec); } });
  assert.deepEqual(scans, [["m#1.1", "w#1.1", "x#1.1", "y#1.1", "z#1.1"]]);
  assert.deepEqual(fences, ["x#1.1", "z#1.1", "w#1.1", "m#1.1"], "fenced execs without live processes are not re-fenced");
  assert.deepEqual(failed, ["x#1.1"]);
  assert.deepEqual(fenced, ["z#1.1:z:false", "w#1.1:w:false", "m#1.1:m:false"]);
});

test("F1 a gate without an outcome whose fence failed is retried with its tracked processes; resolved gates are not", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-sweep-"));
  const journal = await openJournal(join(root, "workflow"));
  t.after(async () => { await journal.close(); await rm(root, { recursive: true, force: true }); });
  await journal.append("gate-intent", { call: "w@1/k@1", id: "gate:w@1/k@1#1", exec: "w@1/k@1#1.1" });
  await journal.append("gate-tracked", { id: "gate:w@1/k@1#1", process: { pid: 7, ppid: 1, start: "g" } });
  await journal.append("fence-failed", { exec: "gate:w@1/k@1#1", error: "Fence timeout" });
  await journal.append("gate-intent", { call: "w@1/k@1", id: "gate:w@1/k@1#2", exec: "w@1/k@1#1.2" });
  await journal.append("fence-failed", { exec: "gate:w@1/k@1#2", error: "Fence timeout" });
  await journal.append("gate", { id: "gate:w@1/k@1#2", unknown: true });
  const fences: [string, number][] = [], fenced: string[] = [];
  const containment = { async scan() { return new Map(); }, async fence(exec: string, tracked: readonly ProcInfo[]) { fences.push([exec, tracked.length]); } };
  await sweepExecutions([journal], containment, { fenced: async (_j, exec, call, was) => { fenced.push(`${exec}:${call}:${was}`); } });
  assert.deepEqual(fences, [["gate:w@1/k@1#1", 1]]);
  assert.deepEqual(fenced, ["gate:w@1/k@1#1:w@1/k@1:false"]);
});

test("F4 a serial containment never overlaps process-table snapshots", async () => {
  let inFlight = 0, most = 0, calls = 0;
  const containment = serialContainment({ async list() { calls++; most = Math.max(most, ++inFlight); await delay(5); inFlight--; if (calls === 2) throw new Error("transient"); return []; } });
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => containment.scan(new Map())));
  assert.equal(most, 1); assert.equal(calls, 5);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"], "a failed snapshot does not block the queue");
});
