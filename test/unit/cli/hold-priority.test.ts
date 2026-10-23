import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hold, parseHold } from '../../../src/cli/hold.ts';
import { main } from '../../../src/cli/main.ts';
import * as lease from '../../../src/platform/lease.ts';
import { OsLock } from '../../../src/platform/lock.ts';
import type { LeaseTicket } from '../../../src/platform/lease.ts';

const unixOnly = process.platform === "win32" ? "uses POSIX sh/sleep command scripts" : false;
const cli = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
async function until<T>(fn: () => T | false | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = fn(); if (value) return value; if (Date.now() >= end) throw new Error('Timed out waiting for lease evidence'); await delay(20); }
}
async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-priority-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
function run(t: test.TestContext, home: string, args: string[]) {
  // Isolate environment tags from other concurrently running test files (DSA_HOLD is resource:seq).
  const argv = [`priority-${args[0]}`, ...args.slice(1)];
  const child = spawn(process.execPath, [cli, 'hold', ...argv], { env: { ...process.env, DSA_HOME: home, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; }
  });
  return { child, exit, stderr: () => stderr };
}
const ticket = (home: string, child: ChildProcess) => lease.readTickets(home, 'priority-machine').find(t => t.wrapper.pid === child.pid);
const gate = (home: string, name: string) => ['sh', '-c', `echo ${name} >> ${join(home, 'log')}; while [ ! -f ${join(home, name)} ] && [ -d ${home} ]; do sleep 0.02; done`];
const step = (home: string, name: string) => ['sh', '-c', `echo ${name} >> ${join(home, 'log')}`];
const lines = (home: string) => readFileSync(join(home, 'log'), 'utf8').trim().split('\n');
const fake = (seq: number, mode: LeaseTicket['mode'], priority?: number, granted = false, slots?: number): LeaseTicket => ({
  seq, resource: 'machine', mode, ...(priority !== undefined ? { priority } : {}), ...(granted ? { grantedAt: 1 } : {}), ...(slots ? { slots } : {}),
  wrapper: { pid: process.pid }, argv: ['true'], cwd: '/', since: 0,
});

test('priority: arguments accept only integer -100..100 and leave unused fields absent', () => {
  assert.deepEqual(parseHold(['machine', '--', 'true']), { resource: 'machine', mode: 'exclusive', argv: ['true'] });
  for (const value of ['-100', '0', '100']) assert.equal(parseHold(['machine', '--priority', value, '--', 'true']).priority, Number(value));
  for (const value of ['-101', '101', '1.5', 'NaN', 'Infinity', '', '1e2', ' 2']) assert.throws(() => parseHold(['machine', '--priority', value, '--', 'true']), /--priority must be/);
  assert.throws(() => parseHold(['machine', '--priority', '--', 'true']), /--priority needs a value/);
  assert.equal(parseHold(['machine', '--yield', '--', 'true']).yield, true);
});

test('expect: parses seconds, s, m, h with inclusive 1s..7d bounds', () => {
  for (const [value, ms] of [['90', 90_000], ['90s', 90_000], ['25m', 1_500_000], ['2h', 7_200_000], ['1s', 1000], ['168h', 604_800_000]] as const) {
    assert.equal(parseHold(['machine', '--expect', value, '--', 'true']).expectMs, ms);
  }
  for (const value of ['0', '-1', '0.5s', '1.5m', '169h', '604801', '7d', '1ms', '', 'abc', 'Infinity', '1e3']) assert.throws(() => parseHold(['machine', '--expect', value, '--', 'true']), /--expect must be/);
  assert.throws(() => parseHold(['machine', '--expect', '--', 'true']), /--expect needs a value/);
});

test('priority: higher first, ties by sequence; holders always block and shared compatibility is preserved', () => {
  const old = fake(1, 'exclusive'), high = fake(2, 'exclusive', 10), tie = fake(3, 'exclusive', 10);
  assert.deepEqual(lease.blockers(old, [old, high, tie]).map(t => t.seq), [2, 3]);
  assert.deepEqual(lease.blockers(high, [old, high, tie]), []);
  assert.deepEqual(lease.blockers(tie, [old, high, tie]).map(t => t.seq), [2]);
  const holder = fake(4, 'exclusive', -100, true);
  assert.deepEqual(lease.blockers(high, [holder]).map(t => t.seq), [4]);
  assert.deepEqual(lease.blockers(fake(1, 'shared', -100), [fake(9, 'shared', 100)]), []);
  assert.deepEqual(lease.blockers(fake(1, 'shared', -100), [fake(9, 'exclusive', 100)]).map(t => t.seq), [9]);
  assert.deepEqual(lease.blockers(fake(1, 'shared', -100), [fake(9, 'counted', 100, true, 1)]), []);
});

test('priority: counted requests respect granted slot limits, exclusive holders and ranked waiters', () => {
  const request = fake(1, 'counted', 100, false, 2);
  const holders = [fake(8, 'counted', -100, true, 2), fake(9, 'shared', 0, true)];
  assert.deepEqual(lease.blockers(request, holders).map(t => t.seq), [8, 9]);
  assert.deepEqual(lease.blockers(request, holders.slice(0, 1)), []);
  assert.deepEqual(lease.blockers(request, [fake(7, 'exclusive', -100, true)]).map(t => t.seq), [7]);
  assert.deepEqual(lease.blockers(fake(2, 'counted', -1, false, 10), [fake(9, 'shared', 0)]).map(t => t.seq), [9]);
  assert.deepEqual(lease.blockers(fake(2, 'counted', 1, false, 10), [fake(1, 'exclusive', -1)]), []);
  assert.equal(lease.slotCount([fake(1, 'counted', -1, false, 2), fake(2, 'counted', 1, false, 4)]), 4);
});

test('priority: later high-priority waiter overtakes low; ties retain FIFO', { skip: unixOnly }, async t => {
  const home = await root(t);
  const a = run(t, home, ['machine', '--', ...gate(home, 'a')]);
  await until(() => ticket(home, a.child)?.command && existsSync(join(home, 'log')));
  const low = run(t, home, ['machine', '--priority', '-5', '--', ...step(home, 'low')]);
  await until(() => ticket(home, low.child));
  const high = run(t, home, ['machine', '--priority', '5', '--', ...step(home, 'high')]);
  await until(() => ticket(home, high.child));
  const tie = run(t, home, ['machine', '--priority', '5', '--', ...step(home, 'tie')]);
  await until(() => ticket(home, tie.child));
  assert.deepEqual(lease.leaseState(home)[0]!.waiters.map(t => t.priority), [5, 5, -5]);
  assert.equal(lines(home).join(','), 'a');
  await writeFile(join(home, 'a'), '');
  assert.deepEqual(await Promise.all([a.exit, low.exit, high.exit, tie.exit]), [0, 0, 0, 0]);
  assert.deepEqual(lines(home), ['a', 'high', 'tie', 'low']);
});

test('priority: no-wait jumps lower waiters but not equal/higher waiters or holders; no refused ticket', async t => {
  const home = await root(t);
  const low = await lease.enqueue(home, { ...fake(1, 'exclusive', -1), seq: undefined } as unknown as Omit<LeaseTicket, 'seq'>);
  const jump = await lease.tryGrant(home, { ...fake(2, 'shared', 1), seq: undefined } as unknown as Omit<LeaseTicket, 'seq'>);
  assert.ok(!('busy' in jump));
  if ('busy' in jump) return;
  assert.deepEqual(lease.blockers(low, lease.liveTickets(home, 'machine')).map(t => t.seq), [jump.seq]);
  const blocked = await lease.tryGrant(home, { ...fake(3, 'exclusive', 100), seq: undefined } as unknown as Omit<LeaseTicket, 'seq'>);
  assert.ok('busy' in blocked, 'priority cannot displace a holder');
  lease.removeTicket(home, jump);
  const equal = await lease.tryGrant(home, { ...fake(3, 'shared', -1), seq: undefined } as unknown as Omit<LeaseTicket, 'seq'>);
  const lower = await lease.tryGrant(home, { ...fake(3, 'shared', -2), seq: undefined } as unknown as Omit<LeaseTicket, 'seq'>);
  assert.ok('busy' in equal); assert.ok('busy' in lower);
  assert.deepEqual(lease.readTickets(home, 'machine').map(t => t.seq), [low.seq]);
});

test('priority: grant rechecks under the lock when a high waiter is enqueued after an empty observation (file gate)', async t => {
  const home = await root(t), entered = join(home, 'entered'), go = join(home, 'go');
  const request = { resource: 'machine', mode: 'exclusive' as const, wrapper: { pid: process.pid }, argv: ['true'], cwd: home, since: Date.now() };
  const low = await lease.enqueue(home, request);
  assert.deepEqual(lease.blockers(low, lease.liveTickets(home, 'machine')), []);
  class GatedLock extends OsLock {
    override async tryAcquire(file: string) {
      await writeFile(entered, ''); await until(() => existsSync(go)); return super.tryAcquire(file);
    }
  }
  const granting = lease.grantQueued(home, low, new GatedLock());
  await until(() => existsSync(entered));
  const high = await lease.enqueue(home, { ...request, priority: 10 });
  await writeFile(go, '');
  assert.deepEqual((await granting).map(t => t.seq), [high.seq]);
  assert.equal(low.grantedAt, undefined);
  assert.deepEqual(await lease.grantQueued(home, high), []);
  assert.deepEqual((await lease.grantQueued(home, low)).map(t => t.seq), [high.seq]);
  assert.equal(lease.readTickets(home, 'machine').filter(t => t.grantedAt !== undefined).length, 1);
});

test('priority: concurrent counted grants cannot oversubscribe slots', async t => {
  const home = await root(t), request = { resource: 'machine', mode: 'counted' as const, slots: 2, wrapper: { pid: process.pid }, argv: ['true'], cwd: home, since: Date.now() };
  const a = await lease.enqueue(home, request), b = await lease.enqueue(home, request), c = await lease.enqueue(home, { ...request, priority: 1 });
  const first = await Promise.all([lease.grantQueued(home, a), lease.grantQueued(home, b), lease.grantQueued(home, c)]);
  assert.equal(c.grantedAt !== undefined, true);
  assert.ok(first.some(busy => busy.length > 0));
  await Promise.all([lease.grantQueued(home, a), lease.grantQueued(home, b)]);
  assert.equal(lease.readTickets(home, 'machine').filter(t => t.grantedAt !== undefined).length, 2);
});

test('expect: holder and waiter display, waiting hold line and JSON fields', { skip: unixOnly }, async t => {
  const home = await root(t), now = Date.now();
  const holder = { ...fake(1, 'exclusive', 3, true), grantedAt: now - 180_000, expectMs: 25 * 60_000, yield: true as const };
  const waiter = { ...fake(2, 'exclusive', -2), expectMs: 25 * 60_000 };
  assert.match(lease.leaseLines([{ resource: 'machine', holders: [holder], waiters: [waiter] }], now)[0]!, /\(exclusive, 3m of ~25m\).*expects 25m/);
  assert.match(lease.leaseLines([{ resource: 'machine', holders: [], waiters: [{ ...waiter, mode: 'counted', slots: 2 }], slots: 2 }], now)[0]!, /expects 25m/);
  const a = run(t, home, ['machine', '--priority', '3', '--yield', '--expect', '25m', '--', ...gate(home, 'a')]);
  await until(() => ticket(home, a.child)?.command);
  const saved = ticket(home, a.child)!;
  assert.equal(saved.priority, 3); assert.equal(saved.yield, true); assert.equal(saved.expectMs, 1_500_000);
  const output: string[] = [];
  await main(['leases', '--json'], { env: { DSA_HOME: home }, write: line => output.push(line) });
  const json = JSON.parse(output.join('\n'))[0].holders[0];
  assert.equal(json.priority, 3); assert.equal(json.yield, true); assert.equal(json.expectMs, 1_500_000);
  await writeFile(join(home, 'a'), ''); assert.equal(await a.exit, 0);
  const b = run(t, home, ['machine', '--expect', '25m', '--', ...gate(home, 'b')]);
  await until(() => ticket(home, b.child)?.command);
  const probe = run(t, home, ['machine', '--max-wait', '0.3', '--', 'true']);
  assert.equal(await probe.exit, 75);
  assert.match(probe.stderr(), /held by .*\(exclusive, \d+s of ~25m\)/);
  await writeFile(join(home, 'b'), ''); assert.equal(await b.exit, 0);
});

test('old tickets: no new fields retain priority zero, compatibility and stored shape', async t => {
  const home = await root(t), old = await lease.enqueue(home, { resource: 'machine', mode: 'exclusive', wrapper: { pid: process.pid }, argv: ['true'], cwd: '/', since: 0 });
  const saved = lease.readTickets(home, 'machine')[0]!;
  for (const key of ['priority', 'yield', 'expectMs']) assert.equal(Object.hasOwn(saved, key), false);
  assert.deepEqual(lease.blockers(fake(2, 'shared', -1), [saved]).map(t => t.seq), [old.seq]);
  assert.deepEqual(lease.blockers(fake(2, 'shared', 1), [saved]), []);
  assert.deepEqual(lease.blockers(fake(2, 'exclusive'), [saved]).map(t => t.seq), [old.seq]);
  await lease.grantQueued(home, old);
  assert.deepEqual(lease.blockers(fake(2, 'shared', 100), lease.readTickets(home, 'machine')).map(t => t.seq), [old.seq]);
});

test('yield: compatible shared requests and refused no-wait probes never trigger yield', { skip: unixOnly }, async t => {
  const home = await root(t);
  const a = run(t, home, ['machine', '--shared', '--yield', '--', ...gate(home, 'a')]);
  await until(() => ticket(home, a.child)?.command);
  const b = run(t, home, ['machine', '--shared', '--', ...gate(home, 'b')]);
  await until(() => ticket(home, b.child)?.command);
  const probe = run(t, home, ['machine', '--priority', '100', '--no-wait', '--', 'true']);
  assert.equal(await probe.exit, 75);
  assert.equal(a.child.exitCode, null); assert.doesNotMatch(a.stderr(), /yielded/);
  await writeFile(join(home, 'a'), ''); await writeFile(join(home, 'b'), '');
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
});

test('stable lines: no-wait, timed-out and yielded lines pin the program interface', { skip: unixOnly }, async t => {
  const home = await root(t), output: string[] = [];
  const a = run(t, home, ['machine', '--', ...gate(home, 'a')]);
  await until(() => ticket(home, a.child)?.command);
  const no = run(t, home, ['machine', '--no-wait', '--', 'true']);
  const timeout = run(t, home, ['machine', '--max-wait', '0.1', '--', 'true']);
  assert.deepEqual(await Promise.all([no.exit, timeout.exit]), [75, 75]);
  assert.match(no.stderr(), /^hold: priority-machine is not free now \(.+\); not running the command \(exit 75\)\n$/);
  assert.match(timeout.stderr(), /(?:^|\n)hold: priority-machine still held by .+ after \d+s; not running the command \(exit 75\)\n$/);
  await writeFile(join(home, 'a'), ''); assert.equal(await a.exit, 0);
  const yielded = hold(parseHold(['priority-machine', '--yield', '--', ...gate(home, 'y')]), { env: { ...process.env, DSA_HOME: home }, stderr: line => output.push(line), pollMs: 30, graceMs: 30 });
  await until(() => lease.readTickets(home, 'priority-machine').some(t => t.command));
  const since = Date.now(), waiter = run(t, home, ['machine', '--', ...step(home, 'next')]);
  assert.equal(await yielded, 75); assert.equal(await waiter.exit, 0);
  assert.ok(Date.now() - since < 3000, 'yield detection and command termination are bounded');
  assert.match(output.find(l => l.startsWith('hold: yielded'))!, /^hold: yielded priority-machine to .+ after \d+s; the command was stopped \(exit 75\)$/);
  assert.deepEqual(lease.readTickets(home, 'priority-machine'), []);
});
