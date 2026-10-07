import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { callDir, callSession } from "../../../../src/paths.ts";
import { JT, type AttentionItem } from "../../../../src/types.ts";
import { observeExecution } from "../../../../src/orchestrator/executor/observe.ts";
import { evidence, fatalProviderError } from "../../../../src/orchestrator/executor/session.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";

async function fixture(t: TestContext) {
  let now = 0, wake = () => {}, ready!: () => void;
  t.mock.method(performance, "now", () => now);
  const home = await mkdtemp(join(tmpdir(), "dsa-progress-")), journal = await openJournal(join(home, "journal"));
  const ticket: CallTicket = { wid: "w", widRev: "w@1", key: "a", gen: 1, callId: "w@1/a@1", cwd: home, journal,
    spec: { agent: "test", task: "test" },
    agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } };
  await mkdir(callDir(home, "w", "a", 1), { recursive: true });
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = observeExecution({ home, config: { k: { trackerMs: 5, progressMs: 600000, stallMs: 600000 } }, ticket, exec: `${ticket.callId}#1.1`,
    child: { pid: 1, start: "fixture", stdin, stdout, stderr, exited: new Promise(() => {}) },
    serial: fn => fn(), setWake: fn => { wake = fn; ready(); }, interrupted: () => false, track: async () => [], fence: async () => {},
    questions: async () => {}, recordUsage: async () => {}, switched: async () => {}, pendingSwitch: () => undefined });
  t.after(async () => { wake(); await running; stdout.destroy(); stdin.destroy(); stderr.destroy(); await journal.close(); await rm(home, { recursive: true, force: true }); });
  await started;
  const tick = async (time: number, event?: object) => { now = time; if (event) stdout.write(JSON.stringify(event) + "\n"); await delay(40); };
  const alerts = (prefix = "noprogress:") => journal.entries().filter(e => e.type === JT.attention && (e.item as AttentionItem).id.startsWith(prefix));
  return { journal, tick, alerts, grow: () => appendFile(callSession(home, "w", "a", 1), '{"type":"custom"}\n') };
}

for (const [source, event] of [
  ["retry start", { type: "auto_retry_start", errorMessage: "quota exhausted " + "x".repeat(250) }],
  ["retry end", { type: "auto_retry_end", finalError: "quota exhausted " + "x".repeat(250) }],
  ["message error", { type: "message_end", message: { stopReason: "error", errorMessage: "quota exhausted " + "x".repeat(250), usage: { output: 99 } } }],
] as const) test(`no-progress ignores ${source} and session growth, resolves and re-arms`, { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.grow(); await f.tick(600001, event);
  const first = f.alerts()[0]!;
  assert.deepEqual(first.item, { id: "noprogress:w@1/a@1", rev: 1, kind: "stall", wid: "w", call: "w@1/a@1",
    text: "w/a: running but no progress for 10m (no output tokens or tool results); last provider error: " + ("quota exhausted " + "x".repeat(250)).slice(0, 200) });
  assert.equal(first.exec, "w@1/a@1#1.1"); assert.equal(first.horizon, 0);
  await f.tick(600002, { type: "message_update" });
  assert.ok(f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === "noprogress:w@1/a@1" && e.rev === 1 && e.resolution === "progress"));
  await f.tick(1200003, event);
  assert.deepEqual(f.alerts().map(e => (e.item as AttentionItem).rev), [1, 2]);
});

for (const toolName of ["bash", "ask"]) test(`no-progress waits for open ${toolName} and starts a fresh horizon on end`, { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.tick(1, { type: "tool_execution_start", toolCallId: "t", toolName });
  await f.tick(1200000, { type: "auto_retry_start", errorMessage: "529 overloaded" });
  assert.equal(f.alerts().length, 0);
  await f.tick(1200001, { type: "tool_execution_end", toolCallId: "t", toolName });
  await f.tick(1800000); assert.equal(f.alerts().length, 0);
  await f.tick(1800002); assert.equal(f.alerts().length, 1);
});

for (const event of [
  { type: "message_update" },
  { type: "tool_execution_update", toolCallId: "t", toolName: "bash" },
  { type: "message_end", message: { stopReason: "stop", usage: { output: 1 } } },
]) test(`no-progress accepts ${event.type} progress`, { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const time of [500000, 1000000, 1500000]) await f.tick(time, event);
  assert.equal(f.alerts().length, 0);
  await f.tick(2100001); assert.equal(f.alerts().length, 1);
});

test("stall text identifies the call", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.tick(600001);
  assert.equal((f.alerts("stall:")[0]!.item as AttentionItem).text, "w/a: no execution activity for 10m");
});

test("provider evidence uses only the segment's last assistant error", () => {
  const receipt = { type: "custom", customType: "dsa-exec", data: { exec: "e" } };
  const error = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "402 insufficient_quota" } };
  assert.equal(evidence([receipt, error], "e").error, error.message.errorMessage);
  assert.equal(evidence([error, receipt], "e").error, undefined);
  assert.equal(evidence([receipt, error, { type: "message", message: { role: "assistant", stopReason: "stop" } }], "e").error, undefined);
  for (const text of ["402", "insufficient_quota", "insufficient balance", "insufficient funds", "quota exceeded", "quota exhausted", "billing disabled", "credit balance low", "额度不足", "余额不足", "usage limit"])
    assert.equal(fatalProviderError(text), true, text);
  for (const text of ["429 rate limit", "529 overloaded", "ECONNRESET", "timeout", "quota remaining: 42"])
    assert.equal(fatalProviderError(text), false, text);
});
