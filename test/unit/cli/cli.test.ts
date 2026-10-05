import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, main, tail, serviceEntryError } from '../../../src/cli/main.ts';
import { pendingWork, submit } from '../../../src/cli/control.ts';
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
  assert.deepEqual(parseArgs(['events', 'w', '--json']), { command: 'events', target: 'w', json: true });
  for (const args of [['events'], ['events', 'a', 'b'], ['events', '..']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['tail', '--json']), { command: 'tail', json: true });
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
  // T10: the list view is the compact projection; events are a timeline without observation noise.
  const out: string[] = [], env = { DSA_HOME: home }, write = (s: string) => { out.push(s); };
  assert.equal(await main(['status'], { env, write }), 0);
  assert.match(out.join('\n'), new RegExp(`^${wid}@1: done · 1/1 done\n  a@1 ok "hello"\n  finished: ".* done: 1 ok"$`));
  out.length = 0; assert.equal(await main(['status', '--json'], { env, write }), 0);
  const view = JSON.parse(out[0]!);
  assert.deepEqual(view.workflows[0].calls, [{ key: 'a', gen: 1, callId: `${wid}@1/a@1`, phase: 'sealed', status: 'ok', ok: true, lastLine: 'hello' }]);
  assert.ok(!('entries' in view.workflows[0]) && !('result' in view.workflows[0].calls[0]));
  out.length = 0; assert.equal(await main(['events', wid, '--json'], { env, write }), 0);
  const events = out.map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['created', 'script-start', 'call', 'sealed', 'done', 'attention']);
  assert.deepEqual([events[3].call, events[3].status, events[4].status], [`${wid}@1/a@1`, 'ok', 'done']);
  out.length = 0; assert.equal(await main(['events', wid], { env, write }), 0);
  assert.match(out[2]!, new RegExp(`^\\S+Z #\\d+ call\\s+key=a gen=1 agent=test$`));
  await assert.rejects(main(['events', 'missing'], { env, write }), /Unknown workflow/);
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
      assert.match(files[0]!.content, /ExecStart="\/node dir\/node" "\/node dir\/cli.ts" start\n/);
      assert.doesNotMatch(files[0]!.content, /resume/);
      assert.match(files[0]!.content, /\[Service\][\s\S]*KillMode=process\n/);
      assert.match(files[1]!.content, /OnUnitActiveSec=30s/);
      assert.deepEqual(commands, ['systemctl --user daemon-reload', 'systemctl --user enable --now pi-durable-subagents.timer']);
    } else { assert.match(files[0]!.content, /<string>\/node dir\/cli.ts<\/string><string>start<\/string><\/array>/); assert.doesNotMatch(files[0]!.content, /resume/); assert.match(files[0]!.content, /<key>AbandonProcessGroup<\/key><true\/>/); assert.match(files[0]!.content, /&amp;/); assert.match(files[0]!.content, /<integer>30<\/integer>/); assert.match(commands[0]!, /^launchctl bootstrap gui\/123 /); }
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

test('P1 start publishes nothing and invokes the starter only while work is pending', { timeout: 15000 }, async t => {
  const home = await root(t), env = { HOME: home, DSA_HOME: home };
  const started: string[] = [], starter = async (h: string) => { started.push(h); };
  const run = async () => { const out: string[] = []; assert.equal(await main(['start'], { env, starter, write: s => out.push(s) }), 0); return out.join('\n'); };
  const quiet = async () => { const before = started.length; assert.equal(await run(), '', 'idle start is silent'); assert.equal(started.length, before); };
  await quiet();
  // A drained / finished workflow is not pending; `start` must not undo the drain the way `resume` would.
  const done = await openJournal(join(home, 'w', 'finished', 'journal.jsonl'));
  await done.append('wf-created', { revision: 1 }); await done.append(JT.done, { status: 'parked' }); await done.close();
  await quiet();
  // A sender's request to the orchestrator that the ledger already resolved is not pending either.
  const outbox = await openJournal(join(home, 'outbox', 'main_x.jsonl'));
  await outbox.append('sent', { request: { rid: 'old', from: 'main:x', to: 'orch', sseq: 1, kind: 'resume', body: {} } });
  await outbox.append('sent', { request: { rid: 'child', from: 'main:x', to: 'w@1/a@1', sseq: 1, kind: 'task', body: {} } });
  const ledger = await openJournal(orchLedger(home)); await ledger.append('applied', { rid: 'old' }); await ledger.close();
  await quiet();
  assert.deepEqual(await scanInbox(orchInbox(home)), []);
  assert.ok(!readJournalSnapshot(orchLedger(home)).some(e => e.type !== 'applied'));
  // Each pending-work source starts the orchestrator.
  await outbox.append('sent', { request: { rid: 'new', from: 'main:x', to: 'orch', sseq: 2, kind: 'drain', body: {} } });
  assert.match(await run(), /work pending/); assert.equal(started.length, 1);
  await outbox.append('resolved', { rid: 'new' }); await outbox.close();
  assert.equal(await pendingWork(home), false);
  await publishRequest(orchInbox(home), { rid: 'inbox', from: 'test', to: 'orch', sseq: 1, kind: 'resume', body: {} });
  assert.equal(await pendingWork(home), true);
  await unlink(join(orchInbox(home), 'inbox.json'));
  const gen = await openJournal(join(home, 'w', 'finished', 'journal.jsonl'));
  await gen.append('generation', { key: 'a', gen: 2 });
  await run(); assert.equal(started.length, 2);
  await gen.append(JT.sealed, { call: 'finished@1/a@2', exec: 'x', result: {} });
  assert.equal(await pendingWork(home), false);
  const running = await openJournal(join(home, 'w', 'running', 'journal.jsonl'));
  await running.append('wf-created', { revision: 1 }); await gen.close(); await running.close();
  await run(); assert.deepEqual(started, [home, home, home]);
  assert.deepEqual(await scanInbox(orchInbox(home)), []);
  assert.throws(() => parseArgs(['start', 'w']));
});

test('P1 start reuses the lock-checked detached starter', { timeout: 10000 }, async t => {
  const home = await root(t), entry = join(home, 'starter.cjs'), marker = join(home, 'started');
  await writeFile(entry, `require('fs').appendFileSync(${JSON.stringify(marker)},'x')`);
  const env = { ...process.env, HOME: home, DSA_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), DSA_ORCHESTRATOR_ENTRY: entry };
  const running = await openJournal(join(home, 'w', 'running', 'journal.jsonl')); await running.append('wf-created', { revision: 1 }); await running.close();
  const held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held);
  try { assert.equal(await main(['start'], { env, write() {} }), 0); await delay(300); await assert.rejects(readFile(marker), { code: 'ENOENT' }); } finally { await held.release(); }
  assert.equal(await main(['start'], { env, write() {} }), 0);
  await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'x');
  assert.deepEqual(await scanInbox(orchInbox(home)), []);
});

test('P1 install-service refuses an npx cache entry and recommends a global install', async t => {
  const home = await root(t), out: string[] = [];
  const entry = join(home, '.npm/_npx/0123abcd/node_modules/pi-durable-subagents/dist/cli/main.js');
  assert.match(serviceEntryError(entry)!, /npm i -g pi-durable-subagents/);
  assert.equal(serviceEntryError('/usr/lib/node_modules/pi-durable-subagents/dist/cli/main.js'), undefined);
  assert.equal(serviceEntryError('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1\\main.js') !== undefined, true);
  const runner = async () => { throw new Error('must not run'); };
  assert.equal(await main(['install-service'], { env: { HOME: home, DSA_HOME: join(home, 'state') }, entry, serviceRunner: runner, write: s => out.push(s) }), 1);
  assert.match(out.join('\n'), /npx cache.*npm i -g pi-durable-subagents/s);
  assert.deepEqual((await readdir(home)).filter(n => n !== '.npm'), []);
  assert.equal(await main(['uninstall-service', '--dry-run'], { env: { HOME: home, DSA_HOME: join(home, 'state') }, entry, serviceRunner: runner, write() {} }), 0);
});

test('help lists start and chaos', async () => {
  const out: string[] = [];
  assert.equal(await main(['help'], { write: s => out.push(s) }), 0);
  assert.match(out[0]!, /\| start \|/); assert.match(out[0]!, /\| chaos /);
});
