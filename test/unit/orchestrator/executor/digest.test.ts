import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionFold, answerKey, digestOpenQuestion } from '../../../../src/orchestrator/executor/digest.ts';
import { openQuestion } from '../../../../src/orchestrator/executor/hibernate.ts';
import { readSessionState, receiptId, forgetSession, type SessionEntry } from '../../../../src/orchestrator/executor/session.ts';
import { sessionUsage } from '../../../../src/orchestrator/executor/usage.ts';
import { ASK_CUT, CT } from '../../../../src/types.ts';

const call = 'W@1/k@1';
let ts = 1000;
const exec = (e: string): SessionEntry => ({ type: 'custom', customType: CT.exec, data: { exec: e } });
const assistant = (content: unknown[], usage = true): SessionEntry => ({ type: 'message', message: { role: 'assistant', content: content as never, ...(usage ? { usage: { input: 3, output: 5, cost: { total: 0.01 } } } : {}), timestamp: ++ts } as never });
const result = (id: string, text = 'ok', isError = false): SessionEntry => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError } as never });
const question = (qid: unknown, rev: unknown): SessionEntry => ({ type: 'custom', customType: CT.question, data: { qid, rev, question: `q ${String(qid)}` } });
const answer = (rid: string, qid: string, rev: number): SessionEntry => ({ type: 'custom_message', customType: CT.msg, details: { rid, qid, rev } });
const receipt = (rid: string): SessionEntry => ({ type: 'custom_message', customType: CT.msg, details: { rid } });
const conflict = (rid: string): SessionEntry => ({ type: 'custom', customType: CT.rejected, data: { rid, reason: 'identity-conflict' } });
const askCall = (id: string) => assistant([{ type: 'toolCall', id, name: 'ask' }]);

/** A session with inherited history, own and foreign segments, receipts, questions, answers and cut asks. */
function history(): SessionEntry[] {
  return [
    { type: 'session' }, assistant([{ type: 'text', text: 'inherited' }]),
    exec(`${call}#1.1`), assistant([{ type: 'text', text: 'a' }]), receipt('r1'), conflict('r2'), receipt('r2'),
    askCall('t1'), question('q1', 1), result('t1', ASK_CUT.shutdown, true),
    exec('W@1/other@1#1.1'), assistant([{ type: 'text', text: 'foreign' }]), question('q9', 1),
    exec(`${call}#1.2`), askCall('t2'), question('q1', 2), answer('r3', 'q1', 2), result('t2'),
    question(5, 1), question('q2', '1'), { type: 'message', message: { role: 'user', details: { qid: 'q2', rev: 1, rid: 'r4' } } as never },
    askCall('t3'), question('q3', 1), assistant([{ type: 'text', text: 'b' }], false),
  ];
}
function check(fold: SessionFold, entries: SessionEntry[], at: string) {
  const s = fold.update(entries);
  assert.deepEqual(s.usage, sessionUsage(entries, call), `usage ${at}`);
  const receipts = new Map<string, SessionEntry>();
  for (const e of entries) { const rid = receiptId(e); if (rid && !receipts.has(rid) && !(e.customType === CT.rejected && e.data?.reason === 'identity-conflict')) receipts.set(rid, e); }
  assert.deepEqual([...s.receipts], [...receipts], `receipts ${at}`);
  const questions = entries.filter(e => e.type === 'custom' && e.customType === CT.question && e.data && typeof e.data.qid === 'string' && typeof e.data.rev === 'number')
    .map(e => ({ qid: e.data!.qid, rev: e.data!.rev, question: e.data!.question }));
  assert.deepEqual(s.questions, questions, `questions ${at}`);
  for (const q of questions) {
    const answered = entries.some(r => { const d = r.message?.details ?? r.details; return d?.qid === q.qid && d?.rev === q.rev && receiptId(r) !== undefined; });
    assert.equal(s.answered.has(answerKey(q.qid, q.rev)), answered, `answered ${q.qid}@${q.rev} ${at}`);
  }
  assert.deepEqual(digestOpenQuestion(entries, s), openQuestion(entries), `open question ${at}`);
  for (const e of [`${call}#1.1`, `${call}#1.2`, 'W@1/other@1#1.1', 'none']) {
    const segment = entries.findLastIndex(x => x.type === 'custom' && x.customType === CT.exec && x.data?.exec === e);
    assert.equal(s.execAt.get(e) ?? -1, segment, `segment ${e} ${at}`);
    for (const qid of ['q1', 'q3', 'q9']) assert.equal((s.questionAt.get(qid) ?? -1) > segment && segment >= 0,
      segment >= 0 && entries.slice(segment + 1).some(x => x.customType === CT.question && x.data?.qid === qid), `asked ${qid} after ${e} ${at}`);
  }
}

test('the session fold equals the whole-session functions at every length, visiting each entry once', () => {
  const all = history(), fold = new SessionFold(call);
  for (let n = 0; n <= all.length; n++) check(fold, all.slice(0, n), `at ${n}`);
  assert.equal(openQuestion(all)?.qid, 'q3', 'the fixture ends with an open question');
  assert.ok(all.some((_, n) => openQuestion(all.slice(0, n))?.qid === 'q1'), 'and has an earlier one');
  assert.equal(fold.visited, all.length, 'growing reads visit only appended entries');
  // A session read from scratch (rewritten: new entry objects) restarts the fold and still agrees.
  const reread = structuredClone(all);
  check(fold, reread, 'after a reread');
  assert.equal(fold.visited, 2 * all.length);
  // A shorter session (truncated, replaced) restarts it too.
  check(fold, reread.slice(0, 5), 'after truncation');
});

test('observing a growing session costs the appended entries, not the session size', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-digest-')), path = join(dir, 'session.jsonl');
  t.after(async () => { forgetSession(path); await rm(dir, { recursive: true, force: true }); });
  const line = (e: SessionEntry) => `${JSON.stringify(e)}\n`;
  const big = 'x'.repeat(4096);
  await writeFile(path, [{ type: 'session' }, exec(`${call}#1.1`), ...Array.from({ length: 5000 }, (_, i) => i % 2 ? result(`t${i}`, big) : assistant([{ type: 'toolCall', id: `t${i + 1}`, name: 'read' }]))].map(line).join(''));
  const fold = new SessionFold(call);
  fold.update((await readSessionState(path)).entries);
  const base = fold.visited;
  assert.equal(base, 5002);
  // Ticks: an unchanged session costs nothing; each append costs only its own entries.
  for (let tick = 0; tick < 20; tick++) {
    if (tick % 4 === 0) await appendFile(path, line(assistant([{ type: 'text', text: `tick ${tick}` }])) + line(receipt(`rid${tick}`)));
    const s = fold.update((await readSessionState(path)).entries);
    assert.ok(s.receipts.has(`rid${tick - tick % 4}`));
  }
  assert.equal(fold.visited - base, 10, 'five appends of two entries');
  assert.equal(fold.state.usage.length, 2500 + 5);
});
