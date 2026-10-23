import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FAUX, REPO, script, tempRoot } from '../../harness/pi.ts';
import { callSession, journalPath, orchLedger } from '../../../src/paths.ts';
import { readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { SessionFold } from '../../../src/orchestrator/executor/digest.ts';
import { describe } from '../../../src/cli/requests.ts';
import { statusBrief, statusView, statusText } from '../../../src/orchestrator/snapshot.ts';
import { presentText } from '../../../src/agent/main/snapshots.ts';
import { CT, JT } from '../../../src/types.ts';

const fields = {
  decision_needed: 'Choose the repair scope.',
  options: [{ label: 'Local fix', scope: 'ask', cost: 'one run', risk: 'low', preferred: true }, { label: 'Defer' }],
  facts: ['commit 5ad9ee3', 'run AK', 'log sha abc'], tried: ['reproduced'],
  classification_candidates: [{ label: 'projection loss', evidence: ['digest drops fields'], unproven: ['restart path'] }],
};
async function stack(t: TestContext) {
  const root = tempRoot('dsa-e2e-structask-'), home = join(root, 'dsa'), cwd = join(root, 'work'), agentDir = join(root, 'agent');
  for (const dir of [join(cwd, '.pi/agents'), home, agentDir]) await mkdir(dir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [FAUX], defaultProvider: 'probe', defaultModel: 'scripted' }));
  await writeFile(join(cwd, '.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nYou echo.\n');
  const config = async (strict: boolean) => writeFile(join(home, 'config.json'), JSON.stringify({ askRequireDecision: strict, k: { hibernateMs: 250, checkpointMs: 50 } }));
  await config(false);
  const cli = (args: string[]) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, 'src/cli/main.ts'), ...args], { cwd, env: { PATH: `${join(REPO, 'node_modules/.bin')}:${process.env.PATH}`, HOME: root, DSA_HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PROBE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timeout: ${args.join(' ')}`)); }, 60_000);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`CLI exit ${code}: ${out} ${err}`)); else resolve(out.trim()); });
  });
  const json = async (args: string[]) => JSON.parse(await cli([...args, '--json']));
  const until = async <T>(get: () => T | false | undefined | Promise<T | false | undefined>, what: string, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const value = await get(); if (value) return value; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
  };
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const pids = () => ledger().filter(e => e.type === 'orchestrator').map(e => Number(e.pid));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await until(() => pids().every(pid => !alive(pid)), 'cleanup', 15_000).catch(() => { for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });
  const run = async (id: string, steps: unknown[]) => {
    const path = join(root, `${id}.json`); await writeFile(path, JSON.stringify({ agent: 'echo', writer: false, task: script(steps) }));
    return { ...(await json(['run', '--request', id, '--spec', path])), path };
  };
  const asking = (id: string) => until(async () => { const d = await json(['describe', '--key', id]); return d.state === 'asking' && d; }, `ask ${id}`);
  const answer = async (id: string, q: any) => json(['send', '--request', `answer-${id}`, '--to', id, '--kind', 'answer', '--qid', q.qid, '--rev', String(q.rev), '--message', 'Local fix']);
  const sealed = (id: string) => until(async () => { const d = await json(['describe', '--key', id]); return d.state === 'sealed' && d; }, `seal ${id}`);
  const rows = async (wid: string, key: string) => {
    const text = await readFile(callSession(home, wid, key, 1), 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  return { home, config, cli, json, until, ledger, journal, pids, alive, run, asking, answer, sealed, rows };
}

test('AK3/AK4: structured ask survives session → digest → attention → describe/status and orchestrator restart, then receives its answer', { timeout: 180_000 }, async t => {
  const s = await stack(t), question = `Repair? ${'Full question. '.repeat(35)}`;
  const started = await s.run('structured', [{ tool: 'ask', args: { question, ...fields } }, { text: 'answered' }]);
  const d = await s.asking('structured'), q = d.questions[0], key = d.calls[0].key, wid = started.wid;
  const expected = { qid: q.qid, rev: 1, to: `${wid}/${key}`, call: `${wid}@1/${key}@1`, text: question, ...fields };
  assert.deepEqual(q, expected);
  assert.deepEqual((await s.json(['describe', wid])).questions, [expected]);
  assert.deepEqual((await describe(s.home, { request: 'structured' })).questions, [expected]);
  const entries = await s.rows(wid, key), data = entries.find(e => e.customType === CT.question).data;
  assert.deepEqual(data, { qid: q.qid, rev: 1, question, ...fields });
  assert.deepEqual(new SessionFold(q.call).update(entries).questions, [data]);
  const item = s.journal(wid).find(e => e.type === JT.attention && (e.item as any).qid === q.qid)!.item as any;
  for (const [k, value] of Object.entries(fields)) assert.deepEqual(item[k], value);
  assert.deepEqual((await s.json(['status', wid])).attention, [item]);
  assert.equal(statusView(s.home).workflows[0]!.attention[0]!.decision_needed, fields.decision_needed);
  const brief = statusBrief(s.home), bq = brief.active[0]!.asking![0]!;
  assert.equal(bq.rev, 1); assert.equal(bq.decision_needed, fields.decision_needed); assert.notEqual(bq.question, question);
  const text = `${fields.decision_needed}\n1. Local fix (preferred)\n2. Defer\n${question}`;
  assert.ok(presentText(item).endsWith(text)); assert.equal(JSON.parse(statusText(s.home, brief)).active[0].asking[0].question, text);
  await s.until(() => s.journal(wid).some(e => e.type === 'hibernated'), 'hibernate before restart');
  const pid = s.pids().at(-1)!; process.kill(pid, 'SIGKILL'); await s.until(() => !s.alive(pid), 'orchestrator killed');
  await s.json(['run', '--request', 'structured', '--spec', started.path]);
  await s.until(() => s.pids().length >= 2, 'successor started');
  assert.deepEqual((await s.asking('structured')).questions, [expected]);
  assert.deepEqual((await s.json(['status', wid])).attention, [item]);
  assert.equal((await s.answer('structured', q)).applied, true);
  const done = await s.sealed('structured'); assert.equal(done.questions, undefined); assert.equal(done.calls[0].ok, true); assert.equal(done.calls[0].output, 'answered');
  assert.equal(s.journal(wid).filter(e => e.type === JT.attention && (e.item as any).kind === 'question').length, 1);
});

test('AK2: real pi refusal errors leave no question/attention/wait or revision bump; a corrected ask can be answered', { timeout: 180_000 }, async t => {
  const s = await stack(t);
  const bad = [
    { question: 'Repair?', options: [] }, { question: 'Repair?', decision_needed: ' ' },
    { question: 'Repair?', decision_needed: 'Choose.', options: [{ label: 'a', preferred: true }, { label: 'b', preferred: true }] },
    { question: 'Repair?', decision_needed: 'Choose.', facts: Array(21).fill('fact') },
    { question: 'Repair?', decision_needed: 'Choose.', options: Array(10).fill({ label: 'x' }) },
    { question: 'Repair?', decision_needed: 'Choose.', tried: ['x'.repeat(2001)] },
    { question: 'Repair?', decision_needed: 'Choose.', facts: 'wrong type' },
    { question: 'Repair?', decision_needed: 'Choose.', options: [{ label: 'x', preferred: 'yes' }] },
  ];
  const started = await s.run('refusal', [...bad.map(args => ({ tool: 'ask', args })), { tool: 'ask', args: { question: 'Repair?', ...fields } }, { text: 'recovered' }]);
  const d = await s.asking('refusal'), key = d.calls[0].key;
  assert.equal(d.questions.length, 1); assert.equal(d.questions[0].rev, 1);
  const entries = await s.rows(started.wid, key), errors = entries.filter(e => e.message?.role === 'toolResult' && e.message.toolName === 'ask');
  assert.equal(errors.length, bad.length);
  for (const e of errors) { assert.equal(e.message.isError, true); assert.match(e.message.content[0].text, /^ask refused:/); }
  assert.equal(entries.filter(e => e.customType === CT.question).length, 1);
  assert.equal(s.journal(started.wid).filter(e => e.type === JT.attention && (e.item as any).kind === 'question').length, 1);
  await s.answer('refusal', d.questions[0]); assert.equal((await s.sealed('refusal')).calls[0].output, 'recovered');
});

test('AK2: config is snapshotted per execution; strict mode refuses plain asks, later default executions accept the unchanged shape', { timeout: 180_000 }, async t => {
  const s = await stack(t); await s.config(true);
  const started = await s.run('strict', [{ delayMs: 3000, tool: 'ask', args: { question: 'Plain?' } }, { tool: 'ask', args: { question: 'Repair?', ...fields } }, { text: 'strict done' }]);
  await s.until(() => s.journal(started.wid).some(e => e.type === 'tracked'), 'strict execution started');
  await s.config(false);
  await s.until(() => s.ledger().findLast(e => e.type === 'config')?.config && (s.ledger().findLast(e => e.type === 'config')!.config as any).askRequireDecision === false, 'config reload');
  const d = await s.asking('strict'), entries = await s.rows(started.wid, d.calls[0].key);
  const refused = entries.find(e => e.message?.role === 'toolResult' && e.message.toolName === 'ask');
  assert.match(refused.message.content[0].text, /^ask refused: decision_needed is required/);
  assert.equal(entries.filter(e => e.customType === CT.question).length, 1);
  await s.answer('strict', d.questions[0]); await s.sealed('strict');
  const plain = await s.run('plain', [{ tool: 'ask', args: { question: 'Plain?' } }, { text: 'plain done' }]);
  const pd = await s.asking('plain'), q = pd.questions[0];
  assert.deepEqual(q, { qid: q.qid, rev: 1, to: `${plain.wid}/${pd.calls[0].key}`, call: q.call, text: 'Plain?' });
  await s.until(() => s.journal(plain.wid).some(e => e.type === 'hibernated'), 'plain ask hibernated');
  await s.until(() => statusBrief(s.home).active[0]?.asking?.[0]?.hibernated === true, 'plain hibernation visible in status');
  assert.deepEqual(statusBrief(s.home).active[0]!.asking![0], { to: q.to, qid: q.qid, hibernated: true, question: 'Plain?' });
  await s.answer('plain', q); assert.equal((await s.sealed('plain')).calls[0].output, 'plain done');
});
