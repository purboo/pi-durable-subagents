import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import type { Entry, Request } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';
import { baselineConsume } from './intake-oracle.ts';
const request = (rid: string, sseq: number, extra: Partial<Request> = {}): Request => ({ rid, sseq, from: 'a', to: 'orch', kind: 'send', body: { to: 'absent/key', kind: 'steer', message: rid }, ...extra });
const withoutTime = (entries: readonly Entry[]) => entries.map(({ ts: _ts, ...entry }) => entry);

test('incremental engine writes exactly the baseline ledger across gaps, conflicts, dependencies, withdrawals and retries', async t => {
  const homes = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'dsa-intake-equivalence-'))));
  const ledgers: Ledgers[] = await Promise.all(homes.map(async home => ({ home, config: {}, orch: await openJournal(orchLedger(home)) })));
  const engines = ledgers.map(ledger => new Engine(ledger, fakeExecutor(ledger), { evaluator: { async start() {}, send() {}, async close() {} } }));
  Object.defineProperty(engines[0], 'consume', { value: baselineConsume });
  t.after(async () => { for (const [i, engine] of engines.entries()) { await engine.close(); await ledgers[i]!.orch.close(); await rm(homes[i]!, { recursive: true, force: true }); } });
  const streams: Request[][] = [
    [request('gap', 2)],
    [request('first', 1), request('pending', 1, { from: 'b' }), request('dependent', 2, { from: 'b', cond: { after: 'pending' } })],
    [request('pending', 1, { from: 'b', body: { changed: true } }), request('first', 1, { body: { changed: true } })],
    [request('withdraw', 3, { kind: 'withdraw', body: { rids: ['pending', 'unseen', 'withdraw-two', 'pending'] } }), request('withdraw-two', 4, { kind: 'withdraw', body: { rids: ['untouched'] } })],
    [request('unseen', 5), request('malformed', 6, { cond: { after: 'later' } }), request('later', 7), request('unknown-dep', 3, { from: 'b', cond: { after: 'absent' } })],
    [request('withdraw-wait', 4, { from: 'b', kind: 'withdraw', body: { rids: ['later'] }, cond: { after: 'dependent' } })],
    [], [], [request('last', 8)], [],
  ];
  for (let pass = 0; pass < streams.length; pass++) {
    for (const [i, engine] of engines.entries()) {
      Object.defineProperty(engine, 'decide', { configurable: true, value: async (req: Request) => {
        if ((req.rid === 'pending' && pass < 5) || (req.rid === 'dependent' && pass < 7)) return { action: 'defer' };
        await ledgers[i]!.orch.append('test-effect', { rid: req.rid });
        return req.rid === 'last' ? { action: 'apply' } : { action: 'reject', reason: 'domain' };
      } });
      // A conflicting file can replace a prior file that still waits in the inbox.
      for (const req of streams[pass]!) {
        await unlink(join(orchInbox(homes[i]!), `${req.rid}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await publishRequest(orchInbox(homes[i]!), req);
      }
      await ledgers[i]!.orch.append('test-unrelated', { pass });
      await engine.intake();
    }
    assert.deepEqual(withoutTime(ledgers[1]!.orch.entries()), withoutTime(ledgers[0]!.orch.entries()), `pass ${pass}`);
    assert.deepEqual(await readdir(orchInbox(homes[1]!)), await readdir(orchInbox(homes[0]!)), `inbox pass ${pass}`);
  }
});

test('a caught-up intake reads only the appended ledger suffix, including resolution of retained requests', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-intake-watermark-'));
  const orch = await openJournal(orchLedger(home)), ledgers: Ledgers = { home, config: {}, orch };
  const engine = new Engine(ledgers, fakeExecutor(ledgers), { evaluator: { async start() {}, send() {}, async close() {} } });
  t.after(async () => { await engine.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  const pending = request('pending', 1);
  await orch.append('request', { request: pending });
  await orch.append('admitted', { rid: pending.rid, from: pending.from, sseq: 1, hash: (await import('../../../../src/kernel/ids.ts')).contentHash(pending), kind: pending.kind });
  Object.defineProperty(engine, 'decide', { value: async () => ({ action: 'defer' }) });
  await engine.intake();
  const seen = orch.entries().length;
  const committed = orch.committed!, snapshot = orch.entries;
  t.after(() => { orch.committed = committed; orch.entries = snapshot; });
  orch.committed = () => new Proxy(committed(), { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < seen) throw new Error(`old ledger position read: ${key}`);
    return Reflect.get(target, key, receiver);
  } });
  orch.entries = () => { throw new Error('full ledger snapshot requested'); };
  await orch.append('test-unrelated', {});
  await engine.intake();
  await orch.append('applied', { rid: pending.rid });
  await engine.intake();
  assert.equal((engine as unknown as { retained: Map<number, Request> }).retained.size, 0);
});
