import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession } from "../../../../src/paths.ts";
import { observeExecution } from "../../../../src/orchestrator/executor/observe.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("P18 a scan completing after received ask start never charges the ask interval", { timeout: 5000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-observe-")), wid = ulid();
  const journal = await openJournal(join(home, "journal"));
  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal,
    spec: { agent: "test", task: "test", timeoutMs: 150 },
    agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
  };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
  const ready = deferred(), scanning = deferred(), release = deferred(), applied = deferred();
  let wake = () => {};
  const running = observeExecution({
    home, config: { k: { trackerMs: 10 } }, ticket, exec: `${ticket.callId}#1.1`,
    child: { pid: 1, start: "fixture", stdin, stdout, stderr, exited: new Promise(() => {}) },
    serial: fn => fn(), setWake: fn => { wake = fn; ready.resolve(); }, interrupted: () => false,
    track: async () => { scanning.resolve(); await release.promise; return [{ pid: 1, ppid: 0, start: "fixture", cpuMs: 100 }]; },
    fence: async () => {}, questions: async () => { applied.resolve(); }, recordUsage: async () => {}, switched: async () => {}, pendingSwitch: () => undefined,
  });
  t.after(async () => {
    release.resolve(); wake(); await running;
    stdout.destroy(); stdin.destroy(); stderr.destroy(); await journal.close(); await rm(home, { recursive: true, force: true });
  });
  await ready.promise;
  stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "bash" }) + "\n");
  await scanning.promise;
  // The RPC event arrives while track() is suspended, before its CPU and file-growth evidence.
  stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "ask", toolCallId: "ask" }) + "\n");
  await appendFile(callSession(home, wid, "a", 1), JSON.stringify({ type: "custom", customType: "dsa-question", data: { qid: "q", rev: 1 } }) + "\n");
  await delay(300);
  release.resolve(); await applied.promise;
  wake(); await running;
  assert.ok(journal.entries().some(e => e.type === "observation" && (e.event as { toolName?: string }).toolName === "ask"));
  assert.equal(journal.entries().some(e => e.type === "timeout-intent"), false);
  const active = Number(journal.entries().findLast(e => e.type === "time")!.active);
  assert.ok(active < ticket.spec.timeoutMs!, `ask interval incorrectly charged: ${active}ms`);
});
