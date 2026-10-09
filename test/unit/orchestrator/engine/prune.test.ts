import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, workflowDir } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { unfinishedWorkflow } from '../../../../src/agent/main/snapshots.ts';
import { JT, type Request, type RunBody, type EvalToOrch, type OrchToEval } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import type { EvaluatorTransport } from '../../../../src/orchestrator/evaluator-client.ts';
import type { Workflow } from '../../../../src/orchestrator/store.ts';
import { fakeExecutor } from './fake.ts';
import { specDigest } from '../../../../src/requests.ts';
import { describe } from '../../../../src/cli/requests.ts';
import { EventLog } from '../../../../src/events/log.ts';

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
  ev(wid: string) { return (this.messages.findLast(m => m.t === 'start' && m.wid === wid) as { ev: number }).ev; }
}
type Booted = { ledgers: Ledgers; engine: Engine; evaluator: ManualEvaluator };

async function home(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-prune-'));
  await mkdir(join(dir, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(dir, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const booted: Booted[] = [];
  t.after(async () => {
    for (const b of booted) { await b.engine.close().catch(() => {}); await b.ledgers.orch.close(); }
    await rm(dir, { recursive: true, force: true });
  });
  /** Start an orchestrator engine over this home (one at a time: close the previous one first). */
  const boot = async (): Promise<Booted> => {
    const ledgers: Ledgers = { home: dir, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(dir)) };
    const evaluator = new ManualEvaluator();
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held' }), { evaluator, discovery: { home: dir, agentDir: join(dir, 'config'), globalNpmRoot: null } });
    const b = { ledgers, engine, evaluator }; booted.push(b);
    await engine.recover();
    return b;
  };
  return { dir, boot };
}
const sequence = new Map<string, number>();
async function request(b: Booted, kind: Request['kind'], body: unknown, rid?: string) {
  const sseq = (sequence.get(b.ledgers.home) ?? 0) + 1; sequence.set(b.ledgers.home, sseq);
  await publishRequest(orchInbox(b.ledgers.home), { rid: rid ?? `r${sseq}`, from: 'cli:prune-test', to: 'orch', sseq, kind, body } as Request);
  await b.engine.intake();
  return rid ?? `r${sseq}`;
}
async function run(b: Booted, end?: 'done' | 'failed' | 'parked' | 'stopped'): Promise<Workflow> {
  const rid = await request(b, 'run', { cwd: join(b.ledgers.home, 'project'), source: 'unused' } satisfies RunBody);
  const wf = b.engine.store.workflows.get(String(b.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === rid)!.wid))!;
  const ev = b.evaluator.ev(wf.wid);
  if (end === 'done') b.evaluator.receive({ t: 'done', wid: wf.wid, ev, result: 1 });
  if (end === 'failed') b.evaluator.receive({ t: 'error', wid: wf.wid, ev, kind: 'script', error: 'boom' });
  if (end === 'parked') b.evaluator.receive({ t: 'error', wid: wf.wid, ev, kind: 'limit', error: 'limit' });
  if (end === 'stopped') await request(b, 'stop', { target: wf.wid });
  await b.engine.intake();
  return wf;
}
const decision = (b: Booted, rid: string) => b.ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);
const pruned = (b: Booted, rid?: string) => b.ledgers.orch.entries().filter(e => e.type === 'pruned' && (!rid || e.rid === rid)).map(e => String(e.wid));

test('prune: only finished workflows without open work; named ineligible ones are rejected with a reason', async t => {
  const { boot } = await home(t), b = await boot();
  const done = await run(b, 'done'), failed = await run(b, 'failed'), stopped = await run(b, 'stopped');
  const parked = await run(b, 'parked'), running = await run(b);
  // Finished while a call is still running (in-process executor work), and finished with an unsealed generation (durable).
  const busy = await run(b);
  b.evaluator.receive({ t: 'call', wid: busy.wid, ev: b.evaluator.ev(busy.wid), pos: 0, key: 'held', spec: { agent: 'test', task: 'held' } });
  await b.engine.intake();
  b.evaluator.receive({ t: 'done', wid: busy.wid, ev: b.evaluator.ev(busy.wid), result: 0 }); await b.engine.intake();
  const generation = await run(b, 'done');
  await generation.journal.append('generation', { rid: 'g', key: 'x', gen: 2, from: `${generation.wid}@1/x@1`, spec: { agent: 'test', task: 'x' }, revision: 1, opening: { rid: 'g', kind: 'follow-up', message: '' } });
  const fenced = await run(b, 'done');
  await fenced.journal.append('fence-failed', { exec: `${fenced.wid}@1/x@1#1.1`, error: 'Fence timeout' });

  const reason = async (body: unknown) => { const rid = await request(b, 'prune', body); return [decision(b, rid)?.type, decision(b, rid)?.reason]; };
  assert.deepEqual(await reason({ wid: parked.wid }), [JT.rejected, 'not-finished:parked']);
  assert.deepEqual(await reason({ wid: running.wid }), [JT.rejected, 'not-finished:running']);
  assert.deepEqual(await reason({ wid: busy.wid }), [JT.rejected, 'open-generation']);
  assert.deepEqual(await reason({ wid: generation.wid }), [JT.rejected, 'open-generation']);
  assert.deepEqual(await reason({ wid: fenced.wid }), [JT.rejected, 'fence-failed']);
  assert.deepEqual(await reason({ wid: 'NOPE' }), [JT.rejected, 'unknown-workflow']);
  assert.deepEqual(await reason({ wid: done.wid, olderThanDays: 1 }), [JT.rejected, 'too-recent']);
  assert.deepEqual(await reason({ olderThanDays: -1 }), [JT.rejected, 'invalid-prune']);
  // Bulk with nothing old enough: applied, nothing pruned.
  const none = await request(b, 'prune', { olderThanDays: 30 });
  assert.equal(decision(b, none)?.type, JT.applied); assert.deepEqual(pruned(b, none), []);
  // Bulk: every eligible finished workflow, in wid order; the others stay.
  const all = await request(b, 'prune', {});
  assert.equal(decision(b, all)?.type, JT.applied);
  assert.deepEqual(pruned(b, all), [done.wid, failed.wid, stopped.wid].sort());
  for (const wf of [done, failed, stopped]) { assert.ok(!b.engine.store.workflows.has(wf.wid)); assert.ok(!existsSync(workflowDir(b.ledgers.home, wf.wid))); }
  for (const wf of [parked, running, busy, generation, fenced]) { assert.ok(b.engine.store.workflows.has(wf.wid)); assert.ok(existsSync(workflowDir(b.ledgers.home, wf.wid))); }
  assert.deepEqual(await reason({ wid: done.wid }), [JT.rejected, 'already-pruned']);
});

test('prune: the pruned entry commits first, then the handle closes and files go; the ledger keeps identity', async t => {
  const { dir, boot } = await home(t), b = await boot();
  const wf = await run(b, 'done'), createRid = String(b.ledgers.orch.entries().find(e => e.type === 'create-intent' && e.wid === wf.wid)!.rid);
  assert.ok((await stat(join(dir, 'staging', createRid))).isDirectory());
  const seen: { journal: boolean; staging: boolean; held: boolean }[] = [];
  const append = b.ledgers.orch.append.bind(b.ledgers.orch);
  b.ledgers.orch.append = async (type, fields) => {
    if (type === 'pruned') seen.push({ journal: existsSync(join(workflowDir(dir, wf.wid), 'journal.jsonl')), staging: existsSync(join(dir, 'staging', createRid)), held: b.engine.store.workflows.has(wf.wid) });
    return append(type, fields);
  };
  const rid = await request(b, 'prune', { wid: wf.wid });
  assert.deepEqual(seen, [{ journal: true, staging: true, held: true }]);
  assert.deepEqual(b.ledgers.orch.entries().filter(e => e.rid === rid).map(e => e.type), [JT.admitted, 'pruned', JT.applied]);
  const entry = b.ledgers.orch.entries().find(e => e.type === 'pruned')!;
  assert.equal(entry.endedAt, wf.journal.entries().find(e => e.type === JT.done)!.ts);
  assert.ok(Number(entry.bytes) > 0);
  assert.ok(!existsSync(workflowDir(dir, wf.wid))); assert.ok(!existsSync(join(dir, 'staging', createRid)));
  await assert.rejects(wf.journal.append('late', {}), /Journal closed/);
  assert.ok(b.ledgers.orch.entries().some(e => e.type === 'create-intent' && e.wid === wf.wid));
  assert.ok(b.ledgers.orch.entries().some(e => e.type === JT.created && e.wid === wf.wid));
});

test('prune: a crash between pruned and removal is finished on recovery and the wid never resurrects', async t => {
  const { dir, boot } = await home(t);
  const first = await boot(), wf = await run(first, 'done'), keep = await run(first, 'parked');
  const runRid = String(first.ledgers.orch.entries().find(e => e.type === JT.created && e.wid === wf.wid)!.rid);
  const original = first.ledgers.orch.entries().find(e => e.type === 'request' && (e.request as Request).rid === runRid)!.request as Request;
  const append = first.ledgers.orch.append.bind(first.ledgers.orch);
  first.ledgers.orch.append = async (type, fields) => {
    const entry = await append(type, fields);
    if (type === 'pruned') throw new Error('crash after pruned');
    return entry;
  };
  await assert.rejects(request(first, 'prune', { wid: wf.wid }, 'crash-prune'), /crash after pruned/);
  assert.ok(existsSync(workflowDir(dir, wf.wid)), 'removal was interrupted');
  await first.engine.close(); await first.ledgers.orch.close();

  const second = await boot();
  assert.ok(!existsSync(workflowDir(dir, wf.wid)), 'recovery finished the removal');
  assert.ok(!second.engine.store.workflows.has(wf.wid)); assert.ok(second.engine.store.workflows.has(keep.wid));
  await second.engine.intake();
  assert.equal(decision(second, 'crash-prune')?.type, JT.applied, 'the replayed prune is applied');
  assert.deepEqual(pruned(second), [wf.wid]);
  // Never resurrected: not by recovery, not by the same run request, not by controls addressed to it.
  await publishRequest(orchInbox(dir), original);
  await second.engine.intake();
  for (const [kind, body] of [['stop', { target: wf.wid }], ['resume', { wid: wf.wid }], ['send', { to: `${wf.wid}/a`, kind: 'steer', message: 'x' }]] as const) {
    const rid = await request(second, kind, body);
    assert.equal(decision(second, rid)?.type, JT.rejected, kind);
  }
  await second.engine.close(); await second.ledgers.orch.close();
  const third = await boot();
  assert.ok(!third.engine.store.workflows.has(wf.wid));
  assert.ok(!existsSync(workflowDir(dir, wf.wid)));
  assert.equal(third.ledgers.orch.entries().filter(e => e.type === JT.created && e.wid === wf.wid).length, 1);
  assert.equal(third.ledgers.orch.entries().filter(e => e.type === 'fake-recover' && e.wid === wf.wid).length, 0, 'no executor recovery for a pruned wid');
  assert.equal(third.ledgers.orch.entries().filter(e => e.type === JT.applied && e.rid === runRid).length, 1);
  // Starters never count a pruned workflow as pending work, even if its directory reappears half-removed.
  assert.equal(unfinishedWorkflow(dir), false);
  await mkdir(workflowDir(dir, wf.wid), { recursive: true });
  assert.equal(unfinishedWorkflow(dir), false);
});

test('request-id tombstone: pruned records the final status and, for a request-id run, its request and spec_digest', async t => {
  const { dir, boot } = await home(t), b = await boot();
  const body = { cwd: join(dir, 'project'), source: 'unused' } satisfies RunBody;
  await request(b, 'run', body, 'req:job-1');
  const wid = String(b.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === 'req:job-1')!.wid);
  b.evaluator.receive({ t: 'error', wid, ev: b.evaluator.ev(wid), kind: 'script', error: 'boom' }); await b.engine.intake();
  const plain = await run(b, 'done');
  const original = b.ledgers.orch.entries().find(e => e.type === 'request' && (e.request as Request).rid === 'req:job-1')!.request as Request;
  assert.equal((await describe(dir, { request: 'job-1' })).state, 'sealed');
  await request(b, 'prune', {});
  const tomb = (w: string) => { const { ts: _ts, seq: _seq, rid: _rid, bytes: _bytes, endedAt: _end, ...rest } = b.ledgers.orch.entries().find(e => e.type === 'pruned' && e.wid === w)!; return rest; };
  assert.deepEqual(tomb(wid), { type: 'pruned', wid, status: 'failed', request: 'job-1', spec_digest: specDigest(original) });
  assert.deepEqual(tomb(plain.wid), { type: 'pruned', wid: plain.wid, status: 'done' });
  // The admitted request and created entries survive the prune (append-only), so the id still resolves to its wid.
  assert.ok(b.ledgers.orch.entries().some(e => e.type === 'request' && (e.request as Request).rid === 'req:job-1'));
  const described = await describe(dir, { request: 'job-1' });
  assert.equal(described.state, 'pruned'); assert.equal(described.wid, wid);
  assert.deepEqual(described.pruned, { status: 'failed', endedAt: Number(b.ledgers.orch.entries().find(e => e.type === 'pruned' && e.wid === wid)!.endedAt) });
  assert.equal(described.spec_digest, specDigest(original)); assert.equal(described.request, 'job-1');
  assert.deepEqual((await describe(dir, { wid: plain.wid })).pruned?.status, 'done');
});

test('prune: when the event log cannot take the workflow\'s events the prune is rejected (event-log: …) and nothing goes', async t => {
  const { boot } = await home(t), b = await boot();
  const wf = await run(b, 'done'), other = await run(b, 'done');
  const original = EventLog.prototype.append;
  EventLog.prototype.append = function () { return Promise.reject(new Error('ENOSPC: no space left')); };
  let named = '', bulk = '';
  try {
    // Entries that derive events, so the prune's flush has something to log.
    for (const w of [wf, other]) await w.journal.append(JT.sealed, { call: `${w.wid}@1/x@1`, result: { status: 'ok' } });
    named = await request(b, 'prune', { wid: wf.wid }); bulk = await request(b, 'prune', {}); }
  finally { EventLog.prototype.append = original; }
  for (const rid of [named, bulk]) {
    assert.equal(decision(b, rid)?.type, JT.rejected);
    assert.match(String(decision(b, rid)?.reason), /^event-log: .*ENOSPC/);
  }
  assert.deepEqual(pruned(b), []);
  for (const w of [wf, other]) { assert.ok(b.engine.store.workflows.has(w.wid)); assert.ok(existsSync(workflowDir(b.ledgers.home, w.wid))); }
  // The caller retries later: the events are logged first, then the journal goes.
  const again = await request(b, 'prune', { wid: wf.wid });
  assert.equal(decision(b, again)?.type, JT.applied);
});
