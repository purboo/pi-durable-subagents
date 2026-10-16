// A settled workflow (orchestrator/settled.ts) opens at the next start without decoding its journal; every request on
// it behaves as before (the journal decodes on first use), and a record that does not describe the journal is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal, frameLine } from '../../../../src/kernel/journal.ts';
import { readCache, writeCache } from '../../../../src/kernel/cache.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { journalPath, orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { settledFacts, settledPath } from '../../../../src/orchestrator/settled.ts';
import { statusView, workflowSnapshot } from '../../../../src/orchestrator/snapshot.ts';
import { JT, type Request, type RunBody, type EvalToOrch, type OrchToEval } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import type { EvaluatorTransport } from '../../../../src/orchestrator/evaluator-client.ts';
import type { Workflow } from '../../../../src/orchestrator/store.ts';
import { fakeExecutor } from './fake.ts';

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
  ev(wid: string) { return (this.messages.findLast(m => m.t === 'start' && m.wid === wid) as { ev: number }).ev; }
  starts(wid: string) { return this.messages.filter(m => m.t === 'start' && m.wid === wid).length; }
}
type Booted = { ledgers: Ledgers; engine: Engine; evaluator: ManualEvaluator };

async function home(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-lazy-'));
  await mkdir(join(dir, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(dir, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const booted: Booted[] = [];
  t.after(async () => {
    for (const b of booted) { await b.engine.close().catch(() => {}); await b.ledgers.orch.close(); }
    await rm(dir, { recursive: true, force: true });
  });
  let sseq = 0;
  const close = async () => { const last = booted.pop(); if (last) { await last.engine.close(); await last.ledgers.orch.close(); } };
  /** Start an engine over this home (one at a time: the previous one is closed first). */
  const boot = async (): Promise<Booted> => {
    await close();
    const ledgers: Ledgers = { home: dir, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(dir)) };
    const evaluator = new ManualEvaluator();
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { recovered: true, forwards: true }), { evaluator, discovery: { home: dir, agentDir: join(dir, 'config'), globalNpmRoot: null } });
    const b = { ledgers, engine, evaluator }; booted.push(b);
    await engine.recover();
    return b;
  };
  const request = async (b: Booted, kind: Request['kind'], body: unknown) => {
    const rid = `r${++sseq}`;
    await publishRequest(orchInbox(dir), { rid, from: 'cli:test', to: 'orch', sseq, kind, body } as Request);
    await b.engine.intake();
    return rid;
  };
  /** A workflow whose call `c` sealed and that ended (`done` or parked). */
  const finished = async (b: Booted, end: 'done' | 'parked' = 'done'): Promise<Workflow> => {
    const rid = await request(b, 'run', { cwd: join(dir, 'project'), source: 'unused' } satisfies RunBody);
    const wf = b.engine.store.workflows.get(String(b.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === rid)!.wid))!;
    const ev = b.evaluator.ev(wf.wid);
    b.evaluator.receive({ t: 'call', wid: wf.wid, ev, pos: 0, key: 'c', spec: { agent: 'test', task: 't' } });
    for (let i = 0; i < 500 && !wf.journal.entries().some(e => e.type === JT.sealed); i++) await delay(5);
    b.evaluator.receive(end === 'done' ? { t: 'done', wid: wf.wid, ev, result: 1 } : { t: 'error', wid: wf.wid, ev, kind: 'limit', error: 'limit' });
    await b.engine.intake();
    assert.ok(wf.journal.entries().some(e => e.type === JT.done));
    return wf;
  };
  const decision = (b: Booted, rid: string) => b.ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
  const wf = (b: Booted, wid: string) => b.engine.store.workflows.get(wid)!;
  return { dir, boot, close, request, finished, decision, wf };
}

test('a settled workflow is written a record and opens lazily at the next start; status reads it from disk as before', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a);
  assert.ok(existsSync(settledPath(f.dir, w.wid)), 'recorded when the workflow settled');
  const done = readCache(settledPath(f.dir, w.wid))!.done as Record<string, unknown>;
  assert.deepEqual(Object.keys(done).sort(), ['seq', 'status', 'ts', 'type'], 'the end without its result');
  assert.ok(w.journal.entries().find(e => e.type === JT.done)!.result !== undefined);
  const before = workflowSnapshot(f.dir, w.wid);
  const b = await f.boot(), lazy = f.wf(b, w.wid);
  assert.equal(lazy.journal.loaded, false);
  assert.equal(lazy.journal.count!(), w.journal.entries().length);
  assert.equal(lazy.revision, 1);
  assert.deepEqual(b.ledgers.orch.entries().findLast(e => e.type === 'fake-recover' && e.wid === w.wid)?.settled, true);
  assert.deepEqual(workflowSnapshot(f.dir, w.wid), before);
  assert.ok(statusView(f.dir).workflows.some(x => x.wid === w.wid && x.status === 'done'));
  assert.equal(lazy.journal.loaded, false, 'status, the start and the waiting tracker never decoded it');
  await b.engine.events.flush();
  assert.equal(lazy.journal.loaded, false, 'nor did the event pump');
});

test('ready reloads revision two from settled metadata without decoding its lazy journal', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a);
  const rid = await f.request(a, 'revise', { wid: w.wid, source: 'revision two' });
  assert.equal(f.decision(a, rid)?.type, JT.applied);
  a.evaluator.receive({ t: 'done', wid: w.wid, ev: a.evaluator.ev(w.wid), result: 2 });
  await a.engine.intake();
  const b = await f.boot(), lazy = f.wf(b, w.wid);
  assert.equal(lazy.revision, 2); assert.equal(lazy.journal.loaded, false);
  await b.engine.store.ready(lazy);
  b.engine.store.releasePins(lazy);
  await b.engine.store.ready(lazy);
  assert.equal(lazy.pins.source, 'revision two');
  assert.equal(lazy.journal.loaded, false, 'the revised snapshot comes from the settled record');
});

test('a follow-up on a lazy workflow decodes it and runs as before', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a);
  const b = await f.boot(), lazy = f.wf(b, w.wid);
  assert.equal(lazy.journal.loaded, false);
  const rid = await f.request(b, 'send', { to: `${w.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  assert.equal(lazy.journal.loaded, true);
  const generation = `${w.wid}@1/c@2`;
  for (let i = 0; i < 500 && !lazy.journal.entries().some(e => e.type === JT.sealed && e.call === generation); i++) await delay(5);
  assert.ok(lazy.journal.entries().some(e => e.type === 'fake-run' && e.call === generation));
  // Settled again: the record follows the journal.
  for (let i = 0; i < 200 && (readCache(settledPath(f.dir, w.wid)) as { journal?: { count?: number } } | undefined)?.journal?.count !== lazy.journal.entries().length; i++) await delay(5);
  assert.equal((readCache(settledPath(f.dir, w.wid)) as { journal: { count: number } }).journal.count, lazy.journal.entries().length);
  const c = await f.boot();
  assert.equal(f.wf(c, w.wid).journal.loaded, false);
  assert.equal(f.wf(c, w.wid).journal.count!(), lazy.journal.entries().length);
});

test('send, stop, revise and resume on a lazy workflow decide as on a decoded one', async t => {
  const f = await home(t), a = await f.boot();
  const pairs = [[await f.finished(a), await f.finished(a)], [await f.finished(a, 'parked'), await f.finished(a, 'parked')]] as const;
  const b = await f.boot();
  // The second of each pair is decoded first: it is the reference.
  for (const [lazy, decoded] of pairs) { assert.equal(f.wf(b, lazy.wid).journal.loaded, false); f.wf(b, decoded.wid).journal.entries(); }
  const same = async (kind: Request['kind'], body: (wid: string) => unknown, which: 0 | 1) => {
    const [lazy, decoded] = pairs[which];
    const x = f.decision(b, await f.request(b, kind, body(lazy.wid))), y = f.decision(b, await f.request(b, kind, body(decoded.wid)));
    assert.equal(x?.type, y?.type, `${kind}: ${String(x?.reason)} vs ${String(y?.reason)}`);
    assert.equal(String(x?.reason ?? '').replaceAll(lazy.wid, 'W'), String(y?.reason ?? '').replaceAll(decoded.wid, 'W'), kind);
    return x;
  };
  await same('send', wid => ({ to: `${wid}/c`, kind: 'steer', message: 'x' }), 0);
  await same('send', wid => ({ to: `${wid}/nope`, kind: 'follow-up', message: 'x' }), 0);
  await same('stop', wid => ({ target: wid }), 0);
  await same('stop', wid => ({ target: `${wid}/c` }), 0);
  await same('resume', wid => ({ wid }), 0);
  assert.equal((await same('resume', wid => ({ wid }), 1))?.type, JT.applied);
  assert.equal(b.evaluator.starts(pairs[1][0].wid), b.evaluator.starts(pairs[1][1].wid));
  assert.equal((await same('revise', wid => ({ wid, source: 'new' }), 0))?.type, JT.applied);
  assert.equal(f.wf(b, pairs[0][0].wid).revision, 2);
  assert.equal(b.evaluator.starts(pairs[0][0].wid), b.evaluator.starts(pairs[0][1].wid), 'the revision runs');
  // A resume of everything leaves a lazy done workflow undecoded.
  const c = await f.boot(), other = await f.finished(c);
  const d = await f.boot();
  assert.equal(f.wf(d, other.wid).journal.loaded, false);
  assert.ok(f.decision(d, await f.request(d, 'resume', {})));
  assert.equal(f.wf(d, other.wid).journal.loaded, false);
});

test('prune of lazy workflows: a single one and all older than a cutoff, as on decoded ones', async t => {
  const f = await home(t), a = await f.boot(), one = await f.finished(a), two = await f.finished(a), parked = await f.finished(a, 'parked');
  const b = await f.boot();
  const single = await f.request(b, 'prune', { wid: one.wid });
  assert.equal(f.decision(b, single)?.type, JT.applied);
  assert.equal(existsSync(settledPath(f.dir, one.wid)), false, 'its record goes with it');
  const all = await f.request(b, 'prune', { olderThanDays: 0 });
  assert.equal(f.decision(b, all)?.type, JT.applied);
  const pruned = b.ledgers.orch.entries().filter(e => e.type === 'pruned').map(e => e.wid);
  assert.deepEqual(pruned.sort(), [one.wid, two.wid].sort(), 'the parked one is not finished');
  assert.ok(b.engine.store.workflows.has(parked.wid));
  assert.equal(f.wf(b, parked.wid).journal.loaded, false, 'deciding that did not decode it');
  const tooRecent = await f.request(b, 'prune', { wid: parked.wid });
  assert.match(String(f.decision(b, tooRecent)?.reason), /not-finished:parked/);
});

test('a tampered or stale record, or a journal appended after it (a crash before the record), opens eagerly and is rewritten', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a);
  const path = settledPath(f.dir, w.wid), good = await readFile(path, 'utf8');
  await f.close();
  // A changed field: the checksum fails.
  await writeFile(path, JSON.stringify({ ...JSON.parse(good), revision: 2 }));
  let b = await f.boot();
  assert.equal(f.wf(b, w.wid).journal.loaded, true);
  assert.equal(await readFile(path, 'utf8'), good, 'rewritten from the decoded journal');
  // A valid record for other bytes (another last line).
  await f.close();
  const record = readCache(path)!;
  writeCache(path, { ...record, journal: { ...(record.journal as object), tail: '00000000' } }, journalPath(f.dir, w.wid));
  b = await f.boot();
  assert.equal(f.wf(b, w.wid).journal.loaded, true);
  // An entry appended after the record was written (a crash before the record followed): the size differs.
  await f.close();
  const length = (readCache(path)!.journal as { count: number }).count;
  await appendFile(journalPath(f.dir, w.wid), frameLine(JSON.stringify({ seq: length + 1, ts: Date.now(), type: 'note-for-test' })));
  b = await f.boot();
  const wf = f.wf(b, w.wid);
  assert.equal(wf.journal.loaded, true);
  assert.equal(wf.journal.entries().at(-1)!.type, 'note-for-test');
  assert.equal((readCache(path)!.journal as { count: number }).count, wf.journal.entries().length);
  const c = await f.boot();
  assert.equal(f.wf(c, w.wid).journal.loaded, false);
});

test('an append to a lazy workflow decodes the journal first and continues its sequence', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a);
  const b = await f.boot(), lazy = f.wf(b, w.wid), count = lazy.journal.count!();
  const entry = await lazy.journal.append('note-for-test', {});
  assert.equal(entry.seq, count + 1);
  assert.equal(lazy.journal.loaded, true);
  assert.deepEqual(lazy.journal.entries().map(e => e.seq), Array.from({ length: count + 1 }, (_, i) => i + 1));
});

test('settledFacts names why a workflow is not settled', async t => {
  const f = await home(t), a = await f.boot(), w = await f.finished(a, 'parked');
  assert.equal(typeof settledFacts(w, () => true), 'object');
  const call = `${w.wid}@1/c@1`, exec = `${call}#1.1`;
  await w.journal.append(JT.exec, { call, exec });
  assert.equal(settledFacts(w, () => true), `unfenced:${exec}`);
  await w.journal.append(JT.fenced, { exec });
  assert.equal(settledFacts(w, () => false), `unrecovered:${call}`);
  assert.deepEqual((settledFacts(w, () => true) as { sweep: unknown }).sweep, [exec]);
  await w.journal.append('forward', { rid: 'x', rid2: 'x2', dest: call, envelope: { kind: 'notify' } });
  assert.equal(settledFacts(w, () => true), 'open-forward:x2');
  await w.journal.append('forward-delivered', { rid: 'x', rid2: 'x2', call });
  assert.equal(typeof settledFacts(w, () => true), 'object', 'a delivered forward is settled');
  await w.journal.append('forward', { rid: 'y', rid2: 'y2', dest: call, envelope: { kind: 'notify' } });
  assert.equal(settledFacts(w, () => true), 'open-forward:y2');
  await w.journal.append('forward-retired', { rid: 'y', rid2: 'y2' });
  assert.equal(typeof settledFacts(w, () => true), 'object');
  await w.journal.append('generation', { key: 'c', gen: 2, revision: 1, from: `${w.wid}@1/c@1` });
  assert.equal(settledFacts(w, () => true), `open-generation:${w.wid}@1/c@2`);
  await w.journal.append(JT.sealed, { call: `${w.wid}@1/c@2`, result: { status: 'ok' } });
  assert.equal(settledFacts(w, () => true), `unfinished-generation:${w.wid}@1/c@2`);
  await w.journal.append(JT.attention, { item: { id: `finished:${w.wid}@1/c@2`, rev: 1, kind: 'finished' } });
  assert.equal(typeof settledFacts(w, () => true), 'object');
  await w.journal.append('gate-intent', { id: 'g1', call: `${w.wid}@1/c@2` });
  assert.equal(settledFacts(w, () => true), 'gate:g1');
  await w.journal.append('gate', { id: 'g1' });
  await w.journal.append('writer-wait', { call: 'other', root: '/r' });
  assert.equal(settledFacts(w, () => true), 'writer-wait:other');
  await w.journal.append('writer-acquired', { call: 'other', root: '/r' });
  assert.equal(typeof settledFacts(w, () => true), 'object');
  await w.journal.append('resumed', { rid: 'again', n: 9 });
  assert.equal(settledFacts(w, () => true), 'running');
});
