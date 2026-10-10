// A follow-up forwarded into running work that seals before taking it is not lost: the orchestrator opens the next
// generation with it (after the pending notes), a later follow-up takes it along instead, a restart opens it once, and
// the send reply says where the follow-up went.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { followUpReceipt, outcomeLine } from '../../../../src/agent/main/tool.ts';
import { JT, type Request, type RunBody } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

async function until<T>(fn: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error('Timed out'); await delay(10); }
}
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-fwd-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  let current: { engine: Engine; ledgers: Ledgers } | undefined;
  const start = async () => {
    const ledgers: Ledgers = { home, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(home)) };
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held', forwards: true, delay: key => key === 'slow' ? 500 : 0 }), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
    await engine.recover();
    current = { engine, ledgers };
    return current;
  };
  const stop = async () => { if (!current) return; await current.engine.close(); await current.ledgers.orch.close(); current = undefined; };
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  let sseq = 0;
  const decision = (rid: string) => current!.ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
  const send = async (body: Record<string, unknown>, rid: string) => {
    await publishRequest(orchInbox(home), { rid, from: 'cli:fwd', to: 'orch', sseq: ++sseq, kind: 'send', body });
    await until(async () => { await current!.engine.intake(); return decision(rid); });
    return rid;
  };
  return { home, start, stop, send, decision, get engine() { return current!.engine; }, get ledgers() { return current!.ledgers; } };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, source: string) {
  const req: Request<RunBody> = { rid: 'run-1', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(f.home, 'project'), source } };
  await publishRequest(orchInbox(f.home), req); await f.engine.intake();
  return String(f.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!.wid);
}

test('a follow-up forwarded into running work that seals first opens the next generation, after the pending notes', async t => {
  const f = await fixture(t);
  await f.start();
  const wid = await run(f, `return await runs.run('slow', {agent:'test',task:'s'});`);
  const journal = () => f.engine.store.workflows.get(wid)!.journal.entries();
  await until(() => journal().some(e => e.type === 'fake-run'));
  const body = { to: `${wid}/slow`, kind: 'follow-up', message: 'fix the review finding' };
  await f.send(body, 'fu-1');
  assert.equal(f.decision('fu-1')?.type, JT.applied);
  // Before the seal the reply names the running generation it was queued into.
  const queued = followUpReceipt(f.home, 'fu-1', body);
  assert.deepEqual({ delivery: queued.delivery, call: queued.call }, { delivery: 'forwarded', call: `${wid}/slow@1` });
  assert.match(outcomeLine({ applied: true, ...queued }), /^applied \(forwarded: queued into running .*slow@1; if it ends before taking it, it opens the next generation\)$/);
  // A notify recorded at the same seal comes first in the opening message.
  await f.engine.store.workflows.get(wid)!.journal.append('pending-note', { rid: 'n-1', call: `${wid}@1/slow@1`, key: 'slow', message: 'use TOML' });
  const opened = await until(() => journal().find(e => e.type === 'generation'));
  assert.equal(opened.rid, 'fu-1'); assert.equal(opened.gen, 2); assert.equal(opened.from, `${wid}@1/slow@1`);
  assert.equal((opened.opening as { message: string }).message, 'Notes recorded after your last turn:\n- use TOML\n\nfix the review finding');
  assert.deepEqual(opened.notes, ['n-1']);
  await until(() => journal().some(e => e.type === JT.sealed && e.call === `${wid}@1/slow@2`));
  // A retry of the same request now names the generation it opened.
  assert.deepEqual(followUpReceipt(f.home, 'fu-1', body), { generation: 2, call: `${wid}/slow` });
  assert.match(outcomeLine({ applied: true, generation: 2, call: `${wid}/slow` }), /^applied \(follow-up generation 2 of .*\/slow\)$/);
  // Restarting opens nothing twice.
  await f.stop(); await f.start();
  await delay(50);
  assert.equal(journal().filter(e => e.type === 'generation').length, 1);
});

test('a later follow-up takes undelivered ones along; a restart opens the rest once', async t => {
  const f = await fixture(t);
  await f.start();
  const wid = await run(f, `return await runs.all([runs.run('held', {agent:'test',task:'h'}), runs.run('b', {agent:'test',task:'b'}), runs.run('c', {agent:'test',task:'c'})]);`);
  const wf = () => f.engine.store.workflows.get(wid)!, journal = () => wf().journal.entries();
  const b = `${wid}@1/b@1`, c = `${wid}@1/c@1`;
  await until(() => journal().some(e => e.type === JT.sealed && e.call === b) && journal().some(e => e.type === JT.sealed && e.call === c));
  // Two follow-ups forwarded to b, retired undelivered at its seal (as if the orchestrator died before opening them).
  for (const [rid, message] of [['early-1', 'first'], ['early-2', 'second']]) {
    await wf().journal.append('forward', { rid, rid2: `${rid}'`, dest: b, hash: 'h', envelope: { to: b, kind: 'follow-up', body: { message } } });
    await wf().journal.append('forward-retired', { rid, rid2: `${rid}'`, reason: 'undelivered-follow-up' });
  }
  await f.send({ to: `${wid}/b`, kind: 'follow-up', message: 'third' }, 'late');
  const opened = journal().find(e => e.type === 'generation' && e.key === 'b')!;
  assert.equal(opened.rid, 'late'); assert.deepEqual(opened.follows, ['early-1', 'early-2']);
  assert.equal((opened.opening as { message: string }).message, 'first\n\nsecond\n\nthird');
  assert.deepEqual(followUpReceipt(f.home, 'early-2', { to: `${wid}/b`, kind: 'follow-up' }), { generation: 2, call: `${wid}/b` });
  // c: one undelivered follow-up and nothing else; the orchestrator restarts and opens it by itself, once.
  await wf().journal.append('forward', { rid: 'lone', rid2: "lone'", dest: c, hash: 'h', envelope: { to: c, kind: 'follow-up', body: { message: 'go on' } } });
  await wf().journal.append('forward-retired', { rid: 'lone', rid2: "lone'", reason: 'undelivered-follow-up' });
  // A retired forward with another reason (a stop, a withdraw) opens nothing.
  await wf().journal.append('forward', { rid: 'dropped', rid2: "dropped'", dest: c, hash: 'h', envelope: { to: c, kind: 'follow-up', body: { message: 'never' } } });
  await wf().journal.append('forward-retired', { rid: 'dropped', rid2: "dropped'", reason: 'retired-without-child-receipt' });
  await f.stop(); await f.start();
  const reopened = await until(() => journal().find(e => e.type === 'generation' && e.key === 'c'));
  assert.equal(reopened.rid, 'lone'); assert.equal((reopened.opening as { message: string }).message, 'go on'); assert.equal(reopened.follows, undefined);
  await until(() => journal().some(e => e.type === JT.sealed && e.call === `${wid}@1/c@2`));
  await f.stop(); await f.start(); await delay(50);
  assert.equal(journal().filter(e => e.type === 'generation').length, 2, 'nothing opened twice');
});
