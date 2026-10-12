// An answer bound to a question (`answer-bound`) whose resolution was not appended (a crash between the two appends)
// is repaired when the call executes again: exactly one `attention-resolved{answered}` for that question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import { CT, JT, type Containment, type ProcInfo, type SpawnSpec } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";

const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r, afterSeal: async () => {}, recover: async () => {} };

test("an answer-bound without its resolution is repaired once when the call executes again", { timeout: 15000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-answer-repair-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  t.mock.method(console, "error", () => {});
  const call = `${wid}@1/a@1`, first = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  const lines = (rows: unknown[]) => rows.map(l => JSON.stringify(l)).join("\n") + "\n";
  // The first execution asked q1 and was cut off; the answer was bound, its resolution never appended.
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec: first } }, { type: "custom", customType: CT.question, data: { qid: "q1", rev: 1, question: "Choose?" } }]));
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "task" } });
  await journal.append(JT.exec, { call, exec: first });
  const id = `q:${call}:q1`;
  await journal.append(JT.attention, { item: { id, rev: 1, kind: "question", text: "Choose?", wid, call, qid: "q1" } });
  await journal.append("answer-bound", { call, qid: "q1", rev: 1, rid: "answer", rid2: "bound-answer", hash: "h", message: "Answer: yes" });
  const containment: Containment & { launches: SpawnSpec[] } = {
    launches: [],
    async spawn(spec: SpawnSpec) {
      this.launches.push(spec);
      // The child receives the bound answer (its receipt) and reports.
      await writeFile(session, lines([{ type: "custom", customType: CT.exec, data: { exec: spec.exec } }, { type: "custom_message", details: { rid: "bound-answer", qid: "q1", rev: 1 } }, { type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok", data: {} } }]));
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
    async fence() {},
  };
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 }, writerLock: "off" } }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  await executor.recover(wid, journal);
  const result = await executor.run(ticket);
  assert.equal(result.status, "ok");
  assert.equal(containment.launches.length, 1);
  const resolved = journal.entries().filter(e => e.type === JT.attentionResolved && e.id === id);
  assert.deepEqual(resolved.map(e => [e.rev, e.resolution]), [[1, "answered"]]);
  // Repaired before the next execution was launched with the answer.
  const next = journal.entries().findIndex(e => e.type === JT.exec && e.exec !== first);
  assert.ok(journal.entries().indexOf(resolved[0]!) < next);
});
