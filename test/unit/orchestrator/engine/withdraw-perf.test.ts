import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import type { Executor, Ledgers } from '../../../../src/orchestrator/contract.ts';
import type { Workflow } from '../../../../src/orchestrator/store.ts';
import { JT, type Entry, type JournalHandle, type Request } from '../../../../src/types.ts';

function memoryJournal(initial: ({ type: string } & Record<string, unknown>)[], opts: { loaded?: boolean; onRead?: () => void } = {}): JournalHandle {
  const entries: Entry[] = initial.map((e, i) => ({ seq: i + 1, ts: i + 1, ...e }));
  let loaded = opts.loaded ?? true;
  const read = () => {
    opts.onRead?.();
    loaded = true;
    return entries;
  };
  return {
    path: '/dev/null',
    get loaded() { return loaded; },
    count: () => entries.length,
    entries: read,
    committed: read,
    async append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>> {
      loaded = true;
      const entry: Entry<T> = { seq: entries.length + 1, ts: Date.now(), type, ...fields };
      entries.push(entry);
      return entry;
    },
    async close() {},
  };
}

function syntheticWorkflow(wid: string, revision: number, journal: JournalHandle, extra: Partial<Workflow> = {}): Workflow {
  return {
    wid,
    revision,
    origin: 'main:test',
    cwd: '/project',
    journal,
    pins: { source: '', args: null, agents: [], inputs: {} },
    scriptPath: '/project/script.js',
    inputs: {},
    ...extra,
  };
}

async function setup(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-withdraw-perf-'));
  const orch = await openJournal(orchLedger(home));
  const ledgers: Ledgers = { home, config: {}, orch };
  const forwards: { rid: string; kind: string; widRev: string; key: string; gen: number }[] = [];
  const stops: { wid: string; callId?: string }[] = [];
  const executor: Executor = {
    async run() { throw new Error('unexpected run'); },
    async forward(req, ctx) {
      forwards.push({ rid: req.rid, kind: req.kind, widRev: ctx.widRev, key: ctx.key, gen: ctx.gen });
      return { action: 'apply' };
    },
    async stop(target) { stops.push(target); },
    async recover() {},
    async retire() {},
    busy: () => false,
    async suspend() {},
    async shutdown() {},
  };
  const engine = new Engine(ledgers, executor, { evaluator: { async start() {}, send() {}, async close() {} } });
  t.after(async () => {
    await engine.close();
    await orch.close();
    await rm(home, { recursive: true, force: true });
  });
  let sseq = 0;
  const submit = async (rid: string, kind: Request['kind'], body: unknown, extra: Partial<Request> = {}) => {
    const req: Request = { rid, from: 'main:test', to: 'orch', sseq: ++sseq, kind, body, ...extra };
    await publishRequest(orchInbox(home), req);
    await engine.intake();
    return req;
  };
  const decision = (rid: string) => orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
  return { home, orch, engine, forwards, stops, submit, decision };
}

test('findCall resolves full, key, slash/at keys, multi-gen, bare wid and prefix-sharing wids accurately', async t => {
  const { engine } = await setup(t);
  let w1Reads = 0;
  const w1 = syntheticWorkflow('w1', 1, memoryJournal([
    { type: 'call', pos: 0, key: 'solo', gen: 1, spec: { agent: 'test', task: '1' } },
    { type: 'generation', key: 'solo', gen: 2, revision: 1, from: 'w1@1/solo@1', spec: { agent: 'test', task: '2' } },
  ], { loaded: false, onRead: () => { w1Reads++; } }));
  const w10 = syntheticWorkflow('w10', 2, memoryJournal([
    { type: 'call', pos: 0, key: 'old', gen: 1, spec: { agent: 'test', task: 'old' } },
    { type: 'revised', revision: 2 },
    { type: 'call', pos: 0, key: 'dir/sub@k', gen: 1, spec: { agent: 'test', task: 'a' } },
    { type: 'call', pos: 1, key: 'second', gen: 1, spec: { agent: 'test', task: 'b' } },
  ]));
  const empty = syntheticWorkflow('wempty', 1, memoryJournal([]));
  engine.store.workflows.set(w1.wid, w1);
  engine.store.workflows.set(w10.wid, w10);
  engine.store.workflows.set(empty.wid, empty);

  const findCall = (to: unknown, bareWid = false) =>
    (engine as unknown as { findCall(to: unknown, bareWid?: boolean): { wf: Workflow; entry: Entry } | undefined }).findCall(to, bareWid);

  // Prefix-sharing wid w10 does not touch lazy w1.
  assert.equal(findCall('w10/dir/sub@k')?.entry.key, 'dir/sub@k');
  assert.equal(findCall('w10@2/dir/sub@k@1')?.entry.key, 'dir/sub@k');
  assert.equal(findCall('w10@1/old@1'), undefined, 'stale revision does not match');
  assert.equal(findCall('w10/old'), undefined, 'prior revision key does not match');
  assert.equal(findCall('w10', true), undefined, 'bare wid requires exactly one key');
  assert.equal(findCall('wempty', true), undefined, 'bare wid with zero calls does not match');
  assert.equal(w1Reads, 0, 'prefix-sharing w10 never read lazy w1');

  // Bare wid with bareWid=false does not match or decode lazy w1.
  assert.equal(findCall('w1', false), undefined);
  assert.equal(w1Reads, 0, 'bare wid with bareWid=false skips decoding lazy journal');

  // Bare wid with bareWid=true matches single-key workflow and returns its latest generation.
  const bare = findCall('w1', true);
  assert.equal(bare?.wf, w1);
  assert.equal(bare?.entry.key, 'solo');
  assert.equal(bare?.entry.gen, 2);

  // Addressing an earlier gen of the current revision resolves to the latest gen of that key.
  const viaGen1 = findCall('w1@1/solo@1', false);
  assert.equal(viaGen1?.entry.key, 'solo');
  assert.equal(viaGen1?.entry.gen, 2);

  // Unknown and malformed inputs return undefined safely.
  assert.equal(findCall('absent/k', true), undefined);
  assert.equal(findCall('', true), undefined);
  assert.equal(findCall(undefined, true), undefined);
  assert.equal(findCall(null, true), undefined);
  assert.equal(findCall(123, true), undefined);
});

test('withdraw deduplicates per (wf, key), supports bare wid and multi-gen, preserves ledger order and handles replaces', async t => {
  const { engine, forwards, submit, decision } = await setup(t);
  const w1 = syntheticWorkflow('w1', 1, memoryJournal([
    { type: 'call', pos: 0, key: 'solo', gen: 1, spec: { agent: 'test', task: '1' } },
    { type: 'generation', key: 'solo', gen: 2, revision: 1, from: 'w1@1/solo@1', spec: { agent: 'test', task: '2' } },
  ]));
  const w2 = syntheticWorkflow('w2', 2, memoryJournal([
    { type: 'call', pos: 0, key: 'stale', gen: 1, spec: { agent: 'test', task: 'stale' } },
    { type: 'revised', revision: 2 },
    { type: 'call', pos: 0, key: 'alpha', gen: 1, spec: { agent: 'test', task: 'a' } },
    { type: 'call', pos: 1, key: 'beta', gen: 1, spec: { agent: 'test', task: 'b' } },
  ]));
  engine.store.workflows.set(w1.wid, w1);
  engine.store.workflows.set(w2.wid, w2);

  // Submit sends in a specific ledger order across w2 and w1, including different address forms for (w1, solo).
  await submit('s-w2-beta', 'send', { to: 'w2/beta', kind: 'steer', message: '1' });
  await submit('s-w1-bare', 'send', { to: 'w1', kind: 'steer', message: '2' });
  await submit('s-w1-full', 'send', { to: 'w1@1/solo@1', kind: 'steer', message: '3' });
  await submit('s-w1-key', 'send', { to: 'w1/solo', kind: 'steer', message: '4' });
  await submit('s-w2-alpha', 'send', { to: 'w2@2/alpha@1', kind: 'steer', message: '5' });
  await submit('s-w2-stale', 'send', { to: 'w2@1/stale@1', kind: 'steer', message: '6' });
  await submit('s-absent', 'send', { to: 'missing/k', kind: 'steer', message: '7' });
  assert.equal(decision('s-w2-stale')?.reason, 'stale-revision');

  forwards.length = 0;

  // Withdraw passes rids in scrambled order with duplicates and unseen rids.
  await submit('w-all', 'withdraw', {
    rids: ['s-w2-alpha', 's-w1-key', 'unseen', 's-w2-stale', 's-absent', 's-w1-full', 's-w1-bare', 's-w2-beta', 's-w2-beta'],
  });
  assert.equal(decision('w-all')?.type, JT.applied);
  // Each distinct (wf, key) is forwarded once, in original send ledger order, to its latest generation.
  assert.deepEqual(forwards, [
    { rid: 'w-all', kind: 'withdraw', widRev: 'w2@2', key: 'beta', gen: 1 },
    { rid: 'w-all', kind: 'withdraw', widRev: 'w1@1', key: 'solo', gen: 2 },
    { rid: 'w-all', kind: 'withdraw', widRev: 'w2@2', key: 'alpha', gen: 1 },
  ]);

  // Replaces-style sequence: withdraw + replacement send with cond.after.
  forwards.length = 0;
  await submit('s-rep', 'send', { to: 'w1', kind: 'steer', message: 'replacement' }, { cond: { after: 'w-all' } });
  assert.equal(decision('s-rep')?.type, JT.applied);
  assert.deepEqual(forwards, [
    { rid: 's-rep', kind: 'send', widRev: 'w1@1', key: 'solo', gen: 2 },
  ]);
});

test('withdraw, findCall, send replay paths and scoped resume stay O(1) across 5,000 loaded workflows', async t => {
  const { orch, engine, forwards, stops, submit, decision } = await setup(t);

  const TOTAL = 5_000;
  let unrelatedReads = 0;
  for (let i = 0; i < TOTAL; i++) {
    const wid = `W${String(i).padStart(5, '0')}`;
    const journal = memoryJournal(
      [{ type: 'call', pos: 0, key: 'k', gen: 1, spec: { agent: 'test', task: 't' } }, { type: JT.done, status: 'done' }],
      { loaded: i % 2 === 0, onRead: () => { unrelatedReads++; } },
    );
    engine.store.workflows.set(wid, syntheticWorkflow(wid, 1, journal));
  }

  // Two active workflows at the end of the map.
  const hotA = syntheticWorkflow('WHOT_A', 1, memoryJournal([
    { type: 'call', pos: 0, key: 'worker', gen: 1, spec: { agent: 'test', task: 'a' } },
  ]));
  const hotB = syntheticWorkflow('WHOT_B', 1, memoryJournal([
    { type: 'call', pos: 0, key: 'worker', gen: 1, spec: { agent: 'test', task: 'b' } },
    { type: 'model-choice', rid: 'replay-choice', call: 'WHOT_B@1/worker@1', model: 'openai/gpt-5' },
    { type: 'forward', rid: 'replay-model-fwd', rid2: 'f2', dest: 'WHOT_B@1/worker@1', envelope: { kind: 'model' } },
    { type: 'generation', rid: 'replay-gen', key: 'worker', gen: 2, revision: 1, from: 'WHOT_B@1/worker@1', spec: { agent: 'test', task: 'b2' } },
    { type: 'retired', call: 'WHOT_B@1/worker@2' },
  ]));
  const hotParked = syntheticWorkflow('WHOT_P', 1, memoryJournal([
    { type: JT.done, status: 'done' },
  ]));
  engine.store.workflows.set(hotA.wid, hotA);
  engine.store.workflows.set(hotB.wid, hotB);
  engine.store.workflows.set(hotParked.wid, hotParked);

  // Seed several sends to withdraw.
  await submit('s1', 'send', { to: 'WHOT_A/worker', kind: 'steer', message: 'm1' });
  await submit('s2', 'send', { to: 'WHOT_A', kind: 'steer', message: 'm2' });
  await submit('s3', 'send', { to: 'WHOT_B/worker', kind: 'steer', message: 'm3' });

  forwards.length = 0;
  unrelatedReads = 0;
  const started = performance.now();

  // 20 withdrawals (matching + empty/unseen) + send replay paths + stop + scoped resume.
  for (let i = 0; i < 20; i++) {
    await submit(`wd-${i}`, 'withdraw', { rids: i % 2 === 0 ? ['s1', 's2', 's3'] : ['nonexistent'] });
  }
  await submit('replay-choice', 'send', { to: 'WHOT_B/worker', kind: 'model', model: 'openai/gpt-5' });
  await submit('replay-model-fwd', 'send', { to: 'WHOT_B/worker', kind: 'model', model: 'openai/gpt-5' });
  await submit('replay-gen', 'send', { to: 'WHOT_B/worker', kind: 'follow-up', message: 'again' });
  await submit('stop-call', 'stop', { target: 'WHOT_A/worker' });
  await submit('resume-one', 'resume', { wid: 'WHOT_P' });

  const elapsedMs = performance.now() - started;

  assert.equal(unrelatedReads, 0, 'no unrelated workflow journal was read across 5,000 workflows');
  assert.ok(elapsedMs < 2000, `expected O(1) operations over 5,000 workflows to stay fast, took ${elapsedMs.toFixed(1)}ms`);

  // Verify semantic outcomes of every operation above.
  assert.equal(forwards.filter(f => f.kind === 'withdraw').length, 20, '10 matching withdraws * 2 distinct (wf, key) targets');
  assert.equal(decision('replay-choice')?.type, JT.applied);
  assert.ok(orch.entries().some(e => e.type === 'send-note' && e.rid === 'replay-choice' && e.model === 'openai/gpt-5'));
  assert.equal(decision('replay-model-fwd')?.type, JT.applied);
  assert.equal(decision('replay-gen')?.type, JT.applied);
  assert.equal(decision('stop-call')?.type, JT.applied);
  assert.deepEqual(stops, [{ wid: 'WHOT_A', callId: 'WHOT_A@1/worker@1' }]);
  assert.equal(decision('resume-one')?.type, JT.rejected);
  assert.match(String(decision('resume-one')?.reason), /^terminal:done/);
});
