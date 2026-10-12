// D1-D3 (1.0.38): one rule for answers in the child. An answer (or a bound resume continue) to any open question of the
// call is delivered at the first opportunity, once; an answer to another question that ends a blocked ask supersedes
// the blocked question.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerChild } from '../../../src/agent/child.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { contentHash } from '../../../src/kernel/ids.ts';
import { CT, JT, type Request } from '../../../src/types.ts';

type Ask = (id: string, args: { question: string }, signal: AbortSignal | undefined, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[]; details: Record<string, any> }>;

/** A child extension over a fake pi; `history` is its session (questions given as qid -> question are asked earlier). */
async function child(t: TestContext, asked: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-answers-'));
  const inbox = join(root, 'inbox'), journal = join(root, 'journal.jsonl');
  await mkdir(inbox);
  const log = await openJournal(journal);
  await log.append(JT.exec, { exec: 'call#1.1', call: 'call' });
  await log.close();
  const old = Object.fromEntries(['DSA_EXEC', 'DSA_CALL', 'DSA_INBOX', 'DSA_JOURNAL', 'DSA_MODEL', 'DSA_BUDGET', 'DSA_SCHEMA'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { DSA_EXEC: 'call#1.1', DSA_CALL: 'call', DSA_INBOX: inbox, DSA_JOURNAL: journal });
  for (const key of ['DSA_MODEL', 'DSA_BUDGET', 'DSA_SCHEMA']) delete process.env[key];
  const hooks = new Map<string, (event: unknown, ctx: any) => Promise<any>>();
  const history: any[] = Object.entries(asked).map(([qid, question]) => ({ type: 'custom', customType: CT.question, data: { qid, rev: 1, question } }));
  const sent: any[] = [];
  let idle = false;
  const ctx = { isIdle: () => idle, sessionManager: { getEntries: () => history }, shutdown() {} };
  let ask!: Ask;
  t.after(async () => {
    await hooks.get('session_shutdown')?.({}, ctx);
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  registerChild({
    on: (name: string, fn: any) => hooks.set(name, fn), registerTool: (tool: { name: string; execute: Ask }) => { if (tool.name === 'ask') ask = tool.execute; },
    appendEntry: (customType: string, data: unknown) => history.push({ type: 'custom', customType, data }),
    sendMessage: (message: unknown) => { sent.push(message); history.push(message); },
  } as unknown as Parameters<typeof registerChild>[0]);
  let sseq = 0;
  const send = async (rid: string, kind: Request['kind'], body: unknown, cond?: Request['cond']) => publishRequest(inbox, { rid, from: 'orch', to: 'call', sseq: ++sseq, kind, body, ...(cond ? { cond } : {}) });
  const start = async (isIdle = false) => { idle = isIdle; await hooks.get('session_start')!({}, ctx); idle = false; };
  const boundary = async (name: 'turn_end' | 'agent_before_settle' = 'turn_end') => { const r = await hooks.get(name)!({}, ctx); history.push(...r.entries); return r.entries as any[]; };
  /** Ask `question`: its qid and the (bounded) wait for the ask's result. */
  const asking = async (question: string) => {
    const before = history.length;
    const result = ask('tool', { question }, undefined, undefined, ctx);
    void result.catch(() => {});
    let q: any;
    for (let i = 0; i < 200 && !q; i++) { q = history.slice(before).find(e => e.customType === CT.question)?.data; if (!q) await delay(5); }
    const settle = async (ms = 3000) => Promise.race([result, delay(ms).then(() => undefined)]);
    return { qid: String(q.qid), rev: Number(q.rev), result: settle };
  };
  const rejected = (rid: string) => history.find(e => e.customType === CT.rejected && e.data.rid === rid)?.data.reason;
  return { history, sent, send, start, boundary, asking, rejected };
}

test('D1: a blocked ask prefers its own answer when answers to several open questions wait', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.start();
  // Both answers wait when the ask for q2 (its qid is the child's hash of execution and question) takes one.
  await c.send('a1', 'answer', { message: 'one' }, { qid: 'q1', rev: 1 });
  await c.send('a2', 'answer', { message: 'two' }, { qid: contentHash({ exec: 'call#1.1', question: 'Reminder?' }), rev: 1 });
  const q2 = await c.asking('Reminder?');
  const result = await q2.result();
  assert.ok(result, 'the ask got a result');
  assert.equal(result.details.rid, 'a2', 'the blocked question takes its own answer first');
  assert.equal(result.details.superseded, undefined);
  // The earlier question's answer is delivered at the next boundary, as a message.
  const entries = await c.boundary();
  const message = entries.find(e => e.type === 'custom_message');
  assert.equal(message?.details.rid, 'a1'); assert.equal(message?.details.qid, 'q1');
  assert.match(message.content, /Question: First\?\nAnswer: one/);
});

test('D2: an answer to an earlier question ends the blocked ask and supersedes it; a later answer to it is rejected', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.start();
  const q2 = await c.asking('Reminder?');
  await c.send('a1', 'answer', { message: 'one' }, { qid: 'q1', rev: 1 });
  const result = await q2.result();
  assert.ok(result, 'the ask got a result');
  assert.deepEqual(result.details, { rid: 'a1', qid: 'q1', rev: 1, superseded: [{ qid: q2.qid, rev: 1 }] });
  assert.match(result.content[0]!.text, /Reminder\?" is withdrawn[^]*Ask again if you still need it[^]*Question: First\?\nAnswer: one/);
  await c.send('a2', 'answer', { message: 'late' }, { qid: q2.qid, rev: 1 });
  await c.boundary();
  assert.equal(c.rejected('a2'), 'stale-rev');
});

test('D1: an answer to an open question outside an ask is delivered as a message at the next boundary', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.start();
  await c.send('a1', 'answer', { message: 'one' }, { qid: 'q1', rev: 1 });
  await c.send('n', 'notify', { message: 'note' });
  const entries = await c.boundary();
  assert.deepEqual(entries.filter(e => e.type === 'custom_message').map(e => e.details.rid), ['a1', 'n'], 'the answer, then the notify');
  assert.deepEqual(entries.find(e => e.details?.rid === 'a1').details, { rid: 'a1', kind: 'answer', from: 'orch', qid: 'q1', rev: 1 });
});

test('D1: an answer to an open question starts an idle child', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.send('a1', 'answer', { message: 'one' }, { qid: 'q1', rev: 1 });
  await c.start(true);
  assert.deepEqual(c.sent.map(m => m.details.rid), ['a1']);
});

test('D3: an adopted answer and its bound continue deliver one receipt per question revision', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.start();
  // The old envelope stayed in the inbox when the orchestrator bound the answer to the hibernation (P28 adoption).
  // A follow-up's new ask takes it first; the bound continue comes after.
  await c.send('old', 'answer', { message: 'one' }, { qid: 'q1', rev: 1 });
  const q3 = await c.asking('Third?');
  assert.equal((await q3.result())?.details.rid, 'old');
  await c.send('bound', 'continue', { message: 'Question: First?\nAnswer: one' }, { qid: 'q1', rev: 1 });
  await c.boundary();
  await c.boundary('agent_before_settle');
  // The ask result (not part of this fake session) was the one delivery: no message delivers q1@1 again.
  assert.deepEqual(c.history.filter(e => e.type === 'custom_message' && e.details?.qid === 'q1').map(e => e.details.rid), [], 'one delivery of q1@1');
  assert.equal(c.rejected('bound'), 'already-answered', 'the bound continue is dropped with a receipt');
});

test('P2a: a bound continue waiting behind a follow-up that asks again resolves that ask (no stuck hibernation)', async t => {
  const c = await child(t, { q1: 'First?' });
  await c.send('follow', 'follow-up', { message: 'earlier instructions' });
  await c.send('bound', 'continue', { message: 'Question: First?\nAnswer: one' , superseded: [] }, { qid: 'q1', rev: 1 });
  await c.start(true);
  assert.deepEqual(c.sent.map(m => m.details.rid), ['follow'], 'the follow-up enters first');
  const q3 = await c.asking('Third?');
  const result = await q3.result();
  assert.ok(result, 'the waiting answer resolves the new ask');
  assert.equal(result.details.rid, 'bound'); assert.equal(result.details.qid, 'q1');
  assert.deepEqual(result.details.superseded, [{ qid: q3.qid, rev: 1 }]);
});

test('D2: a bound continue names the question its hibernated asker superseded', async t => {
  const c = await child(t, { q1: 'First?', q2: 'Reminder?' });
  await c.start();
  await c.send('bound', 'continue', { message: 'Question: First?\nAnswer: one', superseded: [{ qid: 'q2', rev: 1 }] }, { qid: 'q1', rev: 1 });
  const entries = await c.boundary();
  assert.deepEqual(entries.find(e => e.details?.rid === 'bound').details.superseded, [{ qid: 'q2', rev: 1 }]);
  await c.send('a2', 'answer', { message: 'late' }, { qid: 'q2', rev: 1 });
  await c.boundary();
  assert.equal(c.rejected('a2'), 'stale-rev');
});
