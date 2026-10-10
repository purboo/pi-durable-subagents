// A run's `session` (which pi session shows it as its own): the CLI takes --session or the inherited $DSA_SESSION
// (never inside a subagent call), it is not part of the spec digest, admission rejects an invalid one, snapshots carry
// it, the session's status and UI list it as its own, and the orchestrator never passes $DSA_SESSION on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../../../src/cli/main.ts';
import { startOrchestrator } from '../../../src/cli/control.ts';
import { runSession } from '../../../src/cli/requests.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { Outbox } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, outboxRoot } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { allWorkflows, ownedBy, statusBrief } from '../../../src/orchestrator/snapshot.ts';
import { orderWorkflows } from '../../../src/ui/view.ts';
import { requestRid, sendIdentified, specDigest } from '../../../src/requests.ts';
import { JT, type EvalToOrch, type OrchToEval, type Request } from '../../../src/types.ts';
import type { EvaluatorTransport } from '../../../src/orchestrator/evaluator-client.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';

test('runSession: --session wins, else $DSA_SESSION outside a subagent call; a bad flag throws, a bad inherited value is ignored', () => {
  assert.equal(runSession(undefined, {}), undefined);
  assert.equal(runSession(undefined, { DSA_SESSION: '019a-b2c3' }), '019a-b2c3');
  assert.equal(runSession('flag-1', { DSA_SESSION: 'env-1' }), 'flag-1');
  assert.equal(runSession(undefined, { DSA_SESSION: 'env-1', DSA_CALL: 'c1' }), undefined, 'a subagent call never inherits a session');
  assert.equal(runSession(undefined, { DSA_SESSION: 'env-1', DSA_EXEC: 'x1' }), undefined);
  assert.equal(runSession(undefined, { DSA_SESSION: 'has space' }), undefined);
  assert.equal(runSession(undefined, { DSA_SESSION: '' }), undefined);
  assert.throws(() => runSession('has space', {}), /--session must be a pi session id/);
  assert.throws(() => runSession('x'.repeat(129), {}), /--session must be a pi session id/);
});

test('run names the session in the body without changing the digest: a retry from another session gets the same request', async t => {
  const f = await fixture(t), path = await f.spec('a.json', { agent: 'echo', task: 'hello' });
  const first = await f.cli(['run', '--request', 'S', '--spec', path, '--json'], { DSA_SESSION: 'sess-A' });
  assert.equal(first.code, 75, first.out);
  const published = JSON.parse(await readFile(join(orchInbox(f.home), 'req:S.json'), 'utf8')) as Request;
  assert.deepEqual(published.body, { cwd: f.cwd, call: { agent: 'echo', task: 'hello' }, session: 'sess-A' });
  assert.equal(specDigest(published), specDigest({ kind: 'run', body: { cwd: f.cwd, call: { agent: 'echo', task: 'hello' } } }), 'not hashed');
  const other = await f.cli(['run', '--request', 'S', '--spec', path, '--json'], { DSA_SESSION: 'sess-B' });
  assert.equal(other.code, 75, `same request, no conflict: ${other.out}`);
  const none = await f.cli(['run', '--request', 'S', '--spec', path, '--json']);
  assert.equal(none.code, 75, none.out);
  const flagged = await f.cli(['run', '--request', 'F', '--spec', path, '--session', 'sess-C', '--json'], { DSA_SESSION: 'sess-A' });
  assert.equal(flagged.code, 75, flagged.out);
  assert.equal((JSON.parse(await readFile(join(orchInbox(f.home), 'req:F.json'), 'utf8')) as Request<{ session?: string }>).body.session, 'sess-C');
  const bad = await f.cli(['run', '--request', 'B', '--spec', path, '--session', 'no spaces', '--json']);
  assert.equal(bad.code, 1); assert.match(JSON.parse(bad.out).reason, /--session must be a pi session id/);
  const inCall = await f.cli(['run', '--request', 'C', '--spec', path, '--json'], { DSA_SESSION: 'sess-A', DSA_CALL: 'call-1' });
  assert.equal(inCall.code, 75, inCall.out);
  assert.equal((JSON.parse(await readFile(join(orchInbox(f.home), 'req:C.json'), 'utf8')) as Request<{ session?: string }>).body.session, undefined);
  assert.deepEqual((await f.inbox()).sort(), ['req:C.json', 'req:F.json', 'req:S.json'], 'the bad flag published nothing');
});

test('An admitted run with a session is that session\'s own in status and the UI list; other sessions see it as elsewhere', async t => {
  const f = await fixture(t);
  await f.boot();
  const path = await f.spec('a.json', { agent: 'echo', task: 'hello' });
  const run = await f.cli(['run', '--request', 'R', '--spec', path, '--json'], { DSA_SESSION: 'owner-1' }, 5000);
  assert.equal(run.code, 0, run.out);
  const wid = JSON.parse(run.out).wid as string;
  const wf = allWorkflows(f.home).find(w => w.wid === wid)!;
  assert.equal(wf.session, 'owner-1'); assert.match(String(wf.origin), /^cli:/, 'the sender stays the origin');
  assert.ok(ownedBy(wf, 'main:owner-1')); assert.ok(!ownedBy(wf, 'main:other'));
  assert.deepEqual(orderWorkflows(allWorkflows(f.home), 'main:owner-1').map(w => w.wid), [wid]);
  assert.deepEqual(orderWorkflows(allWorkflows(f.home), 'main:other'), []);
  const mine = statusBrief(f.home, { origin: 'main:owner-1' });
  assert.deepEqual(mine.active.map(w => w.wid), [wid]); assert.equal(mine.otherSessions, undefined);
  const theirs = statusBrief(f.home, { origin: 'main:other' });
  assert.deepEqual(theirs.active, []); assert.equal(theirs.otherSessions?.length, 1);
  // A run without a session is no pi session's own.
  const plain = await f.cli(['run', '--request', 'P', '--spec', path, '--json'], {}, 5000);
  const pwid = JSON.parse(plain.out).wid as string;
  assert.equal(allWorkflows(f.home).find(w => w.wid === pwid)!.session, undefined);
  assert.deepEqual(orderWorkflows(allWorkflows(f.home), 'main:owner-1').map(w => w.wid), [wid]);
});

test('The orchestrator rejects a hand-written run request with an invalid session', async t => {
  const f = await fixture(t);
  await f.boot();
  const outbox = await Outbox.open(outboxRoot(f.home), 'main:hand', () => orchInbox(f.home));
  t.after(() => outbox.close());
  const body = { cwd: f.cwd, call: { agent: 'echo', task: 'hello' } };
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('h1'), 'run', { ...body, session: 'no spaces' });
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('h2'), 'run', { ...body, session: 7 });
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('h3'), 'run', { ...body, session: 'ok-1' });
  const reasons = await until(() => { const r = ['req:h1', 'req:h2'].map(rid => readJournalSnapshot(orchLedger(f.home)).find(e => e.type === JT.rejected && e.rid === rid)?.reason); return r.every(Boolean) && r; });
  for (const reason of reasons) assert.match(String(reason), /^invalid-session/);
  await until(() => readJournalSnapshot(orchLedger(f.home)).some(e => e.type === JT.created && e.rid === 'req:h3'));
});

test('startOrchestrator never passes the starting session\'s $DSA_SESSION to the orchestrator', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-session-start-')), home = join(root, 'dsa'), out = join(root, 'env.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'entry.mjs');
  await writeFile(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ session: process.env.DSA_SESSION ?? null, home: process.env.DSA_HOME }));`);
  await mkdir(home, { recursive: true });
  await startOrchestrator(home, { PATH: process.env.PATH, DSA_SESSION: 'sess-X', DSA_ORCHESTRATOR_ENTRY: entry });
  const seen = await until(async () => { try { return JSON.parse(await readFile(out, 'utf8')); } catch { return undefined; } });
  assert.deepEqual(seen, { session: null, home });
});

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-session-')), home = join(root, 'dsa'), cwd = join(root, 'work');
  await mkdir(join(cwd, '.pi/agents'), { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(cwd, '.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nEcho.');
  const noop = join(root, 'noop.mjs'); await writeFile(noop, '');
  const env = { DSA_HOME: home, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', DSA_ORCHESTRATOR_ENTRY: noop };
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); await rm(root, { recursive: true, force: true }); });
  const cli = async (args: string[], extra: Record<string, string> = {}, waitMs = 0) => {
    const lines: string[] = [];
    const code = await main(args, { env: { ...env, ...extra }, cwd, write: line => lines.push(line), starter: async () => {}, waitMs });
    return { code, out: lines.join('\n') };
  };
  const spec = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  const inbox = async () => (await readdir(orchInbox(home)).catch(() => [] as string[])).filter(n => n.endsWith('.json'));
  const boot = async () => {
    const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: { k: { idleExitMs: 30 } } };
    const engine = new Engine(ledgers, fakeExecutor(ledgers, {}), { evaluator: new ManualEvaluator(), discovery: { home: root, agentDir: join(root, 'agent'), globalNpmRoot: null } });
    await engine.recover();
    const timer = setInterval(() => void engine.intake(), 20);
    cleanups.push(async () => { await engine.close().catch(() => {}); await orch.close(); }, () => clearInterval(timer));
    return { engine };
  };
  return { root, home, cwd, cli, spec, inbox, boot };
}
const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await delay(20); }
};
