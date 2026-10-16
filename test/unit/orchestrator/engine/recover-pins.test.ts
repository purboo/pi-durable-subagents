// A start does not hash the pinned files of finished workflows; they are verified before their script, inputs or origin
// are used again. The store's ledger lookups (pruned, created, intents) are indexes kept current on append.
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
  const rid = await f.request(b, 'resume', { wid: wf.wid });
  assert.equal(f.decision(b, rid)?.type, JT.applied);
  assert.equal(b.evaluator.starts(wf.wid), 1);
  assert.equal(b.engine.store.verified(wf.wid), true);
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
