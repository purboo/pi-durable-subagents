// send kind "notify" through the real executor and child: delivered like a steer to a running call, held while the call
// waits on its question (never interrupting it), and turned into a pending note exactly once when the call seals first.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { contentHash, forwardRid, ulid } from "../../../src/kernel/ids.ts";
import { JT, type Request } from "../../../src/types.ts";
import type { CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { snapshotFromEntries } from "../../../src/orchestrator/snapshot.ts";

const agent = { name: "test", description: "test", body: "Test agent", model: "probe/scripted", tools: ["bash"], systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false, sourcePath: "/fixture/test.md", source: "project" as const };
async function until(predicate: () => boolean | Promise<boolean>, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for durable executor evidence"); await delay(20); }
}
async function setup(t: TestContext, config: OrchestratorConfig = {}) {
  const root = tempRoot("dsa-notify-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_DIR: process.env.PROBE_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PROBE_DIR = root;
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  const orch = await openJournal(orchLedger(home)), wid = ulid(), journal = await openJournal(journalPath(home, wid));
  const executor = createExecutor({ home, orch, config });
  const ticket = (task: string): CallTicket => ({ wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd, journal, spec: { agent: "test", task }, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      await journal.close(); await orch.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true });
    }
  });
  const ctx = { journal, widRev: `${wid}@1` as const, key: "a", gen: 1 };
  const notify = (t: CallTicket, rid: string, message: string): Request => ({ rid, from: "main:test", to: "orch", sseq: 1, kind: "send", body: { to: t.callId, kind: "notify", message } });
  const delivery = (rid: string) => orch.entries().find(e => e.type === "send-note" && e.rid === rid)?.delivery;
  const session = async () => (await readFile(callSession(home, wid, "a", 1), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const rid2 = (req: Request) => forwardRid(req.rid, `${wid}@1`, "a", contentHash(req));
  return { root, home, wid, orch, journal, executor, ticket, ctx, notify, delivery, session, rid2 };
}
const receiptIndex = (rows: Record<string, any>[], rid: string) => rows.findIndex(e => e.type === "custom_message" && e.details?.rid === rid);

test("notify to a running call is delivered at its next safe point (steered), exactly once", { timeout: 30000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25 } }), ticket = f.ticket(script([{ tool: "bash", args: { command: "sleep 1" } }, { text: "before the note" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === "observation" && (e.event as { type: string }).type === "tool_execution_start"));
  const req = f.notify(ticket, "note-live", "NOTE-LIVE " + script([{ text: "saw the note" }]));
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  assert.equal(f.delivery(req.rid), "steered");
  const result = await pending;
  assert.equal(result.output, "saw the note", "the call got the note and continued with it");
  assert.equal((await f.session()).filter(e => e.type === "custom_message" && e.details?.rid === f.rid2(req)).length, 1);
  assert.ok(f.journal.entries().some(e => e.type === "forward-delivered" && e.rid === req.rid));
  assert.ok(!f.journal.entries().some(e => e.type === "pending-note"), "a delivered notify is no pending note");
});

for (const hibernate of [false, true]) test(`notify to a${hibernate ? " hibernated" : "n asking"} call is held until the answer, never interrupting the question`, { timeout: 45000 }, async t => {
  const f = await setup(t, { k: { trackerMs: 25, hibernateMs: hibernate ? 40 : 600000 } });
  const ticket = f.ticket(script([{ tool: "ask", args: { question: "Choose?" } }, { text: "answered" }]));
  const pending = f.executor.run(ticket);
  const question = () => f.journal.entries().find(e => e.type === JT.attention && (e.item as { qid?: string }).qid)?.item as { qid: string; rev: number } | undefined;
  await until(() => !!question() && (!hibernate || f.journal.entries().some(e => e.type === JT.fenced)));
  const req = f.notify(ticket, "note-held", "NOTE-HELD " + script([{ text: "saw the note after the answer" }]));
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  assert.equal(f.delivery(req.rid), "held-until-answer");
  await delay(600);
  const before = await f.session();
  assert.equal(receiptIndex(before, f.rid2(req)), -1, "not delivered while the question is open");
  assert.ok(!before.some(e => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "ask"), "the ask was not interrupted");
  const q = question()!;
  const answer: Request = { rid: "answer", from: "main:test", to: "orch", sseq: 2, kind: "send", cond: { qid: q.qid, rev: q.rev }, body: { to: ticket.callId, kind: "answer", message: "blue" } };
  assert.deepEqual(await f.executor.forward(answer, f.ctx), { action: "apply" });
  const result = await pending;
  assert.equal(result.status, "ok");
  assert.equal(result.output, "saw the note after the answer");
  const rows = await f.session(), noted = receiptIndex(rows, f.rid2(req));
  assert.ok(noted >= 0, "delivered after the answer");
  const answered = hibernate ? rows.findIndex(e => e.type === "custom_message" && e.details?.qid === q.qid)
    : rows.findIndex(e => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "ask" && e.message.details?.qid === q.qid);
  assert.ok(answered >= 0 && answered < noted, `the answer (${answered}) comes before the note (${noted})`);
  assert.equal(rows.filter(e => e.type === "custom_message" && e.details?.rid === f.rid2(req)).length, 1);
  assert.ok(!f.journal.entries().some(e => e.type === "pending-note"));
});

test("notify accepted for a running call that seals before delivery becomes one pending note (also after recovery)", { timeout: 20000 }, async t => {
  // No provider slot: the call waits unlaunched, so the notify cannot be delivered before the stop seals it.
  const f = await setup(t, { providers: { probe: { slots: 0 } } }), ticket = f.ticket(script([{ text: "never" }]));
  const pending = f.executor.run(ticket);
  await until(() => f.journal.entries().some(e => e.type === JT.exec));
  const req = f.notify(ticket, "note-race", "decided: use TOML");
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  assert.equal(f.delivery(req.rid), "steered");
  await f.executor.stop({ wid: f.wid }); assert.equal((await pending).status, "stopped");
  const notes = () => f.journal.entries().filter(e => e.type === "pending-note");
  assert.deepEqual(notes().map(e => [e.rid, e.call, e.key, e.message]), [[req.rid, ticket.callId, "a", "decided: use TOML"]]);
  const note = notes()[0]!, retired = f.journal.entries().find(e => e.type === "forward-retired" && e.rid === req.rid)!;
  assert.ok(note.seq < retired.seq, "the note is recorded before its forward is retired");
  // A retry of the same request, and recoveries, add nothing.
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  await f.executor.recover(f.wid, f.journal); await f.executor.recover(f.wid, f.journal);
  assert.equal(notes().length, 1);
  const call = { type: "call", seq: -1, ts: 0, key: "a", gen: 1, pos: 0, spec: { agent: "test" } } as never;
  assert.equal(snapshotFromEntries(f.wid, [call, ...f.journal.entries()]).calls[0]!.notesPending, 1);
});

test("a crash between the seal and the note: recovery records the note once", { timeout: 20000 }, async t => {
  const f = await setup(t), ticket = f.ticket(script([{ text: "never" }]));
  const req = f.notify(ticket, "note-crash", "remember this");
  await f.journal.append(JT.exec, { call: ticket.callId, exec: `${ticket.callId}#1.1` });
  assert.deepEqual(await f.executor.forward(req, f.ctx), { action: "apply" });
  // The seal is durable, the post-seal retirement never ran.
  await f.journal.append(JT.fenced, { exec: `${ticket.callId}#1.1` });
  await f.journal.append(JT.sealed, { call: ticket.callId, exec: `${ticket.callId}#1.1`, result: { key: "a", gen: 1, status: "stopped", ok: false, output: "" } });
  assert.ok(!f.journal.entries().some(e => e.type === "pending-note"));
  const restarted = createExecutor({ home: f.home, orch: f.orch, config: {} });
  try { await restarted.recover(f.wid, f.journal); await restarted.recover(f.wid, f.journal); } finally { await restarted.shutdown(); }
  assert.deepEqual(f.journal.entries().filter(e => e.type === "pending-note").map(e => e.rid), [req.rid]);
  // A withdrawn notify is not turned into a note.
  const g = await setup(t), other = g.ticket(script([{ text: "never" }]));
  const withdrawn = g.notify(other, "note-withdrawn", "never mind");
  await g.journal.append(JT.exec, { call: other.callId, exec: `${other.callId}#1.1` });
  await g.executor.forward(withdrawn, g.ctx);
  await g.executor.forward({ rid: "withdraw", from: "main:test", to: "orch", sseq: 2, kind: "withdraw", body: { rids: [withdrawn.rid] } }, g.ctx);
  await g.executor.stop({ wid: g.wid, callId: other.callId });
  assert.ok(g.journal.entries().some(e => e.type === JT.sealed));
  assert.ok(!g.journal.entries().some(e => e.type === "pending-note"));
});
