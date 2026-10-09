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
import { observeExecution, toolCommand } from "../../../../src/orchestrator/executor/observe.ts";
import { evidence, fatalProviderError, quotaExhausted } from "../../../../src/orchestrator/executor/session.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";

/** The tracker runs on a 5 ms timer; a loaded machine (the full suite, a shared CI runner) can need seconds to observe:
 * a 3 s wait inside a 5 s test limit failed once on a slow CI runner. Waits return as soon as the condition holds. */
async function eventually<T>(fn: () => T, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = fn(); if (value || Date.now() > deadline) return value; await delay(10); }
}
async function fixture(t: TestContext, stallMs = 600000) {
  let now = 0, wake = () => {}, ready!: () => void;
  t.mock.method(performance, "now", () => now);
  const home = await mkdtemp(join(tmpdir(), "dsa-progress-")), journal = await openJournal(join(home, "journal"));
  const ticket: CallTicket = { wid: "w", widRev: "w@1", key: "a", gen: 1, callId: "w@1/a@1", cwd: home, journal,
    spec: { agent: "test", task: "test" },
    agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } };
  await mkdir(callDir(home, "w", "a", 1), { recursive: true });
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = observeExecution({ home, config: { k: { trackerMs: 5, progressMs: 600000, stallMs } }, ticket, exec: `${ticket.callId}#1.1`,
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
] as const) test(`no-progress ignores ${source} and session growth, resolves and re-arms`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.grow(); await f.tick(600001, event);
  const first = (await eventually(() => f.alerts()[0]))!;
  assert.deepEqual(first.item, { id: "noprogress:w@1/a@1", rev: 1, kind: "stall", wid: "w", call: "w@1/a@1",
    text: "w/a: no new output or tool progress received for 10m; the model may still be processing; last provider error: " + ("quota exhausted " + "x".repeat(250)).slice(0, 200) });
  assert.equal(first.exec, "w@1/a@1#1.1"); assert.equal(first.horizon, 0);
  await f.tick(600002, { type: "message_update" });
  assert.ok(await eventually(() => f.journal.entries().some(e => e.type === JT.attentionResolved && e.id === "noprogress:w@1/a@1" && e.rev === 1 && e.resolution === "progress")));
  await f.tick(1200003, event); await eventually(() => f.alerts().length === 2);
  assert.deepEqual(f.alerts().map(e => (e.item as AttentionItem).rev), [1, 2]);
});

for (const toolName of ["bash", "ask"]) test(`no-progress waits for open ${toolName} and starts a fresh horizon on end`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.tick(1, { type: "tool_execution_start", toolCallId: "t", toolName });
  await f.tick(1200000, { type: "auto_retry_start", errorMessage: "529 overloaded" });
  assert.equal(f.alerts().length, 0);
  await f.tick(1200001, { type: "tool_execution_end", toolCallId: "t", toolName });
  await f.tick(1800000); assert.equal(f.alerts().length, 0);
  await f.tick(1800002); await eventually(() => f.alerts().length === 1); assert.equal(f.alerts().length, 1);
});

for (const event of [
  { type: "message_update" },
  { type: "tool_execution_update", toolCallId: "t", toolName: "bash" },
  { type: "message_end", message: { stopReason: "stop", usage: { output: 1 } } },
]) test(`no-progress accepts ${event.type} progress`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const time of [500000, 1000000, 1500000]) await f.tick(time, event);
  assert.equal(f.alerts().length, 0);
  await f.tick(2100001); await eventually(() => f.alerts().length === 1); assert.equal(f.alerts().length, 1);
});

test("stall text names the running tool command and how long it has run, not an ask", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.tick(1, { type: "tool_execution_start", toolCallId: "q", toolName: "ask", args: { question: "x" } });
  await f.tick(2, { type: "tool_execution_end", toolCallId: "q", toolName: "ask" });
  await f.tick(60000, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "make   fault-matrix\n  --all" } });
  await f.tick(60000 + 600001); await eventually(() => f.alerts("stall:").length);
  assert.equal((f.alerts("stall:")[0]!.item as AttentionItem).text, "w/a: no execution activity observed for 10m; running bash `make fault-matrix --all` for 10m (no output or CPU use seen)");
  assert.equal(toolCommand({ command: "x".repeat(200) }), "x".repeat(119) + "…");
  assert.equal(toolCommand({ path: "a.ts" }), '{"path":"a.ts"}');
  assert.equal(toolCommand(undefined), "");
});

test("silence emits one warning, thinking resolves it and a later silence re-arms it", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.tick(600001); assert.ok(await eventually(() => f.alerts().length));
  assert.equal(f.alerts("").length, 1);
  assert.match((f.alerts()[0]!.item as AttentionItem).text, /w\/a: no new output.*model may still be processing/);
  await f.tick(900001); assert.equal(f.alerts("").length, 1);
  await f.tick(900002, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private content" } });
  assert.ok(await eventually(() => f.journal.entries().some(e => e.type === JT.attentionResolved && e.resolution === "progress")));
  await f.tick(1500003); assert.ok(await eventually(() => f.alerts().length === 2));
  assert.equal(f.alerts("").length, 2);
  assert.deepEqual(f.alerts().map(e => (e.item as AttentionItem).rev), [1, 2]);
});

test("an earlier activity warning suppresses the later progress warning until recovery", { timeout: 30000 }, async t => {
  const f = await fixture(t, 300000);
  await f.tick(300001); assert.ok(await eventually(() => f.alerts("stall:").length));
  await f.tick(600001); assert.equal(f.alerts("").length, 1);
  await f.tick(600002, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
  assert.ok(await eventually(() => f.journal.entries().some(e => e.type === JT.attentionResolved && e.resolution === "activity")));
  await f.tick(1200003); assert.ok(await eventually(() => f.alerts().length));
  assert.equal(f.alerts("").length, 2);
  assert.equal((f.alerts()[0]!.lastStream as { type: string }).type, "thinking_delta");
});

for (const type of ["thinking_delta", "text_delta"]) test(`continuous ${type} avoids warnings and checkpoints metadata only`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const time of [500000, 1000000, 1500000]) await f.tick(time, { type: "message_update", assistantMessageEvent: { type, delta: "private content" } });
  assert.equal(f.alerts("").length, 0);
  const checkpoint = await eventually(() => f.journal.entries().findLast(e => e.type === "time" && e.lastStream));
  assert.ok(checkpoint);
  const metadata = checkpoint.lastStream as { type: string; receivedAt: number };
  assert.equal(metadata.type, type); assert.ok(metadata.receivedAt > 0);
  assert.deepEqual(Object.keys(metadata).sort(), ["receivedAt", "type"]);
  assert.equal(JSON.stringify(f.journal.entries()).includes("private content"), false);
});

test("provider evidence uses only the segment's last assistant error", () => {
  const receipt = { type: "custom", customType: "dsa-exec", data: { exec: "e" } };
  const error = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "402 insufficient_quota" } };
  assert.equal(evidence([receipt, error], "e").error, error.message.errorMessage);
  assert.equal(evidence([error, receipt], "e").error, undefined);
  assert.equal(evidence([receipt, error, { type: "message", message: { role: "assistant", stopReason: "stop" } }], "e").error, undefined);
  for (const text of ["402", "insufficient_quota", "insufficient balance", "insufficient funds", "billing disabled", "credit balance low", "余额不足"])
    assert.equal(fatalProviderError(text), true, text);
  for (const text of ["429 rate limit", "529 overloaded", "ECONNRESET", "timeout", "quota remaining: 42", "quota exceeded", "usage limit", "额度不足"])
    assert.equal(fatalProviderError(text), false, text);
  for (const text of ['503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}}', "You have reached your usage limit", "quota exceeded",
    "quota exhausted", "You exceeded your current usage quota", "5-hour limit reached ∙ resets 3pm", "额度已用完"])
    assert.equal(quotaExhausted(text), true, text);
  for (const text of ["429 rate limit", "Request timed out.", "Anthropic stream ended without a stop reason", "402 insufficient_quota", "quota remaining: 42",
    "You exceeded your current quota, please check your plan and billing details."])
    assert.equal(quotaExhausted(text), false, text);
});
