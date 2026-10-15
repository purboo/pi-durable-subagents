import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, type Containment, type Spawned } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { compactWorkflow, snapshotFromEntries } from "../../../../src/orchestrator/snapshot.ts";
import { renderStatus, renderView } from "../../../../src/cli/main.ts";

async function fixture(t: TestContext, pool: boolean, marker: boolean, virtual = false) {
  const home = await mkdtemp(join(tmpdir(), "dsa-model-guard-")), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const children = new Map<string, Spawned & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }>(), launched: string[] = [];
  const containment: Containment = {
    async scan() { return new Map(); },
    async fence(exec) { const child = children.get(exec); child?.stdout.end(); child?.stderr.end(); },
    async spawn(spec) {
      launched.push(spec.env!.DSA_MODEL!);
      const selected = spec.env!.DSA_MODEL!.split("/")[0]!, wrong = selected === "p";
      const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
      const child = { pid: 0, start: "", stdin, stdout, stderr, exited: new Promise<{ code: number; signal: null }>(resolve => stdout.once("end", () => resolve({ code: 0, signal: null }))) };
      children.set(spec.exec, child);
      const entries = [
        { type: "custom", customType: CT.exec, data: { exec: spec.exec } },
        { type: "model_change", provider: selected, modelId: "m" },
        ...(!wrong || virtual ? [{ type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok", data: { continued: true } } }] : []),
      ];
      const session = callSession(home, wid, "a", 1);
      const old = await readFile(session, "utf8").catch(() => "");
      await writeFile(session, old + entries.map(e => JSON.stringify(e)).join("\n") + "\n");
      setImmediate(() => {
        if (virtual) stdout.write(JSON.stringify({ type: CT.modelReady, exec: spec.exec, selected: { provider: "p", id: "m" }, model: { provider: "p", id: "m" }, virtual: true }) + "\n");
        if (wrong && marker && !virtual) stdout.write(JSON.stringify({ type: CT.modelUnavailable, exec: spec.exec, selected: { provider: "p", id: "m" }, actual: { provider: "default", id: "other" }, reason: "no auth for provider p" }) + "\n");
        else stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant", provider: wrong ? "default" : "q", model: wrong ? "other" : "m" } }) + "\n");
        // Queued events after the refusal must not become work/usage evidence.
        if (wrong && !virtual) stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "write", toolCallId: "forbidden", args: { path: "forbidden" } }) + "\n");
        stdout.write('{"type":"agent_settled"}\n');
      });
      return child;
    },
  };
  const executor = createExecutor({ home, orch, config: { writerLock: "off", pools: pool ? { pool: ["p/m", "q/m"] } : undefined, k: { trackerMs: 10 } } },
    { containment, memory: async () => 1e6, effects: { prepare: async () => ({ cwd: home }), beforeSeal: async (_t, _e, r) => r, afterSeal: async () => {}, recover: async () => {} } });
  t.after(async () => { await executor.shutdown(); for (const child of children.values()) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal, spec: { agent: "test", task: "work", model: pool ? "pool" : "p/m" },
    agent: { name: "test", description: "", body: "", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await journal.append("call", { key: "a", gen: 1, spec: ticket.spec });
  return { home, wid, orch, journal, executor, ticket, launched };
}

test("a virtual selection accepts physical answers and reports routing without mismatch", { timeout: 10000 }, async t => {
  const f = await fixture(t, false, false, true), result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok"); assert.deepEqual(f.launched, ["p/m"]);
  assert.equal(f.journal.entries().find(e => e.type === "model-ready")?.virtual, true);
  assert.equal(f.journal.entries().some(e => e.type === "model-unavailable" || e.type === "loss"), false);
  const snap = snapshotFromEntries(f.wid, f.journal.entries()), c = snap.calls[0]!, compact = compactWorkflow(snap);
  assert.equal(c.selectedModel, "p/m"); assert.equal(c.routedModel, "default/other"); assert.equal(c.modelMismatch, undefined);
  assert.equal(compact.calls[0]!.routedModel, "default/other");
  assert.match(renderStatus(snap), /routed default\/other/);
  assert.match(renderView({ workflows: [compact] }), /routed default\/other/);
  assert.doesNotMatch(renderStatus(snap), /used .*selected|model-unavailable/);
  // The virtual exemption belongs to one execution only.
  const next = `${f.ticket.callId}#1.2`;
  await f.journal.append("exec", { call: f.ticket.callId, exec: next });
  await f.journal.append("selected", { exec: next, model: { provider: "q", id: "m" } });
  await f.journal.append("model-used", { exec: next, model: { provider: "default", id: "other" } });
  const physical = snapshotFromEntries(f.wid, f.journal.entries()).calls[0]!;
  assert.equal(physical.routedModel, undefined);
  assert.deepEqual(physical.modelMismatch, { used: "default/other", selected: "q/m" });
});

for (const marker of [true, false]) for (const pool of [true, false]) test(`model-unavailable: ${marker ? "launch receipt" : "unexpected answering model"}, ${pool ? "pool failover" : "explicit failure"}`, { timeout: 10000 }, async t => {
  const f = await fixture(t, pool, marker), result = await f.executor.run(f.ticket);
  assert.equal(result.status, pool ? "ok" : "failed");
  assert.deepEqual(f.launched, pool ? ["p/m", "q/m"] : ["p/m"]);
  const failure = f.journal.entries().find(e => e.type === "model-unavailable")!;
  assert.ok(failure); assert.match(String(failure.reason), /selected p\/m, pi would use default\/other/);
  assert.ok(Number(failure.until) > Date.now());
  if (marker) assert.match(String(failure.reason), /no auth/);
  if (!pool) assert.match(result.error!, /model-unavailable:.*selected p\/m.*default\/other/);
  assert.equal(f.journal.entries().some(e => e.type === "wrote"), false);
  assert.equal(f.journal.entries().some(e => e.type === "observation" && (e.event as { toolCallId?: string }).toolCallId === "forbidden"), false);
  assert.equal(f.journal.entries().some(e => e.type === "loss"), false);
  const snap = snapshotFromEntries(f.wid, f.journal.entries()), compact = compactWorkflow(snap);
  assert.match(renderStatus(snap), /model-unavailable:/);
  assert.match(renderView({ workflows: [compact] }), /model-unavailable:/);
  if (!marker && !pool) {
    assert.deepEqual(snap.calls[0]!.modelMismatch, { used: "default/other", selected: "p/m" });
    assert.deepEqual(compact.calls[0]!.modelMismatch, snap.calls[0]!.modelMismatch);
    assert.match(renderStatus(snap), /used default\/other, selected p\/m/);
    assert.match(renderView({ workflows: [compact] }), /used default\/other, selected p\/m/);
  }
});
