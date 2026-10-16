// A start does not hash the pinned files of finished workflows; they are verified before their script, inputs or origin
// are used again. The store's ledger lookups (pruned, created, intents) are indexes kept current on append.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { JT, isEntry, type Request, type RunBody, type EvalToOrch, type OrchToEval } from '../../../../src/types.ts';
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
  const dir = await mkdtemp(join(tmpdir(), 'dsa-recover-pins-'));
  await mkdir(join(dir, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(dir, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const booted: Booted[] = [];
  t.after(async () => {
    for (const b of booted) { await b.engine.close().catch(() => {}); await b.ledgers.orch.close(); }
    await rm(dir, { recursive: true, force: true });
  });
  let sseq = 0;
  /** Start an engine over this home, closing the previous one first (one orchestrator at a time). */
  const boot = async (): Promise<Booted> => {
    const last = booted.at(-1);
    if (last) { await last.engine.close(); await last.ledgers.orch.close(); booted.pop(); }
    const ledgers: Ledgers = { home: dir, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(dir)) };
    const evaluator = new ManualEvaluator();
    const engine = new Engine(ledgers, fakeExecutor(ledgers), { evaluator, discovery: { home: dir, agentDir: join(dir, 'config'), globalNpmRoot: null } });
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
  /** A workflow whose one call `c` sealed, ended `done` (or parked). */
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
  return { dir, boot, request, finished, decision };
}

test('a terminal workflow is recovered without hashing its pinned files; a tampered file is refused before a resume evaluates it', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first, 'parked');
  await writeFile(wf.scriptPath, 'return 999;');
  // Before: every start hashed every pinned file and refused this start (Pinned content conflict).
  const b = await f.boot(), recovered = b.engine.store.workflows.get(wf.wid)!;
  assert.equal(b.engine.store.verified(wf.wid), false);
  await assert.rejects(b.engine.store.ready(recovered), /Pinned content conflict: .*script\.js/);
  await assert.rejects(b.engine.store.ready(recovered), /Pinned content conflict/, 'refused again on every use');
  const rid = await f.request(b, 'resume', { wid: wf.wid });
  assert.match(String(f.decision(b, rid)?.reason), /^pin-failed: .*Pinned content conflict: .*script\.js/);
  assert.equal(b.evaluator.starts(wf.wid), 0, 'the tampered script never reaches the evaluator');
  assert.equal(recovered.journal.entries().some(e => e.type === 'resumed'), false, 'nothing recorded for the refused resume');
});

test('an intact terminal workflow is verified on its next use: a resume evaluates it as before', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first, 'parked');
  const b = await f.boot();
  assert.equal(b.engine.store.verified(wf.wid), false);
  const recovered = b.engine.store.workflows.get(wf.wid)!;
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.get, 'terminal pins are not resident');
  assert.equal(recovered.pins.source, 'unused', 'details load pins on demand');
  assert.strictEqual(recovered.pins, recovered.pins, 'a detail read caches the checked pins');
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.get, 'one-off detail pins are released after idle');
  const rid = await f.request(b, 'resume', { wid: wf.wid });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  assert.equal(b.evaluator.starts(wf.wid), 1);
  assert.equal(b.engine.store.verified(wf.wid), true);
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.value, 'live work retains verified pins');
});

test('released pin details validate their record and cache the immutable fallback', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const path = join(wf.scriptPath, '..', 'pins.json'), record = JSON.parse(await readFile(path, 'utf8'));
  record.pins.agents = []; await writeFile(path, JSON.stringify(record));
  assert.ok(wf.pins.agents.some(a => a.name === 'test'), 'a bad digest cannot replace the pinned agents');
  assert.strictEqual(wf.pins, wf.pins);
});

test('released pin details raise the same error as ready when neither record nor snapshot loads', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const intent = b.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.wid === wf.wid)!;
  await rm(join(wf.scriptPath, '..', 'pins.json'));
  await rm(join(f.dir, (intent.snapshot as { path: string }).path));
  let failure: unknown;
  await assert.rejects(b.engine.store.ready(wf), error => { failure = error; return true; });
  assert.throws(() => wf.pins, error => String(error) === String(failure));
});

test('cached detail pins are released after a slow file verification fails past the idle deadline', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  const b = await f.boot(), recovered = b.engine.store.workflows.get(wf.wid)!;
  assert.equal(recovered.pins.source, 'unused');
  const internal = b.engine.store as unknown as { pinnedFiles(...args: unknown[]): Promise<unknown> };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(internal, 'pinnedFiles', async () => { await gate; throw new Error('Pinned content conflict: slow verification'); });
  const verifying = assert.rejects(b.engine.store.ready(recovered), /Pinned content conflict/);
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.value, 'verification still uses the cached details');
  release(); await verifying;
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.get, 'a failed verification still schedules idle release');
});

test('historical revision tickets never read the current released pins', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const rid = await f.request(b, 'revise', { wid: wf.wid, source: 'new source' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  b.engine.store.releasePins(wf);
  await rm(join(wf.scriptPath, '..', 'pins.json'));
  const historical = await b.engine.store.atRevision(wf, 1);
  assert.equal(historical.pins.source, 'unused'); assert.equal(historical.revision, 1);
  assert.equal(wf.revision, 2);
  assert.ok(Object.getOwnPropertyDescriptor(wf, 'pins')?.get, 'current pins were never loaded');
});

test('a same-process resume refuses missing released pins before recording resumed', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b, 'parked');
  assert.equal(b.engine.store.verified(wf.wid), true);
  const intent = b.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.wid === wf.wid)!;
  await rm(join(wf.scriptPath, '..', 'pins.json'));
  await rm(join(f.dir, (intent.snapshot as { path: string }).path));
  const rid = await f.request(b, 'resume', { wid: wf.wid });
  assert.match(String(f.decision(b, rid)?.reason), /^pin-failed: .*ENOENT/);
  assert.equal(wf.journal.entries().some(e => e.type === 'resumed'), false);
  assert.equal(b.evaluator.starts(wf.wid), 1);
});

test('idle pin release between follow-up ready and dispatch reloads checked pins', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const recordPath = join(wf.scriptPath, '..', 'pins.json'), record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.pins.agents = []; await writeFile(recordPath, JSON.stringify(record));
  const ready = b.engine.store.ready.bind(b.engine.store);
  t.mock.method(b.engine.store, 'ready', async (target: Workflow) => {
    await ready(target); await delay(1100);
    assert.ok(Object.getOwnPropertyDescriptor(target, 'pins')?.get, 'idle release occurs before dispatch');
  });
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  const call = `${wf.wid}@1/c@2`;
  for (let i = 0; i < 500 && !wf.journal.entries().some(e => e.type === JT.sealed && e.call === call); i++) await delay(5);
  assert.equal((wf.journal.entries().find(e => e.type === JT.sealed && e.call === call)?.result as { status?: string })?.status, 'ok');
});

test('a pins getter that throws after ready seals only that follow-up pin-failed; nothing escapes dispatch', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const ready = b.engine.store.ready.bind(b.engine.store);
  let calls = 0;
  t.mock.method(b.engine.store, 'ready', async (target: Workflow) => {
    await ready(target);
    // The dispatch-side ready (after admission's) leaves a getter that throws, as a load failing after verification.
    if (++calls === 1) b.engine.store.releasePins(target); // released between admission and dispatch: dispatch must ready again
    else Object.defineProperty(target, 'pins', { configurable: true, enumerable: true, get: () => { throw new Error('ENOENT: pins.json'); },
      set: (pins: unknown) => { Object.defineProperty(target, 'pins', { value: pins, configurable: true, enumerable: true, writable: true }); } });
  });
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  const call = `${wf.wid}@1/c@2`;
  for (let i = 0; i < 500 && !wf.journal.entries().some(e => e.type === JT.sealed && e.call === call); i++) await delay(5);
  const sealed = wf.journal.entries().find(e => e.type === JT.sealed && e.call === call);
  assert.equal((sealed?.result as { status?: string })?.status, 'failed');
  assert.match(JSON.stringify(sealed?.result), /pin-failed: ENOENT: pins\.json/);
  assert.equal(calls, 2, 'one admission ready, one dispatch ready; no retry loop');
});

test('held and already dispatched generations skip pins before building a ticket', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const internal = b.engine as unknown as { dispatchGeneration(wf: Workflow, entry: Record<string, unknown>): void; generations: Set<string> };
  const entry = { key: 'c', gen: 2, spec: { agent: 'test', task: 'more' } }, id = `${wf.wid}@1/c@2`;
  Object.defineProperty(wf, 'pins', { configurable: true, get: () => { throw new Error('skipped generation loaded pins'); } });
  internal.generations.add(id);
  try { assert.doesNotThrow(() => internal.dispatchGeneration(wf, entry)); }
  finally { internal.generations.delete(id); }
  const drain = await f.request(b, 'drain', { wid: wf.wid });
  assert.equal(f.decision(b, drain)?.type, JT.applied);
  assert.doesNotThrow(() => internal.dispatchGeneration(wf, entry));
});

test('a held follow-up survives idle pin release and resumes with checked pins', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  await f.request(b, 'drain', { wid: wf.wid });
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(wf, 'pins')?.get);
  const path = join(wf.scriptPath, '..', 'pins.json'), record = JSON.parse(await readFile(path, 'utf8'));
  record.pins.agents = []; await writeFile(path, JSON.stringify(record));
  const resume = await f.request(b, 'resume', { wid: wf.wid });
  assert.equal(f.decision(b, resume)?.type, JT.applied);
  const call = `${wf.wid}@1/c@2`;
  for (let i = 0; i < 500 && !wf.journal.entries().some(e => e.type === JT.sealed && e.call === call); i++) await delay(5);
  assert.equal((wf.journal.entries().find(e => e.type === JT.sealed && e.call === call)?.result as { status?: string })?.status, 'ok');
});

test('an undrain is not refused by a done workflow with damaged released pins; only its held follow-up seals pin-failed', async t => {
  const f = await home(t), b = await f.boot(), damaged = await f.finished(b), parked = await f.finished(b, 'parked');
  const drain = await f.request(b, 'drain', {});
  assert.equal(f.decision(b, drain)?.type, JT.applied);
  const follow = await f.request(b, 'send', { to: `${damaged.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, follow)?.type, JT.applied);
  // Damage the pin record and remove the immutable snapshot, then let the idle release drop the resident pins.
  const intent = b.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.wid === damaged.wid)!;
  await writeFile(join(damaged.scriptPath, '..', 'pins.json'), 'not json');
  await rm(join(f.dir, (intent.snapshot as { path: string }).path));
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(damaged, 'pins')?.get, 'pins released before the undrain');
  const starts = b.evaluator.starts(parked.wid);
  const resume = await f.request(b, 'resume', {});
  assert.equal(f.decision(b, resume)?.type, JT.applied, 'one workflow\'s damaged pins do not refuse the whole undrain');
  assert.ok(parked.journal.entries().some(e => e.type === 'resumed' && e.rid === resume), 'the other workflow is released');
  assert.equal(b.evaluator.starts(parked.wid), starts + 1);
  const call = `${damaged.wid}@1/c@2`;
  for (let i = 0; i < 500 && !damaged.journal.entries().some(e => e.type === JT.sealed && e.call === call); i++) await delay(5);
  const sealed = damaged.journal.entries().find(e => e.type === JT.sealed && e.call === call);
  assert.equal((sealed?.result as { status?: string })?.status, 'failed');
  assert.match(JSON.stringify(sealed?.result), /pin-failed/);
  assert.equal(damaged.journal.entries().some(e => e.type === 'resumed'), false, 'a done workflow is never resumed');
});

test('a tampered pinned file of a finished workflow refuses a revise and a follow-up before they use it', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  await writeFile(wf.scriptPath, 'return 999;');
  const b = await f.boot();
  const revise = await f.request(b, 'revise', { wid: wf.wid, source: 'new' });
  assert.match(String(f.decision(b, revise)?.reason), /pin-failed: .*Pinned content conflict/);
  const follow = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.match(String(f.decision(b, follow)?.reason), /^pin-failed: .*Pinned content conflict/);
  await delay(50);
  const log = b.engine.store.workflows.get(wf.wid)!.journal.entries();
  assert.equal(log.some(e => e.type === 'generation'), false, 'no generation opened from unverified pins');
  assert.equal(log.some(e => e.type === 'fake-invoke' && e.call === `${wf.wid}@1/c@2`), false);
});

test('an intact finished workflow runs a follow-up after verifying its pins', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  const b = await f.boot(), recovered = b.engine.store.workflows.get(wf.wid)!;
  assert.equal(b.engine.store.verified(wf.wid), false);
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  const generation = `${wf.wid}@1/c@2`;
  for (let i = 0; i < 500 && !recovered.journal.entries().some(e => e.type === JT.sealed && e.call === generation); i++) await delay(5);
  assert.ok(recovered.journal.entries().some(e => e.type === 'fake-invoke' && e.call === generation));
  assert.equal(b.engine.store.verified(wf.wid), true);
});

test('terminal pins leave memory in the same process and an intact recovered workflow can revise', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  assert.ok(Object.getOwnPropertyDescriptor(wf, 'pins')?.get, 'a newly ended workflow releases pins');
  const b = await f.boot(), recovered = b.engine.store.workflows.get(wf.wid)!;
  const rid = await f.request(b, 'revise', { wid: wf.wid, source: 'new source', args: { n: 2 } });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.pins.source, 'new source');
  assert.deepEqual(recovered.pins.args, { n: 2 });
  assert.equal(recovered.pins.agents.find(a => a.name === 'test')?.body, 'Synthetic.');
  assert.equal(b.evaluator.starts(wf.wid), 1);
});

test('pins loaded by a refused terminal request are released after idle', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  const b = await f.boot(), recovered = b.engine.store.workflows.get(wf.wid)!;
  const rid = await f.request(b, 'revise', { wid: wf.wid, source: 'new', workflow: '/unused' });
  assert.match(String(f.decision(b, rid)?.reason), /invalid-revise/);
  assert.equal(b.engine.store.verified(wf.wid), true);
  await delay(1100);
  assert.ok(Object.getOwnPropertyDescriptor(recovered, 'pins')?.get, 'a rejected request leaves no resident pins');
  assert.equal(recovered.pins.source, 'unused');
});

test('a damaged released pin record cannot change a same-process follow-up', async t => {
  const f = await home(t), b = await f.boot(), wf = await f.finished(b);
  const record = join(wf.scriptPath, '..', 'pins.json'), parsed = JSON.parse(await readFile(record, 'utf8'));
  parsed.pins.agents = []; await writeFile(record, JSON.stringify(parsed));
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'more' });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  assert.ok(wf.pins.agents.some(a => a.name === 'test'), 'the immutable snapshot supplies the original agent');
});

test('pruned and created indexes keep pruning and materialize semantics across starts and appends', async t => {
  const f = await home(t), first = await f.boot(), gone = await f.finished(first), kept = await f.finished(first);
  const prune = await f.request(first, 'prune', { wid: gone.wid });
  assert.equal(f.decision(first, prune)?.type, JT.applied);
  assert.equal(first.engine.store.pruned().has(gone.wid), true, 'kept current on append');
  assert.equal(first.engine.store.workflows.has(gone.wid), false);
  for (let i = 0; i < 2; i++) {
    const b = await f.boot();
    assert.equal(b.engine.store.workflows.has(gone.wid), false, 'a pruned workflow never materializes');
    assert.equal(b.engine.store.workflows.has(kept.wid), true);
    assert.equal(b.engine.store.pruned().has(gone.wid), true);
    for (const wid of [gone.wid, kept.wid]) assert.equal(b.ledgers.orch.entries().filter(e => e.type === JT.created && e.wid === wid).length, 1, 'created once');
    const again = await f.request(b, 'prune', { wid: gone.wid });
    assert.match(String(f.decision(b, again)?.reason), /already-pruned/);
  }
});

test('a generation open at restart whose pinned script changed is sealed failed pin-failed; the engine goes on; restoring the file lets a follow-up run', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  const spec = wf.journal.entries().find(e => e.type === 'call')!.spec;
  await wf.journal.append('generation', { rid: 'fu', key: 'c', gen: 2, from: `${wf.wid}@1/c@1`, spec, revision: 1, opening: { rid: 'fu', kind: 'follow-up', message: 'more' } });
  const script = await readFile(wf.scriptPath, 'utf8');
  await writeFile(wf.scriptPath, 'return 999;');
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  const b = await f.boot(), log = () => b.engine.store.workflows.get(wf.wid)!.journal.entries(), id = `${wf.wid}@1/c@2`;
  for (let i = 0; i < 500 && !log().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`); i++) await delay(5);
  const seal = log().find(e => e.type === JT.sealed && e.call === id)?.result as { status?: string; error?: string } | undefined;
  assert.equal(seal?.status, 'failed');
  assert.match(String(seal?.error), /^pin-failed: Pinned content conflict: .*script\.js$/);
  assert.equal(log().some(e => e.type === 'fake-run' && e.call === id), false, 'no child ran');
  assert.ok(log().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`), 'finished attention');
  assert.equal(errors.filter(e => e.includes('pin-failed')).length, 1, 'one log line');
  // The engine is alive: another workflow runs its call, and prune no longer finds an open generation.
  const other = await f.finished(b);
  assert.ok(other.journal.entries().some(e => e.type === 'fake-run'));
  await b.engine.intake();
  const stop = await f.request(b, 'stop', { target: wf.wid });
  assert.equal(f.decision(b, stop)?.reason, 'terminal:done', 'the workflow is terminal again');
  // Restore the file: a follow-up verifies the pins again and runs.
  await writeFile(wf.scriptPath, script);
  const rid = await f.request(b, 'send', { to: `${wf.wid}/c`, kind: 'follow-up', message: 'again' });
  assert.equal(f.decision(b, rid)?.type, JT.applied, String(f.decision(b, rid)?.reason));
  const next = `${wf.wid}@1/c@3`;
  for (let i = 0; i < 500 && !log().some(e => e.type === JT.sealed && e.call === next); i++) await delay(5);
  assert.ok(log().some(e => e.type === 'fake-run' && e.call === next));
  assert.equal((log().find(e => e.type === JT.sealed && e.call === next)?.result as { status: string }).status, 'ok');
});

test('an open generation whose pins.json lost its agent list (and script changed) is sealed failed pin-failed; the engine goes on; a restart is idempotent', async t => {
  const f = await home(t), first = await f.boot(), wf = await f.finished(first);
  const spec = wf.journal.entries().find(e => e.type === 'call')!.spec;
  await wf.journal.append('generation', { rid: 'fu', key: 'c', gen: 2, from: `${wf.wid}@1/c@1`, spec, revision: 1, opening: { rid: 'fu', kind: 'follow-up', message: 'more' } });
  await writeFile(wf.scriptPath, 'return 999;');
  const record = join(wf.scriptPath, '..', 'pins.json'), parsed = JSON.parse(await readFile(record, 'utf8'));
  delete parsed.pins.agents; await writeFile(record, JSON.stringify(parsed));
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  const id = `${wf.wid}@1/c@2`;
  const settled = async (b: Booted) => {
    const log = () => b.engine.store.workflows.get(wf.wid)!.journal.entries();
    for (let i = 0; i < 500 && !log().some(e => isEntry(e, JT.attention) && e.item.id === `finished:${id}`); i++) await delay(5);
    return log;
  };
  const b = await f.boot(), log = await settled(b);
  const seals = () => log().filter(e => e.type === JT.sealed && e.call === id);
  assert.equal(seals().length, 1);
  const seal = seals()[0]!.result as { status: string; error: string };
  assert.equal(seal.status, 'failed'); assert.match(seal.error, /^pin-failed: /);
  assert.equal(log().some(e => e.type === 'fake-run' && e.call === id), false, 'no child ran');
  assert.equal(errors.filter(e => e.includes('sealed failed')).length, 1);
  const other = await f.finished(b);
  assert.ok(other.journal.entries().some(e => e.type === 'fake-run'), 'another workflow still dispatches');
  // A restart: nothing new for the sealed generation, the engine starts.
  const length = log().length;
  const again = await f.boot(), relog = await settled(again);
  await again.engine.intake(); await delay(50);
  assert.equal(relog().filter(e => e.type === JT.sealed && e.call === id).length, 1);
  // (A sealed generation's post-seal steps are repeated by the fake as an invoke; it is not run or sealed again.)
  assert.deepEqual(relog().slice(length).filter(e => (e.call === id && e.type !== 'fake-invoke') || (isEntry(e, JT.attention) && e.item.call === id)).map(e => e.type), []);
  assert.equal(relog().some(e => e.type === 'fake-run' && e.call === id), false);
  assert.equal(errors.filter(e => e.includes('sealed failed')).length, 1, 'logged once');
  const rid = await f.request(again, 'stop', { target: wf.wid });
  assert.equal(f.decision(again, rid)?.reason, 'terminal:done');
});
