import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, main, tail } from '../../../src/cli/main.ts';
import { submit } from '../../../src/cli/control.ts';
import { serviceFiles, manageService } from '../../../src/cli/service.ts';
import { OsLock } from '../../../src/platform/lock.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { scanInbox, publishRequest } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLock, orchLedger } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';
import { JT } from '../../../src/types.ts';
import { setTimeout as delay } from 'node:timers/promises';

async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-cli-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
async function until(fn: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000;
  while (!await fn()) { if (performance.now() > end) throw new Error('Timed out'); await delay(20); }
}
test('argument parsing rejects invalid commands, targets and flags', () => {
  assert.deepEqual(parseArgs(['status', '--json', 'w']), { command: 'status', target: 'w', json: true });
  assert.deepEqual(parseArgs(['stop', 'w@1/c@1']), { command: 'stop', target: 'w@1/c@1', json: false });
  assert.equal(parseArgs(['install-service', '--dry-run']).dryRun, true);
  for (const args of [['bad'], ['stop'], ['drain', 'w'], ['status', '../escape'], ['status', '--bad'], ['resume', '--json'], ['status', '--json', '--json'], ['drain', '--dry-run']]) assert.throws(() => parseArgs(args));
});

test('status and tail follow real engine journals with fake executor', { timeout: 15000 }, async t => {
  const home = await root(t), orch = await openJournal(orchLedger(home));
  await mkdir(join(home, 'agent/agents'), { recursive: true });
  await writeFile(join(home, 'agent/agents/test.md'), '---\nname: test\ndescription: test\n---\nTest');
  const ledgers = { home, orch, config: {} }, engine = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await orch.close(); });
  await engine.recover();
  await publishRequest(orchInbox(home), { rid: 'run', from: 'test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: home, source: "return await runs.run('a',{agent:'test',task:'hello'});" } });
  await engine.intake();
  const wid = String(orch.entries().find(e => e.type === JT.created)!.wid);
  const output: string[] = [], controller = new AbortController();
  const follow = tail(home, wid, text => output.push(text), controller.signal, 10);
  try { await until(() => output.some(s => s.includes(': done'))); } finally { controller.abort(); await follow; }
  assert.match(output.join('\n'), /a@1 ok/);
  let json = '';
  assert.equal(await main(['status', wid, '--json'], { env: { DSA_HOME: home }, write: s => { json = s; } }), 0);
  assert.equal(JSON.parse(json).status, 'done');
  assert.equal(JSON.parse(json).calls[0].result.ok, true);
  await assert.rejects(main(['status', 'missing'], { env: { DSA_HOME: home } }), /Unknown workflow/);
});

test('CLI outbox recovers pending, retires receipts and serializes concurrent senders', { timeout: 15000 }, async t => {
  const home = await root(t), held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held);
  t.after(() => held.release());
  const first = (await submit(home, 'drain'))[0]!;
  await unlink(join(orchInbox(home), `${first.rid}.json`));
  const results = await Promise.all([submit(home, 'stop', 'w@1/a@1'), submit(home, 'resume', 'w')]);
  let inbox = await scanInbox(orchInbox(home));
  assert.equal(inbox.length, 3);
  assert.deepEqual(inbox.map(r => r.sseq).sort(), [1, 2, 3]);
  assert.match(first.from, /^cli:.+@.+$/);
  assert.deepEqual(results[0]![0]!.body, { target: 'w@1/a@1' });
  assert.deepEqual(results[1]![0]!.body, { wid: 'w' });
  const ledger = await openJournal(orchLedger(home));
  await ledger.append('applied', { rid: first.rid }); await ledger.close();
  await unlink(join(orchInbox(home), `${first.rid}.json`));
  await submit(home, 'resume');
  inbox = await scanInbox(orchInbox(home));
  assert.ok(!inbox.some(r => r.rid === first.rid));
  assert.equal(Math.max(...inbox.map(r => r.sseq)), 4);
  assert.ok(readJournalSnapshot(join(home, 'outbox', `${first.from}.jsonl`)).some(e => e.type === 'resolved' && e.rid === first.rid));
});

test('stop-all sends one drain with fence without altering journals', async t => {
  const home = await root(t), held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held); t.after(() => held.release());
  for (const [wid, status] of [['running', ''], ['parked', 'parked'], ['done', 'done']]) {
    const journal = await openJournal(join(home, 'w', wid!, 'journal.jsonl'));
    await journal.append('wf-created', { revision: 1 }); if (status) await journal.append(JT.done, { status }); await journal.close();
  }
  const before = await readFile(join(home, 'w/running/journal.jsonl'));
  const sent = await submit(home, 'stop-all');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, 'drain');
  assert.deepEqual(sent[0]!.body, { fence: true });
  assert.deepEqual(await scanInbox(orchInbox(home)), sent);
  assert.deepEqual(await readFile(join(home, 'w/running/journal.jsonl')), before);
});

test('starter runs injected detached entry only when orchestrator lock is free', { timeout: 10000 }, async t => {
  const home = await root(t), entry = join(home, 'starter.cjs'), marker = join(home, 'started');
  await writeFile(entry, `require('fs').appendFileSync(${JSON.stringify(marker)},process.env.DSA_HOME+'\\n')`);
  const env = { ...process.env, HOME: home, DSA_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), DSA_ORCHESTRATOR_ENTRY: entry };
  const held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held);
  try { await submit(home, 'drain', undefined, env); await assert.rejects(readFile(marker), { code: 'ENOENT' }); } finally { await held.release(); }
  await submit(home, 'resume', undefined, env);
  await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === `${home}\n`);
});

test('service files and activation use temporary HOME and fake runners on both platforms', async t => {
  const home = await root(t);
  for (const platform of ['linux', 'darwin']) {
    const files = serviceFiles(home, join(home, 'dsa & state'), '/node dir/cli.ts', platform, '/node dir/node');
    const commands: string[] = [], runner = async (cmd: string, args: string[]) => { commands.push([cmd, ...args].join(' ')); };
    await manageService(files, true, { platform, uid: 123, runner, write() {} });
    for (const f of files) assert.equal(await readFile(f.path, 'utf8'), f.content);
    if (platform === 'linux') {
      assert.match(files[0]!.content, /ExecStart="\/node dir\/node" "\/node dir\/cli.ts" resume/);
      assert.match(files[0]!.content, /\[Service\][\s\S]*KillMode=process\n/);
      assert.match(files[1]!.content, /OnUnitActiveSec=30s/);
      assert.deepEqual(commands, ['systemctl --user daemon-reload', 'systemctl --user enable --now pi-durable-subagents.timer']);
    } else { assert.match(files[0]!.content, /<key>AbandonProcessGroup<\/key><true\/>/); assert.match(files[0]!.content, /&amp;/); assert.match(files[0]!.content, /<integer>30<\/integer>/); assert.match(commands[0]!, /^launchctl bootstrap gui\/123 /); }
    await manageService(files, true, { platform, runner, write() {} });
    await manageService(files, false, { platform, uid: 123, runner, write() {} });
    for (const f of files) await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  }
  const files = serviceFiles(home, home, '/cli', 'linux');
  await assert.rejects(manageService(files, true, { platform: 'linux', runner: async () => { throw new Error('activation failed'); }, write() {} }), /activation failed/);
  assert.equal(await readFile(files[0]!.path, 'utf8'), files[0]!.content);
  await manageService(files, true, { platform: 'linux', dryRun: true, runner: async () => { throw new Error('must not run'); }, write() {} });
  await assert.rejects(manageService(files, false, { platform: 'linux', runner: async () => { throw new Error('deactivation failed'); }, write() {} }), /deactivation failed/);
  assert.equal(await readFile(files[0]!.path, 'utf8'), files[0]!.content);
  await assert.rejects(manageService(serviceFiles(home, home, '/changed', 'linux'), true, { platform: 'linux', runner: async () => { throw new Error('must not run'); }, write() {} }), /Service file differs/);
  const mac = serviceFiles(home, home, '/cli', 'darwin');
  await manageService(mac, true, { platform: 'darwin', runner: async () => { throw new Error('already bootstrapped'); }, write() {} });
  await manageService(mac, false, { platform: 'darwin', runner: async () => { throw new Error('not loaded'); }, write() {} });
  const quoted = serviceFiles(home, '/state/$x%q', '/cli/$x%q', 'linux')[0]!.content;
  assert.match(quoted, /DSA_HOME=\/state\/\$x%%q/);
  assert.match(quoted, /\/cli\/\$\$x%%q/);
});
