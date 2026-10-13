// A pi process reads only its own workflows: UiData.refresh(own) and ownWorkflows decide ownership from the
// orchestrator ledger before any workflow journal is opened, and list exactly what allWorkflows + ownedBy would.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { root, clean } from "./fixture.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { allWorkflows, ownWorkflows, ownedBy } from "../../../src/orchestrator/snapshot.ts";
import { UiData } from "../../../src/ui/data.ts";
import { JT } from "../../../src/types.ts";
after(clean);

const A = "main:session-a", B = "main:session-b";
async function append(path: string, type: string, fields: Record<string, unknown>) {
  const j = await openJournal(path); try { await j.append(type, fields); } finally { await j.close(); }
}
/** One workflow as the engine writes it: run request, create-intent, its journal's wf-created, then `created`. */
async function create(home: string, wid: string, origin: string, opts: { session?: string; labels?: Record<string, string>; created?: boolean; journal?: "dir" } = {}) {
  const rid = `rid-${wid}`, ledger = orchLedger(home);
  await append(ledger, "request", { request: { rid, kind: "run", from: origin, body: { cwd: root, ...(opts.session ? { session: opts.session } : {}), ...(opts.labels ? { labels: opts.labels } : {}) } } });
  await append(ledger, "create-intent", { rid, wid, origin, cwd: root });
  if (opts.journal === "dir") mkdirSync(journalPath(home, wid), { recursive: true }); // unreadable as a journal
  else {
    const j = await openJournal(journalPath(home, wid));
    await j.append("wf-created", { rid, origin, cwd: root, revision: 1, name: `name-${wid}` });
    await j.append("call", { pos: 0, key: "k", gen: 1, spec: { agent: "worker", task: `task ${wid}` } });
    await j.close();
  }
  if (opts.created !== false) await append(ledger, JT.created, { rid, wid, origin });
}
async function seal(home: string, wid: string, gen = 1, done = true) {
  const j = await openJournal(journalPath(home, wid)), call = `${wid}@1/k@${gen}`;
  await j.append(JT.exec, { call, exec: `${call}#1.1` });
  await j.append(JT.sealed, { call, exec: `${call}#1.1`, result: { key: "k", gen, status: "ok", ok: true, output: "out" } });
  if (done) await j.append(JT.done, { status: "done", result: 1 });
  await j.close();
}

test("ownWorkflows equals allWorkflows filtered by ownedBy: origins, a session-named run, a pruned and a paused workflow", async () => {
  const home = join(root, "equal");
  await create(home, "W01", A);
  await seal(home, "W01");
  await create(home, "W02", B, { labels: { node: "x" } });
  await create(home, "W03", "cli:host:1", { session: "session-a", labels: { attempt: "2" } }); // named this session
  await create(home, "W04", A);
  await append(orchLedger(home), "drain", { origin: A }); // holds A's live workflows: W04 shows paused
  await create(home, "W05", A); await seal(home, "W05");
  await append(orchLedger(home), "pruned", { rid: "p", wid: "W05", endedAt: 1, bytes: 0 }); // directory still there
  await create(home, "W06", A, { created: false }); // being created: the intent is in, `created` not yet
  await create(home, "W07", "cli:host:2");
  const all = allWorkflows(home);
  assert.equal(all.find(w => w.wid === "W04")?.paused, true);
  for (const own of [A, B, "main:session-c", "cli:host:2"]) {
    assert.deepEqual(ownWorkflows(home, own), all.filter(w => ownedBy(w, own)), own);
  }
  assert.deepEqual(ownWorkflows(home, A).map(w => w.wid), ["W06", "W04", "W03", "W01"]);
  for (const own of [A, B, "cli:host:2"]) {
    assert.deepEqual(ownWorkflows(home, own, { started: true }), all.filter(w => w.origin === own), `${own} started`);
  }
  assert.deepEqual(ownWorkflows(home, A, { started: true }).map(w => w.wid), ["W06", "W04", "W01"]);
  assert.equal(ownWorkflows(home, A).find(w => w.wid === "W03")?.session, "session-a");
  assert.deepEqual(ownWorkflows(home, A).find(w => w.wid === "W03")?.labels, { attempt: "2" });
});

test("UiData.refresh(own) never opens other sessions' journals: unreadable foreign ones do not matter", async () => {
  const home = join(root, "foreign");
  await create(home, "W10", A); await seal(home, "W10");
  await create(home, "W11", B, { journal: "dir" });
  await create(home, "W12", "cli:host:3", { journal: "dir" });
  await create(home, "W13", "cli:host:4", { session: "session-a" });
  assert.throws(() => allWorkflows(home), "reading every journal fails on the foreign ones");
  const data = new UiData(home);
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W13", "W10"]);
  assert.ok(data.facts.has("W10@1/k@1") && data.facts.has("W13@1/k@1"));
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W13", "W10"]);
  const other = new UiData(home); other.refresh("main:nobody");
  assert.deepEqual(other.workflows, []);
});

test("UiData.refresh(own) follows new own workflows, follow-up generations and seals", async () => {
  const home = join(root, "growth");
  await create(home, "W20", A); await seal(home, "W20");
  await create(home, "W21", B);
  const data = new UiData(home);
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W20"]);
  // A new workflow of this session, first while only its intent is in the ledger, then once `created` lands.
  await create(home, "W22", A, { created: false });
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W22", "W20"]);
  await append(orchLedger(home), JT.created, { rid: "rid-W22", wid: "W22", origin: A });
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W22", "W20"]);
  // A follow-up generation on the finished W20, then its seal.
  const j = await openJournal(journalPath(home, "W20"));
  await j.append("generation", { pos: 0, key: "k", gen: 2, spec: { agent: "worker", task: "more" } });
  await j.close();
  data.refresh(A);
  let w20 = data.workflows.find(w => w.wid === "W20")!;
  assert.equal(w20.followUps, 1);
  assert.deepEqual(w20.calls.map(c => [c.callId, c.phase]), [["W20@1/k@1", "sealed"], ["W20@1/k@2", "queued"]]);
  await seal(home, "W20", 2, false);
  data.refresh(A);
  w20 = data.workflows.find(w => w.wid === "W20")!;
  assert.equal(w20.followUps, undefined);
  assert.deepEqual(w20.calls.map(c => [c.callId, c.phase]), [["W20@1/k@1", "sealed"], ["W20@1/k@2", "sealed"]]);
  // A session-named run of another sender becomes this session's own once its `created` lands.
  await create(home, "W23", "cli:host:5", { session: "session-a", created: false });
  data.refresh(A);
  assert.ok(!data.workflows.some(w => w.wid === "W23"), "its session is known with `created`, as in allWorkflows");
  await append(orchLedger(home), JT.created, { rid: "rid-W23", wid: "W23", origin: "cli:host:5" });
  data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W23", "W22", "W20"]);
});

test("a workflow the ledger does not know is attributed by its journal's first entry", async () => {
  const home = join(root, "unknown"), j = await openJournal(journalPath(home, "W30"));
  await j.append("wf-created", { origin: A, cwd: root, revision: 1 }); await j.close();
  mkdirSync(journalPath(home, "W31"), { recursive: true });
  const data = new UiData(home);
  data.refresh(A); data.refresh(A);
  assert.deepEqual(data.workflows.map(w => w.wid), ["W30"]);
  data.refresh(B);
  assert.deepEqual(data.workflows, []);
});
