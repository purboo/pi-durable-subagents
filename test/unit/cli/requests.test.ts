// R1–R3 unit paths of `run|send|stop --request` and `describe` over an isolated home: no orchestrator process (the
// starter is a no-op) or an in-process engine with the fake executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/cli/main.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { Outbox } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, outboxRoot } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { findRequest, requestRid, sendIdentified, specDigest } from '../../../src/requests.ts';
import { lastFence } from '../../../src/cli/requests.ts';
import { JT, type EvalToOrch, type OrchToEval, type Request } from '../../../src/types.ts';
import type { EvaluatorTransport } from '../../../src/orchestrator/evaluator-client.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-req-')), home = join(root, 'dsa'), cwd = join(root, 'work');
  await mkdir(join(cwd, '.pi/agents'), { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(cwd, '.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nEcho.');
  // Plain controls (stop <wid>) start an orchestrator process themselves: give them a no-op entry so the in-process
  // engine stays the only writer of this home.
  const noop = join(root, 'noop.mjs'); await writeFile(noop, '');
  const env = { DSA_HOME: home, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', DSA_ORCHESTRATOR_ENTRY: noop };
  const engines: { engine: Engine; close: () => Promise<void> }[] = [];
  // Deferred cleanups (intake timers, sessions, env) run last-in first-out before the engines close and the root goes.
  const deferred: (() => unknown)[] = [];
  const defer = (fn: () => unknown) => { deferred.push(fn); };
  t.after(async () => {
    for (const fn of deferred.reverse()) await fn();
    for (const e of engines) await e.close();
    await rm(root, { recursive: true, force: true });
  });
  const cli = async (args: string[], options: { waitMs?: number } = {}) => {
    const lines: string[] = [];
    const code = await main(args, { env, cwd, write: line => lines.push(line), starter: async () => {}, waitMs: options.waitMs ?? 0 });
    return { code, out: lines.join('\n') };
  };
  const spec = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  const inbox = async () => (await readdir(orchInbox(home)).catch(() => [] as string[])).filter(n => n.endsWith('.json'));
  const boot = async () => {
    const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: { k: { idleExitMs: 30 } } };
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held' }), { evaluator: new ManualEvaluator(), discovery: { home: root, agentDir: join(root, 'agent'), globalNpmRoot: null } });
    await engine.recover();
    engines.push({ engine, close: async () => { await engine.close().catch(() => {}); await orch.close(); } });
    return engine;
  };
    const pump = (engine: Engine) => { const timer = setInterval(() => void engine.intake(), 20); defer(() => clearInterval(timer)); return () => clearInterval(timer); };
  return { root, home, cwd, env, cli, spec, inbox, boot, defer, pump };
}

test('R1: ids are validated; spec_digest hashes kind, body and cond but not a run origin', () => {
  assert.equal(requestRid('a'), 'req:a'); assert.equal(requestRid('A'.repeat(124)).length, 128);
  for (const bad of ['', '-a', 'a/b', 'a b', 'A'.repeat(125), '.x']) assert.throws(() => requestRid(bad), /invalid request id/);
  const run = { kind: 'run' as const, body: { cwd: '/w', call: { agent: 'echo', task: 't' } } };
  assert.equal(specDigest(run), specDigest({ ...run, body: { ...run.body, origin: { sessionFile: '/s', leafId: 'x' } } }));
  assert.notEqual(specDigest(run), specDigest({ ...run, body: { ...run.body, name: 'n' } }));
  const answer = { kind: 'send' as const, body: { to: 'w/a', kind: 'answer', message: 'yes' } };
  assert.notEqual(specDigest({ ...answer, cond: { qid: 'q1', rev: 1 } }), specDigest({ ...answer, cond: { qid: 'q1', rev: 2 } }));
});

test('R2: run --request without a decision is pending (75); retries reuse the envelope; other content conflicts (3) and publishes nothing', async t => {
  const f = await fixture(t), path = await f.spec('a.json', { agent: 'echo', task: 'hello' });
  const first = await f.cli(['run', '--request', 'job-1', '--spec', path, '--json']);
  assert.equal(first.code, 75); assert.deepEqual(JSON.parse(first.out), { request: 'job-1', pending: true });
  assert.deepEqual(await f.inbox(), ['req:job-1.json']);
  const published = JSON.parse(await readFile(join(orchInbox(f.home), 'req:job-1.json'), 'utf8')) as Request;
  assert.deepEqual(published.body, { cwd: f.cwd, call: { agent: 'echo', task: 'hello' } });
  const pending = await f.cli(['describe', '--key', 'job-1', '--json']);
  assert.deepEqual(JSON.parse(pending.out), { state: 'pending', request: 'job-1', kind: 'run', spec_digest: specDigest(published) });
  assert.match((await f.cli(['run', '--request', 'job-1', '--spec', path])).out, /job-1: submitted; not decided yet — retry with the same id \(safe\)/);
  const sent = readJournalSnapshot(join(outboxRoot(f.home), 'outbox', (await readdir(join(f.home, 'outbox')))[0]!)).filter(e => e.type === 'sent');
  assert.equal(sent.length, 1, 'a retry adds no envelope');
  const other = await f.cli(['run', '--request', 'job-1', '--spec', await f.spec('b.json', { agent: 'echo', task: 'other' }), '--json']);
  assert.equal(other.code, 3);
  assert.deepEqual(JSON.parse(other.out), { request: 'job-1', error: 'request-conflict', spec_digest: specDigest(published), state: 'pending' });
  assert.deepEqual(await f.inbox(), ['req:job-1.json']);
  assert.deepEqual(JSON.parse(await readFile(join(orchInbox(f.home), 'req:job-1.json'), 'utf8')), published);
  // The tool's sender (another outbox) sees the same identity under the home-wide check.
  const outbox = await Outbox.open(outboxRoot(f.home), 'main:tool', () => orchInbox(f.home));
  t.after(() => outbox.close());
  const same = await sendIdentified(f.home, outbox, 'main:tool', 'req:job-1', 'run', { ...published.body as object, origin: { sessionFile: '/s', leafId: 'l' } });
  assert.ok('sent' in same && same.sent === false && same.request.from === published.from);
  const differs = await sendIdentified(f.home, outbox, 'main:tool', 'req:job-1', 'stop', { target: 'x' });
  assert.ok('conflict' in differs && differs.digest === specDigest(published));
  assert.deepEqual(await f.inbox(), ['req:job-1.json']);
  // A run absent anywhere is absent.
  assert.deepEqual(JSON.parse((await f.cli(['describe', '--key', 'nope', '--json'])).out), { state: 'absent', request: 'nope' });
});

test('R2: invalid run specs fail before publication (fork, unknown agent, bad JSON, request field, bad id)', async t => {
  const f = await fixture(t);
  const cases: [unknown, RegExp][] = [
    [{ agent: 'echo', task: 't', context: 'fork' }, /context "fork"/],
    [{ tasks: [{ agent: 'echo', task: 't', context: 'fork' }] }, /context "fork"/],
    [{ agent: 'ghost', task: 't' }, /Unknown agent: ghost\. Available agents: .*\becho\b/],
    [{ agent: 'echo', task: 't', request: 'x' }, /--request, not a spec field/],
    [{ agent: 'echo', task: 't', bogus: 1 }, /Invalid call/],
    [[1], /JSON object/],
  ];
  for (const [value, error] of cases) await assert.rejects(f.cli(['run', '--request', 'x', '--spec', await f.spec('s.json', value)]), error);
  await assert.rejects(f.cli(['run', '--request', 'bad/id', '--spec', await f.spec('s.json', { agent: 'echo', task: 't' })]), /invalid request id/);
  await assert.rejects(f.cli(['run', '--request', 'x']), /usage: run/);
  await assert.rejects(f.cli(['run', '--request', 'x', '--spec', 'a', '--bogus']), /Unknown or repeated option --bogus/);
  assert.deepEqual(await f.inbox(), []);
});

test('R2: a decided run answers created once, then existing; cwd resolution; stop --request and send to a pending run', async t => {
  const f = await fixture(t), engine = await f.boot();
  await mkdir(join(f.cwd, 'sub/.pi/agents'), { recursive: true });
  await writeFile(join(f.cwd, 'sub/.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nEcho.');
  const path = await f.spec('t.json', { tasks: [{ agent: 'echo', task: 'a' }, { agent: 'echo', task: 'b' }], cwd: 'sub', name: 'two' });
  const stopIntake = f.pump(engine);
  const first = await f.cli(['run', '--request', 'two', '--spec', path, '--json'], { waitMs: 5000 });
  assert.equal(first.code, 0, first.out);
  const reply = JSON.parse(first.out);
  assert.equal(reply.created, true); assert.equal(reply.request, 'two');
  const admitted = (await findRequest(f.home, 'req:two'))!.request;
  assert.equal(admitted.from.startsWith('cli:'), true); assert.equal(reply.spec_digest, specDigest(admitted));
  assert.equal((admitted.body as { cwd: string }).cwd, join(f.cwd, 'sub'));
  const again = await f.cli(['run', '--request', 'two', '--spec', path], { waitMs: 5000 });
  assert.equal(again.out, `two → ${reply.wid} (existing)`); assert.equal(again.code, 0);
  const created = readJournalSnapshot(orchLedger(f.home)).filter(e => e.type === JT.created);
  assert.equal(created.length, 1);
  // A different spec after the decision: conflict naming the original's wid, digest and state.
  const other = await f.cli(['run', '--request', 'two', '--spec', await f.spec('o.json', { agent: 'echo', task: 'x' }), '--json'], { waitMs: 5000 });
  assert.equal(other.code, 3);
  assert.deepEqual(JSON.parse(other.out), { request: 'two', error: 'request-conflict', wid: reply.wid, spec_digest: reply.spec_digest, state: 'running' });
  // send --to <run-id> with two calls needs a key.
  await assert.rejects(f.cli(['send', '--request', 'f1', '--to', 'two', '--kind', 'steer', '--message', 'hi'], { waitMs: 5000 }), /name one with --call/);
  // A send to a run that has no workflow yet is pending (75), not an error.
  stopIntake();
  await f.cli(['run', '--request', 'later', '--spec', await f.spec('l.json', { agent: 'echo', task: 'l' })]);
  const early = await f.cli(['send', '--request', 'f2', '--to', 'later', '--kind', 'steer', '--message', 'hi', '--json']);
  assert.equal(early.code, 75); assert.match(early.out, /no workflow yet/);
  // stop --request: the id is decided once; a retry reports the same outcome without a second stop.
  f.pump(engine);
  const stop = await f.cli(['stop', '--request', 's1', 'two', '--json'], { waitMs: 5000 });
  assert.equal(stop.code, 0, stop.out); assert.equal(JSON.parse(stop.out).applied, true);
  const retry = await f.cli(['stop', '--request', 's1', 'two', '--json'], { waitMs: 5000 });
  assert.equal(retry.code, 0); assert.deepEqual(JSON.parse(retry.out), JSON.parse(stop.out));
  assert.equal(readJournalSnapshot(orchLedger(f.home)).filter(e => e.type === JT.admitted && e.kind === 'stop').length, 1);
  const third = await f.cli(['stop', '--request', 's1', 'later', '--json'], { waitMs: 5000 });
  assert.equal(third.code, 3);
  // stop without --request keeps its old behaviour.
  assert.match((await f.cli(['stop', reply.wid])).out, /^submitted stop /);
});

test('R3: lastFence names restart-force, orchestrator-crash or process-died from the journals (best effort)', () => {
  const e = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({ seq, ts: seq * 10, type, ...extra });
  const journal = [e(1, JT.exec, { exec: 'x1' }), e(5, JT.fenced, { exec: 'x1' })];
  assert.equal(lastFence([e(1, JT.exec, { exec: 'x1' })], []), undefined);
  // The orchestrator that launched x1 died without orchestrator-exit; the next start's recovery fenced it.
  const crashed = [e(0, 'orchestrator', { pid: 1 }), e(2, 'orchestrator', { pid: 2 })];
  assert.deepEqual(lastFence(journal, crashed), { at: 50, exec: 'x1', reason: 'orchestrator-crash' });
  const clean = [e(0, 'orchestrator', { pid: 1 }), e(1, 'orchestrator-exit', { pid: 1 }), e(2, 'orchestrator', { pid: 2 })];
  assert.equal(lastFence(journal, clean)?.reason, 'process-died');
  assert.equal(lastFence(journal, [e(0, 'orchestrator', { pid: 1 })])?.reason, 'process-died');
  assert.equal(lastFence(journal, [...crashed, e(3, 'restart', { force: true, live: ['x1'] })])?.reason, 'restart-force');
  assert.equal(lastFence(journal, [...clean, e(3, 'restart', { force: false, live: ['x1'] })])?.reason, 'process-died');
});

test('R1: the subagents tool shares request ids with the CLI: same content → same wid, other content → request-conflict', async t => {
  const f = await fixture(t), engine = await f.boot();
  f.pump(engine);
  const keys = ['HOME', 'DSA_HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'DSA_ORCHESTRATOR_ENTRY'] as const;
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let tool: { execute: (...args: unknown[]) => Promise<{ details: unknown }> } | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const context = { cwd: f.cwd, hasUI: false, isIdle: () => false, ui: { notify() {} },
    sessionManager: { getSessionId: () => 'tool-session', getSessionFile: () => undefined, getLeafId: () => undefined } };
  // The session's starter reads the environment when it runs: keep the no-op orchestrator entry for the whole test so
  // only the in-process engine writes this ledger.
  Object.assign(process.env, f.env);
  f.defer(() => { for (const k of keys) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; });
  const { registerMain } = await import('../../../src/agent/main.ts');
  registerMain({ on(name: string, fn: never) { handlers.set(name, fn); }, registerTool(value: never) { tool = value; }, sendMessage() {} } as never);
  await handlers.get('session_start')!({}, context);
  f.defer(() => handlers.get('session_shutdown')!({ reason: 'reload' }, context));
  const call = async (args: Record<string, unknown>) => (await tool!.execute('id', args, undefined, undefined, context)).details as Record<string, unknown>;
  const first = await call({ agent: 'echo', task: 'shared', request: 'shared' });
  assert.equal(typeof first.wid, 'string', JSON.stringify(first));
  // The CLI submits the same content (cwd + call): the same run. (A session's origin is not hashed: see the first test.)
  const cli = await f.cli(['run', '--request', 'shared', '--spec', await f.spec('shared.json', { agent: 'echo', task: 'shared' }), '--json'], { waitMs: 5000 });
  assert.equal(cli.code, 0, cli.out);
  assert.deepEqual(JSON.parse(cli.out), { request: 'shared', wid: first.wid, created: false, spec_digest: JSON.parse(cli.out).spec_digest });
  assert.deepEqual(await call({ agent: 'echo', task: 'shared', request: 'shared' }), { wid: first.wid }, 'a tool retry gets the same wid');
  const other = await call({ agent: 'echo', task: 'different', request: 'shared' });
  assert.equal(other.reason, 'request-conflict'); assert.equal(other.wid, first.wid); assert.equal(other.applied, false);
  await assert.rejects(call({ action: 'status', request: 'x' }), /request is a string id for run, send or stop/);
  assert.equal(readJournalSnapshot(orchLedger(f.home)).filter(e => e.type === JT.created).length, 1);
  // A stop with an id: decided once; the retry answers the same.
  const stop = await call({ action: 'stop', target: first.wid, request: 'tool-stop' });
  assert.equal(stop.applied, true, JSON.stringify(stop));
  assert.equal((await call({ action: 'stop', target: first.wid, request: 'tool-stop' })).applied, true);
  assert.equal(readJournalSnapshot(orchLedger(f.home)).filter(e => e.type === JT.admitted && e.rid === 'req:tool-stop').length, 1);
  assert.ok(!readJournalSnapshot(orchLedger(f.home)).some(e => e.type === 'orchestrator'), 'no orchestrator process was started');
});
