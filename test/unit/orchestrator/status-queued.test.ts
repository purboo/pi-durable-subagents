import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../src/kernel/journal.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { compactWorkflow, snapshotFromEntries, statusBrief, workflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { main } from "../../../src/cli/main.ts";
import { deriveEntry } from "../../../src/events/derive.ts";
import { foldWaits, waitInput, waitsOf } from "../../../src/events/waiting.ts";
import { emptyLedger, foldLedger } from "../../../src/orchestrator/ledger.ts";
import { resultLines } from "../../../src/ui/tool.ts";
import { dockLines, orderWorkflows, statusPhrase, summary } from "../../../src/ui/view.ts";
import type { Entry } from "../../../src/types.ts";

const wid = "W", call = `${wid}@1/a@1`, exec = `${call}#1.1`;
const entry = (seq: number, type: string, fields: Record<string, unknown> = {}): Entry => ({ seq, ts: 1000 + seq, type, ...fields }) as Entry;
const item = { id: `q:${call}:q1`, rev: 1, kind: "question", text: "Choose?", wid, call, qid: "q1" };
const asked = [entry(1, "wf-created", { revision: 1, origin: "main:test" }), entry(2, "call", { key: "a", gen: 1, spec: { agent: "worker", model: "p/m" } }),
  entry(3, "exec", { call, exec }), entry(4, "selected", { exec, model: { provider: "p", id: "m" } }), entry(5, "attention", { item }),
  entry(6, "hibernated", { call, exec, qid: "q1", rev: 1 }), entry(7, "fenced", { exec })];
const bound = [...asked, entry(8, "answer-bound", { call, qid: "q1", rev: 1, rid: "answer", rid2: "bound-answer", message: "Answer: yes" })];

test("answered but queued: snapshots, brief, CLI and UI stop asking before resume", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-answered-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const journal = await openJournal(journalPath(home, wid));
  t.after(() => journal.close());
  for (const { seq: _s, ts: _t, type, ...fields } of bound) await journal.append(type, fields);
  const snap = workflowSnapshot(home, wid), c = snap.calls[0]!;
  assert.equal(c.phase, "queued"); assert.equal(c.answered, "q1"); assert.equal(c.hibernated, true);
  assert.deepEqual(snap.attention, []);
  assert.equal(compactWorkflow(snap).calls[0]!.answered, "q1");
  const brief = statusBrief(home).active[0]!;
  assert.equal(brief.calls[0]!.phase, "queued"); assert.equal(brief.calls[0]!.answered, "q1"); assert.equal(brief.calls[0]!.hibernated, true);
  assert.equal(brief.asking, undefined);
  assert.equal(statusPhrase(c, snap, undefined, 2000), "queued (answered, waiting for a slot)");
  assert.equal(summary([snap]).asking, 0); assert.equal(summary([snap]).queued, 1);
  assert.match(dockLines([snap], new Map(), () => "M", 120, 2000).join("\n"), /queued \(answered, waiting for a slot\)/);
  assert.match(resultLines({ wid, ...c })[0]!, /queued \(answered, waiting for a slot\)/);
  const lines: string[] = [];
  assert.equal(await main(["status", wid], { env: { DSA_HOME: home }, write: line => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /queued \(answered, waiting for a slot\)/);
  await journal.append("exec", { call, exec: `${call}#1.2` });
  const queued = workflowSnapshot(home, wid).calls[0]!;
  assert.equal(queued.phase, "queued"); assert.equal(queued.answered, "q1"); assert.equal(queued.hibernated, true);
  await journal.append("selected", { exec: `${call}#1.2`, model: { provider: "p", id: "m" } });
  const running = workflowSnapshot(home, wid).calls[0]!;
  assert.equal(running.phase, "running"); assert.equal(running.answered, undefined); assert.equal(running.hibernated, undefined);
  const resumed = snapshotFromEntries(wid, [...bound, entry(9, "resumed", { call, exec })]).calls[0]!;
  assert.equal(resumed.phase, "running"); assert.equal(resumed.answered, undefined); assert.equal(resumed.hibernated, undefined);
  const stopped = snapshotFromEntries(wid, [...bound, entry(9, "sealed", { call, result: { status: "stopped" } })]).calls[0]!;
  assert.equal(stopped.answered, undefined); assert.equal(stopped.hibernated, undefined);
  const recovered = snapshotFromEntries(wid, [...asked.slice(0, 5), asked[6]!, asked[5]!, bound.at(-1)!]).calls[0]!;
  assert.equal(recovered.phase, "queued"); assert.equal(recovered.answered, "q1"); assert.equal(recovered.hibernated, true);
  // A bound answer only closes the matching revision of the matching question.
  const newer = snapshotFromEntries(wid, [...bound, entry(9, "attention", { item: { ...item, rev: 2 } })]);
  assert.equal(newer.attention.length, 1); assert.equal(newer.calls[0]!.phase, "asking");
});

test("answer-bound clears asking in the waiting fold before a new execution exists", () => {
  const ledger = foldLedger(emptyLedger(), [entry(1, "config", { hash: "h", config: { providers: { p: { slots: 1 } } } }), entry(2, "hold", { pool: "p", exec: "other#1.1", slot: 0 })]);
  const env = { now: 2000, ledger }, f = foldWaits(wid, asked);
  assert.equal(waitInput(f, f.calls.get(call)!, env).asking, true);
  foldWaits(wid, bound, f);
  assert.equal(waitInput(f, f.calls.get(call)!, env).asking, false);
  assert.equal(waitsOf(f, env).get(call)?.reason, "slot");
  const next = [...bound, entry(9, "exec", { call, exec: `${call}#1.2` })];
  foldWaits(wid, next, f);
  assert.equal(waitsOf(f, env).get(call)?.reason, "slot");
  foldWaits(wid, [...next, entry(10, "fenced", { exec: `${call}#1.2` })], f);
  assert.equal(waitsOf(f, env).get(call), undefined, "a drained continuation has no live execution");
});

test("answer-bound emits answered once even when the child later resolves the question", () => {
  const rows = [...bound, entry(9, "attention-resolved", { id: item.id, rev: 1, resolution: "answered" })];
  const ledger = [entry(1, "request", { request: { rid: "answer", from: "main:test", body: { message: "yes" } } })];
  const events = rows.flatMap((_, i) => deriveEntry(wid, rows, i, ledger, {}));
  const answers = events.filter(e => e.type === "answered");
  assert.equal(answers.length, 1); assert.equal(answers[0]!.ts, bound.at(-1)!.ts);
  assert.equal((answers[0] as { length: number }).length, 3);
});

for (const status of ["done", "failed", "stopped"] as const) test(`finished run ${status}: live follow-up has active and leads the text`, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-followup-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const journal = await openJournal(journalPath(home, wid)), ledger = await openJournal(orchLedger(home));
  t.after(async () => { await journal.close(); await ledger.close(); });
  await ledger.append("created", { wid, rid: "run", origin: "main:test" });
  for (const [type, fields] of [["wf-created", { revision: 1, origin: "main:test" }], ["call", { key: "a", gen: 1 }],
    ["sealed", { call, result: { status: "ok", ok: true, output: "done" } }], ["workflow-done", { status }]] as const) await journal.append(type, fields);
  assert.equal(workflowSnapshot(home, wid).active, undefined);
  await journal.append("generation", { key: "a", gen: 2 });
  assert.equal(workflowSnapshot(home, wid).active, true, "queued follow-up is active");
  await journal.append("exec", { call: `${wid}@1/a@2`, exec: `${wid}@1/a@2#1.1` });
  await journal.append("selected", { exec: `${wid}@1/a@2#1.1`, model: { provider: "p", id: "m" } });
  const snap = workflowSnapshot(home, wid), brief = statusBrief(home).active[0]!;
  assert.equal(snap.status, status); assert.equal(snap.active, true); assert.equal(brief.active, true);
  assert.equal(compactWorkflow(snap).active, true);
  assert.match(resultLines({ active: [brief] })[0]!, new RegExp(`follow-up running \\(run ${status}\\)`));
  assert.match(resultLines(compactWorkflow(snap))[0]!, new RegExp(`follow-up running \\(run ${status}\\)`));
  assert.match(statusBrief(home, { origin: "main:other" }).otherSessions![0]!, new RegExp(`follow-up running \\(run ${status}\\)`));
  const lines: string[] = [];
  assert.equal(await main(["status", wid], { env: { DSA_HOME: home }, write: line => lines.push(line) }), 0);
  assert.match(lines.join("\n"), new RegExp(`follow-up running \\(run ${status}\\)`));
  assert.equal(orderWorkflows([{ ...snap, wid: "finished", active: undefined, followUps: undefined }, snap])[0]!.wid, wid);
  await journal.append("attention", { item: { ...item, call: `${wid}@1/a@2`, id: `q:${wid}@1/a@2:q1` } });
  assert.equal(workflowSnapshot(home, wid).active, true, "asking follow-up is active");
  await journal.append("sealed", { call: `${wid}@1/a@2`, result: { status: "ok", ok: true, output: "done" } });
  assert.equal(workflowSnapshot(home, wid).active, undefined);
  assert.equal(compactWorkflow(workflowSnapshot(home, wid)).active, undefined);
  // Only the latest generation matters when an older generation was retired without a seal.
  const superseded = snapshotFromEntries(wid, [entry(1, "call", { key: "a", gen: 1 }), entry(2, "generation", { key: "a", gen: 2 }),
    entry(3, "sealed", { call: `${wid}@1/a@2`, result: { status: "ok" } }), entry(4, "workflow-done", { status })]);
  assert.equal(superseded.active, undefined);
});
