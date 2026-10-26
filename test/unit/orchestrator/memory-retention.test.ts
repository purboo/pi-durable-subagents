import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { crc32, openJournal } from "../../../src/kernel/journal.ts";
import { ownWorkflows, pausedElsewhere, SETTLED_RECHECK_MS, statusBrief, statusView, workflowDigest, workflowDigestChecked } from "../../../src/orchestrator/snapshot.ts";
import { workflows } from "../../../src/agent/main/snapshots.ts";
import { digestDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { JT } from "../../../src/types.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
/** WeakRef targets stay alive until the current job ends: collect only after yielding. */
async function collect(): Promise<void> { for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); gc(); } }

async function created(home: string, wids: [string, string][]): Promise<void> {
  const ledger = await openJournal(orchLedger(home));
  for (const [wid, origin] of wids) { await ledger.append("create-intent", { wid, origin }); await ledger.append(JT.created, { wid, origin }); }
  await ledger.close();
}
async function workflow(home: string, wid: string, origin: string, finished: boolean): Promise<void> {
  const journal = await openJournal(journalPath(home, wid));
  await journal.append("wf-created", { origin, revision: 1, name: `name-${wid}` });
  await journal.append("call", { key: "a", gen: 1, spec: { agent: "worker", task: `task of ${wid}` } });
  if (finished) {
    await journal.append(JT.sealed, { call: `${wid}@1/a@1`, result: { key: "a", gen: 1, ok: true, status: "ok", output: "ok" } });
    await journal.append(JT.done, { status: "done" });
    await journal.append(JT.attention, { item: { id: `finished:${wid}`, rev: 1, kind: "finished", wid, text: "done" } });
    await journal.append(JT.attentionResolved, { id: `finished:${wid}`, rev: 1 });
  }
  await journal.close();
}
/** Rename a workflow in its stored digest, keeping the record valid: a reader that shows the new name read the file. */
function renameStored(home: string, wid: string, name: string): void {
  const path = join(digestDir(home), `${wid}.json`), { checksum: _checksum, ...record } = JSON.parse(readFileSync(path, "utf8"));
  record.digest.snapshot.name = name;
  writeFileSync(path, JSON.stringify({ ...record, checksum: crc32(Buffer.from(JSON.stringify(record))) }));
}

test("a main-session polling pass keeps no earlier pass alive", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-retain-pass-"));
  try {
    await created(home, [["w1", "main:s"], ["w2", "main:s"], ["w3", "main:s"]]);
    for (const wid of ["w1", "w2", "w3"]) await workflow(home, wid, "main:s", false);
    let clock = Date.now() + 60_000;
    t.mock.method(Date, "now", () => clock);
    const journal = await openJournal(journalPath(home, "w1")), passes: WeakRef<object>[] = [];
    for (let i = 0; i < 8; i++) {
      await journal.append(JT.attention, { item: { id: `s${i}`, rev: 1, kind: "stall", wid: "w1", text: "quiet" } });
      clock += SETTLED_RECHECK_MS + 1; // past the listing's trust window: the pass lists w/ and reads w1 again
      const result = workflows(home, "main:s");
      assert.equal(result.length, 3);
      passes.push(new WeakRef(result));
    }
    await journal.close();
    await collect();
    assert.deepEqual(passes.slice(0, -1).map(p => p.deref() !== undefined), new Array(7).fill(false),
      "each pass's result (and the listing, ledger state and digests it carries) is released once a newer pass replaces it");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a status listing keeps no digest of a settled workflow and reads the ones it shows from disk", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsa-retain-status-"));
  try {
    const own: [string, string][] = [["01OWN1", "main:s"], ["01OWN2", "main:s"]], other: [string, string][] = [["01OTH1", "main:o"], ["01OTH2", "main:o"], ["01OTH3", "main:o"]];
    await created(home, [...own, ...other]);
    await workflow(home, "01OWN1", "main:s", true);
    await workflow(home, "01OWN2", "main:s", false);
    for (const [wid] of other) await workflow(home, wid, "main:o", wid !== "01OTH3");
    const brief = statusBrief(home, { origin: "main:s" });
    assert.deepEqual(brief.active.map(w => w.wid), ["01OWN2"]);
    assert.deepEqual(brief.otherSessions?.map(line => line.split(" · ")[0]), ["01OTH3"]);
    assert.deepEqual(brief.finished.map(line => line.split(" · ")[0]), ["01OWN1"], "finished workflows of other sessions are not shown");
    // Own first, then newest first; settled ones are shown up to `keep`.
    const view = () => statusView(home, { origin: "main:s" }).workflows.map(w => `${w.wid}:${w.name}`);
    assert.deepEqual(view(), ["01OWN2:name-01OWN2", "01OWN1:name-01OWN1", "01OTH3:name-01OTH3", "01OTH2:name-01OTH2", "01OTH1:name-01OTH1"]);
    assert.deepEqual(statusView(home, { origin: "main:s", keep: 1 }).workflows.map(w => w.wid), ["01OWN2", "01OWN1", "01OTH3"]);
    // The stored digests changed underneath: a listing that kept them in memory would still show the old names.
    for (const wid of ["01OWN1", "01OTH1", "01OTH2"]) renameStored(home, wid, `stored-${wid}`);
    assert.deepEqual(view(), ["01OWN2:name-01OWN2", "01OWN1:stored-01OWN1", "01OTH3:name-01OTH3", "01OTH2:stored-01OTH2", "01OTH1:stored-01OTH1"]);
    renameStored(home, "01OTH1", "again");
    assert.equal(view().at(-1), "01OTH1:again", "a settled workflow it showed is not kept either");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a status listing leaves the digests pollers hold, their trust windows and pass identity alone, and still sees holds", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-retain-held-"));
  try {
    await created(home, [["01OWN1", "main:s"], ["01OWN2", "main:s"], ["01OTH1", "main:o"], ["01OTH2", "main:o"]]);
    await workflow(home, "01OWN1", "main:s", true);
    await workflow(home, "01OWN2", "main:s", false);
    await workflow(home, "01OTH1", "main:o", true);
    await workflow(home, "01OTH2", "main:o", false);
    const ledger = await openJournal(orchLedger(home));
    await ledger.append("drain", { origin: "main:o" }); // holds main:o's live workflow: paused for main:s
    await ledger.close();
    let clock = Date.now() + 60_000;
    t.mock.method(Date, "now", () => clock);
    const main = workflows(home, "main:s"), own = ownWorkflows(home, "main:s");
    const held = ["01OWN1", "01OWN2"].map(wid => ({ wid, digest: workflowDigest(home, wid), checked: workflowDigestChecked(home, wid) }));
    for (const h of held) assert.ok(Number.isFinite(h.checked), `${h.wid} is held by a poller`);
    clock += 1;
    statusBrief(home, { origin: "main:s" }); statusView(home, { origin: "main:s" });
    assert.deepEqual(pausedElsewhere(home, "main:s"), ["01OTH2 (name-01OTH2)"]);
    assert.equal(workflowDigestChecked(home, "01OTH1"), -Infinity, "a settled workflow no poller held is not kept");
    for (const h of held) {
      assert.equal(workflowDigest(home, h.wid), h.digest, `${h.wid}: the held digest is the same object`);
      assert.ok(Number.isFinite(workflowDigestChecked(home, h.wid)), `${h.wid}: still checked`);
    }
    assert.equal(workflows(home, "main:s"), main, "the main pass is reused");
    assert.equal(ownWorkflows(home, "main:s"), own, "the owner pass is reused");
  } finally { await rm(home, { recursive: true, force: true }); }
});
