// The pi session's starter: with an orchestrator running (its lock held) nothing is scanned; without one, the first
// unfinished, not-held workflow (any session's) starts it, and the scan stops there.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../src/kernel/journal.ts";
import { OsLock } from "../../../src/platform/lock.ts";
import { journalPath, orchInbox, orchLedger, orchLock } from "../../../src/paths.ts";
import { scanInbox } from "../../../src/kernel/mailbox.ts";
import { JT } from "../../../src/types.ts";
import { unfinishedWorkflow } from "../../../src/agent/main/snapshots.ts";
import { registerMain } from "../../../src/agent/main.ts";

const root = mkdtempSync(join(tmpdir(), "dsa-starter-"));
const saved = { HOME: process.env.HOME, DSA_HOME: process.env.DSA_HOME, DSA_SCOPE: process.env.DSA_SCOPE, DSA_ORCHESTRATOR_ENTRY: process.env.DSA_ORCHESTRATOR_ENTRY, DSA_SESSION: process.env.DSA_SESSION };
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});
process.env.HOME = root; process.env.DSA_SCOPE = "off";
// A stand-in orchestrator: it only records that it was started.
const entry = join(root, "fake-orchestrator.mjs");
writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.DSA_HOME + "/launched", "1");\n`);
process.env.DSA_ORCHESTRATOR_ENTRY = entry;

const A = "main:00000000-0000-7000-8000-00000000000a", B = "main:00000000-0000-7000-8000-00000000000b";
async function append(path: string, type: string, fields: Record<string, unknown>) {
  const j = await openJournal(path); try { await j.append(type, fields); } finally { await j.close(); }
}
/** A workflow as the engine writes it; `journal: "dir"` makes its journal unreadable, `done` finishes it. */
async function create(home: string, wid: string, origin: string, opts: { done?: boolean; journal?: "dir" } = {}) {
  const rid = `rid-${wid}`;
  await append(orchLedger(home), "create-intent", { rid, wid, origin, cwd: root });
  if (opts.journal === "dir") mkdirSync(journalPath(home, wid), { recursive: true });
  else {
    const j = await openJournal(journalPath(home, wid));
    await j.append("wf-created", { rid, origin, cwd: root, revision: 1 });
    if (opts.done) await j.append(JT.done, { status: "done", result: 1 });
    await j.close();
  }
  await append(orchLedger(home), JT.created, { rid, wid, origin });
}
let n = 0;
const fresh = () => { const home = join(root, `home-${++n}`); mkdirSync(home, { recursive: true }); return home; };

/** Starts a pi session (the extension's session_start, which runs the starter), then shuts it down for `reason`.
 *  Returns the notes the session showed. */
async function session(home: string, origin = A, reason = "reload"): Promise<string[]> {
  process.env.DSA_HOME = home;
  const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>(), notes: string[] = [];
  registerMain({ on: (name: string, fn: (event: unknown, ctx?: unknown) => Promise<unknown>) => hooks.set(name, fn), registerTool() {},
    sendMessage(message: { content: string }) { notes.push(message.content); } } as never);
  const ctx = { hasUI: false, isIdle: () => false, cwd: root, sessionManager: { getSessionId: () => origin.slice(5), getEntries: () => [], getSessionFile: () => undefined, getLeafId: () => null } };
  try { await hooks.get("session_start")!({}, ctx); }
  finally { await hooks.get("session_shutdown")!({ reason }); }
  return notes;
}
async function launched(home: string, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (existsSync(join(home, "launched"))) return true; await delay(25); }
  return false;
}

test("unfinishedWorkflow stops at the first unfinished workflow and skips held ones without reading them", async () => {
  const home = fresh();
  await create(home, "W01", B, { journal: "dir" }); // unreadable, older
  await create(home, "W02", B, { done: true });
  await create(home, "W03", A);                     // unfinished, newest
  assert.equal(unfinishedWorkflow(home), true, "the newest unfinished one decides; older journals are not read");
  const held = fresh();
  await create(held, "W01", A, { done: true });
  await create(held, "W02", B, { journal: "dir" });
  await append(orchLedger(held), "drain", { origin: B });
  assert.equal(unfinishedWorkflow(held), false, "a held workflow is skipped without reading its journal");
  const done = fresh();
  await create(done, "W01", A, { done: true }); await create(done, "W02", B, { done: true });
  assert.equal(unfinishedWorkflow(done), false);
  assert.equal(unfinishedWorkflow(done), false, "unchanged journals are decided again without reading them");
  const j = await openJournal(journalPath(done, "W01"));
  await j.append("generation", { pos: 0, key: "k", gen: 2, spec: { agent: "worker", task: "more" } }); await j.close();
  assert.equal(unfinishedWorkflow(done), true, "a follow-up generation on a finished workflow is pending work");
});

test("starter: with an orchestrator holding its lock, no workflow journal is read and nothing is started", async () => {
  const home = fresh();
  await create(home, "W01", B, { journal: "dir" });
  await create(home, "W02", "cli:host:1", { journal: "dir" });
  const lock = await new OsLock().tryAcquire(orchLock(home));
  assert.ok(lock);
  try { await session(home); }
  finally { await lock.release(); }
  assert.equal(await launched(home, 300), false);
});

test("starter: without an orchestrator, an unfinished foreign or own workflow starts one; finished work does not", async () => {
  const foreign = fresh();
  await create(foreign, "W01", B);
  await session(foreign);
  assert.equal(await launched(foreign), true, "another session's unfinished workflow");
  const own = fresh();
  await create(own, "W01", B, { done: true }); await create(own, "W02", A);
  await session(own);
  assert.equal(await launched(own), true, "this session's unfinished workflow");
  const idle = fresh();
  await create(idle, "W01", B, { done: true }); await create(idle, "W02", A, { done: true });
  await session(idle);
  assert.equal(await launched(idle, 500), false, "nothing pending");
});

test("quit pause: the start notice names this session's paused workflows; a quit drains only when one of its own runs", async () => {
  const home = fresh();
  await create(home, "W01", A);                     // A's, live, held below
  await create(home, "W02", B);                     // B's, live, held below
  await create(home, "W03", A, { done: true });
  await append(orchLedger(home), "drain", { fence: true, origin: A });
  await append(orchLedger(home), "drain", { fence: true, origin: B });
  const lock = await new OsLock().tryAcquire(orchLock(home)); // an orchestrator runs: the starter stays out of the way
  assert.ok(lock);
  try {
    const notes = await session(home, A, "quit");
    assert.equal(notes.filter(n => /paused when pi quit/.test(n)).length, 1);
    assert.match(notes.find(n => /paused when pi quit/.test(n))!, /^1 subagent workflow was paused when pi quit \(W01\)/);
    assert.deepEqual((await scanInbox(orchInbox(home))).filter(r => r.kind === "drain"), [], "nothing of A's runs: no drain");
    const running = fresh();
    await create(running, "W01", A); await create(running, "W02", B, { done: true });
    const held = await new OsLock().tryAcquire(orchLock(running));
    try {
      assert.deepEqual((await session(running, A, "quit")).filter(n => /paused when pi quit/.test(n)), []);
      const drains = (await scanInbox(orchInbox(running))).filter(r => r.kind === "drain");
      assert.deepEqual(drains.map(r => [r.from, r.body]), [[A, { fence: true, origin: A }]]);
    } finally { await held?.release(); }
  } finally { await lock.release(); }
});

test("R3: a held workflow with a started, unsealed command call is pending work (starter and CLI start); sealed, it is not", async () => {
  const { pendingWork } = await import("../../../src/cli/control.ts");
  // The ledger attributes the held workflow (W01), and one whose journal names its origin only itself (W02).
  for (const attributed of [true, false]) {
    const home = fresh();
    if (attributed) await create(home, "W01", B);
    else { // no ledger `created`: the journal's own `created` entry names its origin
      await append(journalPath(home, "W01"), JT.created, { rid: "rid-W01", wid: "W01", origin: B });
      await append(journalPath(home, "W01"), "wf-created", { rid: "rid-W01", origin: B, cwd: root, revision: 1 });
    }
    await append(orchLedger(home), "drain", { origin: B });
    const path = journalPath(home, "W01");
    await append(path, "call", { pos: 0, key: "k", gen: 1, spec: { command: ["sleep", "100"] } });
    assert.equal(unfinishedWorkflow(home), false, `held, not started: waits for resume (attributed: ${attributed})`);
    assert.equal(await pendingWork(home), false);
    await append(path, "command-intent", { call: "W01@1/k@1", id: "command:W01@1/k@1#1", n: 1 });
    assert.equal(unfinishedWorkflow(home), true, `started command under a hold (attributed: ${attributed})`);
    assert.equal(await pendingWork(home), true);
    if (attributed) { await session(home, A); assert.ok(await launched(home), "the pi session's starter starts the orchestrator"); }
    await append(path, "command-started", { id: "command:W01@1/k@1#1", pid: 1, start: "1", dir: "/x" });
    await append(path, JT.sealed, { call: "W01@1/k@1", result: { key: "k", gen: 1, status: "ok", ok: true, output: "" } });
    assert.equal(unfinishedWorkflow(home), false, "sealed: held work again");
    assert.equal(await pendingWork(home), false);
  }
});

test("F4: a held workflow is pending only for a live command attempt: a withdrawn intent is not", async () => {
  const { pendingWork } = await import("../../../src/cli/control.ts");
  // (a) Close after the intent and before the spawn: command-withdrawn; nothing runs.
  const a = fresh();
  await create(a, "W01", B);
  await append(orchLedger(a), "drain", { origin: B });
  const pa = journalPath(a, "W01"), id = "command:W01@1/k@1#1";
  await append(pa, "call", { pos: 0, key: "k", gen: 1, spec: { command: ["sleep", "100"] } });
  await append(pa, "command-intent", { call: "W01@1/k@1", id, n: 1 });
  assert.equal(unfinishedWorkflow(a), true, "intent: live");
  await append(pa, "command-withdrawn", { call: "W01@1/k@1", id });
  assert.equal(unfinishedWorkflow(a), false, "withdrawn: no live attempt");
  assert.equal(await pendingWork(a), false);
  // A later start decides again: a new intent with the same id is live again.
  await append(pa, "command-intent", { call: "W01@1/k@1", id, n: 1 });
  assert.equal(unfinishedWorkflow(a), true, "a new intent after the withdrawal is live");
});

test("F4: a running command retired by revise, the new revision done, then a drain: not pending work", async () => {
  const { pendingWork } = await import("../../../src/cli/control.ts");
  const id = "command:W01@1/k@1#1";
  const b = fresh();
  await create(b, "W01", B);
  const pb = journalPath(b, "W01");
  await append(pb, "call", { pos: 0, key: "k", gen: 1, spec: { command: ["sleep", "100"] } });
  await append(pb, "command-intent", { call: "W01@1/k@1", id, n: 1 });
  await append(pb, "command-started", { call: "W01@1/k@1", id, pid: 1, start: "1", dir: "/x" });
  await append(pb, "revised", { revision: 2, rid: "rev-2" });
  await append(pb, "retired", { call: "W01@1/k@1" });
  await append(pb, JT.done, { status: "done", result: 1 });
  await append(orchLedger(b), "drain", { origin: B });
  assert.equal(unfinishedWorkflow(b), false, "retired: not a reason to start an orchestrator");
  assert.equal(await pendingWork(b), false);
});
