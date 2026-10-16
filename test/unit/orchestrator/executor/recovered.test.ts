// A sealed or retired call whose recovery ran to its end gets a `recovered` receipt; a later start does not read it again
// while the receipt is current and nothing concerns the call since.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callInbox, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type Entry, type JournalHandle, type ProcInfo } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { sessionReads } from "../../../../src/orchestrator/executor/session.ts";
import { RECOVERED, RECOVERY_VERSION, completeCalls, concernedCalls, concerns } from "../../../../src/orchestrator/executor/recovered.ts";

const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };
const containment: Containment = {
  async spawn() { const s = new PassThrough(); s.end(); return { pid: 0, start: "", stdin: new PassThrough(), stdout: s, stderr: s, exited: Promise.resolve({ code: 0, signal: null }) }; },
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
  async fence() {},
};
const lines = (rows: unknown[]) => rows.map(l => JSON.stringify(l)).join("\n") + "\n";
const message = (id: string) => ({ type: "message", message: { role: "assistant", id, content: [{ type: "text", text: "x" }], usage: { input: 1, output: 1, cost: { total: 0 } } } });

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-recovered-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, exec = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec } }, message("m1")]));
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "task" } });
  await journal.append(JT.exec, { call, exec });
  await journal.append(JT.fenced, { exec });
  await journal.append(JT.sealed, { call, exec, result: { key: "a", gen: 1, status: "ok", ok: true, output: "" } });
  const executors: ReturnType<typeof createExecutor>[] = [];
  t.after(async () => { for (const e of executors) await e.shutdown(); await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  /** One orchestrator start's recovery of this workflow (a fresh executor each time); returns the session reads made. */
  const recover = async (options?: { batch: boolean }) => {
    const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 } } }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
    executors.push(executor);
    const before = sessionReads();
    const counts = await executor.recover(wid, journal, options);
    return { reads: sessionReads() - before, counts, executor };
  };
  const usage = () => journal.entries().filter(e => e.type === "usage" && e.call === call).map(e => String(e.id));
  const receipts = () => journal.entries().filter(e => e.type === RECOVERED && e.call === call);
  return { home, wid, orch, journal, call, exec, session, recover, usage, receipts };
}

test("a sealed call with a current receipt is not read again; a later concerning entry or an older version makes recovery read and repair it", async t => {
  const f = await fixture(t);
  const first = await f.recover();
  assert.ok(first.reads >= 1, "no receipt: read as before");
  assert.deepEqual(first.counts, { calls: 1, skipped: 0 });
  assert.deepEqual(f.usage(), ["m1"]);
  assert.deepEqual(f.receipts().map(e => e.v), [RECOVERY_VERSION]);
  const length = f.journal.entries().length;
  // Something only a read would find (a session line appended after the seal): not seen while the receipt holds.
  await appendFile(f.session, lines([message("m2")]));
  const second = await f.recover();
  assert.equal(second.reads, 0); assert.deepEqual(second.counts, { calls: 0, skipped: 1 });
  assert.equal(f.journal.entries().length, length, "nothing appended for a recovered call (the receipt is idempotent)");
  // An entry that concerns the call after its receipt: read and repaired again, one new receipt.
  await f.journal.append("pending-note", { rid: "n1", call: f.call, key: "a", message: "later" });
  const third = await f.recover();
  assert.ok(third.reads >= 1); assert.deepEqual(third.counts, { calls: 1, skipped: 0 });
  assert.deepEqual(f.usage(), ["m1", "m2"]);
  assert.equal(f.receipts().length, 2);
  assert.equal((await f.recover()).reads, 0);
  // A receipt of an older recovery version does not count.
  await f.journal.append(RECOVERED, { call: f.call, v: RECOVERY_VERSION - 1 });
  await appendFile(f.session, lines([message("m3")]));
  assert.ok((await f.recover()).reads >= 1);
  assert.deepEqual(f.usage(), ["m1", "m2", "m3"]);
  assert.equal(f.receipts().at(-1)!.v, RECOVERY_VERSION);
  assert.equal((await f.recover()).reads, 0);
});

test("a crash between the seal and its post-seal work recovers fully and appends the receipt once", async t => {
  const f = await fixture(t);
  // Cut off after the seal: a notify forward never received, an open question item and an envelope left in the inbox.
  await f.journal.append("forward", { rid: "n1", rid2: "n1-2", dest: f.call, hash: "h", envelope: { to: f.call, kind: "notify", body: { message: "late" } } });
  await f.journal.append(JT.attention, { item: { id: `q:${f.call}:q1`, rev: 1, kind: "question", text: "?", wid: f.wid, call: f.call, qid: "q1" } });
  const inbox = callInbox(f.home, f.wid, "a", 1);
  await mkdir(inbox, { recursive: true }); await writeFile(join(inbox, "left.json"), "{}");
  await f.recover();
  const types = (e: Entry) => e.type;
  const after = f.journal.entries().slice(6).map(types);
  assert.deepEqual(after.filter(t => t !== "usage"), ["pending-note", "forward-retired", JT.attentionResolved, RECOVERED]);
  assert.deepEqual(await readdir(inbox), [], "inbox cleaned before the receipt");
  const length = f.journal.entries().length;
  assert.equal((await f.recover()).reads, 0);
  assert.equal(f.journal.entries().length, length);
  assert.equal(f.receipts().length, 1);
});

test("a batched recovery records receipts only in finishRecovery, after the inbox cleanup", async t => {
  const f = await fixture(t);
  const inbox = callInbox(f.home, f.wid, "a", 1);
  await mkdir(inbox, { recursive: true }); await writeFile(join(inbox, "left.json"), "{}");
  const { executor, counts } = await f.recover({ batch: true });
  assert.deepEqual(counts, { calls: 1, skipped: 0 });
  assert.equal(f.receipts().length, 0); assert.deepEqual(await readdir(inbox), ["left.json"]);
  await executor.finishRecovery!();
  assert.equal(f.receipts().length, 1); assert.deepEqual(await readdir(inbox), []);
  assert.equal(executor.recovered!(f.journal, f.call), true);
  // A writer lock still held by the call: recovery is not complete for the engine.
  await f.orch.append("writer-hold", { root: "/repo", call: f.call });
  assert.equal(executor.recovered!(f.journal, f.call), false);
});

test("concerns: any field naming the call, its executions, attention ids, forwards to it and generations of its key", () => {
  const wid = "W", call = `${wid}@1/a@1`, other = `${wid}@1/b@1`;
  const entry = (type: string, fields: Record<string, unknown>) => ({ seq: 1, ts: 0, type, ...fields }) as Entry;
  const forwards = new Map([["r2", call]]);
  const yes = [entry("usage", { call, id: "x" }), entry(JT.fenced, { exec: `${call}#1.2` }), entry("forward", { dest: call }),
    entry("stop-requested", { rid: "s", call }), entry("x", { target: call }), entry("generation", { key: "a", gen: 2, from: call }),
    entry("generation", { key: "a", gen: 3, from: `${wid}@1/a@2` }), entry(JT.attention, { item: { id: `writer:${call}`, call } }),
    entry(JT.attentionResolved, { id: `q:${call}:q1`, rev: 1 }), entry(JT.attentionResolved, { id: `worktree:${other}|${call}` }),
    entry("forward-retired", { rid: "r", rid2: "r2" }), entry("wrote", { exec: `${other}#1.1`, after: [call] })];
  for (const e of yes) assert.equal(concerns(e, call, rid2 => forwards.get(rid2)), true, JSON.stringify(e));
  const no = [entry("usage", { call: other }), entry(JT.sealed, { call: `${wid}@1/a@10` }), entry(RECOVERED, { call, v: 1 }),
    entry("forward-retired", { rid2: "other" }), entry("ev", { n: 3 }), entry("usage", { call: `V@1/a@1` }), entry("generation", { key: "b", gen: 2, from: other })];
  for (const e of no) assert.equal(concerns(e, call, rid2 => forwards.get(rid2)), false, JSON.stringify(e));
  assert.deepEqual([...concernedCalls(entry("x", { a: call, b: [other] }), wid, new Set([call, other, `${wid}@1/c@1`]))].sort(), [call, other]);
});

test("completeCalls reads only entries after the earliest current receipt and follows appends", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-complete-"));
  const journal: JournalHandle = await openJournal(join(home, "j.jsonl"));
  t.after(async () => { await journal.close(); await rm(home, { recursive: true, force: true }); });
  const a = "W@1/a@1", b = "W@1/b@1";
  await journal.append(RECOVERED, { call: a, v: RECOVERY_VERSION });
  await journal.append("usage", { call: b, id: "1" });
  await journal.append(RECOVERED, { call: b, v: RECOVERY_VERSION });
  assert.deepEqual([...completeCalls(journal, "W")].sort(), [a, b]);
  await journal.append("forward", { dest: a, rid2: "x" });
  assert.deepEqual([...completeCalls(journal, "W")], [b]);
  await journal.append(RECOVERED, { call: a, v: RECOVERY_VERSION });
  await journal.append("forward-retired", { rid2: "x" });
  assert.deepEqual([...completeCalls(journal, "W")], [b], "a forward-retired of a forward to the call concerns it");
});

test("a settled journal opened lazily is recovered without decoding; the sweep still scans its tracked identities", async t => {
  const f = await fixture(t);
  await f.journal.append("tracked", { exec: f.exec, pid: 4242, start: "77" });
  await f.journal.append("tracked", { exec: f.exec, pid: 4242, start: "77" });
  await f.recover();
  const { journalExpectation, openLazyJournal } = await import("../../../../src/kernel/journal.ts");
  const { sweepSeed } = await import("../../../../src/orchestrator/executor/sweep.ts");
  const seed = sweepSeed(f.journal), expect = journalExpectation(f.journal)!;
  assert.deepEqual(seed, [{ exec: f.exec, call: f.call, tracked: ["4242 77"] }]);
  const lazy = (await openLazyJournal(f.journal.path, expect))!;
  const scans: ReadonlyMap<string, readonly ProcInfo[]>[] = [];
  const watching: Containment = { ...containment, async scan(known) { scans.push(known); return new Map([...known.keys()].map(exec => [exec, []])); } };
  const executor = createExecutor({ home: f.home, orch: f.orch, config: {} }, { effects, containment: watching, memory: async () => 1e6, sweepMs: 20 });
  t.after(async () => { await executor.shutdown(); await lazy.close(); });
  const before = sessionReads();
  assert.deepEqual(await executor.recover(f.wid, lazy, { batch: true, settled: { calls: 1, sweep: seed } }), { calls: 0, skipped: 1 });
  await executor.finishRecovery!();
  for (let i = 0; i < 200 && !scans.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(sessionReads(), before);
  assert.deepEqual(scans[0]?.get(f.exec), [{ pid: 4242, ppid: 0, start: "77" }]);
  assert.equal(lazy.loaded, false, "neither recovery nor the sweep decoded it");
});
