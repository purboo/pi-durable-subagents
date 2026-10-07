import assert from "node:assert/strict";
import { mkdtemp, rename, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openJournal } from "../../../src/kernel/journal.ts";
import { snapshotFromEntries, workflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { journalPath } from "../../../src/paths.ts";
import { JT } from "../../../src/types.ts";

test("incremental snapshots equal a full fold at every prefix and own their output", async () => {
  const home = await mkdtemp(join(tmpdir(), "snapshot-incremental-")), wid = "wf";
  const path = journalPath(home, wid), journal = await openJournal(path);
  const call = "wf@1/a@1", next = "wf@1/a@2", qid = `q:${call}:question`;
  const usage = { input: 2, output: 3, costUsd: 0.01 };
  const result = { key: "a", gen: 1, status: "ok", ok: true, output: "answer", usage };
  const events: [string, Record<string, unknown>][] = [
    ["wf-created", { revision: 1, name: "test", cwd: "/tmp", origin: "test" }],
    ["call", { key: "a", spec: { agent: "worker", model: "p/m:low" } }],
    [JT.exec, { call, exec: "e1" }],
    ["selected", { exec: "e1", model: { provider: "p", id: "m" } }],
    ["observation", { exec: "e1", event: { type: "tool_execution_start" } }],
    ["usage", { call, id: "u1", usage }],
    ["usage", { call, id: "u1", usage }],
    [JT.attention, { item: { id: qid, rev: 1, kind: "question", text: "continue?", call } }],
    ["hibernated", { call, exec: "e1" }],
    [JT.fenced, { exec: "e1" }],
    ["answer-bound", { call }],
    ["resumed", { call }],
    [JT.attentionResolved, { id: qid, rev: 1 }],
    [JT.attention, { item: { id: qid, rev: 1, kind: "question", text: "already resolved" } }],
    [JT.exec, { call, exec: "e2" }],
    ["selected", { exec: "e2", model: { id: "m2" } }],
    ["forward", { dest: call, rid: "s1", rid2: "r1", envelope: { kind: "steer" } }],
    ["forward", { dest: call, rid: "s2", rid2: "r2", envelope: { kind: "model", body: { provider: "p", model: "m3" } } }],
    ["forward-delivered", { call, rid2: "r1", reason: "withdrawn" }],
    ["forward-retired", { rid2: "r2" }],
    [JT.sealed, { call, result }],
    [JT.done, { status: "done", result: { nested: ["result"] } }],
    ["generation", { key: "a", gen: 2 }],
    [JT.exec, { call: next, exec: "e3" }],
    ["selected", { exec: "e3", model: { id: "m" } }],
    ["retired", { call: next }],
    ["refused", { key: "b", reason: "spawn-budget" }],
    ["reused", { key: "copy", from: call }],
    ["reused", { key: "future", from: "future" }],
    [JT.exec, { call: "future", exec: "future-exec" }],
    [JT.sealed, { call: "future", result }],
    ["resumed", {}],
    ["revised", { revision: 2 }],
    ["reused", { key: "a", from: call }],
    ["call", { key: "new", gen: 1 }],
    [JT.done, { status: "failed", error: "test" }],
    ["wf-created", { revision: 3 }],
  ];
  const retained: { value: ReturnType<typeof workflowSnapshot>; copy: ReturnType<typeof workflowSnapshot> }[] = [];
  try {
    assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, []));
    for (const [type, fields] of events) {
      await journal.append(type, fields);
      const actual = workflowSnapshot(home, wid);
      assert.deepStrictEqual(actual, snapshotFromEntries(wid, journal.entries()), `prefix ${journal.entries().length}: ${type}`);
      for (const old of retained) assert.deepStrictEqual(old.value, old.copy);
      retained.push({ value: actual, copy: structuredClone(actual) });
    }
    // Mutating nested consumer data must not poison the reducer or the immutable journal.
    const latest = retained.at(-1)!.value;
    latest.calls[0]!.result!.usage!.input = 999;
    latest.calls[0]!.agent = "consumer";
    await journal.append("observation", { exec: "unknown" });
    assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, journal.entries()));
  } finally { await journal.close(); await rm(home, { recursive: true, force: true }); }
});

test("snapshot cache resets for replacement, truncation and disappearance and isolates homes", async () => {
  const home = await mkdtemp(join(tmpdir(), "snapshot-replace-")), wid = "same";
  const path = journalPath(home, wid);
  try {
    for (let round = 0; round < 3; round++) {
      const journal = await openJournal(path);
      await journal.append("wf-created", { revision: round + 1 });
      await journal.append("call", { key: `call-${round}` });
      await journal.close();
      assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, journal.entries()));
      if (round === 0) await rename(path, `${path}.old`);
      else {
        await truncate(path, 0);
        assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, []));
        await rm(path);
        assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, []));
      }
    }
    assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, []));
    const other = join(home, "other"), journal = await openJournal(journalPath(other, wid));
    await journal.append("call", { key: "isolated" });
    await journal.close();
    assert.deepStrictEqual(workflowSnapshot(other, wid), snapshotFromEntries(wid, journal.entries()));
    assert.deepStrictEqual(workflowSnapshot(home, wid), snapshotFromEntries(wid, []));
  } finally { await rm(home, { recursive: true, force: true }); }
});
