import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, HELP } from '../../../src/cli/main.ts';
import { describe } from '../../../src/cli/requests.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { orchInbox, orchLedger, journalPath } from '../../../src/paths.ts';
import { findRequest, specDigest } from '../../../src/requests.ts';
import { packageVersion } from '../../../src/version.ts';
import { snapshotFromEntries, workflowSnapshot, orchestratorTooOld, WAKE_SINCE } from '../../../src/orchestrator/snapshot.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-cli-wake-')), home = join(root, 'dsa'), cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true }); await mkdir(home);
  const env = { HOME: root, DSA_HOME: home, PI_CODING_AGENT_DIR: join(root, 'agent') };
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const lines: string[] = [];
    const code = await main(args, { cwd, env: { ...env, ...extra }, waitMs: 0, starter: async () => {}, write: line => lines.push(line), stdin: async () => '{"command":["true"]}' });
    return { code, out: lines.join('\n') };
  };
  const inbox = () => readdir(orchInbox(home)).catch(() => [] as string[]);
  return { root, home, cwd, cli, inbox };
}

test('run argv is literal and normalizes cwd, timeout, name, labels and wake caller containing @digits', async t => {
  const f = await fixture(t), args = ['run', '--request', 'build', '--wake', 'caller', '--cwd', 'sub', '--timeout-ms', '5000', '--name', 'my build', '--labels', '{"node":"A"}', '--json', '--', 'sh', '-c', 'echo "$literal"', '--spec', '--json'];
  const reply = await f.cli(args, { DSA_CALL: 'W@3/a@12@7' });
  assert.equal(reply.code, 75);
  const req = (await findRequest(f.home, 'req:build'))!.request;
  assert.deepEqual(req.body, { cwd: join(f.cwd, 'sub'), name: 'my build', labels: { node: 'A' }, call: { command: ['sh', '-c', 'echo "$literal"', '--spec', '--json'], timeoutMs: 5000 }, wake: { to: 'W/a@12' }, caller: 'W@3/a@12@7' });
  const retry = await f.cli(args, { DSA_CALL: 'W@3/a@12@8' });
  assert.equal(retry.code, 75); assert.equal((await findRequest(f.home, 'req:build'))!.request.body && specDigest(req), specDigest((await findRequest(f.home, 'req:build'))!.request));
  assert.deepEqual(await f.inbox(), ['req:build.json']);
  assert.deepEqual((await describe(f.home, { request: 'build' })).wake, { to: 'W/a@12', state: 'pending' });
});

for (const [args, reason] of [
  [['--wake', 'caller', '--', 'true'], '--wake caller needs DSA_CALL: run it from inside a subagent call'],
  [['--wake', 'other', '--', 'true'], '--wake takes exactly caller'],
  [['--spec', '-', '--', 'true'], '--spec and -- are mutually exclusive'],
  [['--spec', '-', '--timeout-ms', '5'], '--timeout-ms and --name require --'],
  [['--spec', '-', '--name', 'job'], '--timeout-ms and --name require --'],
  [['--timeout-ms', '-1', '--', 'true'], '--timeout-ms needs a positive integer'],
  [['--timeout-ms', '1.5', '--', 'true'], '--timeout-ms needs a positive integer'],
  [['--timeout-ms', '0', '--', 'true'], '--timeout-ms needs a positive integer'],
  [['--'], 'usage: run'],
] as [string[], string][]) test(`run usage refuses ${args.join(' ')} without submitting`, async t => {
  const f = await fixture(t), r = await f.cli(['run', '--request', 'bad', '--json', ...args]);
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.out).applied, false); assert.ok(JSON.parse(r.out).reason.startsWith(reason), r.out);
  assert.deepEqual(await f.inbox(), []); assert.equal(await findRequest(f.home, 'req:bad'), undefined);
});

test('run --spec still accepts wake caller; malformed caller is refused; help documents both forms and hold flags', async t => {
  const f = await fixture(t);
  assert.equal((await f.cli(['run', '--request', 'spec', '--spec', '-', '--wake', 'caller', '--json'], { DSA_CALL: 'W@1/k@1' })).code, 75);
  assert.deepEqual((await findRequest(f.home, 'req:spec'))!.request.body, { cwd: f.cwd, call: { command: ['true'] }, wake: { to: 'W/k' }, caller: 'W@1/k@1' });
  const invalid = await f.cli(['run', '--request', 'invalid', '--wake', 'caller', '--json', '--', 'true'], { DSA_CALL: 'bad' });
  assert.equal(invalid.code, 1); assert.match(invalid.out, /valid DSA_CALL/);
  assert.match(HELP, /--wake caller/); assert.match(HELP, /--timeout-ms <n>/);
  for (const flag of ['priority', 'yield', 'expect']) assert.ok(HELP.includes(`--${flag}`));
});

test('wake version gate refuses before recording, preserves retries, and allows the same loaded version or no live orchestrator (R-11-1)', async t => {
  const f = await fixture(t), args = (id: string) => ['run', '--request', id, '--wake', 'caller', '--json', '--', 'true'];
  const caller = { DSA_CALL: 'W@1/key@1' };
  assert.equal((await f.cli(args('recorded'), caller)).code, 75, 'no running orchestrator passes');
  const original = (await findRequest(f.home, 'req:recorded'))!.request;
  const orch = await openJournal(orchLedger(f.home)); t.after(() => orch.close());
  await orch.append('orchestrator', { pid: process.pid, version: '1.0.45' });
  const refusal = `the running orchestrator 1.0.45 predates run --wake (new in 1.1.0); restart it to the installed version 1.1.0 first (\`pi-durable-subagents restart\` or the subagents tool's restart action), then send again`;
  assert.equal(orchestratorTooOld(f.home, 'run --wake', WAKE_SINCE, '1.1.0'), refusal);
  assert.equal(orchestratorTooOld(f.home, 'run --wake', WAKE_SINCE, '1.0.45'), undefined, 'the unreleased leaf engine is the same loaded version');
  await orch.append('orchestrator', { pid: process.pid, version: '0.0.1' });
  const before = orch.entries().length;
  const refused = await f.cli(args('refused'), caller);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).reason, `the running orchestrator 0.0.1 predates run --wake (new in 1.1.0); restart it to the installed version ${packageVersion()} first (\`pi-durable-subagents restart\` or the subagents tool's restart action), then send again`);
  assert.equal(orch.entries().length, before); assert.equal(await findRequest(f.home, 'req:refused'), undefined);
  assert.deepEqual(await f.inbox(), ['req:recorded.json']);
  assert.deepEqual(await readdir(join(f.home, 'w')).catch(() => []), [], 'the refusal creates no workflow');
  assert.equal((await f.cli(args('recorded'), caller)).code, 75, 'a recorded pending request bypasses the gate');
  await orch.append('request', { request: original });
  await orch.append('created', { rid: original.rid, wid: 'W', origin: original.from });
  await orch.append('applied', { rid: original.rid });
  const retry = await f.cli(args('recorded'), { DSA_CALL: 'W@1/key@9' });
  assert.equal(retry.code, 0); assert.deepEqual(JSON.parse(retry.out), { request: 'recorded', wid: 'W', created: false, spec_digest: specDigest(original) });
  await orch.append('orchestrator', { pid: process.pid, version: packageVersion() });
  assert.equal((await f.cli(args('same-version'), caller)).code, 75);
  await orch.append('orchestrator', { pid: process.pid, version: '1.1.0' });
  assert.equal(orchestratorTooOld(f.home, 'run --wake', WAKE_SINCE, '1.1.0'), undefined);
  await orch.append('orchestrator-exit', { pid: process.pid });
  assert.equal(orchestratorTooOld(f.home, 'run --wake', WAKE_SINCE, '1.1.0'), undefined);
  assert.equal((await f.cli(args('no-live'), caller)).code, 75);
});

test('version and --version print the package version and exit 0 without starting anything', async t => {
  const f = await fixture(t);
  for (const command of ['version', '--version']) assert.deepEqual(await f.cli([command]), { code: 0, out: `pi-durable-subagents ${packageVersion()}` });
  assert.deepEqual(await f.inbox(), []);
});

test('describe projects ended entries of each latest generation, concatenated in journal order with a cap and more', async t => {
  const f = await fixture(t), wid = 'W', orch = await openJournal(orchLedger(f.home)), journal = await openJournal(journalPath(f.home, wid));
  t.after(async () => { await journal.close(); await orch.close(); });
  await orch.append('request', { request: { rid: 'req:parent', from: 'main:p', to: 'orch', kind: 'run', sseq: 1, body: { cwd: f.cwd, source: 'return 1;' } } });
  await orch.append('created', { rid: 'req:parent', wid, origin: 'main:p' });
  await journal.append('wf-created', { revision: 1, origin: 'main:p', cwd: f.cwd });
  await journal.append('call', { key: 'a@12', gen: 1, spec: { agent: 'test', task: 't' } });
  await journal.append('ended', { call: 'W@1/a@12@1', exec: 'x1', procs: [{ pid: 1, command: 'old generation' }] });
  await journal.append('generation', { key: 'a@12', gen: 2, revision: 1, spec: { agent: 'test', task: 't' } });
  await journal.append('call', { key: 'b', gen: 1, spec: { agent: 'test', task: 't' } });
  await journal.append('ended', { call: 'W@1/a@12@2', exec: 'x2', procs: Array.from({ length: 15 }, (_, i) => ({ pid: 10 + i, command: `sleep ${i}` })) });
  await journal.append('unknown-future-entry', { ignored: true });
  await journal.append('ended', { call: 'W@1/a@12@2', exec: 'x3', procs: Array.from({ length: 10 }, (_, i) => ({ pid: 100 + i, command: `bash ${i}` })), more: 7 });
  for (const key of [{ wid }, { request: 'parent' }]) {
    const d = await describe(f.home, key), a = d.calls!.find(c => c.key === 'a@12')!;
    assert.equal(a.gen, 2); assert.equal(a.endedAtSeal!.length, 20); assert.equal(a.endedAtSealMore, 12);
    assert.deepEqual(a.endedAtSeal![0], { pid: 10, command: 'sleep 0' }); assert.deepEqual(a.endedAtSeal!.at(-1), { pid: 104, command: 'bash 4' });
    assert.equal(d.calls!.find(c => c.key === 'b')!.endedAtSeal, undefined);
  }
  // The incremental reducer also sees a late ended record, without losing its earlier prefix.
  workflowSnapshot(f.home, wid);
  await journal.append('ended', { call: 'W@1/b@1', exec: 'xb', procs: [{ pid: 200, command: '' }] });
  assert.deepEqual((await describe(f.home, { wid })).calls!.find(c => c.key === 'b')!.endedAtSeal, [{ pid: 200, command: '' }]);
  // Reusing a sealed call in a later revision keeps the same generation and its ended-process evidence.
  await journal.append('revised', { revision: 2 });
  await journal.append('reused', { key: 'a@12', gen: 2, from: 'W@1/a@12@2', spec: { agent: 'test', task: 't' } });
  const reused = snapshotFromEntries(wid, journal.entries()).calls[0]!;
  assert.equal(reused.endedAtSeal!.length, 20); assert.equal(reused.endedAtSealMore, 12);
});
