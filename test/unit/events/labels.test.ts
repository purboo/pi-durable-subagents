// R6: label validation (one function for the CLI, the tool and admission), `run --labels` exit codes, labels in the spec
// digest (request-conflict on other labels), admission rejection of a hand-written request, and describe's labels
// (running and after prune).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../../../src/cli/main.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { Outbox } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, outboxRoot } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { requestRid, sendIdentified, specDigest } from '../../../src/requests.ts';
import { request } from '../../../src/agent/main/tool.ts';
import { checkLabels, labelsProblem, parseLabels } from '../../../src/events/labels.ts';
import { JT, type EvalToOrch, type OrchToEval, type Request } from '../../../src/types.ts';
import type { EvaluatorTransport } from '../../../src/orchestrator/evaluator-client.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';

test('R6: labels are a flat object of at most 32 keys [A-Za-z0-9_.:-]{1,64} with string values ≤ 256 units, ≤ 4096 bytes of JSON', () => {
  assert.equal(labelsProblem({ owed_node: 'n1', 'attempt.no': '2', 'a:b-c': '' }), undefined);
  assert.equal(labelsProblem({}), undefined);
  for (const bad of [null, [], 'x', 3, ['a']]) assert.match(String(labelsProblem(bad)), /JSON object/);
  assert.match(String(labelsProblem(new Map())), /plain JSON object/);
  const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
  assert.equal(labelsProblem(keys(32)), undefined);
  assert.match(String(labelsProblem(keys(33))), /33 keys; at most 32/);
  assert.equal(labelsProblem({ ['k'.repeat(64)]: 'v' }), undefined);
  assert.match(String(labelsProblem({ ['k'.repeat(65)]: 'v' })), /label key "k{65}" must be 1-64/);
  assert.match(String(labelsProblem({ 'a b': 'v' })), /label key "a b"/);
  assert.match(String(labelsProblem({ '': 'v' })), /label key ""/);
  assert.match(String(labelsProblem({ ok: 'v', n: 1 })), /label "n" must have a string value/);
  assert.match(String(labelsProblem({ nested: { a: 'b' } })), /label "nested" must have a string value/);
  assert.equal(labelsProblem({ v: 'é'.repeat(256) }), undefined, '256 UTF-16 units');
  assert.match(String(labelsProblem({ v: 'x'.repeat(257) })), /label "v" is 257 characters long; at most 256/);
  // 20 keys of 250 characters: within the per-key limits, above 4096 bytes of JSON.
  assert.match(String(labelsProblem(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(250)])))), /bytes of JSON; at most 4096/);
  // Bytes, not characters: 16 values of 128 three-byte characters are 6 KiB.
  assert.match(String(labelsProblem(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, '€'.repeat(128)])))), /bytes of JSON/);
  assert.throws(() => checkLabels({ 'bad key': 'x' }), /label key "bad key"/);
  assert.throws(() => parseLabels('{oops'), /--labels is not JSON/);
  assert.deepEqual(parseLabels('{"a":"b"}'), { a: 'b' });
});

test('R6: the tool normalizer passes valid labels into the run body and refuses invalid ones; {} is no labels', () => {
  const run = request({ agent: 'echo', task: 't', labels: { owed_node: 'n1' } }, '/w');
  assert.deepEqual(run.body, { cwd: '/w', call: { agent: 'echo', task: 't' }, labels: { owed_node: 'n1' } });
  const tasks = request({ tasks: [{ agent: 'echo', task: 't' }], labels: { role: 'impl' } }, '/w');
  assert.deepEqual((tasks.body as { labels?: unknown }).labels, { role: 'impl' });
  assert.deepEqual(request({ agent: 'echo', task: 't', labels: {} }, '/w').body, { cwd: '/w', call: { agent: 'echo', task: 't' } });
  assert.throws(() => request({ agent: 'echo', task: 't', labels: { 'a/b': 'x' } }, '/w'), /label key "a\/b"/);
  assert.throws(() => request({ agent: 'echo', task: 't', labels: ['x'] }, '/w'), /JSON object/);
});

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-labels-')), home = join(root, 'dsa'), cwd = join(root, 'work');
  await mkdir(join(cwd, '.pi/agents'), { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(cwd, '.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nEcho.');
  const noop = join(root, 'noop.mjs'); await writeFile(noop, '');
  const env = { DSA_HOME: home, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', DSA_ORCHESTRATOR_ENTRY: noop };
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); await rm(root, { recursive: true, force: true }); });
  const cli = async (args: string[], options: { waitMs?: number } = {}) => {
    const lines: string[] = [];
    const code = await main(args, { env, cwd, write: line => lines.push(line), starter: async () => {}, waitMs: options.waitMs ?? 0 });
    return { code, out: lines.join('\n') };
  };
  const spec = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  const inbox = async () => (await readdir(orchInbox(home)).catch(() => [] as string[])).filter(n => n.endsWith('.json'));
  const boot = async (hold?: string) => {
    const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: { k: { idleExitMs: 30 } } };
    const evaluator = new ManualEvaluator();
    const engine = new Engine(ledgers, fakeExecutor(ledgers, { ...(hold ? { hold } : {}) }), { evaluator, discovery: { home: root, agentDir: join(root, 'agent'), globalNpmRoot: null } });
    await engine.recover();
    const timer = setInterval(() => void engine.intake(), 20);
    cleanups.push(async () => { await engine.close().catch(() => {}); await orch.close(); }, () => clearInterval(timer));
    /** End a workflow's script (the manual evaluator runs none). */
    const finish = (wid: string) => {
      const ev = (evaluator.messages.findLast(m => m.t === 'start' && m.wid === wid) as { ev: number }).ev;
      evaluator.receive({ t: 'done', wid, ev, result: 1 });
    };
    return { engine, finish };
  };
  return { root, home, cwd, cli, spec, inbox, boot };
}
const until = async <T>(get: () => T | undefined | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = get(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await delay(20); }
};

test('R6: run --labels — invalid JSON, invalid labels and labels in the spec exit 1 and submit nothing; valid ones are hashed into spec_digest', async t => {
  const f = await fixture(t), path = await f.spec('a.json', { agent: 'echo', task: 'hello' });
  const notJson = await f.cli(['run', '--request', 'L', '--spec', path, '--labels', '{node', '--json']);
  assert.equal(notJson.code, 1); assert.equal(JSON.parse(notJson.out).applied, false); assert.match(JSON.parse(notJson.out).reason, /--labels is not JSON/);
  const badKey = await f.cli(['run', '--request', 'L', '--spec', path, '--labels', '{"bad key":"x"}', '--json']);
  assert.equal(badKey.code, 1); assert.match(JSON.parse(badKey.out).reason, /label key "bad key"/);
  const badValue = await f.cli(['run', '--request', 'L', '--spec', path, '--labels', JSON.stringify({ v: 'x'.repeat(257) }), '--json']);
  assert.equal(badValue.code, 1); assert.match(JSON.parse(badValue.out).reason, /label "v" is 257 characters/);
  const inSpec = await f.cli(['run', '--request', 'L', '--spec', await f.spec('s.json', { agent: 'echo', task: 'hello', labels: { a: 'b' } }), '--json']);
  assert.equal(inSpec.code, 1); assert.match(JSON.parse(inSpec.out).reason, /--labels <json>, not in the spec/);
  await assert.rejects(f.cli(['run', '--request', 'L', '--spec', path, '--labels', '[]']), /JSON object/, 'text mode: the CLI prints the error, exit 1');
  assert.deepEqual(await f.inbox(), [], 'nothing was published');
  assert.equal(JSON.parse((await f.cli(['describe', '--key', 'L', '--json'])).out).state, 'absent');
  // Valid labels: published in the body, part of the digest; the same labels retry, other labels conflict (3).
  const labels = { owed_node: 'n1', owed_attempt: '2' };
  const first = await f.cli(['run', '--request', 'L', '--spec', path, '--labels', JSON.stringify(labels), '--json']);
  assert.equal(first.code, 75, first.out);
  const published = JSON.parse(await readFile(join(orchInbox(f.home), 'req:L.json'), 'utf8')) as Request;
  assert.deepEqual(published.body, { cwd: f.cwd, call: { agent: 'echo', task: 'hello' }, labels });
  const unlabeled = specDigest({ kind: 'run', body: { cwd: f.cwd, call: { agent: 'echo', task: 'hello' } } });
  assert.notEqual(specDigest(published), unlabeled);
  const pending = JSON.parse((await f.cli(['describe', '--key', 'L', '--json'])).out);
  assert.deepEqual(pending, { state: 'pending', request: 'L', kind: 'run', spec_digest: specDigest(published), labels });
  // Key order does not matter (the digest hashes canonical JSON).
  const same = await f.cli(['run', '--request', 'L', '--spec', path, '--labels', JSON.stringify({ owed_attempt: '2', owed_node: 'n1' }), '--json']);
  assert.equal(same.code, 75, same.out);
  for (const other of [{ owed_node: 'n1', owed_attempt: '3' }, undefined]) {
    const conflict = await f.cli(['run', '--request', 'L', '--spec', path, ...(other ? ['--labels', JSON.stringify(other)] : []), '--json']);
    assert.equal(conflict.code, 3, conflict.out);
    assert.deepEqual(JSON.parse(conflict.out), { request: 'L', error: 'request-conflict', spec_digest: specDigest(published), state: 'pending' });
  }
  // An unlabeled id conflicts with labels added later.
  assert.equal((await f.cli(['run', '--request', 'U', '--spec', path, '--json'])).code, 75);
  assert.equal((await f.cli(['run', '--request', 'U', '--spec', path, '--labels', '{"a":"b"}', '--json'])).code, 3);
  assert.deepEqual((await f.inbox()).sort(), ['req:L.json', 'req:U.json']);
});

test('R6: decided runs — same labels get the first outcome, other labels conflict; describe echoes labels, also after prune', async t => {
  const f = await fixture(t), { finish } = await f.boot();
  const path = await f.spec('a.json', { agent: 'echo', task: 'hello' }), labels = { role: 'impl' };
  const first = await f.cli(['run', '--request', 'D', '--spec', path, '--labels', JSON.stringify(labels), '--json'], { waitMs: 5000 });
  assert.equal(first.code, 0, first.out);
  const reply = JSON.parse(first.out);
  const again = await f.cli(['run', '--request', 'D', '--spec', path, '--labels', JSON.stringify(labels), '--json'], { waitMs: 5000 });
  assert.deepEqual(JSON.parse(again.out), { ...reply, created: false });
  const other = await f.cli(['run', '--request', 'D', '--spec', path, '--labels', '{"role":"review"}', '--json'], { waitMs: 5000 });
  assert.equal(other.code, 3); assert.equal(JSON.parse(other.out).wid, reply.wid);
  assert.deepEqual(JSON.parse((await f.cli(['describe', '--key', 'D', '--json'])).out).labels, labels, 'running');
  finish(reply.wid);
  const done = await until(() => { const d = readJournalSnapshot(join(f.home, 'w', reply.wid, 'journal.jsonl')).find(e => e.type === JT.done); return d; });
  assert.equal(done.status, 'done');
  const byKey = JSON.parse((await f.cli(['describe', '--key', 'D', '--json'])).out), byWid = JSON.parse((await f.cli(['describe', reply.wid, '--json'])).out);
  assert.deepEqual(byKey.labels, labels); assert.deepEqual(byWid.labels, labels);
  assert.match((await f.cli(['describe', '--key', 'D'])).out, /\n {2}labels: role=impl\n/);
  const prune = await f.cli(['prune', reply.wid], { waitMs: 5000 });
  assert.equal(prune.code, 0, prune.out);
  await until(() => readJournalSnapshot(orchLedger(f.home)).some(e => e.type === 'pruned' && e.wid === reply.wid));
  const pruned = JSON.parse((await f.cli(['describe', '--key', 'D', '--json'])).out);
  assert.equal(pruned.state, 'pruned'); assert.deepEqual(pruned.labels, labels, 'from the admitted request the ledger keeps');
  assert.deepEqual(JSON.parse((await f.cli(['describe', reply.wid, '--json'])).out).labels, labels);
  // A run without labels has none in describe.
  const plain = await f.cli(['run', '--request', 'P', '--spec', path, '--json'], { waitMs: 5000 });
  assert.equal(plain.code, 0, plain.out);
  assert.equal(JSON.parse((await f.cli(['describe', '--key', 'P', '--json'])).out).labels, undefined);
});

test('R6: the orchestrator rejects a hand-written run request with invalid labels at admission, with the reason', async t => {
  const f = await fixture(t);
  await f.boot();
  const outbox = await Outbox.open(outboxRoot(f.home), 'main:hand', () => orchInbox(f.home));
  t.after(() => outbox.close());
  const body = { cwd: f.cwd, call: { agent: 'echo', task: 'hello' }, labels: { 'no spaces allowed': 'x' } };
  const sent = await sendIdentified(f.home, outbox, 'main:hand', requestRid('hand'), 'run', body);
  assert.ok('sent' in sent);
  const rejected = await until(() => readJournalSnapshot(orchLedger(f.home)).find(e => e.type === JT.rejected && e.rid === 'req:hand'));
  assert.match(String(rejected.reason), /^invalid-labels: label key "no spaces allowed"/);
  assert.ok(!readJournalSnapshot(orchLedger(f.home)).some(e => e.type === JT.created && e.rid === 'req:hand'), 'no workflow');
  const d = JSON.parse((await f.cli(['describe', '--key', 'hand', '--json'])).out);
  assert.equal(d.state, 'rejected'); assert.match(d.reason, /invalid-labels/);
  // Too many keys, and a non-string value, are rejected the same way.
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']));
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('hand2'), 'run', { ...body, labels: many });
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('hand3'), 'run', { ...body, labels: { n: 1 } });
  const reasons = await until(() => { const r = ['req:hand2', 'req:hand3'].map(rid => readJournalSnapshot(orchLedger(f.home)).find(e => e.type === JT.rejected && e.rid === rid)?.reason); return r.every(Boolean) && r; });
  assert.match(String(reasons[0]), /invalid-labels: labels have 33 keys/); assert.match(String(reasons[1]), /invalid-labels: label "n" must have a string value/);
  // Valid labels are admitted.
  await sendIdentified(f.home, outbox, 'main:hand', requestRid('hand4'), 'run', { ...body, labels: { ok: 'yes' } });
  await until(() => readJournalSnapshot(orchLedger(f.home)).some(e => e.type === JT.created && e.rid === 'req:hand4'));
});
