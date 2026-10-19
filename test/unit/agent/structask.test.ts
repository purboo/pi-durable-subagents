import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerMain } from '../../../src/agent/main.ts';
import { registerChild } from '../../../src/agent/child.ts';
import { recover } from '../../../src/agent/child/history.ts';
import { presentText } from '../../../src/agent/main/snapshots.ts';
import { SessionFold } from '../../../src/orchestrator/executor/digest.ts';
import { configHash, configProblem, orchestratorSettings } from '../../../src/orchestrator/config.ts';
import { statusBrief, statusDetail, statusView } from '../../../src/orchestrator/snapshot.ts';
import * as snapshots from '../../../src/orchestrator/snapshot.ts';
import { describe, renderDescription } from '../../../src/cli/requests.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { contentHash } from '../../../src/kernel/ids.ts';
import { journalPath, orchLedger } from '../../../src/paths.ts';
import { CT, JT } from '../../../src/types.ts';

const fields = {
  decision_needed: 'Choose the repair scope.',
  options: [{ label: 'Local fix', scope: 'ask', cost: 'one run', risk: 'low', preferred: true }, { label: 'Defer' }],
  facts: ['commit 5ad9ee3', 'run AK', 'log sha abc'], tried: ['reproduced'],
  classification_candidates: [{ label: 'projection loss', evidence: ['digest drops fields'], unproven: ['restart path'] }],
};
async function child(t: TestContext, requireDecision = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-structask-')), inbox = join(root, 'inbox'), journal = join(root, 'journal');
  await mkdir(inbox); const log = await openJournal(journal);
  await log.append(JT.exec, { exec: 'call#1.1', call: 'call' }); await log.close();
  const keys = ['DSA_EXEC', 'DSA_CALL', 'DSA_INBOX', 'DSA_JOURNAL', 'DSA_MODEL', 'DSA_BUDGET', 'DSA_SCHEMA', 'DSA_ASK_REQUIRE_DECISION'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  keys.forEach(k => { delete process.env[k]; });
  Object.assign(process.env, { DSA_EXEC: 'call#1.1', DSA_CALL: 'call', DSA_INBOX: inbox, DSA_JOURNAL: journal, DSA_ASK_REQUIRE_DECISION: String(requireDecision) });
  const history: any[] = [], hooks = new Map<string, any>(); let tool: any, seq = 0;
  const ctx = { isIdle: () => false, sessionManager: { getEntries: () => history }, shutdown() {} };
  registerChild({ on: (name: string, fn: unknown) => hooks.set(name, fn), registerTool: (v: any) => { if (v.name === 'ask') tool = v; },
    appendEntry: (customType: string, data: unknown) => history.push({ type: 'custom', customType, data }) } as any);
  await hooks.get('session_start')({}, ctx);
  t.after(async () => { await hooks.get('session_shutdown')({}, ctx); for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await rm(root, { recursive: true, force: true }); });
  const invoke = (args: unknown) => tool.execute('tool', args, undefined, undefined, ctx);
  const answered = async (args: any) => {
    const qid = contentHash({ exec: 'call#1.1', question: args.question });
    await publishRequest(inbox, { rid: `a${++seq}`, from: 'orch', to: 'call', sseq: seq, kind: 'answer', body: { message: 'Local fix' }, cond: { qid, rev: 1 } });
    const result = await Promise.race([invoke(args), delay(1500).then(() => { throw new Error('ask left a blocked wait'); })]);
    assert.equal(result.content[0].text, 'Local fix');
    return history.filter(e => e.customType === CT.question).at(-1).data;
  };
  return { history, tool, invoke, answered };
}

test('AK1/AK3: tool schema and description; structured session/history/digest preserve metadata and the old qid formula', async t => {
  const c = await child(t);
  for (const key of Object.keys(fields)) assert.ok(c.tool.parameters.properties[key], key);
  assert.match(c.tool.description, /decision_needed/); assert.match(c.tool.description, /scope\/cost\/risk/);
  const q = await c.answered({ question: 'Repair?', ...fields });
  assert.deepEqual(q, { qid: contentHash({ exec: 'call#1.1', question: 'Repair?' }), rev: 1, question: 'Repair?', ...fields });
  assert.deepEqual(recover(c.history).questions.get(q.qid), q);
  assert.deepEqual(new SessionFold('call').update(c.history).questions, [q]);
});

const invalid: [string, unknown][] = [
  ['structured without decision', { options: [] }], ['blank decision', { decision_needed: ' \n' }],
  ['two preferred', { options: [{ label: 'a', preferred: true }, { label: 'b', preferred: true }] }],
  ...['options', 'classification_candidates'].map(k => [`${k} limit`, { [k]: Array.from({ length: 10 }, () => ({ label: 'x' })) }] as [string, unknown]),
  ...['facts', 'tried'].map(k => [`${k} limit`, { [k]: Array(21).fill('x') }] as [string, unknown]),
  ...['question', 'decision_needed'].map(k => [`${k} length`, { [k]: 'x'.repeat(2001) }] as [string, unknown]),
  ...['question', 'decision_needed'].map(k => [`${k} type`, { [k]: 7 }] as [string, unknown]),
  ...['facts', 'tried', 'options', 'classification_candidates'].map(k => [`${k} type`, { [k]: 'no' }] as [string, unknown]),
  ['option object', { options: [null] }], ['option label', { options: [{}] }], ['preferred boolean', { options: [{ label: 'x', preferred: 1 }] }],
  ...['scope', 'cost', 'risk'].flatMap(k => [[`option ${k} type`, { options: [{ label: 'x', [k]: [] }] }], [`option ${k} length`, { options: [{ label: 'x', [k]: 'x'.repeat(2001) }] }]] as [string, unknown][]),
  ['facts item', { facts: [2] }], ['tried length', { tried: ['x'.repeat(2001)] }],
  ['candidate object', { classification_candidates: [2] }], ['candidate label', { classification_candidates: [{}] }],
  ...['evidence', 'unproven'].flatMap(k => [[`candidate ${k} type`, { classification_candidates: [{ label: 'x', [k]: 2 }] }], [`candidate ${k} item`, { classification_candidates: [{ label: 'x', [k]: [true] }] }], [`candidate ${k} length`, { classification_candidates: [{ label: 'x', [k]: ['x'.repeat(2001)] }] }]] as [string, unknown][]),
];
for (const [name, bad] of invalid) test(`AK2: refuses ${name} before writing or waiting, then the child can ask again`, async t => {
  const c = await child(t), before = structuredClone(c.history);
  const args = { question: 'Repair?', decision_needed: 'Choose.', ...(bad as object) };
  if (name === 'structured without decision') delete (args as any).decision_needed;
  const result = await Promise.race([c.invoke(args).then(() => 'resolved', (e: Error) => e.message), delay(400).then(() => 'blocked')]);
  assert.match(result, /^ask refused:/);
  if (name === 'structured without decision' || name === 'blank decision') assert.equal(result, 'ask refused: decision_needed is required (one sentence naming the decision you need), then options');
  assert.deepEqual(c.history, before, 'no question entry or revision side effect');
  assert.equal((await c.answered({ question: 'Repair?', ...fields })).rev, 1);
});

test('AK2: configured strict mode rejects plain ask; default plain asks keep the original data shape', async t => {
  await t.test('strict', async t => {
    const c = await child(t, true);
    const refusal = await Promise.race([c.invoke({ question: 'Repair?' }).then(() => 'resolved', (e: Error) => e.message), delay(400).then(() => 'blocked')]);
    assert.match(refusal, /^ask refused:/);
    assert.equal(c.history.some(e => e.customType === CT.question), false);
    assert.equal((await c.answered({ question: 'Repair?', decision_needed: 'Choose.' })).rev, 1);
  });
  await t.test('default', async t => {
    const c = await child(t);
    const q = await c.answered({ question: 'Repair?' });
    assert.deepEqual(q, { qid: contentHash({ exec: 'call#1.1', question: 'Repair?' }), rev: 1, question: 'Repair?' });
  });
});

test('R-12-AK-2: default plain asks accept long questions unchanged but still refuse non-string questions', async t => {
  const c = await child(t), question = 'x'.repeat(2001);
  assert.throws(() => c.tool.prepareArguments({ question: 7 }), /^Error: ask refused: question must be a string$/);
  await assert.rejects(c.invoke({ question: 7 }), /^Error: ask refused: question must be a string$/);
  assert.deepEqual(c.tool.prepareArguments({ question }), { question });
  const q = await c.answered({ question });
  assert.deepEqual(q, { qid: contentHash({ exec: 'call#1.1', question }), rev: 1, question });
});

test('AK1: exact collection and string limits are accepted, optional option/candidate members stay absent', async t => {
  const c = await child(t);
  const args = { question: 'x'.repeat(2000), decision_needed: 'd'.repeat(2000), options: Array.from({ length: 9 }, () => ({ label: 'o'.repeat(2000) })), facts: Array(20).fill('f'.repeat(2000)), tried: Array(20).fill('t'.repeat(2000)), classification_candidates: Array.from({ length: 9 }, () => ({ label: 'c'.repeat(2000) })) };
  const { qid: _q, rev: _r, ...stored } = await c.answered(args);
  assert.deepEqual(stored, args);
});

test('AK2: askRequireDecision validation, settings and hash; old config hash is unchanged', () => {
  assert.equal(configProblem({ askRequireDecision: true }), undefined);
  assert.equal(configProblem({ askRequireDecision: false }), undefined);
  assert.equal(configProblem({ askRequireDecision: 'true' }), 'askRequireDecision must be a boolean');
  assert.deepEqual(orchestratorSettings({ askRequireDecision: true, ui: true }), { askRequireDecision: true });
  assert.notEqual(configHash({ askRequireDecision: true }), configHash({}));
  assert.equal(configHash({}), contentHash({}).slice(0, 12));
});

test('AK3/AK4/R-12-AK-1: mixed plain/structured describe and status JSON; decision-first parent text', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-ask-projection-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home)); await ledger.append(JT.created, { rid: 'r', wid: 'W' }); await ledger.close();
  const j = await openJournal(journalPath(home, 'W')); await j.append('wf-created', { revision: 1 });
  for (const key of ['plain', 'structured']) await j.append('call', { key, gen: 1, spec: { agent: 'echo' } });
  const plain = { id: 'p', rev: 1, kind: 'question' as const, text: 'Plain?', wid: 'W', call: 'W@1/plain@1', qid: 'p' };
  const structured = { ...plain, id: 's', qid: 's', call: 'W@1/structured@1', text: 'Repair?', ...fields };
  for (const item of [plain, structured]) await j.append(JT.attention, { item }); await j.close();
  const d = await describe(home, { wid: 'W' });
  assert.deepEqual(d.questions, [{ qid: 'p', rev: 1, to: 'W/plain', call: plain.call, text: 'Plain?' }, { qid: 's', rev: 1, to: 'W/structured', call: structured.call, text: 'Repair?', ...fields }]);
  const brief = statusBrief(home);
  assert.deepEqual(brief.active[0]!.asking, [{ to: 'W/plain', qid: 'p', question: 'Plain?' }, { to: 'W/structured', qid: 's', question: 'Repair?', rev: 1, decision_needed: fields.decision_needed }]);
  assert.deepEqual(statusDetail(home, 'W').attention, [plain, structured]);
  const compact = statusView(home).workflows[0]!.attention;
  assert.deepEqual(compact[0], { id: 'p', rev: 1, kind: 'question', text: 'Plain?', call: plain.call, qid: 'p' });
  assert.equal(compact[1]!.decision_needed, fields.decision_needed);
  const text = 'Choose the repair scope.\n1. Local fix (preferred)\n2. Defer\nRepair?';
  assert.ok(presentText(structured).endsWith(text)); assert.ok(presentText(plain).endsWith('Plain?'));
  assert.ok(renderDescription(d).includes(text.split('\n').map(l => `    ${l}`).join('\n')));
  assert.equal(JSON.parse(snapshots.statusText(home, brief)).active[0].asking[1].question, text);
  const oldHome = process.env.DSA_HOME; let tool: any;
  try {
    process.env.DSA_HOME = home;
    registerMain({ on() {}, registerTool(v: unknown) { tool = v; } } as any);
    const result = await tool.execute('status', { action: 'status', wid: 'W', full: true }, undefined, undefined, { cwd: home });
    assert.deepEqual(result.details.attention, [plain, structured]);
    assert.equal(JSON.parse(result.content[0].text).attention[1].text, text);
    assert.equal(JSON.parse(result.content[0].text).attention[0].text, 'Plain?');
  } finally { if (oldHome === undefined) delete process.env.DSA_HOME; else process.env.DSA_HOME = oldHome; }
});
