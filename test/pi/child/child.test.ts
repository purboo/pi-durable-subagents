import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CT, JT, type Request } from '../../../src/types.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { startPi, tempRoot, REPO, script, settled, type PiInstance } from '../../harness/pi.ts';

async function fixture(t: any, options: { stale?: boolean; fenced?: boolean; schema?: unknown; budget?: unknown } = {}) {
  const root = tempRoot('dsa-child-'), inbox = join(root, 'inbox'), journal = join(root, 'journal.jsonl');
  await mkdir(inbox);
  const log = await openJournal(journal);
  await log.append(JT.exec, { exec: options.stale ? 'new-exec' : 'exec', call: 'call' });
  if (options.fenced) await log.append(JT.fenced, { exec: 'exec' });
  await log.close();
  const env: Record<string, string> = { DSA_HOME: root, DSA_EXEC: 'exec', DSA_CALL: 'call', DSA_INBOX: inbox, DSA_JOURNAL: journal };
  if (options.budget !== undefined) env.DSA_BUDGET = JSON.stringify(options.budget);
  if (options.schema !== undefined) { env.DSA_SCHEMA = join(root, 'schema.json'); await writeFile(env.DSA_SCHEMA, JSON.stringify(options.schema)); }
  let sequence = 0;
  const send = async (kind: Request['kind'], body: unknown, cond?: Request['cond']) => {
    const req: Request = { rid: `r${++sequence}`, from: 'orch', to: 'call', sseq: sequence, kind, body, ...(cond ? { cond } : {}) };
    await publishRequest(inbox, req); return req;
  };
  const instances: PiInstance[] = [];
  const start = (args: string[] = [], model = true) => {
    const pi = startPi({ root, name: `pi-${instances.length}`, extensions: [join(REPO, 'src/agent/extension.ts')], env, args, model }); instances.push(pi); return pi;
  };
  t.after(async () => {
    for (const pi of instances) {
      await writeFile(join(pi.dir, 'events.json'), JSON.stringify(pi.events, null, 2));
      await writeFile(join(pi.dir, 'stderr.log'), pi.stderr.join(''));
      await pi.stop();
    }
    t.diagnostic(`durable evidence: ${root}`);
  });
  return { root, inbox, send, start };
}
const receipts = (pi: PiInstance, rid: string) => pi.sessionEntries().filter(e => e.type === 'custom_message' && e.customType === CT.msg && e.details.rid === rid);
const toolResults = (pi: PiInstance) => pi.sessionEntries().filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => e.message);
async function until<T>(get: () => T | undefined | false | null, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = get(); if (result) return result; await delay(20); }
  throw new Error('Condition timed out');
}
const question = (pi: PiInstance, rev = 1) => until(() => pi.sessionEntries().find(e => e.customType === CT.question && e.data.rev === rev)?.data);

test('boot task, ordered receipts, restart deduplication, and idle delivery', { timeout: 45000 }, async t => {
  const f = await fixture(t), task = await f.send('task', { message: script([{ text: 'boot done' }]) });
  const pi = f.start(); await pi.waitFor(settled);
  assert.equal(receipts(pi, task.rid).length, 1);
  const entries = pi.sessionEntries();
  assert.ok(entries.findIndex(e => e.customType === CT.admitted) < entries.findIndex(e => e.customType === CT.msg));
  const session = pi.sessionFile()!; await pi.stop();
  const resumed = f.start(['--session', session], false);
  const id = resumed.send({ type: 'get_state' }); await resumed.waitFor(e => e.type === 'response' && e.id === id);
  const next = await f.send('continue', { message: script([{ text: 'idle done' }]) });
  await resumed.waitFor(settled);
  const history = (await readFile(session, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(history.filter(e => e.customType === CT.msg && e.details.rid === task.rid).length, 1);
  assert.equal(history.filter(e => e.customType === CT.msg && e.details.rid === next.rid).length, 1);
});

test('steer during a tool lands only at turn_end; model affects the next provider request', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ tool: 'bash', args: { command: 'sleep 1' } }, { text: 'finished' }]) });
  const pi = f.start(); await pi.waitFor(e => e.type === 'tool_execution_start');
  const steer = await f.send('steer', { message: 'boundary steer' });
  const model = await f.send('model', { provider: 'probe', model: 'scripted2' });
  assert.equal(receipts(pi, steer.rid).length, 0);
  await pi.waitFor(settled);
  assert.equal(receipts(pi, steer.rid).length, 1);
  const history = pi.sessionEntries();
  assert.ok(history.findIndex(e => e.message?.role === 'toolResult') < history.findIndex(e => e.customType === CT.msg && e.details.rid === steer.rid));
  assert.ok(history.some(e => e.customType === CT.model && e.data.rid === model.rid));
  const starts = pi.events.filter(e => e.type === 'message_start' && (e.message as any)?.role === 'assistant');
  assert.deepEqual(starts.map(e => (e.message as any).model), ['scripted', 'scripted2']);
});

test('withdraw before delivery leaves a receipt; after dependency and late tombstone survive restart', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const withdrawal = await f.send('withdraw', { rids: ['r2'] });
  const old = await f.send('steer', { message: 'must never appear' });
  await f.send('task', { message: script([{ text: 'replacement' }]) }, { after: withdrawal.rid });
  const pi = f.start(); await pi.waitFor(settled);
  assert.equal(receipts(pi, old.rid).length, 0);
  assert.ok(pi.sessionEntries().some(e => e.customType === CT.withdrawn && e.data.rid === withdrawal.rid));
  assert.ok(pi.sessionEntries().some(e => e.customType === CT.rejected && e.data.rid === old.rid && e.data.reason === 'withdrawn'));
  const session = pi.sessionFile()!; await pi.stop();
  const resumed = f.start(['--session', session], false);
  await f.send('continue', { message: script([{ text: 'after restart' }]) }, { after: withdrawal.rid });
  await resumed.waitFor(settled);
  const entries = (await readFile(session, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.customType === CT.withdrawn).length, 1);
});

test('ask answer persists immediate meta records, rejects duplicate answers, and recovers receipts', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ tool: 'ask', args: { question: 'Which?' } }, { text: 'answered' }]) });
  const pi = f.start(), q = await question(pi);
  const answer = await f.send('answer', { message: 'yes' }, { qid: q.qid, rev: q.rev });
  await pi.waitFor(settled);
  const result = toolResults(pi).find(m => m.toolName === 'ask');
  assert.deepEqual(result.details, { rid: answer.rid, qid: q.qid, rev: 1 });
  const history = pi.sessionEntries();
  assert.ok(history.findIndex(e => e.customType === CT.admitted && e.data.rid === answer.rid) < history.findIndex(e => e.message?.toolName === 'ask'));
  const duplicate = await f.send('answer', { message: 'second' }, { qid: q.qid, rev: 1 });
  await until(() => pi.sessionEntries().some(e => e.customType === CT.rejected && e.data.rid === duplicate.rid && e.data.reason === 'already-answered'));
  const session = pi.sessionFile()!; await pi.stop();
  const resumed = f.start(['--session', session], false);
  await f.send('continue', { message: script([{ text: 'restart' }]) }); await resumed.waitFor(settled);
  const persisted = (await readFile(session, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(persisted.filter(e => e.message?.toolName === 'ask' && e.message.details?.rid === answer.rid).length, 1);
});

test('ask steer interruption keeps question open, defers answers, and re-ask rejects stale revisions', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ tool: 'ask', args: { question: 'Open?' } }, { text: 'interrupted' }]) });
  const pi = f.start(), q = await question(pi);
  const steer = await f.send('steer', { message: 'change direction' });
  await pi.waitFor(settled);
  const result = toolResults(pi).find(m => m.toolName === 'ask');
  assert.deepEqual(result.details, { rid: steer.rid, kind: 'steer' });
  assert.match(result.content[0].text, /interrupted_by.*steer/);
  assert.equal(receipts(pi, steer.rid).length, 0);
  const deferred = await f.send('answer', { message: 'late answer' }, { qid: q.qid, rev: 1 });
  await until(() => pi.sessionEntries().some(e => e.customType === CT.admitted && e.data.rid === deferred.rid));
  assert.ok(!pi.sessionEntries().some(e => e.customType === CT.rejected && e.data.rid === deferred.rid));
  await f.send('continue', { message: script([{ tool: 'ask', args: { question: 'Open?' } }, { text: 'reasked' }]) });
  const q2 = await question(pi, 2); assert.equal(q2.qid, q.qid);
  await until(() => pi.sessionEntries().some(e => e.customType === CT.rejected && e.data.rid === deferred.rid && e.data.reason === 'stale-rev'));
  const answer = await f.send('answer', { message: 'fresh answer' }, { qid: q2.qid, rev: 2 });
  await until(() => toolResults(pi).some(m => m.details?.rid === answer.rid));
});

test('ask abort releases the blocked queue and model stays deferred until boundary', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ tool: 'ask', args: { question: 'Abort?' } }, { text: 'after' }]) });
  const pi = f.start(); await question(pi);
  const model = await f.send('model', { provider: 'probe', model: 'scripted2' });
  await until(() => pi.sessionEntries().some(e => e.customType === CT.admitted && e.data.rid === model.rid));
  const statusId = pi.send({ type: 'get_state' });
  const status = await pi.waitFor(e => e.type === 'response' && e.id === statusId);
  assert.equal((status.data as any).pendingMessageCount, 0);
  assert.ok(!pi.sessionEntries().some(e => e.customType === CT.model));
  pi.send({ type: 'abort' }); await pi.waitFor(settled);
  assert.ok(toolResults(pi).some(m => m.toolName === 'ask' && m.isError));
});

for (const options of [{ stale: true }, { fenced: true }]) test(`launch gate writes nothing: ${JSON.stringify(options)}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, options); await f.send('task', { message: script([{ text: 'forbidden' }]) });
  const pi = f.start(); await until(() => pi.exited(), 5000);
  assert.equal(pi.sessionFile(), null);
  assert.equal(pi.sessionEntries().length, 0);
  assert.deepEqual(await readdir(f.inbox), ['r1.json']);
  assert.equal(pi.events.filter(e => e.type === 'message_start').length, 0);
});

test('agent_before_settle consumes the final mailbox race exactly once', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ text: 'initial turn' }]) });
  const pi = f.start(['-e', join(REPO, 'test/pi/child/boundary-probe.ts')]);
  await pi.waitFor(settled);
  assert.equal(receipts(pi, 'r2').length, 1);
  assert.equal(pi.events.filter(e => e.type === 'message_start' && (e.message as any)?.role === 'assistant').length, 2);
});

test('unknown model and unsupported requests reject without blocking later work', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const model = await f.send('model', { provider: 'missing', model: 'missing' });
  const unsupported = await f.send('stop', {});
  const malformed = await f.send('task', {});
  await f.send('task', { message: script([{ text: 'still works' }]) });
  const pi = f.start(); await pi.waitFor(settled);
  const rejected = pi.sessionEntries().filter(e => e.customType === CT.rejected).map(e => e.data);
  assert.deepEqual(rejected, [{ rid: model.rid, reason: 'unknown-model' }, { rid: unsupported.rid, reason: 'unsupported' }, { rid: malformed.rid, reason: 'malformed' }]);
  assert.ok(!pi.sessionEntries().some(e => e.customType === CT.model));
});

test('report schema rejects invalid data then terminates after a valid report', { timeout: 35000 }, async t => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'string', enum: ['yes'] } } }, additionalProperties: false };
  const f = await fixture(t, { schema });
  await f.send('task', { message: script([
    { tool: 'report', args: { outcome: 'ok', data: { items: [4], extra: true } } },
    { tool: 'report', args: { outcome: 'ok', data: { items: ['yes'] } } },
    { text: 'must not run' },
  ]) });
  const pi = f.start(); await pi.waitFor(settled);
  const results = toolResults(pi);
  assert.equal(results[0].isError, true); assert.match(results[0].content[0].text, /expected string/); assert.match(results[0].content[0].text, /additional property/);
  assert.equal(results[1].isError, false);
  assert.equal(pi.sessionEntries().filter(e => e.customType === CT.report).length, 1);
  assert.equal(pi.events.filter(e => e.type === 'message_start' && (e.message as any)?.role === 'assistant').length, 2);
});

test('follow-up waits for the run to settle while steer lands at turn_end; model switch applies thinking', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  await f.send('task', { message: script([{ tool: 'bash', args: { command: 'sleep 1' } }, { text: 'finished' }, { text: 'after follow-up' }]) });
  const pi = f.start(); await pi.waitFor(e => e.type === 'tool_execution_start');
  const follow = await f.send('follow-up', { message: 'later please' });
  const model = await f.send('model', { provider: 'probe', model: 'thinker', thinking: 'high' });
  await until(() => receipts(pi, follow.rid).length === 1 && pi.events.some(e => e.type === 'agent_settled'), 20000);
  const history = pi.sessionEntries();
  const finished = history.findIndex(e => e.message?.role === 'assistant' && JSON.stringify(e.message.content).includes('finished'));
  const delivered = history.findIndex(e => e.customType === CT.msg && e.details.rid === follow.rid);
  assert.ok(finished >= 0 && delivered > finished, 'follow-up is delivered only after the run produced its final answer');
  assert.ok(history.some(e => e.message?.role === 'assistant' && JSON.stringify(e.message.content).includes('after follow-up')));
  const switched = history.find(e => e.customType === CT.model && e.data.rid === model.rid);
  assert.equal(switched?.data.thinking, 'high');
  const id = pi.send({ type: 'get_state' }); const state = await pi.waitFor(e => e.type === 'response' && e.id === id) as any;
  assert.equal(state.data?.thinkingLevel, 'high');
});

test('per-call budget refuses the next provider request at the boundary', { timeout: 40000 }, async t => {
  const f = await fixture(t, { budget: { tokens: 1 } });
  await f.send('task', { message: script([{ tool: 'bash', args: { command: 'true' } }, { text: 'must not run' }]) });
  const pi = f.start(); await pi.waitFor(settled);
  const history = pi.sessionEntries();
  const refusal = history.find(e => e.customType === CT.budget);
  assert.ok(refusal, 'budget refusal entry'); assert.equal(refusal.data.exec, 'exec'); assert.ok(refusal.data.usage.tokens >= 1);
  assert.ok(!history.some(e => e.message?.role === 'assistant' && JSON.stringify(e.message.content).includes('must not run')));
  // pi records the refused turn as an aborted assistant message with zero usage; the provider saw one request only.
  const calls = (await readFile(join(pi.dir, 'ext.log'), 'utf8')).split('\n').filter(l => l.includes(' respond ')).length;
  assert.equal(calls, 1, 'the provider received exactly one request');
  const last = history.filter(e => e.message?.role === 'assistant').at(-1)!.message;
  assert.equal(last.usage.totalTokens, 0);
});
