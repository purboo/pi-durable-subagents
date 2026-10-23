import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, hasJournalSnapshot, openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { allWorkflows, ownWorkflows, SETTLED_RECHECK_MS, snapshotFromEntries, workflowDigest, workflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { unfinishedWorkflow } from "../../../src/agent/main/snapshots.ts";
import { digestDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { JT } from "../../../src/types.ts";

const call = "wf@1/a@1";
const result = { key: "a", gen: 1, status: "ok", ok: true, output: "answer", usage: { input: 2, output: 3, costUsd: 0.01 } };
const finished: [string, Record<string, unknown>][] = [
  ["wf-created", { revision: 1, name: "test", cwd: "/tmp", origin: "main:s" }],
  ["call", { key: "a", spec: { agent: "worker", task: "do it" } }],
  [JT.exec, { call, exec: "e1" }],
  ["selected", { exec: "e1", model: { provider: "p", id: "m" } }],
  ["observation", { exec: "e1", event: { type: "tool_execution_start" } }],
  [JT.attention, { item: { id: "n1", rev: 1, kind: "note", text: "for the main agent", wid: "wf" } }],
  [JT.fenced, { exec: "e1" }],
  [JT.sealed, { call, result }],
  [JT.done, { status: "done", result: { nested: ["result"] } }],
  [JT.attention, { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } }],
  [JT.attentionResolved, { id: "finished:wf", rev: 1 }],
];
const stored = (home: string, wid: string) => join(digestDir(home), `${wid}.json`);
function writeStored(path: string, value: Record<string, unknown>): void {
  const { checksum: _checksum, ...record } = value;
  writeFileSync(path, JSON.stringify({ ...record, checksum: crc32(Buffer.from(JSON.stringify(record))) }));
}
/** A fresh process: nothing in memory, only what is on disk. */
function fresh(home: string, wid: string): { name?: string; settled: boolean; unfinished: boolean } {
  const src = new URL("../../../src/", import.meta.url).href;
  const code = `const s = await import(${JSON.stringify(`${src}orchestrator/snapshot.ts`)}), m = await import(${JSON.stringify(`${src}agent/main/snapshots.ts`)});
const d = s.workflowDigest(${JSON.stringify(home)}, ${JSON.stringify(wid)});
console.log(JSON.stringify({ name: d.snapshot.name, settled: !!d.settled, unfinished: m.unfinishedWorkflow(${JSON.stringify(home)}) }));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 }));
}

test("a settled workflow's digest is stored, read back without its journal, and replaced once the journal grows", { skip: process.platform === "win32" ? "Windows dev/ino file identity does not invalidate the cache as POSIX does" : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), "settled-digest-")), wid = "wf", journal = await openJournal(journalPath(home, wid));
  try {
    for (const [type, fields] of finished.slice(0, -3)) await journal.append(type, fields);
    assert.equal(workflowDigest(home, wid).settled, undefined, "a running workflow is not settled");
    assert.equal(existsSync(stored(home, wid)), false, "nor stored");
    for (const [type, fields] of finished.slice(-3)) await journal.append(type, fields);
    const digest = workflowDigest(home, wid);
    assert.deepStrictEqual(digest.snapshot, snapshotFromEntries(wid, journal.entries()));
    assert.deepStrictEqual(digest.settled?.attention, [finished[5]![1].item]);
    assert.equal(digest.settled?.tasks["a\0undefined"], "do it");
    assert.equal(unfinishedWorkflow(home), false);
    // What a new pi reads is the stored digest (here marked, to tell it from a fresh fold of the journal).
    const file = JSON.parse(readFileSync(stored(home, wid), "utf8"));
    assert.deepStrictEqual(file.digest, JSON.parse(JSON.stringify(digest)));
    file.digest.snapshot.name = "from-cache";
    writeStored(stored(home, wid), file);
    assert.deepStrictEqual(fresh(home, wid), { name: "from-cache", settled: true, unfinished: false });
    const src = new URL("../../../src/orchestrator/snapshot.ts", import.meta.url).href;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", `const s = await import(${JSON.stringify(src)}); console.log(Number.isNaN(s.workflowDigest(${JSON.stringify(home)}, ${JSON.stringify(wid)}).snapshot.calls[0].pos));`], { encoding: "utf8", timeout: 10_000 }).trim(), "true", "stored snapshots preserve a missing position's NaN");
    // Another reducer's digest is not trusted.
    for (const changed of [{ v: "0.other" }, { v: file.v.replace(/[^.]+$/, "other-code") }, { ino: file.ino + 1 }, { size: file.size + 1 }, { home: "foreign" }, { dev: file.dev + 1 }]) {
      writeStored(stored(home, wid), { ...file, ...changed });
      assert.deepStrictEqual(fresh(home, wid), { name: "test", settled: true, unfinished: false });
    }
    for (const corrupt of ["{", JSON.stringify({ ...file, digest: { snapshot: { wid }, settled: {} } }), JSON.stringify({ ...file, checksum: "bad" })]) {
      writeFileSync(stored(home, wid), corrupt);
      assert.deepStrictEqual(fresh(home, wid), { name: "test", settled: true, unfinished: false });
    }
    // A follow-up appends: the stored digest no longer matches the journal, in this process and in a new one.
    await journal.append("generation", { key: "a", gen: 2 });
    const reopened = workflowDigest(home, wid);
    assert.equal(reopened.settled, undefined);
    assert.deepStrictEqual(reopened.snapshot, snapshotFromEntries(wid, journal.entries()));
    assert.equal(reopened.snapshot.followUps, 1);
    assert.equal(unfinishedWorkflow(home), true);
    assert.deepStrictEqual(fresh(home, wid), { name: "test", settled: false, unfinished: true });
    assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, journal.entries()));
  } finally { await journal.close(); await rm(home, { recursive: true, force: true }); }
});

test("a journal with a torn last line is not stored as settled", async () => {
  const home = await mkdtemp(join(tmpdir(), "settled-torn-")), wid = "wf", journal = await openJournal(journalPath(home, wid));
  try {
    for (const [type, fields] of finished) await journal.append(type, fields);
    await journal.close();
    await appendFile(journalPath(home, wid), "0000000"); // an append still being written
    const digest = workflowDigest(home, wid);
    assert.deepStrictEqual(digest.snapshot, snapshotFromEntries(wid, journal.entries()));
    assert.equal(digest.settled, undefined);
    assert.equal(existsSync(stored(home, wid)), false);
  } finally { await journal.close(); await rm(home, { recursive: true, force: true }); }
});
