import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openJournal, readJournalSnapshot } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, orchLock, pinnedDir, journalPath } from '../../../../src/paths.ts';
import { OsLock } from '../../../../src/platform/lock.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { statusBrief, statusView, workflowSnapshot } from '../../../../src/orchestrator/snapshot.ts';
import { contentHash } from '../../../../src/kernel/ids.ts';
import { main } from '../../../../src/orchestrator/main.ts';
import { EvaluatorClient, type EvaluatorTransport } from '../../../../src/orchestrator/evaluator-client.ts';
import { JT, type Request, type RunBody, type EvalToOrch, type OrchToEval, type CallResult } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  death!: () => void;
  async start(message: (message: EvalToOrch) => void, death: () => void) { this.receive = message; this.death = death; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
  current() { return this.messages.findLast(m => m.t === 'start')! as Extract<OrchToEval, { t: 'start' }>; }
}
async function until<T>(fn: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error('Timed out'); await delay(10); }
}
async function fixture(t: test.TestContext, evaluator?: EvaluatorTransport | ((ledgers: Ledgers) => EvaluatorTransport), hold?: string) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-engine-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const ledgers: Ledgers = { home, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(home)) };
  const executor = fakeExecutor(ledgers, { delay: key => key === 'a' ? 400 : key === 'b' ? 10 : 0, hold });
  const engine = new Engine(ledgers, executor, { evaluator: typeof evaluator === 'function' ? evaluator(ledgers) : evaluator, discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await ledgers.orch.close(); await rm(home, { recursive: true, force: true }); });
  const run = async (source: string, extra: Partial<RunBody> = {}, sseq = 1) => {
    const req: Request<RunBody> = { rid: `run-${sseq}`, from: 'main:test', to: 'orch', sseq, kind: 'run', body: { cwd: join(home, 'project'), source, ...extra } };
    await publishRequest(orchInbox(home), req); await engine.intake();
    const created = ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!;
    return engine.store.workflows.get(created.wid as string)!;
  };
  await engine.recover();
  return { home, ledgers, engine, executor, run };
}
const spec = (task: string) => ({ agent: 'test', task });
const propose = (evalClient: ManualEvaluator, pos: number, key: string, task = key) => {
  const { wid, ev } = evalClient.current(); evalClient.receive({ t: 'call', wid, ev, pos, key, spec: spec(task) });
};
const idle = (evalClient: ManualEvaluator, exposed: number) => {
  const { wid, ev } = evalClient.current(); evalClient.receive({ t: 'idle', wid, ev, exposed });
};

test('intake FIFO, gap holding, immutable identity and pin copies', async t => {
  const evaluator = new ManualEvaluator();
  const { home, ledgers, engine } = await fixture(t, evaluator);
  const input = join(home, 'declared.txt'); await writeFile(input, 'fixed input');
  const one: Request = { rid: 'one', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), source: 'return args;', args: { value: 7 }, inputs: { document: input } } };
  const two: Request = { rid: 'two', from: 'main:test', to: 'orch', sseq: 2, kind: 'revise', body: {} };
  await publishRequest(orchInbox(home), two); await engine.intake();
  assert.equal(ledgers.orch.entries().filter(e => e.type === JT.admitted).length, 0);
  await publishRequest(orchInbox(home), one); await engine.intake();
  assert.deepEqual(ledgers.orch.entries().filter(e => e.type === JT.admitted).map(e => e.rid), ['one', 'two']);
  assert.equal(ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === 'two')?.reason, 'unknown-workflow');
  const wid = ledgers.orch.entries().find(e => e.type === JT.created)!.wid as string;
  assert.equal(engine.store.workflows.get(wid)!.journal.entries()[0]!.type, 'wf-created');
  assert.deepEqual(JSON.parse(await readFile(join(pinnedDir(home, wid), 'args.json'), 'utf8')), { value: 7 });
  const mapping = JSON.parse(await readFile(join(pinnedDir(home, wid), 'inputs.json'), 'utf8'));
  await writeFile(input, 'changed');
  assert.equal(await readFile(mapping.document, 'utf8'), 'fixed input');
  assert.ok(JSON.parse(await readFile(join(pinnedDir(home, wid), 'agents.json'), 'utf8')).some((a: { name: string }) => a.name === 'test'));
  await publishRequest(orchInbox(home), { ...one, body: { source: 'different' } }); await engine.intake();
  assert.equal(ledgers.orch.entries().filter(e => e.type === JT.created).length, 1);
  assert.equal(ledgers.orch.entries().filter(e => e.type === JT.applied && e.rid === 'one').length, 1);
  assert.ok(ledgers.orch.entries().some(e => e.type === JT.rejected && e.reason === 'identity-conflict'));
});

test('live call -> run -> seal -> durable exposure -> send; host death replays sealed calls', async t => {
  const evaluator = new ManualEvaluator();
  const { engine, run } = await fixture(t, evaluator);
  const wf = await run('unused');
  propose(evaluator, 0, 'a'); idle(evaluator, 0);
  await until(() => evaluator.messages.some(m => m.t === 'expose'));
  const order = wf.journal.entries().map(e => e.type);
  assert.ok(order.indexOf('call') < order.indexOf('fake-run'));
  assert.ok(order.indexOf('fake-run') < order.indexOf(JT.sealed));
  assert.ok(order.indexOf(JT.sealed) < order.indexOf('exposed'));
  const ev1 = evaluator.current().ev;
  evaluator.death(); await until(() => evaluator.current().ev === ev1 + 1);
  evaluator.receive({ t: 'call', wid: wf.wid, ev: ev1, pos: 1, key: 'stale', spec: spec('stale') });
  propose(evaluator, 0, 'a'); idle(evaluator, 0);
  await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
  assert.equal(wf.journal.entries().filter(e => e.type === 'call').length, 1);
  assert.equal(evaluator.messages.filter(m => m.t === 'expose').length, 2);
  idle(evaluator, 1); await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === JT.done).length, 0);
});

test('real evaluator rolling DAG exposes in completion order', async t => {
  const { engine, run } = await fixture(t);
  const wf = await run(`const a = runs.run('a', {agent:'test', task:'a'});
const b = runs.run('b', {agent:'test', task:'b'});
const first = await Promise.race([a,b]);
emit(first.key);
await runs.run('dependent', {agent:'test', task:first.key});
await a; await b; return first.key;`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  assert.equal(wf.journal.entries().find(e => e.type === JT.done)?.result, 'b');
  assert.deepEqual(wf.journal.entries().filter(e => e.type === 'exposed').map(e => e.pos), [1, 3, 0]);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 3);
  await engine.intake();
});

test('real host SIGKILL: rolling DAG reproduces logged exposure order in ev+1', async t => {
  const sent: OrchToEval[] = [], received: EvalToOrch[] = [];
  const { ledgers, run } = await fixture(t, ledgers => {
    const client = new EvaluatorClient(ledgers);
    return {
      start: (message, death) => client.start(event => { received.push(event); message(event); }, death),
      send: event => { sent.push(event); client.send(event); },
      close: () => client.close(),
    };
  }, 'tail');
  const wf = await run(`const a = runs.run('a', {agent:'test',task:'a'});
const b = runs.run('b', {agent:'test',task:'b'});
const first = await Promise.race([a,b]);
await runs.run('dependent', {agent:'test',task:first.key});
await a; await b;
return await runs.run('tail', {agent:'test',task:'tail'});`);
  await until(() => wf.journal.entries().some(e => e.type === 'fake-run' && e.key === 'tail'));
  const firstExposures = sent.flatMap(m => m.t === 'expose' && m.ev === 1 ? [m.pos] : []);
  // Which of a and b finishes first depends on the runner's timing; the property is that ev+1 replays that order.
  assert.deepEqual([...firstExposures].sort(), [0, 1, 2]); assert.equal(firstExposures.length, 3);
  const host = ledgers.orch.entries().findLast(e => e.type === 'eval-tracked')!.process as { pid: number };
  process.kill(host.pid, 'SIGKILL');
  await until(() => received.some(m => m.t === 'idle' && m.ev === 2 && m.exposed === 3));
  assert.deepEqual(sent.flatMap(m => m.t === 'expose' && m.ev === 2 ? [m.pos] : []), firstExposures);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 4);
  assert.equal(wf.journal.entries().filter(e => e.type === 'exposed').length, 3);
  assert.equal(wf.journal.entries().filter(e => e.type === JT.done).length, 0);
  assert.ok(ledgers.orch.entries().some(e => e.type === 'eval-fenced'));
});

test('creation intent recovers partial pins and commits created only once', async t => {
  const evaluator = new ManualEvaluator(); const { engine, ledgers, run, home } = await fixture(t, evaluator);
  const existing = await run('return 1;');
  const wid = 'recovered';
  await ledgers.orch.append('create-intent', { rid: 'interrupted', wid, origin: 'main:test', cwd: existing.cwd, pins: existing.pins });
  await mkdir(pinnedDir(home, wid), { recursive: true });
  await writeFile(join(pinnedDir(home, wid), 'script.js'), existing.pins.source);
  await engine.recover();
  const wf = engine.store.workflows.get(wid)!;
  assert.equal(wf.journal.entries()[0]!.type, 'wf-created');
  assert.equal(await readFile(join(pinnedDir(home, wid), 'args.json'), 'utf8'), 'null');
  await engine.store.recover();
  assert.equal(ledgers.orch.entries().filter(e => e.type === JT.created && e.rid === 'interrupted').length, 1);
});

test('replay mismatch parks without rerunning', async t => {
  const evaluator = new ManualEvaluator(); const { engine, run } = await fixture(t, evaluator);
  const wf = await run('unused'); propose(evaluator, 0, 'a'); idle(evaluator, 0);
  await until(() => evaluator.messages.some(m => m.t === 'expose'));
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'a', 'changed'); await engine.intake();
  const done = wf.journal.entries().find(e => e.type === JT.done)!;
  assert.equal(done.status, 'parked'); assert.match(done.error as string, /mismatch/);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
});

test('frontier waits for acknowledged exposures then parks missing output', async t => {
  const evaluator = new ManualEvaluator(); const { engine, run } = await fixture(t, evaluator, 'pending');
  const wf = await run('unused'); propose(evaluator, 0, 'a'); idle(evaluator, 0);
  await until(() => evaluator.messages.some(m => m.t === 'expose'));
  propose(evaluator, 1, 'pending'); await engine.intake();
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'a'); idle(evaluator, 0); await engine.intake();
  assert.ok(!wf.journal.entries().some(e => e.type === JT.done));
  idle(evaluator, 1); await engine.intake();
  const done = wf.journal.entries().find(e => e.type === JT.done)!;
  assert.equal(done.status, 'parked'); assert.match(done.error as string, /Missing output/);
});

test('sealed but not exposed is recovered without calling executor.run', async t => {
  const evaluator = new ManualEvaluator(); const { engine, run } = await fixture(t, evaluator);
  const wf = await run('unused');
  propose(evaluator, 0, 'a');
  await until(() => wf.journal.entries().some(e => e.type === JT.sealed));
  assert.equal(wf.journal.entries().filter(e => e.type === 'exposed').length, 0);
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'a'); idle(evaluator, 0); await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
  assert.equal(wf.journal.entries().filter(e => e.type === 'exposed').length, 1);
});

test('now/random values replay and changed needs park', async t => {
  const evaluator = new ManualEvaluator(); const { engine, run } = await fixture(t, evaluator);
  const wf = await run('unused');
  evaluator.receive({ t: 'need', wid: wf.wid, ev: 1, n: 0, kind: 'random' }); await engine.intake();
  const value = wf.journal.entries().find(e => e.type === 'value')!.value;
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  evaluator.receive({ t: 'need', wid: wf.wid, ev: 2, n: 0, kind: 'random' }); await engine.intake();
  assert.equal((evaluator.messages.findLast(m => m.t === 'value') as { value: number }).value, value);
  assert.equal(wf.journal.entries().filter(e => e.type === 'value').length, 1);
  evaluator.death(); await until(() => evaluator.current().ev === 3);
  evaluator.receive({ t: 'need', wid: wf.wid, ev: 3, n: 0, kind: 'now' }); await engine.intake();
  assert.equal(wf.journal.entries().find(e => e.type === JT.done)?.status, 'parked');
});

test('idle exits after K6 and held OS lock prevents opening a ledger', async t => {
  const { engine, home } = await fixture(t, new ManualEvaluator());
  const began = performance.now(); await engine.loop();
  assert.ok(performance.now() - began >= 30);
  const lock = await new OsLock().tryAcquire(orchLock(home)); assert.ok(lock);
  try {
    await main({ home, executor: () => { throw new Error('must not construct executor'); } });
    const second = child(home);
    assert.equal((await second.ended).code, 0, second.stderr());
  }
  finally { await lock.release(); }
});

test('unfinished work prevents idle exit; drain commits proposals without dispatching and held work lets the orchestrator exit', async t => {
  const evaluator = new ManualEvaluator(); const { engine, home, run } = await fixture(t, evaluator);
  const wf = await run('unused');
  const busy = new AbortController(), t0 = performance.now(), busyTimer = setTimeout(() => busy.abort(), 100);
  try { await engine.loop(busy.signal); } finally { clearTimeout(busyTimer); }
  assert.ok(performance.now() - t0 >= 90, 'unfinished work keeps the orchestrator alive');
  await publishRequest(orchInbox(home), { rid: 'drain', from: 'cli:test', to: 'orch', sseq: 1, kind: 'drain', body: {} });
  await engine.intake();
  propose(evaluator, 0, 'new'); idle(evaluator, 0); await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === 'call').length, 1);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 0);
  // Drain: work the drain holds cannot progress until a resume request (which starts an orchestrator), so it does not keep one alive.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try { await engine.loop(controller.signal); } finally { clearTimeout(timer); }
  assert.equal(controller.signal.aborted, false, 'idle exit while only held work remains');
});

test('drain holds only the workflows that exist when it is recorded; a later run dispatches normally', async t => {
  const { engine, home, run } = await fixture(t);
  await submit(engine, home, 'drain', { fence: true });
  const wf = await run(`return await runs.run('a', {agent:'test',task:'a'});`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
});

test('run fanout, send, withdraw, stop and drain use committed lifecycle', async t => {
  const evaluator = new ManualEvaluator(); const { engine, home, ledgers, run } = await fixture(t, evaluator, 'pending');
  const wf = await run(undefined as unknown as string, { tasks: [spec('hello')] });
  assert.match(wf.pins.source, /runs.all/);
  propose(evaluator, 0, 'pending'); await engine.intake();
  const requests: Request[] = [
    { rid: 'send', from: 'cli:test', to: 'orch', sseq: 1, kind: 'send', body: { to: `${wf.wid}/pending`, kind: 'steer', message: 'new' } },
    { rid: 'withdraw', from: 'cli:test', to: 'orch', sseq: 2, kind: 'withdraw', body: { rids: ['send'] } },
    { rid: 'drain', from: 'cli:test', to: 'orch', sseq: 3, kind: 'drain', body: {} },
    { rid: 'stop', from: 'cli:test', to: 'orch', sseq: 4, kind: 'stop', body: { target: wf.wid } },
  ];
  await publishRequest(orchInbox(home), requests[0]!); await engine.intake();
  for (const req of requests.slice(1)) await publishRequest(orchInbox(home), req);
  await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-forward').length, 2);
  assert.equal(wf.journal.entries().find(e => e.type === JT.done)?.status, 'stopped');
  assert.ok(ledgers.orch.entries().some(e => e.type === 'drain'));
  assert.ok(ledgers.orch.entries().some(e => e.type === JT.applied && e.rid === 'withdraw'));
  assert.ok(ledgers.orch.entries().some(e => e.type === JT.withdrawn && e.rid === 'withdraw'));
});

function child(home: string, hold?: string, crashWindow: boolean | 'retire' = false) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('./fake.ts', import.meta.url))], { env: { ...process.env, DSA_HOME: home, ...(crashWindow ? { DSA_FAKE_CRASH_WINDOW: crashWindow === true ? 'admitted' : crashWindow } : {}), ...(hold ? { DSA_FAKE_HOLD: hold } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', data => { stderr += data; });
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { proc.once('error', reject); proc.once('exit', (code, signal) => resolve({ code, signal })); });
  return { proc, ended, stderr: () => stderr };
}

test('pin failures reject durably and rejected/withdrawn staging is removed', async t => {
  const { engine, home, ledgers } = await fixture(t, new ManualEvaluator());
  const req: Request<RunBody> = { rid: 'missing', from: 'cli:stage', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), workflow: join(home, 'absent.js') } };
  await publishRequest(orchInbox(home), req); await engine.intake();
  assert.match(ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === req.rid)!.reason as string, /^pin-failed: .*ENOENT/);
  await assert.rejects(readFile(join(home, 'staging', req.rid, 'snapshot.json')), { code: 'ENOENT' });
  const withdrawn = { ...req, rid: 'withdrawn-run', sseq: 2, body: { cwd: join(home, 'project'), source: 'return 1;' } };
  await publishRequest(orchInbox(home), withdrawn);
  await publishRequest(orchInbox(home), { rid: 'withdraw-stage', from: 'cli:stage', to: 'orch', sseq: 3, kind: 'withdraw', body: { rids: [withdrawn.rid] } });
  await engine.intake();
  assert.equal(ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === withdrawn.rid)?.reason, 'withdrawn');
  await assert.rejects(readFile(join(home, 'staging', withdrawn.rid, 'snapshot.json')), { code: 'ENOENT' });
});

test('existing staging is reused before admission even after external sources disappear', async t => {
  const { engine, home, ledgers } = await fixture(t, new ManualEvaluator());
  const file = join(home, 'original.js'); await writeFile(file, 'return "original";');
  const req: Request<RunBody> = { rid: 'staged', from: 'cli:stage', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), workflow: file } };
  await engine.store.stage(req, { home, agentDir: join(home, 'config'), globalNpmRoot: null });
  await rm(file);
  await publishRequest(orchInbox(home), req); await engine.intake();
  const created = ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!;
  assert.equal(engine.store.workflows.get(created.wid as string)!.pins.source, 'return "original";');
});

test('sequence-gap candidates stage on first observation; a staging dir without snapshot is restaged', async t => {
  const { engine, home, ledgers } = await fixture(t, new ManualEvaluator());
  const file = join(home, 'gap.js'); await writeFile(file, 'return "first";');
  const req: Request<RunBody> = { rid: 'gap', from: 'cli:gap', to: 'orch', sseq: 2, kind: 'run', body: { cwd: join(home, 'project'), workflow: file } };
  await publishRequest(orchInbox(home), req); await engine.intake();
  assert.ok(!ledgers.orch.entries().some(e => e.type === JT.admitted));
  await writeFile(file, 'return "changed";');
  await publishRequest(orchInbox(home), { rid: 'gap-first', from: 'cli:gap', to: 'orch', sseq: 1, kind: 'revise', body: {} });
  await engine.intake();
  const created = ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid)!;
  assert.equal(engine.store.workflows.get(created.wid as string)!.pins.source, 'return "first";');
  const incomplete = { ...req, rid: 'incomplete', sseq: 3 };
  await mkdir(join(home, 'staging', incomplete.rid));
  await publishRequest(orchInbox(home), incomplete); await engine.intake();
  assert.ok(!ledgers.orch.entries().some(e => e.type === JT.rejected && e.rid === incomplete.rid));
  const restaged = ledgers.orch.entries().find(e => e.type === JT.created && e.rid === incomplete.rid)!;
  assert.equal(engine.store.workflows.get(restaged.wid as string)!.pins.source, 'return "changed";');
});

test('SIGKILL after staging and admission, before create-intent, preserves original script and inputs', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-stage-kill-'));
  const children: ReturnType<typeof child>[] = [];
  t.after(async () => {
    for (const child of children) { if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL'); await child.ended; }
    await rm(home, { recursive: true, force: true });
  });
  const script = join(home, 'source.js'), input = join(home, 'input.txt');
  await writeFile(script, 'return {script:"original", input:runs.input("document")};');
  await writeFile(input, 'original input');
  await publishRequest(orchInbox(home), { rid: 'staged-crash', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: home, workflow: script, inputs: { document: input } } });
  const first = child(home, undefined, true); children.push(first);
  await until(() => readJournalSnapshot(orchLedger(home)).some(e => e.type === JT.admitted));
  assert.ok(!readJournalSnapshot(orchLedger(home)).some(e => e.type === 'create-intent'));
  assert.equal(await readFile(join(home, 'staging/staged-crash/inputs/document'), 'utf8'), 'original input');
  first.proc.kill('SIGKILL'); await first.ended;
  await writeFile(script, 'return "modified";'); await rm(input);
  const second = child(home); children.push(second);
  await until(() => second.proc.exitCode !== null || second.proc.signalCode !== null);
  assert.equal((await second.ended).code, 0, second.stderr());
  const created = readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created)!;
  const done = readJournalSnapshot(journalPath(home, created.wid as string)).find(e => e.type === JT.done)!;
  assert.equal(done.status, 'done', String(done.error));
  assert.deepEqual(done.result, { script: 'original', input: 'original input' });
});

test('SIGKILL engine mid-run: sealed result is replayed, unsealed call resumes', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-engine-kill-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test\n---\nTest');
  const children: ChildProcess[] = [];
  t.after(async () => { for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await rm(home, { recursive: true, force: true }); });
  await publishRequest(orchInbox(home), { rid: 'run', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), source: `await runs.run('a', {agent:'test',task:'a'}); return await runs.run('b', {agent:'test',task:'b'});` } });
  const first = child(home, 'b'); children.push(first.proc);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created));
  const file = journalPath(home, created.wid as string);
  await until(() => readJournalSnapshot(file).some(e => e.type === 'fake-run' && e.key === 'b'));
  first.proc.kill('SIGKILL'); assert.equal((await first.ended).signal, 'SIGKILL');
  const second = child(home); children.push(second.proc);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([second.ended, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Recovery timed out: ${second.stderr()}`)), 15_000); })]).finally(() => clearTimeout(timeout));
  assert.equal(exit.code, 0, second.stderr());
  const entries = readJournalSnapshot(file);
  assert.deepEqual(entries.filter(e => e.type === 'ev').map(e => e.n), [1, 2]);
  assert.equal(entries.filter(e => e.type === 'fake-run' && e.key === 'a').length, 1);
  assert.equal(entries.filter(e => e.type === 'fake-invoke' && e.key === 'a').length, 1);
  assert.equal(entries.filter(e => e.type === 'fake-run' && e.key === 'b').length, 2);
  assert.equal(entries.find(e => e.type === JT.done)?.status, 'done');
  assert.equal(entries.filter(e => e.type === 'exposed').length, 2);
});

async function submit(engine: Engine, home: string, kind: Request['kind'], body: unknown, sseq = 1) {
  const rid = `control-${sseq}`;
  await publishRequest(orchInbox(home), { rid, from: 'cli:extensions', to: 'orch', sseq, kind, body });
  await engine.intake();
  return rid;
}

test('staged budgets reach tickets and create-intent references large input snapshots', async t => {
  const evaluator = new ManualEvaluator(), { home, ledgers, run, engine } = await fixture(t, evaluator);
  const input = join(home, 'large.txt'); await writeFile(input, 'large-input'.repeat(100_000));
  ledgers.config.k!.spawnBudget = 7;
  const wf = await run('unused', { name: 'Named workflow', usageBudget: { tokens: 42, costUsd: 0.5 }, inputs: { large: input } });
  const intent = ledgers.orch.entries().find(e => e.type === 'create-intent')!;
  assert.equal(intent.pins, undefined);
  const ref = intent.snapshot as { path: string; hash: string };
  assert.equal(ref.path, 'staging/run-1/snapshot.json');
  assert.equal(ref.hash, contentHash(JSON.parse(await readFile(join(home, ref.path), 'utf8'))));
  assert.ok(JSON.stringify(intent).length < 1000);
  assert.equal(wf.pins.maxCalls, 7);
  ledgers.config.k!.spawnBudget = 0;
  propose(evaluator, 0, 'budget'); idle(evaluator, 0);
  await until(() => evaluator.messages.some(m => m.t === 'expose'));
  assert.deepEqual(wf.journal.entries().find(e => e.type === 'fake-invoke')!.workflowBudget, { tokens: 42, costUsd: 0.5 });
  assert.equal(workflowSnapshot(home, wf.wid).name, 'Named workflow');
  await engine.intake();
});

test('spawn refusals replay identically, remain sealed in snapshots and never dispatch', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine, ledgers } = await fixture(t, evaluator);
  const wf = await run('unused', { maxCalls: 1 });
  propose(evaluator, 0, 'first'); propose(evaluator, 1, 'refused'); idle(evaluator, 0);
  await until(() => evaluator.messages.filter(m => m.t === 'expose').length === 2);
  const first = evaluator.messages.filter(m => m.t === 'expose');
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
  assert.equal(wf.journal.entries().find(e => e.type === 'refused')!.reason, 'spawn-budget');
  const snapshot = workflowSnapshot(home, wf.wid), refusal = snapshot.calls.find(c => c.key === 'refused')!;
  assert.equal(refusal.refused, 'spawn-budget'); assert.equal(refusal.phase, 'sealed');
  assert.equal(refusal.result?.error, 'spawn budget exceeded'); assert.equal(snapshot.status, 'running');
  ledgers.config.k!.spawnBudget = 100;
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'first'); propose(evaluator, 1, 'refused'); idle(evaluator, 0); await engine.intake();
  assert.deepEqual(evaluator.messages.filter(m => m.t === 'expose' && m.ev === 2).map(m => ({ ...m, ev: 1 })), first);
  assert.equal(wf.journal.entries().filter(e => e.type === 'refused').length, 1);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
  idle(evaluator, 2); await engine.intake();
  assert.equal(workflowSnapshot(home, wf.wid).status, 'running');
});

test('real evaluator continues past a refusal and returns its failed result', async t => {
  const { run, home } = await fixture(t);
  const wf = await run(`return await runs.run('denied', {agent:'test',task:'no'});`, { maxCalls: 0 });
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  const snapshot = workflowSnapshot(home, wf.wid);
  assert.equal(snapshot.status, 'done');
  assert.equal((snapshot.result as CallResult).error, 'spawn budget exceeded');
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 0);
});

test('origin branch and input bytes stay on disk, not in memory, across revision and recovery', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine, ledgers } = await fixture(t, evaluator);
  const session = join(home, 'origin.jsonl'), input = join(home, 'doc');
  await writeFile(session, [{ type: 'session', version: 3, id: 'origin' }, { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'x'.repeat(1000) } }].map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(input, 'bytes');
  const wf = await run('source', { origin: { sessionFile: session }, inputs: { doc: input } });
  const pinned = join(pinnedDir(home, wf.wid), 'origin.jsonl');
  assert.equal(wf.pins.origin, undefined); assert.deepEqual(wf.pins.inputs, {});
  assert.equal(wf.originPath, pinned);
  assert.deepEqual((await readFile(pinned, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l).id), ['origin', 'a']);
  assert.equal(await readFile(wf.inputs.doc!, 'utf8'), 'bytes');
  propose(evaluator, 0, 'c'); idle(evaluator, 0);
  const invoked = await until(() => wf.journal.entries().find(e => e.type === 'fake-invoke'));
  assert.equal(invoked.originSession, pinned, 'the call ticket reads the pinned file');
  await writeFile(session, 'changed after admission');
  await submit(engine, home, 'revise', { wid: wf.wid, source: 'new source' });
  assert.equal(wf.revision, 2); assert.equal(wf.pins.origin, undefined);
  assert.equal(wf.originPath, join(pinnedDir(home, wf.wid), 'r2', 'origin.jsonl'));
  assert.equal(await readFile(wf.originPath!, 'utf8'), await readFile(pinned, 'utf8'), 'a revision keeps the pinned origin');
  const again = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
  await again.store.recover();
  const recovered = again.store.workflows.get(wf.wid)!;
  assert.equal(recovered.pins.origin, undefined); assert.deepEqual(recovered.pins.inputs, {});
  assert.equal(recovered.revision, 2); assert.equal(recovered.originPath, wf.originPath);
  await again.store.close();
});

test('a restart reads each revision\'s pins.json instead of parsing and re-publishing its staged snapshot', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine, ledgers } = await fixture(t, evaluator);
  const session = join(home, 'origin.jsonl'), input = join(home, 'doc');
  await writeFile(session, JSON.stringify({ type: 'session', version: 3, id: 'origin' }) + '\n');
  await writeFile(input, 'v1');
  const wf = await run('source', { origin: { sessionFile: session }, inputs: { doc: input }, usageBudget: { tokens: 5 } });
  await writeFile(input, 'v2');
  await submit(engine, home, 'revise', { wid: wf.wid, source: 'new source' });
  const recover = async () => {
    const again = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
    try { await again.store.recover(); return again.store.workflows.get(wf.wid)!; } finally { await again.store.close(); }
  };
  const records = [join(pinnedDir(home, wf.wid), 'pins.json'), join(pinnedDir(home, wf.wid), 'r2', 'pins.json')];
  for (const record of records) assert.equal(JSON.parse(await readFile(record, 'utf8')).pins.origin, undefined);
  // Without the staged snapshots, only the records can rebuild the workflow.
  await rm(join(home, 'staging'), { recursive: true, force: true });
  const recovered = await recover();
  assert.equal(recovered.revision, 2); assert.equal(recovered.pins.source, 'new source');
  assert.deepEqual(recovered.pins.usageBudget, { tokens: 5 }); assert.deepEqual(recovered.pins.inputSources, wf.pins.inputSources);
  assert.equal(recovered.originPath, wf.originPath); assert.equal(recovered.scriptPath, wf.scriptPath);
  assert.equal(await readFile(recovered.inputs.doc!, 'utf8'), 'v2');
  const first = await engine.store.atRevision(recovered, 1);
  assert.equal(first.pins.source, 'source'); assert.equal(await readFile(first.inputs.doc!, 'utf8'), 'v1');
  // A record for another snapshot is not trusted: the snapshot is needed again (and here it is gone).
  const r2 = JSON.parse(await readFile(records[1]!, 'utf8')); r2.snapshot = 'other';
  await writeFile(records[1]!, JSON.stringify(r2));
  await assert.rejects(recover(), /ENOENT/);
});

test('revision re-pins inputs, reuses matching seals, allocates changed generations and rejects stale requests', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine, ledgers } = await fixture(t, evaluator);
  const input = join(home, 'document'); await writeFile(input, 'before');
  const wf = await run('old source', { args: { version: 1 }, inputs: { doc: input } });
  propose(evaluator, 0, 'same'); propose(evaluator, 1, 'changed'); idle(evaluator, 0);
  await until(() => evaluator.messages.filter(m => m.t === 'expose').length === 2);
  const oldStart = evaluator.current();
  await writeFile(input, 'after');
  await submit(engine, home, 'revise', { wid: wf.wid, source: 'new source', args: { version: 2 } });
  assert.equal(wf.revision, 2); assert.equal(evaluator.current().ev, 2);
  assert.equal(wf.pins.source, 'new source'); assert.deepEqual(wf.pins.args, { version: 2 });
  assert.equal(await readFile(wf.inputs.doc!, 'utf8'), 'after');
  assert.equal(await readFile(join(pinnedDir(home, wf.wid), 'script.js'), 'utf8'), 'old source');
  assert.equal(ledgers.orch.entries().find(e => e.type === 'fake-retire')!.widRev, `${wf.wid}@1`);
  assert.ok(evaluator.messages.some(m => m.t === 'stop' && m.ev === 1));
  evaluator.receive({ t: 'error', wid: wf.wid, ev: oldStart.ev, kind: 'script', error: 'stale' });
  propose(evaluator, 0, 'same'); propose(evaluator, 1, 'changed', 'different task'); idle(evaluator, 0);
  await until(() => evaluator.messages.filter(m => m.t === 'expose' && m.ev === 2).length === 2);
  const entries = wf.journal.entries(), reused = entries.find(e => e.type === 'reused')!;
  assert.equal(reused.from, `${wf.wid}@1/same@1`);
  assert.equal(entries.filter(e => e.type === 'call' && e.key === 'same').length, 1);
  assert.equal(entries.findLast(e => e.type === 'call' && e.key === 'changed')!.gen, 2);
  assert.equal(entries.filter(e => e.type === 'fake-run').length, 3);
  const snapshot = workflowSnapshot(home, wf.wid);
  assert.equal(snapshot.rev, 2); assert.equal(snapshot.status, 'running'); assert.equal(snapshot.calls.length, 2);
  assert.equal(snapshot.calls.find(c => c.key === 'same')!.reused, reused.from);
  assert.equal(snapshot.calls.find(c => c.key === 'changed')!.callId, `${wf.wid}@2/changed@2`);
  const stale = await submit(engine, home, 'send', { to: `${wf.wid}@1/changed@1`, kind: 'steer', message: 'stale' }, 2);
  assert.equal(ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === stale)!.reason, 'stale-revision');
  const sealedSteer = await submit(engine, home, 'send', { to: `${wf.wid}/changed`, kind: 'steer', message: 'current' }, 3);
  assert.equal(decision(ledgers, sealedSteer)?.reason, 'finished:ok — use kind "follow-up" to continue it');
  assert.equal(wf.journal.entries().filter(e => e.type === 'generation').length, 0);
  const followUp = await submit(engine, home, 'send', { to: `${wf.wid}/changed`, kind: 'follow-up', message: 'continue' }, 4);
  assert.equal(decision(ledgers, followUp)?.type, JT.applied);
  assert.equal(wf.journal.entries().filter(e => e.type === 'generation').length, 1);
  await until(() => wf.journal.entries().filter(e => e.type === 'fake-run').length === 4);
  evaluator.death(); await until(() => evaluator.current().ev === 3);
  propose(evaluator, 0, 'same'); propose(evaluator, 1, 'changed', 'different task'); idle(evaluator, 0); await engine.intake();
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 4);
  assert.equal(evaluator.messages.filter(m => m.t === 'expose' && m.ev === 3).length, 2);
});

test('revision staging survives a sequence gap and pin failure never retires the old revision', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine, ledgers } = await fixture(t, evaluator);
  const wf = await run('original');
  const source = join(home, 'revision.js'); await writeFile(source, 'pinned revision');
  await submit(engine, home, 'revise', { wid: wf.wid, workflow: source }, 2);
  await rm(source);
  await submit(engine, home, 'revise', { wid: wf.wid, workflow: join(home, 'absent') }, 1);
  assert.match(String(ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === 'control-1')!.reason), /pin-failed/);
  assert.equal(wf.revision, 2); assert.equal(wf.pins.source, 'pinned revision');
  assert.equal(ledgers.orch.entries().filter(e => e.type === 'fake-retire').length, 1);
  await assert.rejects(readFile(join(home, 'staging/control-1/snapshot.json')), { code: 'ENOENT' });
});

test('resume supersedes a park durably, increments ev and resolves old finished attention', async t => {
  const evaluator = new ManualEvaluator(), { home, run, engine } = await fixture(t, evaluator);
  const wf = await run('return 1');
  evaluator.receive({ t: 'error', wid: wf.wid, ev: 1, kind: 'limit', error: 'temporary evaluator limit' });
  await engine.intake();
  assert.equal(workflowSnapshot(home, wf.wid).status, 'parked');
  await submit(engine, home, 'resume', { wid: wf.wid });
  assert.equal(evaluator.current().ev, 2);
  assert.equal(wf.journal.entries().find(e => e.type === 'resumed')!.n, 2);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'running');
  assert.equal(workflowSnapshot(home, wf.wid).attention.length, 0);
  evaluator.receive({ t: 'done', wid: wf.wid, ev: 2, result: 1 }); await engine.intake();
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
  assert.equal(workflowSnapshot(home, wf.wid).attention[0]!.rev, 2);
  assert.equal(wf.journal.entries().filter(e => e.type === JT.done).length, 2);
});

test('ExecutorShutdown rejection leaves the call unsealed and replayable', async t => {
  const evaluator = new ManualEvaluator(), { run, engine, executor, home } = await fixture(t, evaluator);
  const execute = executor.run.bind(executor);
  executor.run = async () => { const error = new Error('shutdown'); error.name = 'ExecutorShutdown'; throw error; };
  const wf = await run('unused'); propose(evaluator, 0, 'pending'); idle(evaluator, 0);
  await engine.intake(); await delay(10); await engine.intake();
  assert.equal(wf.journal.entries().filter(e => [JT.sealed, JT.done, 'exposed'].includes(e.type)).length, 0);
  executor.run = execute;
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'pending'); idle(evaluator, 0);
  await until(() => evaluator.messages.some(m => m.t === 'expose'));
  assert.equal(workflowSnapshot(home, wf.wid).calls[0]!.phase, 'sealed');
});

test('SIGKILL during revision retirement recovers staged pins without starting the old revision', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-revise-kill-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test\n---\nTest');
  const children: ReturnType<typeof child>[] = [];
  t.after(async () => {
    for (const p of children) { if (p.proc.exitCode === null && p.proc.signalCode === null) p.proc.kill('SIGKILL'); await p.ended; }
    await rm(home, { recursive: true, force: true });
  });
  await publishRequest(orchInbox(home), { rid: 'run', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), source: `return await runs.run('held',{agent:'test',task:'held'});` } });
  const first = child(home, 'held', 'retire'); children.push(first);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created));
  const file = journalPath(home, String(created.wid));
  await until(() => readJournalSnapshot(file).some(e => e.type === 'fake-run'));
  const source = join(home, 'new.js'); await writeFile(source, 'return "new revision";');
  await publishRequest(orchInbox(home), { rid: 'revise', from: 'main:test', to: 'orch', sseq: 2, kind: 'revise', body: { wid: created.wid, workflow: source } });
  await until(() => readJournalSnapshot(orchLedger(home)).some(e => e.type === 'fake-retire'));
  first.proc.kill('SIGKILL'); await first.ended; await rm(source);
  const second = child(home); children.push(second);
  await until(() => second.proc.exitCode !== null || second.proc.signalCode !== null);
  assert.equal((await second.ended).code, 0, second.stderr());
  const entries = readJournalSnapshot(file);
  assert.equal(entries.filter(e => e.type === 'revised').length, 1);
  assert.equal(entries.filter(e => e.type === 'fake-run').length, 1);
  assert.deepEqual(entries.filter(e => e.type === 'ev').map(e => e.n), [1, 2]);
  assert.equal(workflowSnapshot(home, String(created.wid)).result, 'new revision');
});

test('retired run completion cannot expose or park the successor revision', async t => {
  const evaluator = new ManualEvaluator(), { run, engine, executor, home } = await fixture(t, evaluator);
  let release!: (result: CallResult) => void;
  executor.run = () => new Promise(resolve => { release = resolve; });
  const wf = await run('unused'); propose(evaluator, 0, 'old'); idle(evaluator, 0); await engine.intake();
  await submit(engine, home, 'revise', { wid: wf.wid, source: 'return 2;' });
  release({ key: 'old', gen: 1, status: 'stopped', ok: false, output: '', error: 'retired' });
  await delay(10); await engine.intake();
  assert.equal(evaluator.messages.filter(m => m.t === 'expose').length, 0);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'running');
  assert.equal(workflowSnapshot(home, wf.wid).calls.length, 0);
  evaluator.receive({ t: 'done', wid: wf.wid, ev: 2, result: 2 }); await engine.intake();
  assert.equal(workflowSnapshot(home, wf.wid).result, 2);
});

test('resume recovery repairs finished attention after a crash at the resumed commit', async t => {
  const evaluator = new ManualEvaluator(), { run, engine, home } = await fixture(t, evaluator);
  const wf = await run('unused');
  evaluator.receive({ t: 'error', wid: wf.wid, ev: 1, kind: 'limit', error: 'limit' }); await engine.intake();
  await wf.journal.append('resumed', { rid: 'crash-resume', n: 2 });
  assert.equal(workflowSnapshot(home, wf.wid).attention.length, 1);
  await engine.recover();
  assert.equal(evaluator.current().ev, 2);
  assert.equal(workflowSnapshot(home, wf.wid).attention.length, 0);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'running');
});

test('invalid spawn budgets reject before creation and refused proposal mismatches park', async t => {
  const evaluator = new ManualEvaluator(), { engine, home, ledgers, run } = await fixture(t, evaluator);
  await submit(engine, home, 'run', { cwd: join(home, 'project'), source: 'unused', maxCalls: -1 });
  assert.match(String(ledgers.orch.entries().find(e => e.type === JT.rejected)!.reason), /invalid-maxCalls/);
  assert.equal(engine.store.workflows.size, 0);
  const wf = await run('unused', { maxCalls: 0 });
  propose(evaluator, 0, 'denied'); idle(evaluator, 0); await engine.intake();
  evaluator.death(); await until(() => evaluator.current().ev === 2);
  propose(evaluator, 0, 'denied', 'different'); await engine.intake();
  assert.equal(workflowSnapshot(home, wf.wid).status, 'parked');
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 0);
});

test('durable drain lets an in-flight call finish, blocks the next dispatch and resume releases it', async t => {
  const { engine, home, run, ledgers } = await fixture(t);
  const wf = await run(`await runs.run('a', {agent:'test',task:'a'}); return await runs.run('b', {agent:'test',task:'b'});`);
  await until(() => wf.journal.entries().some(e => e.type === 'fake-run' && e.key === 'a'));
  await submit(engine, home, 'drain', {});
  await until(() => wf.journal.entries().some(e => e.type === 'call' && e.key === 'b'));
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1);
  assert.equal(wf.journal.entries().filter(e => e.type === JT.sealed).length, 1);
  assert.equal(ledgers.orch.entries().findLast(e => e.type === 'drain')!.fence, false);
  await submit(engine, home, 'resume', { wid: wf.wid }, 2);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  assert.equal(ledgers.orch.entries().findLast(e => e.type === 'undrain')!.rid, 'control-2');
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 2);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
});

test('a follow-up on a finished workflow is live work: a drain holds it, status shows it, and resume releases it', async t => {
  const { engine, home, run, ledgers } = await fixture(t);
  const wf = await run(`return await runs.run('b', {agent:'test',task:'b'});`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  await submit(engine, home, 'drain', { fence: true }, 1);
  const sent = await submit(engine, home, 'send', { to: `${wf.wid}/b`, kind: 'follow-up', message: 'more' }, 2);
  assert.equal(decision(ledgers, sent)?.type, JT.applied);
  await delay(50);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1, 'held: the follow-up waits');
  const held = workflowSnapshot(home, wf.wid);
  assert.equal(held.status, 'done'); assert.equal(held.followUps, 1);
  assert.ok(statusView(home).workflows.some(w => w.wid === wf.wid && w.paused && w.followUps === 1));
  const brief = statusBrief(home, { origin: 'main:test' });
  assert.deepEqual(brief.active.map(w => [w.wid, w.followUps, w.calls.map(c => c.key)]), [[wf.wid, 1, ['b']]]);
  assert.equal(brief.finished.length, 0);
  const resumed = await submit(engine, home, 'resume', {}, 3);
  assert.equal(decision(ledgers, resumed)?.type, JT.applied, String(decision(ledgers, resumed)?.reason));
  await until(() => wf.journal.entries().some(e => e.type === JT.sealed && e.call === `${wf.wid}@1/b@2`));
  assert.equal(wf.journal.entries().filter(e => e.type === JT.done).length, 1, 'the workflow result stays');
  const after = workflowSnapshot(home, wf.wid);
  assert.equal(after.status, 'done'); assert.equal(after.followUps, undefined);
  assert.ok(statusView(home).workflows.some(w => w.wid === wf.wid && !w.paused && !w.followUps));
  assert.equal(statusBrief(home, { origin: 'main:test' }).active.length, 0);
});

test('drain without workflows idle-exits; the drain stays durable for the next orchestrator', async t => {
  const { engine, home, ledgers } = await fixture(t, new ManualEvaluator());
  await submit(engine, home, 'drain', { fence: true });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try { await engine.loop(controller.signal); } finally { clearTimeout(timer); }
  assert.equal(controller.signal.aborted, false);
  assert.equal(ledgers.orch.entries().findLast(e => e.type === 'drain' || e.type === 'undrain')!.type, 'drain');
});

test('drain with fence survives restart without dispatch, then resume continues unsealed calls', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-drain-kill-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test\n---\nTest');
  const children: ReturnType<typeof child>[] = [];
  t.after(async () => {
    for (const p of children) { if (p.proc.exitCode === null && p.proc.signalCode === null) p.proc.kill('SIGKILL'); await p.ended; }
    await rm(home, { recursive: true, force: true });
  });
  await publishRequest(orchInbox(home), { rid: 'run', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), source: `return await runs.run('held',{agent:'test',task:'held'});` } });
  const first = child(home, 'held'); children.push(first);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created));
  const file = journalPath(home, String(created.wid));
  await until(() => readJournalSnapshot(file).some(e => e.type === 'fake-run'));
  await publishRequest(orchInbox(home), { rid: 'drain-fence', from: 'main:test', to: 'orch', sseq: 2, kind: 'drain', body: { fence: true } });
  await until(() => readJournalSnapshot(orchLedger(home)).some(e => e.type === JT.applied && e.rid === 'drain-fence'));
  assert.ok(readJournalSnapshot(file).some(e => e.type === 'fake-fenced'));
  assert.equal(readJournalSnapshot(file).filter(e => e.type === JT.sealed || e.type === JT.done).length, 0);
  first.proc.kill('SIGKILL'); await first.ended;
  const second = child(home); children.push(second);
  await until(() => readJournalSnapshot(file).some(e => e.type === 'ev' && e.n === 2));
  // Held work cannot progress, so the restarted orchestrator idle-exits without dispatching; the drain stays durable.
  assert.equal((await second.ended).code, 0, second.stderr());
  assert.equal(readJournalSnapshot(file).filter(e => e.type === 'fake-run').length, 1);
  assert.equal(readJournalSnapshot(file).filter(e => e.type === JT.sealed || e.type === JT.done).length, 0);
  await publishRequest(orchInbox(home), { rid: 'resume', from: 'main:test', to: 'orch', sseq: 3, kind: 'resume', body: {} });
  const third = child(home); children.push(third); // the starter runs an orchestrator for the pending resume request
  assert.equal((await third.ended).code, 0, third.stderr());
  assert.equal(readJournalSnapshot(file).filter(e => e.type === 'fake-run').length, 2);
  assert.equal(readJournalSnapshot(file).filter(e => e.type === JT.sealed).length, 1);
  assert.equal(workflowSnapshot(home, String(created.wid)).status, 'done');
});

test('v12 §2: sealed steer rejects without opening a generation, stopped guidance and old resolution replay remain stable', async t => {
  const evaluator = new ManualEvaluator(), { engine, home, ledgers, run } = await fixture(t, evaluator);
  const wf = await run('unused'); propose(evaluator, 0, 'a'); idle(evaluator, 0);
  await until(() => wf.journal.entries().some(e => e.type === JT.sealed && e.call === `${wf.wid}@1/a@1`));
  const old: Request = { rid: 'old-steer', from: 'cli:old', to: 'orch', sseq: 1, kind: 'send', body: { to: `${wf.wid}/a`, kind: 'steer', message: 'historical' } };
  await ledgers.orch.append('request', { request: old });
  await ledgers.orch.append(JT.admitted, { rid: old.rid, from: old.from, sseq: old.sseq, hash: contentHash(old), kind: old.kind });
  await ledgers.orch.append(JT.applied, { rid: old.rid });
  await wf.journal.append('generation', { rid: old.rid, key: 'a', gen: 2, from: `${wf.wid}@1/a@1`, spec: spec('a'), revision: 1, opening: { rid: old.rid, kind: 'steer', message: 'historical' } });
  await wf.journal.append(JT.sealed, { call: `${wf.wid}@1/a@2`, result: { key: 'a', gen: 2, status: 'stopped', ok: false, output: '' } });
  await engine.intake();
  assert.equal(decision(ledgers, old.rid)?.type, JT.applied);
  assert.equal(wf.journal.entries().filter(e => e.type === 'generation' && e.rid === old.rid).length, 1);
  const rid = await submit(engine, home, 'send', { to: wf.wid, kind: 'steer', message: 'too late' });
  assert.equal(decision(ledgers, rid)?.reason, 'finished:stopped — use kind "follow-up" to continue it');
  assert.equal(wf.journal.entries().filter(e => e.type === 'generation').length, 1);
  const second = await submit(engine, home, 'send', { to: `${wf.wid}/a`, kind: 'steer', message: 'too late again' }, 2);
  assert.equal(decision(ledgers, second)?.reason, 'finished:stopped — use kind "follow-up" to continue it');
  assert.equal(wf.journal.entries().filter(e => e.type === 'generation').length, 1);
});

test('v12 §3: finished attention digests latest calls, report, errors and stopped without calling it failed', async () => {
  const { finishedText } = await import('../../../../src/orchestrator/engine.ts');
  const e = (seq: number, type: string, f: Record<string, unknown>) => ({ seq, ts: seq, type, ...f });
  const res = (key: string, status: string, output = '') => ({ key, gen: 1, status, ok: status === 'ok', output });
  const entries = [
    e(1, 'wf-created', { name: 'nightly', origin: 'o', cwd: '/', revision: 1 }),
    e(2, 'call', { key: 'a', gen: 1, spec: { agent: 'x' } }), e(3, 'call', { key: 'b', gen: 1, spec: { agent: 'x' } }), e(4, 'call', { key: 'c', gen: 1, spec: { agent: 'x' } }),
    e(5, 'sealed', { call: 'w@1/a@1', result: res('a', 'ok', 'line1\nDONE: a') }),
    e(6, 'sealed', { call: 'w@1/b@1', result: { ...res('b', 'stopped', 'partially complete'), error: 'user stopped' } }),
    e(7, 'sealed', { call: 'w@1/c@1', result: { ...res('c', 'skipped', 'ignored text'), data: { verdict: 'skip' } } }),
    e(8, 'workflow-done', { status: 'stopped', error: 'workflow stopped' }),
  ];
  assert.equal(finishedText('w', entries as never), 'nightly (w) stopped: 1 ok; 1 stopped; 1 skipped\na: ok\n  line1\nDONE: a\nb: stopped (edits it made so far are left in place)\n  partially complete\n  Error: user stopped\nc: skipped\n  {"verdict":"skip"}\nError: workflow stopped\nFull output: subagents status wid:w');
  assert.equal(finishedText('w', entries as never, 'w@1/b@1'), 'nightly/b@1 (follow-up) stopped:\nb: stopped (edits it made so far are left in place)\n  partially complete\n  Error: user stopped\nError: workflow stopped\nFull output: subagents status wid:w');
  assert.doesNotMatch(finishedText('w', entries as never), /failed/);
  entries.push(e(9, 'generation', { key: 'a', gen: 2, from: 'w@1/a@1', spec: { agent: 'x' } }));
  entries.push(e(10, 'sealed', { call: 'w@1/a@2', result: { key: 'a', gen: 2, status: 'timeout', ok: false, output: 'retry timed out' } }));
  const current = finishedText('w', entries as never);
  assert.match(current, /^nightly \(w\) stopped: 1 timeout; 1 stopped; 1 skipped/);
  assert.match(current, /a@2: timeout\n  retry timed out/);
  assert.doesNotMatch(current, /DONE: a/);
});

test('v12 §3: digest shares the notice fairly, bounds the whole, and keeps output and report tails', async () => {
  const { finishedText } = await import('../../../../src/orchestrator/engine.ts');
  const e = (seq: number, type: string, fields: Record<string, unknown>) => ({ seq, ts: seq, type, ...fields });
  const entries = [e(1, 'wf-created', { name: 'bulk', revision: 1 })];
  for (let i = 0; i < 8; i++) {
    const key = `k${i}`;
    entries.push(e(entries.length + 1, 'call', { key, gen: 1, spec: { agent: 'x' } }));
    entries.push(e(entries.length + 1, 'sealed', { call: `w@1/${key}@1`, result: { key, gen: 1, status: 'ok', ok: true, output: 'X'.repeat(3000) + `tail-${i}`, ...(i === 0 ? { data: { detail: 'Y'.repeat(3000), ending: 'report-tail' } } : {}) } }));
  }
  entries.push(e(entries.length + 1, 'workflow-done', { status: 'done', error: 'workflow error' }));
  const digest = finishedText('w', entries as never);
  assert.ok(digest.length <= 6000, `notice is ${digest.length} characters`);
  assert.match(digest, /^bulk \(w\) done: 8 ok/);
  assert.match(digest, /k0: ok\n  ….*report-tail"\}/s);
  assert.doesNotMatch(digest, /k0: ok\n  .*tail-0/);
  for (let i = 1; i < 8; i++) assert.match(digest, new RegExp(`k${i}: ok\\n  …X+tail-${i}`));
  assert.match(digest, /\nError: workflow error\nFull output: subagents status wid:w$/);
  const single = finishedText('w', entries as never, 'w@1/k0@1');
  assert.ok(single.length <= 6000);
  assert.match(single, /"detail":"Y{3000}","ending":"report-tail"/, 'a single report that fits is not cut');
  // Short results take only what they need; the long one gets the rest.
  const mixed = [e(1, 'wf-created', { name: 'mix', revision: 1 })];
  for (const [i, output] of ['short-a', 'short-b', 'L'.repeat(9000) + 'long-tail'].entries()) {
    mixed.push(e(mixed.length + 1, 'call', { key: `m${i}`, gen: 1, spec: { agent: 'x' } }));
    mixed.push(e(mixed.length + 1, 'sealed', { call: `w@1/m${i}@1`, result: { key: `m${i}`, gen: 1, status: 'ok', ok: true, output } }));
  }
  mixed.push(e(mixed.length + 1, 'workflow-done', { status: 'done' }));
  const fair = finishedText('w', mixed as never);
  assert.ok(fair.length <= 6000 && fair.length > 5500, `fair notice is ${fair.length} characters`);
  assert.match(fair, /m0: ok\n  short-a\nm1: ok\n  short-b\nm2: ok\n  …L+long-tail/);
});

const decision = (ledgers: Ledgers, rid: string) => ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid);

test('T6: resume of a final workflow and stop of a sealed call reject with reasons; drain and parked stay resumable', async t => {
  const { engine, home, ledgers, run } = await fixture(t);
  const wf = await run(`return await runs.run('a', {agent:'test',task:'a'});`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  let rid = await submit(engine, home, 'stop', { target: `${wf.wid}/a` }, 1);
  assert.deepEqual([decision(ledgers, rid)?.type, decision(ledgers, rid)?.reason], [JT.rejected, 'already-sealed:ok']);
  rid = await submit(engine, home, 'resume', { wid: wf.wid }, 2);
  assert.deepEqual([decision(ledgers, rid)?.type, decision(ledgers, rid)?.reason], [JT.rejected, 'terminal:done \u2014 start a new run']);
  rid = await submit(engine, home, 'resume', {}, 3);
  assert.equal(decision(ledgers, rid)?.reason, 'nothing-to-resume');
  assert.equal(wf.journal.entries().filter(e => e.type === 'resumed' || e.type === 'stop-requested').length, 0);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 1, 'nothing reran');
  // A drain holds only unfinished workflows: a final one stays final under a drain, and the reply says so.
  await submit(engine, home, 'drain', {}, 4);
  rid = await submit(engine, home, 'resume', { wid: wf.wid }, 5);
  assert.deepEqual([decision(ledgers, rid)?.type, decision(ledgers, rid)?.reason], [JT.rejected, 'terminal:done \u2014 start a new run']);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
  rid = await submit(engine, home, 'stop', { target: wf.wid }, 6);
  assert.equal(decision(ledgers, rid)?.reason, 'terminal:done', 'stopping a finished workflow is rejected, not silently applied');
});

test('T4: stop of a running call applies once; a later stop of the stopped seal rejects; a replayed stop stays applied', async t => {
  const evaluator = new ManualEvaluator(), { engine, home, ledgers, run } = await fixture(t, evaluator, 'held');
  const wf = await run('unused');
  propose(evaluator, 0, 'held'); idle(evaluator, 0); await engine.intake();
  await until(() => wf.journal.entries().some(e => e.type === 'fake-run'));
  const call = `${wf.wid}@1/held@1`;
  let rid = await submit(engine, home, 'stop', { target: `${wf.wid}/held` }, 1);
  assert.equal(decision(ledgers, rid)?.type, JT.applied);
  assert.deepEqual(wf.journal.entries().filter(e => e.type === 'stop-requested').map(e => [e.rid, e.call]), [[rid, call]]);
  assert.deepEqual(ledgers.orch.entries().findLast(e => e.type === 'fake-stop')?.target, { wid: wf.wid, callId: call });
  // The executor seals the stop (simulated); a second stop now reports the seal instead of pretending to act.
  await wf.journal.append(JT.sealed, { call, exec: `${call}#1.1`, result: { key: 'held', gen: 1, status: 'stopped', ok: false, output: '' } });
  rid = await submit(engine, home, 'stop', { target: call }, 2);
  assert.equal(decision(ledgers, rid)?.reason, 'already-sealed:stopped');
  // Crash window: the stop took effect (marker + seal) but its decision was never committed -> replay applies it.
  await wf.journal.append('stop-requested', { rid: 'control-3', call });
  rid = await submit(engine, home, 'stop', { target: `${wf.wid}/held` }, 3);
  assert.equal(decision(ledgers, rid)?.type, JT.applied);
});

test('P10/P11: script console lines are persisted per workflow, one line each with ev and level, and bounded', { timeout: 30_000 }, async t => {
  const { engine, home, run } = await fixture(t);
  const wf = await run(`console.log('hello', {a: 1}); console.warn('multi\\nline'); return 1;`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  const log = join(home, 'w', wf.wid, 'script.log');
  const lines = (await until(async () => { const text = await readFile(log, 'utf8').catch(() => ''); return text.split('\n').length > 2 ? text : ''; })).trim().split('\n');
  assert.match(lines[0]!, /^\S+Z ev=1 log: hello \{"a":1\}$/);
  assert.match(lines[1]!, /^\S+Z ev=1 warn: multi\\nline$/);
  const { statusDetail } = await import('../../../../src/orchestrator/snapshot.ts');
  assert.equal(statusDetail(home, wf.wid).scriptLog, log);
  const big = await run(`for (let i = 0; i < 1500; i++) console.log(String(i).padStart(1000, 'x')); return 2;`, {}, 2);
  await until(() => big.journal.entries().some(e => e.type === JT.done), 20_000);
  const bigLog = join(home, 'w', big.wid, 'script.log');
  const text = await until(async () => { const s = await readFile(bigLog, 'utf8').catch(() => ''); return s.endsWith('dropped]\n') ? s : ''; }, 20_000);
  assert.ok(Buffer.byteLength(text) <= 1 << 20, `bounded: ${Buffer.byteLength(text)}`);
  assert.equal(text.split('\n').filter(l => l.includes('limit (1 MiB) reached')).length, 1);
  assert.ok(text.split('\n').length > 900);
});

test('contracts: a script proposing an invalid spec gets a failed result naming the problems; nothing is dispatched', async t => {
  const { home, run } = await fixture(t);
  const wf = await run(`const r = await runs.run('a', {agent:'test', task:'a', isolaton:'worktree'}); return r;`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  const done = wf.journal.entries().find(e => e.type === JT.done)!;
  const result = done.result as { status: string; error: string };
  assert.equal(result.status, 'failed'); assert.match(result.error, /invalid spec: unknown field "isolaton"/);
  assert.equal(wf.journal.entries().filter(e => e.type === 'fake-run').length, 0);
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
});

test('contracts: status shows the real refusal reason, the same text the script received', async t => {
  const { home, run } = await fixture(t);
  const wf = await run(`return await runs.run('a', {agent:'test', task:'a', isolaton:'worktree'});`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  const shown = workflowSnapshot(home, wf.wid).calls[0]!.result!.error!;
  assert.match(shown, /invalid spec: unknown field "isolaton"/);
  assert.equal(shown, (wf.journal.entries().find(e => e.type === JT.done)!.result as { error: string }).error);
});

test('contracts: an unknown agent name fails only that call, naming the available agents; the workflow continues', async t => {
  const { home, run } = await fixture(t);
  const wf = await run(`const bad = await runs.run('a', {agent:'coder', task:'a'}); const good = await runs.run('b', {agent:'test', task:'b'}); return [bad.status, bad.error, good.status];`);
  await until(() => wf.journal.entries().some(e => e.type === JT.done));
  const [status, error, good] = wf.journal.entries().find(e => e.type === JT.done)!.result as string[];
  assert.equal(status, 'failed'); assert.match(error!, /unknown agent "coder"; available agents: .*\btest\b/); assert.equal(good, 'ok');
  assert.equal(workflowSnapshot(home, wf.wid).status, 'done');
});

test('P25: a bare wid addresses a single-call workflow; an unknown target names the addresses that work', async t => {
  const { engine, home, run, ledgers } = await fixture(t, undefined, 'a');
  const wf = await run(`return await runs.run('a', {agent:'test',task:'a'});`);
  await until(() => wf.journal.entries().some(e => e.type === 'call'));
  await submit(engine, home, 'send', { to: `${wf.wid}/nope`, kind: 'steer', message: 'x' }, 1);
  const rejected = await until(() => ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === 'control-1'));
  assert.equal(rejected.reason, `unknown-call: use one of ${wf.wid}/a`);
  await submit(engine, home, 'send', { to: wf.wid, kind: 'steer', message: 'use TOML' }, 2);
  await until(() => ledgers.orch.entries().some(e => e.type === JT.applied && e.rid === 'control-2'));
});

test('quit pause: a drain scoped to one session holds only its workflows; another session keeps running; resume of that origin continues them', async t => {
  const { engine, home, ledgers, run } = await fixture(t, undefined, 'held');
  const mine = await run(`return await runs.run('held', {agent:'test',task:'mine'});`, {}, 1);
  const req: Request<RunBody> = { rid: 'run-other', from: 'main:other', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(home, 'project'), source: `return await runs.run('b', {agent:'test',task:'other'});` } };
  await publishRequest(orchInbox(home), req); await engine.intake();
  const other = engine.store.workflows.get(ledgers.orch.entries().find(e => e.type === JT.created && e.rid === 'run-other')!.wid as string)!;
  await until(() => mine.journal.entries().some(e => e.type === 'fake-run'));
  const origin = mine.origin;
  await submit(engine, home, 'drain', { fence: true, origin }, 1);
  await until(() => mine.journal.entries().some(e => e.type === 'fake-fenced'));
  await until(() => other.journal.entries().some(e => e.type === JT.done));
  assert.equal(workflowSnapshot(home, other.wid).status, 'done', 'the other session was not paused');
  assert.equal(workflowSnapshot(home, mine.wid).status, 'running');
  assert.equal(statusView(home).workflows.find(w => w.wid === mine.wid)!.paused, true);
  assert.equal(statusView(home).workflows.find(w => w.wid === mine.wid)!.calls[0]!.phase, 'queued', 'a fenced, unsealed call waits; it is not shown as running');
  const fakeRuns = () => mine.journal.entries().filter(e => e.type === 'fake-run').length;
  await delay(100); assert.equal(fakeRuns(), 1, 'nothing is dispatched while held');
  const rid = await submit(engine, home, 'resume', { origin }, 2);
  assert.equal(decision(ledgers, rid)?.type, JT.applied);
  assert.deepEqual(ledgers.orch.entries().findLast(e => e.type === 'undrain'), { ...ledgers.orch.entries().findLast(e => e.type === 'undrain'), rid, origin });
  await until(() => fakeRuns() === 2);
  assert.equal(statusView(home).workflows.find(w => w.wid === mine.wid)!.paused, undefined);
});
