import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession } from "../../../../src/paths.ts";
import { observeExecution, sessionChanged } from "../../../../src/orchestrator/executor/observe.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";

test("watcher accepts session and inbox growth and ignores live/temp traffic", () => {
  for (const name of [null, "session.jsonl", "inbox", Buffer.from("session.jsonl")]) assert.equal(sessionChanged(name), true);
  for (const name of ["live.json", "live.json.tmp", ".live.json.123.tmp", "stderr.log", "session.jsonl.tmp"]) assert.equal(sessionChanged(name), false);
});

test("watch notifications read session growth promptly without process-table scans", { timeout: 5000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-watch-")), wid = ulid(), journal = await openJournal(join(home, "journal"));
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal,
    spec: { agent: "test", task: "test" }, agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } };
  const dir = callDir(home, wid, "a", 1); await mkdir(dir, { recursive: true });
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough(), ready = deferred(), changed = deferred();
  let wake = () => {}, scans = 0, reads = 0;
  const running = observeExecution({ home, config: {}, ticket, exec: `${ticket.callId}#1.1`,
    child: { pid: 1, start: "fixture", stdin, stdout, stderr, exited: new Promise(() => {}) },
    serial: fn => fn(), setWake: fn => { wake = fn; ready.resolve(); }, interrupted: () => false,
    track: async () => { scans++; return []; }, fence: async () => {},
    questions: async () => { reads++; changed.resolve(); }, recordUsage: async () => {}, switched: async () => {}, pendingSwitch: () => undefined });
  t.after(async () => { wake(); await running; stdout.destroy(); stdin.destroy(); stderr.destroy(); await journal.close(); await rm(home, { recursive: true, force: true }); });
  await ready.promise;
  await writeFile(join(dir, "live.json"), "{}"); await writeFile(join(dir, "live.json.tmp"), "{}");
  await delay(40); assert.equal(reads, 0); assert.equal(scans, 0);
  await Promise.all(Array.from({ length: 10 }, () => appendFile(callSession(home, wid, "a", 1), "{}\n")));
  await Promise.race([changed.promise, delay(500).then(() => { throw new Error("Session notification was not prompt"); })]);
  assert.equal(scans, 0); assert.equal(reads, 1, "a session notification burst is coalesced");
});

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

test("each scan records only the usage appended since the previous one; a restarted list is recorded again", { timeout: 10000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-observe-usage-")), wid = ulid(), journal = await openJournal(join(home, "journal"));
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal,
    spec: { agent: "test", task: "test" }, agent: { name: "test", description: "test", body: "test", sourcePath: "fixture", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false } };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough(), ready = deferred();
  const u = (id: string) => ({ id, usage: { input: 1, output: 1, costUsd: 0 } });
  let list = [u("1"), u("2")], wake = () => {};
  const recorded: string[][] = [];
  const running = observeExecution({ home, config: { k: { trackerMs: 20 } }, ticket, exec: `${ticket.callId}#1.1`,
    child: { pid: 1, start: "fixture", stdin, stdout, stderr, exited: new Promise(() => {}) },
    serial: fn => fn(), setWake: fn => { wake = fn; ready.resolve(); }, interrupted: () => false,
    track: async () => [], fence: async () => {}, questions: async () => {}, usage: () => list,
    recordUsage: async values => { if (values.length) recorded.push(values.map(v => v.id)); }, switched: async () => {}, pendingSwitch: () => undefined });
  t.after(async () => { wake(); await running; stdout.destroy(); stdin.destroy(); stderr.destroy(); await journal.close(); await rm(home, { recursive: true, force: true }); });
  await ready.promise;
  // A large tool update is activity evidence without being parsed; it changes nothing recorded.
  stdout.write(`{"type":"tool_execution_update","toolCallId":"t","partialResult":"${"x".repeat(10000)}"}\n`);
  await delay(100);
  list.push(u("3"));
  await delay(100);
  list = [u("1"), u("2"), u("3")]; // a session read from scratch: a new list
  await delay(100);
  assert.deepEqual(recorded, [["1", "2"], ["3"], ["1", "2", "3"]]);
  assert.equal(journal.entries().some(e => e.type === "observation"), false);
});
