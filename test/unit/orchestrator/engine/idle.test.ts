import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readlink, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JOURNAL_REST_MS, openJournal, openJournalDescriptors, readJournalSnapshot } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { journalPath, orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { statusView, workflowSnapshot } from '../../../../src/orchestrator/snapshot.ts';
import { renderView } from '../../../../src/cli/main.ts';
import { doctor, renderDoctor } from '../../../../src/cli/doctor.ts';
import { writeStats } from '../../../../src/orchestrator/stats.ts';
import { ProcessTable } from '../../../../src/platform/proctable.ts';
import { JT, type Request, type RunBody } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

async function until<T>(fn: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error('Timed out'); await delay(20); }
}
/** Descriptors of this process open on workflow journals under `home` (Linux; undefined elsewhere). */
async function journalFds(home: string): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  let n = 0;
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
    if (target.startsWith(join(home, 'w')) && target.endsWith('/journal.jsonl')) n++;
  }
  return n;
}

test('a resting journal closes its descriptor, reopens it for an append and stays the same file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-rest-')), path = join(dir, 'w', 'x', 'journal.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = await openJournal(path), base = openJournalDescriptors();
  t.after(() => journal.close());
  await journal.append('one', { n: 1 });
  assert.equal(journal.descriptorOpen, true);
  journal.resting = true;
  await until(() => journal.descriptorOpen === false);
  assert.equal(openJournalDescriptors(), base - 1);
  if (process.platform === 'linux') assert.equal(await journalFds(dir), 0);
  // An append reopens it; a burst writes through one descriptor, which closes again after the burst.
  await Promise.all([journal.append('two', { n: 2 }), journal.append('three', { n: 3 })]);
  assert.equal(journal.descriptorOpen, true);
  assert.deepEqual(readJournalSnapshot(path).map(e => [e.seq, e.type]), [[1, 'one'], [2, 'two'], [3, 'three']]);
  await delay(JOURNAL_REST_MS + 200);
  assert.equal(journal.descriptorOpen, false);
  // Not resting: the descriptor stays after an append.
  journal.resting = false;
  await journal.append('four', {});
  await delay(JOURNAL_REST_MS + 200);
  assert.equal(journal.descriptorOpen, true);
  journal.resting = true;
  await until(() => journal.descriptorOpen === false);
  // A failed reopen wrote nothing and does not poison the handle: the next append succeeds.
  if (process.getuid?.() !== 0) {
    await chmod(path, 0o400);
    await assert.rejects(journal.append('denied', {}), /EACCES/);
    await chmod(path, 0o600);
    await journal.append('five', {});
    assert.deepEqual(readJournalSnapshot(path).map(e => e.type).slice(-2), ['four', 'five']);
    journal.resting = true;
    await until(() => journal.descriptorOpen === false);
  }
  // A file changed behind a resting handle is never appended to.
  await truncate(path, 10);
  await assert.rejects(journal.append('six', {}), /Journal changed while closed/);
  await journal.close();
  assert.equal(openJournalDescriptors(), base - 1);
});

test('finished workflows hold no journal descriptor and are not polled; a follow-up reopens one and recovery is unchanged', { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-idle-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const scans = { n: 0 }, list = ProcessTable.prototype.list;
  ProcessTable.prototype.list = function (...args) { scans.n++; return list.apply(this, args); };
  const engines: { engine: Engine; ledgers: Ledgers }[] = [];
  t.after(async () => {
    ProcessTable.prototype.list = list;
    for (const { engine, ledgers } of engines) { await engine.close().catch(() => {}); await ledgers.orch.close(); }
    await rm(home, { recursive: true, force: true });
  });
  const boot = async () => {
    const ledgers: Ledgers = { home, config: { k: { idleExitMs: 60_000, trackerMs: 100 } }, orch: await openJournal(orchLedger(home)) };
    const engine = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
    engines.push({ engine, ledgers });
    await engine.recover();
    return { engine, ledgers };
  };
  let sseq = 0;
  const submit = async (engine: Engine, kind: Request['kind'], body: unknown) => {
    const rid = `r${++sseq}`;
    await publishRequest(orchInbox(home), { rid, from: 'main:test', to: 'orch', sseq, kind, body } as Request);
    await engine.intake();
    return rid;
  };
  const { engine, ledgers } = await boot();
  const wids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const rid = await submit(engine, 'run', { cwd: join(home, 'project'), source: `return await runs.run('b', {agent:'test',task:'b${i}'});` } satisfies RunBody);
    wids.push(String(ledgers.orch.entries().find(e => e.type === JT.created && e.rid === rid)!.wid));
  }
  const workflows = wids.map(wid => engine.store.workflows.get(wid)!);
  await until(() => workflows.every(wf => wf.journal.entries().some(e => e.type === JT.done)));
  // Every workflow finished: no journal descriptor stays open, none is considered live.
  await until(() => engine.stats().openJournals === 0);
  assert.equal(engine.stats().liveWorkflows, 0);
  if (process.platform === 'linux') assert.equal(await journalFds(home), 0);

  // Idle: the 1 s intake poll runs no pass while nothing changes, and the evaluator host is scanned only rarely.
  const controller = new AbortController(), loop = engine.loop(controller.signal);
  await delay(300);
  const passes = engine.stats().passesPerSecond, scansBefore = scans.n;
  const before = (engine as unknown as { passes: number[] }).passes.length;
  await delay(2500);
  assert.equal((engine as unknown as { passes: number[] }).passes.length, before, 'no intake pass while idle');
  assert.ok(scans.n - scansBefore <= 1, `evaluator host scans while no script runs: ${scans.n - scansBefore}`);
  assert.ok(passes >= 0);

  // A follow-up to a closed workflow: a new generation continuing the same session, sealed; then it rests again.
  const [wf] = workflows;
  const sent = await submit(engine, 'send', { to: `${wf!.wid}/b`, kind: 'follow-up', message: 'more' });
  assert.equal(ledgers.orch.entries().find(e => e.type === JT.applied && e.rid === sent)?.type, JT.applied);
  const generation = wf!.journal.entries().find(e => e.type === 'generation' && e.rid === sent)!;
  assert.equal(generation.from, `${wf!.wid}@1/b@1`);
  await until(() => wf!.journal.entries().some(e => e.type === JT.sealed && e.call === `${wf!.wid}@1/b@2`));
  await until(() => wf!.journal.entries().some(e => e.type === JT.attention && (e.item as { id: string }).id === `finished:${wf!.wid}@1/b@2`));
  await until(() => engine.stats().openJournals === 0);
  assert.equal(engine.stats().liveWorkflows, 0);
  // Disk and memory agree after the reopen.
  assert.deepEqual(readJournalSnapshot(journalPath(home, wf!.wid)), wf!.journal.entries());
  controller.abort(); await loop;
  await engine.close(); await ledgers.orch.close(); engines.length = 0;

  // Recovery: the same state, and the finished workflows rest again.
  const again = await boot();
  const snap = workflowSnapshot(home, wf!.wid);
  assert.equal(snap.status, 'done');
  assert.deepEqual(snap.calls.map(c => [c.key, c.gen, c.result?.status]), [['b', 1, 'ok'], ['b', 2, 'ok']]);
  await until(() => again.engine.stats().openJournals === 0);
  assert.equal(again.engine.stats().workflows, 3);
});

test('status and doctor show the stats of the running orchestrator only', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-stats-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home));
  await orch.append('orchestrator', { version: '0.0.0', pid: process.pid });
  await orch.close();
  assert.equal(statusView(home).orchestratorStats, undefined, 'nothing published yet');
  const stats = { pid: process.pid, at: Date.now(), workflows: 190, liveWorkflows: 3, openJournals: 3, passesPerSecond: 0.4, readBytes: 12e6 };
  await writeStats(home, stats);
  assert.deepEqual(statusView(home).orchestratorStats, stats);
  assert.match(renderView(statusView(home)), /^orchestrator: 0\.0\.0 \(pid \d+\)[^\n]* · 3 live \/ 190 workflows, 3 journals open, 0\.4 passes\/s, read 12 MB$/m);
  const report = await doctor(home);
  assert.deepEqual(report.orchestratorStats, stats);
  assert.match(renderDoctor(report), /orchestrator: .*; 3 live \/ 190 workflows/);
  // Another process's numbers (a previous orchestrator) are not shown.
  await writeStats(home, { ...stats, pid: process.pid + 100000 });
  assert.equal(statusView(home).orchestratorStats, undefined);
});
