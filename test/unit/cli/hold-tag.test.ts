import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hold, parseHold } from '../../../src/cli/hold.ts';
import { ProcessTable } from '../../../src/platform/proctable.ts';
import * as lease from '../../../src/platform/lease.ts';

const linux = { skip: process.platform !== 'linux' ? 'DSA_HOLD environment discovery requires Linux /proc; macOS may expose only process groups' : false };
const cli = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
async function until<T>(fn: () => T | false | undefined): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) { const value = fn(); if (value) return value; if (Date.now() >= end) throw new Error('Timed out waiting for tagged processes'); await delay(20); }
}
async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-hold-tag-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
function run(t: test.TestContext, home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  // Keep resource:seq tags distinct from other test files, whose DSA_HOME directories are also temporary.
  const argv = [`tag-${args[0]}`, ...args.slice(1)];
  const child = spawn(process.execPath, [cli, 'hold', ...argv], { env: { ...process.env, DSA_HOME: home, NODE_TEST_CONTEXT: undefined, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', d => { stderr += d; });
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; }
  });
  return { child, exit, stderr: () => stderr };
}
function cleanupPid(t: test.TestContext, file: string) {
  t.after(() => { if (existsSync(file)) { try { process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL'); } catch { /* gone */ } } });
}
const pid = (file: string) => Number(readFileSync(file, 'utf8'));
const running = (p: number) => lease.alive({ pid: p });
const current = (home: string, p: number) => lease.readTickets(home, 'tag-machine').find(t => t.wrapper.pid === p);

// The escaped shell waits until the test releases the command, so its new session and environment are observable.
const escaped = (home: string, ignoreTerm = false) => ['sh', '-c',
  `setsid sh -c '${ignoreTerm ? 'trap "" TERM; ' : ''}echo $$ > ${join(home, 'escaped.pid')}; ${ignoreTerm ? 'while :; do sleep 1; done' : 'exec sleep 60'}' & while [ ! -f ${join(home, 'go')} ] && [ -d ${home} ]; do sleep 0.02; done`];

const assertEnded = (home: string) => ['sh', '-c', `p=$(cat ${join(home, 'escaped.pid')}); if [ -r /proc/$p/stat ]; then state=$(awk '{print $3}' /proc/$p/stat); [ "$state" = Z ] || [ "$state" = X ] || exit 99; fi; echo next > ${join(home, 'next')}`];

test('tag: held command receives exact resource:seq and preserves DSA_EXEC / DSA_CALL', async t => {
  const home = await root(t), output = join(home, 'env');
  const a = run(t, home, ['machine', '--', 'sh', '-c', `printf '%s\n' "$DSA_HOLD" "$DSA_EXEC" "$DSA_CALL" > ${output}; while [ ! -f ${join(home, 'go')} ] && [ -d ${home} ]; do sleep 0.02; done`],
    { DSA_EXEC: 'exec-kept', DSA_CALL: 'W1@1/a@2', DSA_HOLD: 'outer:99' });
  const saved = await until(() => { const t = current(home, a.child.pid!); return t?.command && existsSync(output) ? t : undefined; });
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [`tag-machine:${saved.seq}`, 'exec-kept', 'W1@1/a@2']);
  await writeFile(join(home, 'go'), ''); assert.equal(await a.exit, 0);
});

test('tag: setsid descendant ends before a waiting holder starts after command exit', linux, async t => {
  const home = await root(t), file = join(home, 'escaped.pid'); cleanupPid(t, file);
  const a = run(t, home, ['machine', '--', ...escaped(home)]);
  const saved = await until(() => { const t = current(home, a.child.pid!); return t?.command && existsSync(file) ? t : undefined; });
  const escapedPid = pid(file), stat = readFileSync(`/proc/${escapedPid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  assert.equal(Number(stat[3]), escapedPid, 'descendant has its own session');
  assert.notEqual(escapedPid, saved.command!.pid);
  assert.ok(readFileSync(`/proc/${escapedPid}/environ`, 'utf8').split('\0').includes(`DSA_HOLD=tag-machine:${saved.seq}`));
  const b = run(t, home, ['machine', '--', ...assertEnded(home)]);
  await until(() => current(home, b.child.pid!));
  await writeFile(join(home, 'go'), '');
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
  assert.equal(running(escapedPid), false); assert.equal(existsSync(join(home, 'next')), true);
  assert.deepEqual(lease.leaseState(home), []);
});

test('tag: orphan reclamation retains ticket after wrapper, leader and original group are gone', linux, async t => {
  const home = await root(t), file = join(home, 'escaped.pid'); cleanupPid(t, file);
  const a = run(t, home, ['machine', '--', ...escaped(home)]);
  const saved = await until(() => { const t = current(home, a.child.pid!); return t?.command && existsSync(file) ? t : undefined; });
  const escapedPid = pid(file);
  a.child.kill('SIGKILL'); await a.exit;
  process.kill(-saved.command!.pid, 'SIGKILL');
  await until(() => !running(saved.command!.pid) && !lease.groupAlive(saved.command!.pid));
  assert.equal(running(escapedPid), true);
  assert.equal(lease.orphaned(saved), true);
  assert.equal(lease.liveTickets(home, 'tag-machine').length, 1, 'tag alone keeps the ticket live');
  assert.equal(lease.leaseState(home)[0]!.holders[0]!.seq, saved.seq);
  const b = run(t, home, ['machine', '--', ...assertEnded(home)]);
  assert.equal(await b.exit, 0); assert.equal(running(escapedPid), false);
  assert.match(b.stderr(), /hold: ending processes left by/);
  assert.deepEqual(lease.readTickets(home, 'tag-machine'), []);
});

test('yield: exclusive waiter receives lease only after TERM-resistant escaped descendants are killed', linux, async t => {
  const home = await root(t), file = join(home, 'escaped.pid'), output: string[] = []; cleanupPid(t, file);
  const a = hold(parseHold(['tag-machine', '--shared', '--yield', '--', ...escaped(home, true)]),
    { env: { ...process.env, DSA_HOME: home }, pollMs: 30, graceMs: 100, stderr: line => output.push(line) });
  await until(() => existsSync(file) && lease.readTickets(home, 'tag-machine').some(t => t.command));
  const escapedPid = pid(file), began = Date.now();
  const b = run(t, home, ['machine', '--', ...assertEnded(home)]);
  assert.equal(await a, 75); assert.equal(await b.exit, 0);
  assert.ok(Date.now() - began < 3000, 'yield watches + polls and ends the tree within its grace');
  assert.equal(running(escapedPid), false);
  assert.match(output.find(l => l.startsWith('hold: yielded'))!, /^hold: yielded tag-machine to .+ after \d+s; the command was stopped \(exit 75\)$/);
  assert.deepEqual(lease.readTickets(home, 'tag-machine'), []);
});

test('tag: forwarded signal followed by exit cleans escaped descendants before release', linux, async t => {
  const home = await root(t), file = join(home, 'escaped.pid'); cleanupPid(t, file);
  const a = run(t, home, ['machine', '--', ...escaped(home)]);
  await until(() => existsSync(file) && current(home, a.child.pid!)?.command);
  a.child.kill('SIGTERM'); assert.equal(await a.exit, 143);
  assert.equal(running(pid(file)), false); assert.deepEqual(lease.readTickets(home, 'tag-machine'), []);
});

test('tag: exact tags protect unrelated processes; ProcessTable default still discovers DSA_EXEC', linux, async t => {
  const home = await root(t), tag = `other:${process.pid}`;
  const bystander = spawn('sleep', ['60'], { env: { ...process.env, DSA_EXEC: 'exec-kept', DSA_HOLD: tag }, stdio: 'ignore' });
  const exit = new Promise(resolve => bystander.once('exit', resolve));
  t.after(async () => { bystander.kill('SIGKILL'); await exit; });
  await new Promise<void>((resolve, reject) => { bystander.once('spawn', resolve); bystander.once('error', reject); });
  const table = new ProcessTable({ tagName: 'DSA_HOLD' });
  assert.equal((await table.list(new Set([tag]))).find(p => p.pid === bystander.pid)?.tag, tag);
  assert.equal((await new ProcessTable().list(new Set(['exec-kept']))).find(p => p.pid === bystander.pid)?.tag, 'exec-kept');
  const result = await hold(parseHold(['tag-machine', '--', 'true']), { env: { ...process.env, DSA_HOME: home }, graceMs: 30 });
  assert.equal(result, 0); assert.equal(running(bystander.pid!), true);
});

test('tag: cleanup rescans forks, escalates TERM to KILL and reports survivors at the five-second bound', linux, async t => {
  const tkt: lease.LeaseTicket = { seq: 1, resource: 'tag-bound', mode: 'exclusive', wrapper: { pid: process.pid }, argv: ['true'], cwd: '/', since: 0 };
  const messages: string[] = [], signals: [number, string | number | undefined][] = [];
  let now = 0, scans = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(ProcessTable.prototype, 'tagged', () => {
    scans++; now += 1000;
    return [{ pid: 99_999_991 }, ...(scans > 1 ? [{ pid: 99_999_992 }] : [])];
  });
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => { if (signal !== 0) signals.push([pid, signal]); return true; });
  await lease.endLeaseProcesses(tkt, 2000, line => messages.push(line));
  assert.ok(scans >= 5 && scans <= 6, 'cleanup stops at the bound, even when tagged processes remain');
  assert.ok(signals.some(([pid, signal]) => pid === 99_999_991 && signal === 'SIGTERM'));
  assert.ok(signals.some(([pid, signal]) => pid === 99_999_992 && signal === 'SIGKILL'), 'rescans include newly discovered descendants');
  assert.deepEqual(messages, ['hold: 2 processes tagged tag-bound:1 survived; releasing']);
});

test('tag: failed command spawn releases its granted ticket', async t => {
  const home = await root(t), output: string[] = [];
  assert.equal(await hold(parseHold(['tag-machine', '--', '/nonexistent-dsa-hold-test']), { env: { ...process.env, DSA_HOME: home }, stderr: line => output.push(line) }), 127);
  assert.match(output[0]!, /^hold: cannot run/);
  assert.deepEqual(lease.readTickets(home, 'tag-machine'), []);
});
