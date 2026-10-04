import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { Containment } from "../../../../src/platform/containment.ts";
import { skipLostCandidate, sweepExecutions } from "../../../../src/orchestrator/executor/sweep.ts";
import { JT } from "../../../../src/types.ts";

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
