// send kind "notify" at the orchestrator: a sealed call gets a durable pending note (nothing starts), status shows it, and
// the next follow-up's opening carries every pending note once, in order, also across an orchestrator restart.
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
import { statusBrief, statusView, workflowSnapshot } from '../../../../src/orchestrator/snapshot.ts';
import { renderView } from '../../../../src/cli/main.ts';
import { withNotes } from '../../../../src/orchestrator/notes.ts';
import { JT, type Request, type RunBody } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

async function until<T>(fn: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error('Timed out'); await delay(10); }
}
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-notify-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  let current: { engine: Engine; ledgers: Ledgers } | undefined;
  const start = async () => {
    const ledgers: Ledgers = { home, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(home)) };
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held' }), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
    await engine.recover();
    current = { engine, ledgers };
    return current;
  };
  const stop = async () => { if (!current) return; await current.engine.close(); await current.ledgers.orch.close(); current = undefined; };
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  let sseq = 0;
  const send = async (body: Record<string, unknown>, rid = `send-${sseq + 1}`) => {
    await publishRequest(orchInbox(home), { rid, from: 'cli:notify', to: 'orch', sseq: ++sseq, kind: 'send', body });
    await until(async () => { await current!.engine.intake(); return decision(rid); });
    return rid;
  };
  const decision = (rid: string) => current!.ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
  const delivery = (rid: string) => current!.ledgers.orch.entries().findLast(e => e.type === 'send-note' && e.rid === rid)?.delivery;
  return { home, start, stop, send, decision, delivery, get engine() { return current!.engine; }, get ledgers() { return current!.ledgers; } };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, source: string) {
  const req: Request<RunBody> = { rid: 'run-1', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(f.home, 'project'), source } };
  await publishRequest(orchInbox(f.home), req); await f.engine.intake();
  const created = f.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!;
  return String(created.wid);
}

test('notify to a sealed call starts nothing, shows in status, and the next follow-up opens with every note once (across a restart)', async t => {
  const f = await fixture(t);
  await f.start();
  const wid = await run(f, `return await runs.run('b', {agent:'test',task:'b'});`);
  const journal = () => f.engine.store.workflows.get(wid)!.journal.entries();
  await until(() => journal().some(e => e.type === JT.done));
  const first = await f.send({ to: `${wid}/b`, kind: 'notify', message: 'decided: use TOML' });
  const second = await f.send({ to: `${wid}/b`, kind: 'notify', message: 'and keep\ntwo lines' });
  for (const rid of [first, second]) { assert.equal(f.decision(rid)?.type, JT.applied); assert.equal(f.delivery(rid), 'noted'); }
  await delay(50);
  assert.equal(journal().filter(e => e.type === 'fake-run').length, 1, 'nothing started');
  assert.ok(!journal().some(e => e.type === 'generation'));
  assert.deepEqual(journal().filter(e => e.type === 'pending-note').map(e => [e.rid, e.key, e.call, e.message]),
    [[first, 'b', `${wid}@1/b@1`, 'decided: use TOML'], [second, 'b', `${wid}@1/b@1`, 'and keep\ntwo lines']]);
  // status: JSON notesPending, the text line, and the brief keeps a finished ok call that has notes.
  assert.equal(workflowSnapshot(f.home, wid).calls[0]!.notesPending, 2);
  const view = statusView(f.home);
  assert.equal(view.workflows[0]!.calls[0]!.notesPending, 2);
  assert.match(renderView(view), /\n {2}b@1 ok .*"b" · 2 notes pending/);
  assert.match(statusBrief(f.home, { origin: 'main:test' }).finished[0]!, / · 2 notes pending/);

  // A restart between the notes and the follow-up loses and repeats nothing.
  await f.stop(); await f.start();
  const follow = await f.send({ to: `${wid}/b`, kind: 'follow-up', message: 'go on' });
  assert.equal(f.decision(follow)?.type, JT.applied);
  const opened = journal().find(e => e.type === 'generation')!;
  const expected = 'Notes recorded after your last turn:\n- decided: use TOML\n- and keep\n  two lines\n\ngo on';
  assert.equal(withNotes(['decided: use TOML', 'and keep\ntwo lines'], 'go on'), expected);
  assert.equal((opened.opening as { message: string }).message, expected);
  assert.deepEqual(opened.notes, [first, second]);
  await until(() => journal().some(e => e.type === JT.sealed && e.call === `${wid}@1/b@2`));
  assert.equal(workflowSnapshot(f.home, wid).calls.at(-1)!.notesPending, undefined, 'consumed');
  assert.doesNotMatch(renderView(statusView(f.home)), /notes? pending/);
  // Restarting again and following up again: the notes are not carried twice.
  await f.stop(); await f.start();
  const again = await f.send({ to: `${wid}/b`, kind: 'follow-up', message: 'once more' });
  assert.equal(f.decision(again)?.type, JT.applied);
  const gens = journal().filter(e => e.type === 'generation');
  assert.equal(gens.length, 2);
  assert.equal((gens[1]!.opening as { message: string }).message, 'once more');
  assert.equal(gens[1]!.notes, undefined);
  // A notify needs a message; a steer to a sealed call is still rejected.
  const empty = await f.send({ to: `${wid}/b`, kind: 'notify', message: '' });
  assert.match(String(f.decision(empty)?.reason), /^malformed/);
  await until(() => journal().some(e => e.type === JT.sealed && e.call === `${wid}@1/b@3`));
  const steer = await f.send({ to: `${wid}/b`, kind: 'steer', message: 'late' });
  assert.match(String(f.decision(steer)?.reason), /^finished:ok/);
});

test('notify to a running call is forwarded; a follow-up waits until a notify the seal has not settled became a note', async t => {
  const f = await fixture(t);
  await f.start();
  const wid = await run(f, `return await runs.all([runs.run('held', {agent:'test',task:'h'}), runs.run('b', {agent:'test',task:'b'})]);`);
  const wf = () => f.engine.store.workflows.get(wid)!, journal = () => wf().journal.entries();
  await until(() => journal().some(e => e.type === JT.sealed && e.call === `${wid}@1/b@1`));
  const live = await f.send({ to: `${wid}/held`, kind: 'notify', message: 'for the running one' });
  assert.equal(f.decision(live)?.type, JT.applied);
  assert.ok(journal().some(e => e.type === 'fake-forward' && e.rid === live), 'forwarded to the executor');
  assert.ok(!journal().some(e => e.type === 'pending-note'));
  // A notify forwarded to b before it sealed whose fate the executor has not recorded yet (between seal and retirement).
  const b = `${wid}@1/b@1`;
  await wf().journal.append('forward', { rid: 'early', rid2: 'early-2', dest: b, hash: 'h', envelope: { to: b, kind: 'notify', body: { message: 'early note' } } });
  const late = 'late-note';
  await publishRequest(orchInbox(f.home), { rid: late, from: 'cli:other', to: 'orch', sseq: 1, kind: 'send', body: { to: `${wid}/b`, kind: 'notify', message: 'late note' } });
  await publishRequest(orchInbox(f.home), { rid: 'follow', from: 'cli:other', to: 'orch', sseq: 2, kind: 'send', body: { to: `${wid}/b`, kind: 'follow-up', message: 'continue' } });
  await f.engine.intake(); await f.engine.intake();
  assert.equal(f.decision(late), undefined, 'waits for the earlier notify');
  assert.ok(!journal().some(e => e.type === 'generation'));
  await wf().journal.append('pending-note', { rid: 'early', call: b, key: 'b', message: 'early note' });
  await wf().journal.append('forward-retired', { rid: 'early', rid2: 'early-2', reason: 'retired-without-child-receipt' });
  await until(async () => { await f.engine.intake(); return f.decision('follow'); });
  assert.equal(f.delivery(late), 'noted');
  const opened = journal().find(e => e.type === 'generation')!;
  assert.equal((opened.opening as { message: string }).message, 'Notes recorded after your last turn:\n- early note\n- late note\n\ncontinue');
  assert.deepEqual(opened.notes, ['early', late]);
});

test('a replayed notify follows what happened to its forward: delivered or retired is no second note; a receipt left from a cut-off decision is corrected', async t => {
  const f = await fixture(t);
  await f.start();
  const wid = await run(f, `return await runs.run('b', {agent:'test',task:'b'});`);
  const wf = () => f.engine.store.workflows.get(wid)!, journal = () => wf().journal.entries(), b = `${wid}@1/b@1`;
  await until(() => journal().some(e => e.type === JT.done));
  const notes = () => journal().filter(e => e.type === 'pending-note');
  const forward = async (rid: string, end: 'forward-delivered' | 'forward-retired' | undefined, delivery = 'steered') => {
    // The first decision forwarded it to the running call and recorded its receipt, then the orchestrator died before
    // the decision; the call went on (or sealed) meanwhile.
    await f.ledgers.orch.append('send-note', { rid, delivery });
    await wf().journal.append('forward', { rid, rid2: `${rid}-2`, dest: b, hash: 'h', envelope: { to: b, kind: 'notify', body: { message: rid } } });
    if (end === 'forward-delivered') await wf().journal.append(end, { rid, rid2: `${rid}-2`, call: b });
    if (end === 'forward-retired') {
      await wf().journal.append('pending-note', { rid, call: b, key: 'b', message: rid });
      await wf().journal.append(end, { rid, rid2: `${rid}-2`, reason: 'retired-without-child-receipt' });
    }
  };
  // Delivered: applied as steered, no note.
  await forward('n1', 'forward-delivered');
  const n1 = await f.send({ to: `${wid}/b`, kind: 'notify', message: 'n1' }, 'n1');
  assert.equal(f.decision(n1)?.type, JT.applied);
  assert.equal(notes().length, 0, 'a note the call received is not pending as well');
  assert.equal(f.delivery(n1), 'steered');
  assert.equal(workflowSnapshot(f.home, wid).calls[0]!.notesPending, undefined);
  // Delivered while held for a question: the receipt stays held-until-answer.
  await forward('n2', 'forward-delivered', 'held-until-answer');
  await f.send({ to: `${wid}/b`, kind: 'notify', message: 'n2' }, 'n2');
  assert.equal(f.delivery('n2'), 'held-until-answer'); assert.equal(notes().length, 0);
  // Retired at the seal: its note exists already; no second one, and the receipt says noted.
  await forward('n3', 'forward-retired');
  await f.send({ to: `${wid}/b`, kind: 'notify', message: 'n3' }, 'n3');
  assert.deepEqual(notes().map(e => e.rid), ['n3']); assert.equal(f.delivery('n3'), 'noted');
  // Cut off between its receipt and its forward: nothing reached the call, so it is a note and the receipt says so.
  await f.ledgers.orch.append('send-note', { rid: 'n4', delivery: 'steered' });
  await f.send({ to: `${wid}/b`, kind: 'notify', message: 'n4' }, 'n4');
  assert.deepEqual(notes().map(e => e.rid), ['n3', 'n4']); assert.equal(f.delivery('n4'), 'noted');
  // A forward whose end is not recorded yet: the decision waits for it.
  await forward('n5', undefined);
  await publishRequest(orchInbox(f.home), { rid: 'n5', from: 'cli:other', to: 'orch', sseq: 1, kind: 'send', body: { to: `${wid}/b`, kind: 'notify', message: 'n5' } });
  await f.engine.intake(); await f.engine.intake();
  assert.equal(f.decision('n5'), undefined);
  await wf().journal.append('forward-delivered', { rid: 'n5', rid2: 'n5-2', call: b });
  await until(async () => { await f.engine.intake(); return f.decision('n5'); });
  assert.deepEqual(notes().map(e => e.rid), ['n3', 'n4']);
  assert.equal(workflowSnapshot(f.home, wid).calls[0]!.notesPending, 2);
});
