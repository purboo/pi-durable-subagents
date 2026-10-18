import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, wakeText } from '../../../../src/orchestrator/engine.ts';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { contentHash } from '../../../../src/kernel/ids.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import { describe } from '../../../../src/cli/requests.ts';
import { statusDetail } from '../../../../src/orchestrator/snapshot.ts';
import { settledFacts } from '../../../../src/orchestrator/settled.ts';
import { specDigest } from '../../../../src/requests.ts';
import { JT, type CallResult, type Entry, type EvalToOrch, type OrchToEval, type Request, type RunBody } from '../../../../src/types.ts';
import type { EvaluatorTransport } from '../../../../src/orchestrator/evaluator-client.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

class Evaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (m: EvalToOrch) => void;
  async start(receive: (m: EvalToOrch) => void) { this.receive = receive; }
  send(m: OrchToEval) { this.messages.push(m); }
  async close() {}
}
async function until<T>(get: () => T, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + 5000;
  for (;;) { const value = get(); if (value) return value as NonNullable<T>; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(5); }
}
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-wake-')), cwd = join(home, 'project');
  await mkdir(join(cwd, '.pi/agents'), { recursive: true });
  await writeFile(join(cwd, '.pi/agents/test.md'), '---\nname: test\ndescription: test\n---\nTest.');
  let current: { engine: Engine; ledgers: Ledgers; evaluator: Evaluator } | undefined, seq = 0;
  const start = async () => {
    const ledgers: Ledgers = { home, orch: await openJournal(orchLedger(home)), config: {} }, evaluator = new Evaluator();
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { forwards: true, recovered: true, delay: key => key === 'slow' ? 250 : 0 }),
      { evaluator, discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
    current = { engine, ledgers, evaluator }; await engine.recover();
  };
  const stop = async () => { if (current) { await current.engine.close(); await current.ledgers.orch.close(); current = undefined; } };
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  const send = async (kind: Request['kind'], body: unknown, rid = `req:r${++seq}`) => {
    const req: Request = { rid, from: `cli:${rid}`, to: 'orch', kind, sseq: 1, body };
    await publishRequest(orchInbox(home), req); await current!.engine.intake(); return req;
  };
  const run = async (body: Partial<RunBody> = {}) => {
    const req = await send('run', { cwd, source: 'return null;', ...body });
    const created = current!.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid);
    return { req, wid: created ? String(created.wid) : undefined };
  };
  const wf = (wid: string) => current!.engine.store.workflows.get(wid)!;
  const log = (wid: string) => wf(wid).journal.entries();
  const ev = (wid: string) => Number(current!.evaluator.messages.findLast(m => m.t === 'start' && m.wid === wid && 'ev' in m)?.ev);
  const finish = async (wid: string) => { current!.evaluator.receive({ t: 'done', wid, ev: ev(wid), result: null }); await current!.engine.intake(); };
  const call = async (wid: string, key = 'a@12', command = false) => {
    current!.evaluator.receive({ t: 'call', wid, ev: ev(wid), pos: 0, key, spec: command ? { command: ['true'] } as never : { agent: 'test', task: 'hello' } });
    await until(() => log(wid).some(e => e.type === 'call' && e.key === key));
  };
  const caller = async (key = 'a@12', sealed = true, command = false) => {
    const { wid } = await run(); await call(wid!, key, command);
    if (sealed) { await until(() => log(wid!).some(e => e.type === JT.sealed)); await finish(wid!); }
    return wid!;
  };
  const child = (wid: string, key = 'a@12') => run({ wake: { to: `${wid}/${key}` }, caller: `${wid}@1/${key}@1` });
  await start();
  return { home, cwd, start, stop, send, run, wf, log, finish, call, caller, child, get engine() { return current!.engine; }, get ledgers() { return current!.ledgers; } };
}

const outcome = (entries: readonly Entry[]) => entries.findLast(e => e.type === 'wake-outcome');
test('wake: a sealed caller opens one generation with the pinned bounded message and normal finished attention', async t => {
  const f = await fixture(t), caller = await f.caller(), { req, wid } = await f.child(caller);
  const call = `${wid}@1/cmd@1`;
  await f.wf(wid!).journal.append('call', { key: 'cmd', gen: 1, spec: { command: ['false'] } });
  await f.wf(wid!).journal.append(JT.sealed, { call, result: { key: 'cmd', gen: 1, status: 'failed', ok: false, output: 'wake-out\n', data: { exitCode: 3, signal: null, durationMs: 1000 } } });
  await f.finish(wid!);
  const opened = f.log(caller).filter(e => e.type === 'generation');
  assert.equal(opened.length, 1); assert.equal(opened[0]!.gen, 2);
  const message = (opened[0]!.opening as { message: string }).message;
  assert.ok(message.startsWith(`Durable run ${req.rid.slice(4)} (${wid}) that you started with --wake caller finished: done.\n`));
  assert.match(message, /cmd: failed exit 3 \(1000ms\)/); assert.match(message, /wake-out/); assert.ok(message.length <= 4000);
  assert.equal(outcome(f.log(wid!))?.state, 'applied');
  assert.deepEqual((await describe(f.home, { wid: wid! })).wake, { to: `${caller}/a@12`, state: 'applied', rev: 1, generation: 2 });
  assert.ok(f.log(wid!).some(e => e.type === JT.attention && (e.item as { id: string }).id === `finished:${wid}`));
  await publishRequest(orchInbox(f.home), req); await f.engine.intake();
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1, 'same run id retains its first result');
  const wakeRequest = f.log(wid!).find(e => e.type === 'wake-request')!.request as Request;
  await publishRequest(orchInbox(f.home), wakeRequest); await f.engine.intake();
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1, 'retry of the derived wake id gets its first decision');
  assert.equal((await describe(f.home, { wid: wid! })).wake?.state, 'applied');
  const normal = f.log(wid!).find(e => e.type === JT.attention && (e.item as { id: string }).id === `finished:${wid}`)!;
  assert.doesNotMatch((normal.item as { text: string }).text, /wake-out/, 'origin attention retains its existing command digest');
  await f.send('prune', { wid });
  const pruned = await describe(f.home, { wid: wid! });
  assert.equal(pruned.state, 'pruned'); assert.deepEqual(pruned.wake, { to: `${caller}/a@12`, state: 'applied', rev: 1, generation: 2 });
});

test('wake: running caller receives a forward and reopens when that follow-up is undelivered', async t => {
  const f = await fixture(t), caller = await f.caller('slow', false), { wid } = await f.child(caller, 'slow');
  await f.finish(wid!);
  assert.equal(f.log(caller).filter(e => e.type === 'forward').length, 1);
  assert.equal(outcome(f.log(wid!))?.state, 'applied');
  const opened = await until(() => f.log(caller).find(e => e.type === 'generation'));
  assert.equal(opened.gen, 2); assert.match((opened.opening as { message: string }).message, /--wake caller finished: done/);
});

test('wake: stopped caller is durably skipped', async t => {
  const f = await fixture(t), caller = await f.caller(), { wid } = await f.child(caller);
  // A stopped latest generation must never be reopened by a wake.
  await f.wf(caller).journal.append('generation', { key: 'a@12', gen: 2, revision: 1, spec: { agent: 'test', task: 't' }, from: `${caller}@1/a@12@1`, rid: 'manual', opening: { message: 't' } });
  await f.wf(caller).journal.append(JT.sealed, { call: `${caller}@1/a@12@2`, result: { key: 'a@12', gen: 2, status: 'stopped', ok: false, output: '' } });
  await f.finish(wid!);
  assert.equal(outcome(f.log(wid!))?.state, 'skipped'); assert.equal(outcome(f.log(wid!))?.reason, 'caller stopped');
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1);
  await f.stop(); await f.start();
  assert.equal(f.log(wid!).filter(e => e.type === 'wake-outcome').length, 1);
});

for (const fate of ['pruned', 'retired', 'pins'] as const) test(`wake: ${fate} caller refuses the follow-up durably`, async t => {
  const f = await fixture(t), caller = await f.caller(), { wid } = await f.child(caller);
  if (fate === 'pruned') await f.send('prune', { wid: caller });
  if (fate === 'retired') await f.send('revise', { wid: caller, source: 'return 2;' });
  if (fate === 'pins') { await f.stop(); await f.start(); await writeFile(join(f.home, 'w', caller, 'pinned', 'script.js'), 'broken'); }
  await f.finish(wid!);
  assert.equal(outcome(f.log(wid!))?.state, 'rejected'); assert.ok(outcome(f.log(wid!))?.reason);
  await f.engine.intake(); assert.equal(f.log(wid!).filter(e => e.type === 'wake-outcome').length, 1);
});

for (const bad of ['missing', 'pruned', 'key', 'command', 'revision', 'address'] as const) test(`wake admission rejects ${bad} before creating a workflow`, async t => {
  const f = await fixture(t), caller = await f.caller('a', true, bad === 'command');
  if (bad === 'pruned') await f.send('prune', { wid: caller });
  const wid = bad === 'missing' ? 'MISSING' : caller, key = bad === 'key' ? 'absent' : 'a';
  const r = await f.run({ wake: { to: `${wid}/${bad === 'address' ? 'other' : key}` }, caller: `${wid}@${bad === 'revision' ? 2 : 1}/${key}@1` });
  assert.equal(r.wid, undefined);
  const rejected = f.ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === r.req.rid);
  assert.match(String(rejected?.reason), /^wake caller: /);
});

for (const cut of ['done', 'send-effect', 'decision', 'outcome'] as const) test(`wake recovery at ${cut} delivers exactly once`, async t => {
  const f = await fixture(t), caller = await f.caller(), { wid } = await f.child(caller);
  const wf = f.wf(wid!);
  // Inject the cut on a committed journal/ledger boundary; do not alter or truncate durable history.
  await wf.journal.append(JT.done, { status: 'done' });
  if (cut !== 'done') {
    const request: Request = { rid: `wake-${contentHash([wf.wake!.rid, 1]).slice(0, 32)}`, from: `wake:${wf.wake!.rid}:1`, to: 'orch', sseq: 1, kind: 'send', cond: { epoch: `${caller}@1` }, body: { to: `${caller}/a@12`, kind: 'follow-up', message: 'pinned before crash' } };
    await wf.journal.append('wake-request', { rev: 1, request });
    await f.ledgers.orch.append('request', { request });
    await f.ledgers.orch.append('admitted', { rid: request.rid, from: request.from, sseq: 1, kind: 'send', hash: contentHash(request) });
    await f.wf(caller).journal.append('generation', { rid: request.rid, key: 'a@12', gen: 2, revision: 1, spec: { agent: 'test', task: 'hello' }, from: `${caller}@1/a@12@1`, opening: { rid: request.rid, message: 'pinned before crash' } });
    if (cut === 'decision' || cut === 'outcome') await f.ledgers.orch.append('applied', { rid: request.rid });
    if (cut === 'outcome') await wf.journal.append('wake-outcome', { rev: 1, state: 'applied', generation: 2 });
  }
  await f.stop(); await f.start();
  await until(() => outcome(f.log(wid!)));
  assert.equal(outcome(f.log(wid!))?.state, 'applied');
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1);
  await f.stop(); await f.start(); await f.engine.intake();
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1);
  assert.equal(f.log(wid!).filter(e => e.type === 'wake-outcome').length, 1);
});

test('awaiting follows pending → running → finished → absent, ordered and restricted to caller revision; pending wake refuses prune and settle', async t => {
  const f = await fixture(t), caller = await f.caller();
  const req: Request<RunBody> = { rid: 'req:pending', from: 'cli:pending', to: 'orch', sseq: 1, kind: 'run', body: { cwd: f.cwd, source: 'return null;', wake: { to: `${caller}/a@12` }, caller: `${caller}@1/a@12@7` } };
  await f.engine.store.stage(req);
  await f.ledgers.orch.append('request', { request: req });
  await f.ledgers.orch.append('admitted', { rid: req.rid, from: req.from, sseq: 1, kind: 'run', hash: contentHash(req) });
  const awaiting = async () => (await describe(f.home, { wid: caller })).calls![0]!.awaiting;
  assert.deepEqual(await awaiting(), [{ request: 'pending', state: 'pending' }]);
  await f.engine.intake();
  const wid = String(f.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!.wid);
  assert.deepEqual(await awaiting(), [{ request: 'pending', wid, state: 'running' }]);
  assert.deepEqual(statusDetail(f.home, caller).calls[0]!.awaiting, await awaiting());
  await f.wf(wid).journal.append(JT.done, { status: 'done' });
  assert.deepEqual(await awaiting(), [{ request: 'pending', wid, state: 'finished' }]);
  assert.equal(settledFacts(f.wf(wid), () => true), 'wake pending');
  const prune = await f.send('prune', { wid });
  assert.equal(f.ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === prune.rid)?.reason, 'wake pending');
  assert.equal(await awaiting(), undefined);
  // A prior revision's run is excluded, even though its own wake has not been decided.
  await f.ledgers.orch.append('request', { request: { ...req, rid: 'req:old', body: { ...req.body, caller: `${caller}@0/a@12@1` } } });
  assert.equal(await awaiting(), undefined);
});

test('wake: each completion revision delivers once and holds use the existing generation dispatch rule', async t => {
  const f = await fixture(t), caller = await f.caller(), { wid } = await f.child(caller);
  await f.send('drain', { wid: caller });
  await f.finish(wid!);
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 1);
  assert.equal(f.log(caller).filter(e => e.type === 'fake-run' && String(e.call).endsWith('@2')).length, 0, 'held generation does not run');
  await f.send('resume', { wid: caller });
  await until(() => f.log(caller).some(e => e.type === JT.sealed && String(e.call).endsWith('@2')));
  await f.send('revise', { wid, source: 'return 2;' }); await f.finish(wid!);
  assert.deepEqual(f.log(wid!).filter(e => e.type === 'wake-outcome').map(e => [e.rev, e.state, e.generation]), [[1, 'applied', 2], [2, 'applied', 3]]);
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 2);
  await f.stop(); await f.start();
  assert.equal(f.log(caller).filter(e => e.type === 'generation').length, 2);
});

test('awaiting indexes matching runs in admission order without touching unrelated workflow journals', async t => {
  const f = await fixture(t), caller = await f.caller(), first = await f.child(caller), second = await f.child(caller);
  await mkdir(join(f.home, 'w', 'UNRELATED'), { recursive: true });
  await writeFile(join(f.home, 'w', 'UNRELATED', 'journal.jsonl'), 'invalid journal that must not be read\n');
  const expected = [first, second].map(r => ({ request: r.req.rid.slice(4), wid: r.wid, state: 'running' }));
  assert.deepEqual((await describe(f.home, { wid: caller })).calls![0]!.awaiting, expected);
  assert.deepEqual(statusDetail(f.home, caller).calls[0]!.awaiting, expected);
  const pending = ['early-envelope', 'later-envelope'].map(id => ({ rid: `req:${id}`, from: `cli:${id}`, to: 'orch', sseq: 1, kind: 'run' as const, body: { cwd: f.cwd, source: 'return 1;', caller: `${caller}@1/a@12@1`, wake: { to: `${caller}/a@12` } } }));
  for (const request of pending) await f.ledgers.orch.append('request', { request });
  assert.deepEqual((await describe(f.home, { wid: caller })).calls![0]!.awaiting, expected, 'unadmitted envelopes are excluded');
  for (const request of [...pending].reverse()) await f.ledgers.orch.append('admitted', { rid: request.rid, from: request.from, sseq: 1, kind: 'run', hash: contentHash(request) });
  assert.deepEqual((await describe(f.home, { wid: caller })).calls![0]!.awaiting, [...expected, { request: 'later-envelope', state: 'pending' }, { request: 'early-envelope', state: 'pending' }]);
});

test('describe sealedAt follows the latest generation seal and is absent while it runs (R-11-2)', async t => {
  const f = await fixture(t), wid = await f.caller('slow', false);
  await f.wf(wid).journal.append(JT.exec, { call: `${wid}@1/slow@1`, exec: `${wid}@1/slow@1#1.1` });
  await f.wf(wid).journal.append('selected', { exec: `${wid}@1/slow@1#1.1`, model: { provider: 'test', id: 'fake' } });
  const initial = (await describe(f.home, { wid })).calls![0]!;
  assert.equal(initial.phase, 'running'); assert.equal(initial.sealedAt, undefined);
  const first = await until(() => f.log(wid).find(e => e.type === JT.sealed && e.call === `${wid}@1/slow@1`));
  await f.finish(wid);
  assert.equal((await describe(f.home, { wid })).calls![0]!.sealedAt, first.ts);
  await f.send('send', { to: `${wid}/slow`, kind: 'follow-up', message: 'again' });
  await f.wf(wid).journal.append(JT.exec, { call: `${wid}@1/slow@2`, exec: `${wid}@1/slow@2#1.1` });
  await f.wf(wid).journal.append('selected', { exec: `${wid}@1/slow@2#1.1`, model: { provider: 'test', id: 'fake' } });
  const running = (await describe(f.home, { wid })).calls![0]!;
  assert.equal(running.gen, 2); assert.equal(running.phase, 'running'); assert.equal(running.sealedAt, undefined);
  const second = await until(() => f.log(wid).find(e => e.type === JT.sealed && e.call === `${wid}@1/slow@2`));
  assert.equal((await describe(f.home, { wid })).calls![0]!.sealedAt, second.ts);
  assert.ok(second.ts > first.ts);
});

test('request digest retains old bytes, ignores caller generations and hashes wake routing', () => {
  const body = { cwd: '/w', call: { command: ['true'] } }, old = contentHash({ kind: 'run', body, cond: undefined });
  assert.equal(specDigest({ kind: 'run', body }), old);
  const run = { kind: 'run' as const, body: { ...body, wake: { to: 'W/a@12' }, caller: 'W@1/a@12@1' } };
  assert.notEqual(specDigest(run), old);
  assert.equal(specDigest(run), specDigest({ ...run, body: { ...run.body, caller: 'W@1/a@12@9' } }));
  assert.notEqual(specDigest(run), specDigest({ ...run, body: { ...run.body, wake: { to: 'W/b' } } }));
});

test('wake text caps calls/output, retains output tail and never invents agent exit codes', () => {
  const entries: Entry[] = [{ seq: 1, ts: 0, type: 'wf-created', revision: 1 }];
  for (let n = 0; n < 22; n++) {
    const key = `c${n}`;
    entries.push({ seq: entries.length + 1, ts: 1, type: 'call', key, gen: 1, spec: { agent: 'test' } });
    entries.push({ seq: entries.length + 1, ts: 2, type: JT.sealed, call: `W@1/${key}@1`, result: { key, gen: 1, status: 'ok', ok: true, output: `${'x'.repeat(500)}TAIL`, data: { exitCode: 42 } } satisfies CallResult });
  }
  const done: Entry = { seq: entries.length + 1, ts: 3, type: JT.done, status: 'done' }; entries.push(done);
  const message = wakeText('R', 'W', done, entries);
  assert.ok(message.length <= 4000); assert.match(message, /… 2 more/); assert.doesNotMatch(message.split('\n').slice(1, 21).join('\n'), /exit/);
  const command: Entry[] = [
    { seq: 1, ts: 0, type: 'call', key: 'cmd', gen: 1, spec: { command: ['sh'] } },
    { seq: 2, ts: 1, type: JT.sealed, call: 'W@1/cmd@1', result: { key: 'cmd', gen: 1, status: 'failed', ok: false, output: `${'old output '.repeat(2000)}END-TAIL`, data: { exitCode: null, signal: 'SIGTERM', durationMs: 10 } } },
    { seq: 3, ts: 2, type: JT.done, status: 'done' },
  ];
  const clipped = wakeText('signal', 'W', command[2]!, command);
  assert.ok(clipped.length <= 4000); assert.match(clipped, /cmd: failed signal SIGTERM \(10ms\)/); assert.match(clipped, /END-TAIL/);
});
