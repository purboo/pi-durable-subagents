// Resource leases: `pi-durable-subagents hold` runs one command at a time per exclusive resource (shared holders
// together), strictly in request order, keeps the lease while the command lives even if the wrapper is killed, ends the
// command's leftovers before releasing, and shows holders and waiters in `leases` and status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHold } from '../../../src/cli/hold.ts';
import { main, renderView } from '../../../src/cli/main.ts';
import { blockers, groupAlive, leaseCalls, leaseDir, leaseLines, leaseState, orphaned, readTickets, writeShim, type LeaseTicket } from '../../../src/platform/lease.ts';
import { statusBrief, statusView } from '../../../src/orchestrator/snapshot.ts';
import { restartRefusal } from '../../../src/orchestrator/restart.ts';

const cli = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-hold-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (performance.now() > end) throw new Error('Timed out'); await delay(20); }
}
interface Run { child: ChildProcess; exit: Promise<number | null>; stderr: () => string }
function run(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const child = spawn(process.execPath, [cli, 'hold', ...args], { env: { ...process.env, DSA_HOME: home, NODE_TEST_CONTEXT: undefined, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr!.on('data', d => { err += d; });
  return { child, exit: new Promise(r => child.once('exit', code => r(code))), stderr: () => err };
}
const log = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
/** A command that appends "<name> start", sleeps, appends "<name> end". */
const step = (file: string, name: string, s: number) => ['sh', '-c', `echo "${name} start" >> ${file}; sleep ${s}; echo "${name} end" >> ${file}`];
const granted = (home: string, resource: string, pid: number) => readTickets(home, resource).find(x => x.wrapper.pid === pid && x.grantedAt !== undefined);
const queued = (home: string, resource: string, pid: number) => readTickets(home, resource).find(x => x.wrapper.pid === pid);

test('hold: arguments are checked', () => {
  assert.deepEqual(parseHold(['machine', '--shared', '--max-wait', '1.5', '--note', 'bench', '--', 'make', '-j4']),
    { resource: 'machine', mode: 'shared', maxWaitMs: 1500, note: 'bench', argv: ['make', '-j4'] });
  assert.throws(() => parseHold(['machine', 'make']), /needs -- before the command/);
  assert.throws(() => parseHold(['--', 'make']), /needs a resource/);
  assert.throws(() => parseHold(['a/b', '--', 'make']), /Invalid resource/);
  assert.throws(() => parseHold(['m', '--max-wait', 'x', '--', 'make']), /--max-wait must be/);
  assert.throws(() => parseHold(['m', '--bogus', '--', 'make']), /Unknown option --bogus/);
  assert.equal(parseHold(['m', '--no-wait', '--', 'make']).maxWaitMs, 0);
  assert.throws(() => parseHold(['m', '--']), /needs a command/);
});

test('hold: blockers are strict FIFO; an exclusive waiter keeps later shared requests out', () => {
  const t = (seq: number, mode: 'exclusive' | 'shared') => ({ seq, mode }) as LeaseTicket;
  const all = [t(1, 'shared'), t(2, 'exclusive'), t(3, 'shared')];
  assert.deepEqual(blockers(all[0]!, all), []);
  assert.deepEqual(blockers(all[1]!, all).map(x => x.seq), [1]);
  assert.deepEqual(blockers(all[2]!, all).map(x => x.seq), [2]);
  assert.deepEqual(blockers(t(4, 'shared'), [t(1, 'shared'), t(3, 'shared')]), []);
});

test('hold: exclusive holders run one after another in request order; exit codes pass through', async t => {
  const home = await root(t), file = join(home, 'log');
  // A holds until the test lets it go, so B and C queue behind it however slowly they start.
  const go = join(home, 'go');
  const a = run(home, ['machine', '--', 'sh', '-c', `echo "a start" >> ${file}; while [ ! -f ${go} ]; do sleep 0.05; done; echo "a end" >> ${file}`]);
  await until(() => granted(home, 'machine', a.child.pid!));
  const b = run(home, ['machine', '--', ...step(file, 'b', 0.1)]);
  await until(() => /1 ahead/.test(b.stderr()), 20_000);
  const c = run(home, ['machine', '--', 'sh', '-c', `echo "c start" >> ${file}; exit 7`]);
  await until(() => /2 ahead/.test(c.stderr()), 20_000);
  await writeFile(go, '');
  assert.deepEqual(await Promise.all([a.exit, b.exit, c.exit]), [0, 0, 7]);
  assert.deepEqual(log(file), ['a start', 'a end', 'b start', 'b end', 'c start']);
  assert.match(b.stderr(), /hold: waiting for machine \(exclusive\) — held by pid \d+ `sh -c .*` \(exclusive, \d+s\); 1 ahead/);
  assert.match(b.stderr(), /hold: machine granted after/);
  assert.equal(a.stderr(), '', 'granted at once: nothing printed');
  const k = run(home, ['machine', '--', 'sh', '-c', 'kill -TERM $$']);
  assert.equal(await k.exit, 143);
  assert.deepEqual(await readdir(leaseDir(home, 'machine')).then(n => n.filter(x => x.endsWith('.json'))), [], 'released');
});

test('hold: shared holders run together; an exclusive request waits for them and blocks later shared ones', async t => {
  const home = await root(t), file = join(home, 'log');
  const s1 = run(home, ['gpu', '--shared', '--', ...step(file, 's1', 0.8)]);
  const s2 = run(home, ['gpu', '--shared', '--', ...step(file, 's2', 0.8)]);
  await until(() => granted(home, 'gpu', s1.child.pid!) && granted(home, 'gpu', s2.child.pid!));
  const e = run(home, ['gpu', '--', ...step(file, 'e', 0.3)]);
  await until(() => queued(home, 'gpu', e.child.pid!));
  const s3 = run(home, ['gpu', '--shared', '--', ...step(file, 's3', 0.1)]);
  assert.deepEqual(await Promise.all([s1.exit, s2.exit, e.exit, s3.exit]), [0, 0, 0, 0]);
  const order = log(file);
  assert.deepEqual(order.slice(0, 2).sort(), ['s1 start', 's2 start'], 'shared holders overlap');
  assert.deepEqual(order.slice(4), ['e start', 'e end', 's3 start', 's3 end']);
});

test('hold: --max-wait gives up with 75 without running the command', async t => {
  const home = await root(t), file = join(home, 'log');
  const a = run(home, ['machine', '--', ...step(file, 'a', 5)]);
  await until(() => granted(home, 'machine', a.child.pid!));
  const b = run(home, ['machine', '--max-wait', '0.3', '--', ...step(file, 'b', 0)]);
  assert.equal(await b.exit, 75);
  assert.deepEqual(log(file), ['a start'], 'gave up while the holder still ran');
  assert.match(b.stderr(), /still held by pid \d+ .* not running the command \(exit 75\)/);
  assert.equal(await a.exit, 0);
  assert.deepEqual(log(file), ['a start', 'a end']);
});

test('hold: --max-wait 0 / --no-wait takes the lease at once or exits 75 without ever being a waiter', async t => {
  const home = await root(t), file = join(home, 'log');
  // Free: runs at once, its ticket granted from the start.
  const free = run(home, ['machine', '--no-wait', '--', ...step(file, 'free', 0.5)]);
  await until(() => granted(home, 'machine', free.child.pid!));
  assert.equal(await free.exit, 0); assert.equal(free.stderr(), '');
  // A shared probe next to a shared holder is granted too.
  // The shared holder runs until the test lets it go, so nothing else is granted while the probe is watched.
  const go = join(home, 'go');
  const s = run(home, ['machine', '--shared', '--', 'sh', '-c', `while [ ! -f ${go} ]; do sleep 0.05; done`]);
  await until(() => granted(home, 'machine', s.child.pid!));
  const probe = run(home, ['machine', '--shared', '--max-wait', '0', '--', ...step(file, 'probe', 0)]);
  assert.equal(await probe.exit, 0);
  // An exclusive request behind the shared holder waits; a shared probe now has a waiter ahead: refused, and no ticket
  // of it ever appears in the directory (watched for the whole attempt).
  const e = run(home, ['machine', '--', ...step(file, 'e', 0)]);
  await until(() => queued(home, 'machine', e.child.pid!));
  const before = (await readdir(leaseDir(home, 'machine'))).filter(n => n.endsWith('.json')).sort();
  const top = Math.max(...before.map(n => Number.parseInt(n, 10)));
  const seen: string[] = [], watcher = watch(leaseDir(home, 'machine'), (_event, name) => { if (name) seen.push(String(name)); });
  const refused = run(home, ['machine', '--shared', '--no-wait', '--', ...step(file, 'refused', 0)]);
  assert.equal(await refused.exit, 75);
  await delay(100); watcher.close();
  assert.match(refused.stderr(), /hold: machine is not free now \(pid \d+ `sh -c .*e start.*` \(exclusive, waiting, \d+s\)\); not running the command \(exit 75\)/);
  assert.deepEqual(seen.filter(n => /^\d{12}\.json/.test(n) && Number.parseInt(n, 10) > top), [], 'no ticket of the refused probe was written');
  assert.deepEqual((await readdir(leaseDir(home, 'machine'))).filter(n => n.endsWith('.json')).sort(), before);
  await writeFile(go, '');
  assert.deepEqual(await Promise.all([s.exit, e.exit]), [0, 0]);
  assert.ok(!log(file).some(l => l.startsWith('refused')), 'the refused command never ran');
});

test('hold: a killed wrapper keeps the lease until its command ends; leftovers end before release', async t => {
  const home = await root(t), file = join(home, 'log'), pidFile = join(home, 'bg.pid');
  const a = run(home, ['machine', '--', ...step(file, 'a', 1)]);
  const ticket = await until(() => { const x = granted(home, 'machine', a.child.pid!); return x?.command ? x : undefined; });
  a.child.kill('SIGKILL'); await a.exit;
  const b = run(home, ['machine', '--', 'sh', '-c', `echo "b start" >> ${file}; (sleep 30 & echo $! > ${pidFile}; wait) & sleep 0.2; echo "b end" >> ${file}`]);
  assert.equal(await b.exit, 0);
  assert.deepEqual(log(file), ['a start', 'a end', 'b start', 'b end'], `b waited for a's command (pid ${ticket.command!.pid})`);
  const leftover = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(leftover, 0), /ESRCH/, 'the background process the command left is ended');
});

test('hold: when the wrapper is killed and the command has ended, its leftovers keep the lease until a waiter ends them', async t => {
  const home = await root(t), file = join(home, 'log'), pidFile = join(home, 'bg.pid');
  const a = run(home, ['machine', '--', 'sh', '-c', `sleep 30 & echo $! > ${pidFile}; echo "a start" >> ${file}; sleep 0.5`]);
  const ticket = await until(() => { const x = granted(home, 'machine', a.child.pid!); return x?.command && existsSync(pidFile) ? x : undefined; });
  a.child.kill('SIGKILL'); await a.exit;
  process.kill(ticket.command!.pid, 'SIGKILL');
  const leftover = Number(readFileSync(pidFile, 'utf8'));
  await until(() => { try { process.kill(ticket.command!.pid, 0); return false; } catch { return true; } });
  assert.doesNotThrow(() => process.kill(leftover, 0), 'the leftover still runs');
  assert.equal(leaseState(home).length, 1, 'the ticket stays live while its group has members');
  const b = run(home, ['machine', '--', 'sh', '-c', `echo "b start" >> ${file}`]);
  assert.equal(await b.exit, 0);
  assert.throws(() => process.kill(leftover, 0), /ESRCH/, 'the waiter ended the leftover before running');
  assert.match(b.stderr(), /hold: ending processes left by pid \d+/);
  assert.deepEqual(log(file), ['a start', 'b start']);
});

test('hold: leftovers are the command\'s group only: zombies do not hold a lease, a reused pid is never taken for it', { skip: process.platform !== 'linux' }, async t => {
  // A parent that never reaps: its child leads a new process group and exits (a zombie leader), optionally leaving a
  // sleeping member in the group.
  const zombie = async (member: boolean) => {
    const py = spawn('python3', ['-c', `import os,time\npid=os.fork()\nif pid==0:\n  os.setpgid(0,0)\n  if ${member ? 'True' : 'False'} and os.fork()==0:\n    time.sleep(30); os._exit(0)\n  os._exit(0)\nprint(pid,flush=True)\ntime.sleep(30)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const pid = await new Promise<number>(resolve => py.stdout!.once('data', d => resolve(Number(String(d).trim()))));
    await until(() => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z'); } catch { return false; } });
    t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } py.kill('SIGKILL'); });
    const start = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!;
    return { pid, start };
  };
  const ticket = (command: { pid: number; start: string }): LeaseTicket => ({ seq: 1, resource: 'm', mode: 'exclusive', wrapper: { pid: 999_999_99 }, command, argv: ['x'], cwd: '/', since: 0, grantedAt: 0 });
  const alone = await zombie(false);
  assert.equal(orphaned(ticket(alone)), false, 'a zombie leader alone holds nothing');
  const group = await zombie(true);
  await until(() => groupAlive(group.pid));
  assert.equal(orphaned(ticket(group)), true, 'its own zombie leader with a running member: leftovers');
  assert.equal(orphaned(ticket({ pid: group.pid, start: '1' })), false, 'another start token: a reused pid, not the command');
});

test('hold: dead tickets are reclaimed; leases and status show holders and waiters', async t => {
  const home = await root(t), file = join(home, 'log');
  await mkdir(leaseDir(home, 'machine'), { recursive: true });
  const dead: LeaseTicket = { seq: 1, resource: 'machine', mode: 'exclusive', wrapper: { pid: 999_999_99 }, argv: ['x'], cwd: '/', since: Date.now() - 60_000, grantedAt: Date.now() };
  await writeFile(join(leaseDir(home, 'machine'), '000000000001.json'), JSON.stringify(dead));
  await writeFile(join(leaseDir(home, 'machine'), '.seq'), '1');
  const a = run(home, ['machine', '--note', 'profile', '--', ...step(file, 'a', 1.2)], { DSA_CALL: 'W1@1/bench@1', DSA_EXEC: 'W1@1/bench@1#1.1' });
  const at = await until(() => granted(home, 'machine', a.child.pid!));
  assert.equal(at.seq, 2, 'numbers are never reused');
  assert.equal(existsSync(join(leaseDir(home, 'machine'), '000000000001.json')), false, 'the dead ticket is gone');
  const b = run(home, ['machine', '--', 'true'], { DSA_CALL: 'W2@1/build@2' });
  await until(() => queued(home, 'machine', b.child.pid!));
  const state = leaseState(home);
  assert.match(leaseLines(state, Date.now()).join('|'), /^machine held by W1\/bench \(exclusive, \d+s, `sh -c echo "a start" .*…`, profile\); waiting: W2\/build \d+s$/);
  const calls = leaseCalls(state);
  assert.equal(calls.get('W1@1/bench@1'), 'holds lease machine');
  assert.match(calls.get('W2@1/build@2')!, /^waiting for lease machine \d+s$/);
  const lines: string[] = [];
  assert.equal(await main(['leases'], { env: { DSA_HOME: home }, write: l => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /^machine held by W1\/bench \(exclusive/);
  const view = statusView(home);
  assert.match(view.leases![0]!, /^machine held by W1\/bench/);
  assert.match(renderView(view), /\nlease: machine held by W1\/bench/);
  assert.match(statusBrief(home).leases![0]!, /waiting: W2\/build/);
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
  assert.deepEqual(leaseState(home), []);
  lines.length = 0; await main(['leases'], { env: { DSA_HOME: home }, write: l => lines.push(l) });
  assert.deepEqual(lines, ['No leases held or waited for']);
});

test('hold: the shim runs the CLI from a child environment', async t => {
  const home = await root(t), bin = join(home, 'bin');
  const shim = writeShim(bin, process.execPath, cli);
  const out = await new Promise<string>((resolve, reject) => {
    const c = spawn('sh', ['-c', 'pi-durable-subagents hold machine -- sh -c "echo held"'], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSA_HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    let s = ''; c.stdout.on('data', d => { s += d; }); c.once('error', reject); c.once('exit', code => code === 0 ? resolve(s) : reject(new Error(`exit ${code}`)));
  });
  assert.equal(out.trim(), 'held');
  assert.match(readFileSync(shim, 'utf8'), /^#!\/bin\/sh\nexec '.*node.*' '.*main\.ts' "\$@"\n$/);
});

// Counted leases: `hold <resource> --slots N` admits up to N holders, strictly in request order.
/** Like step, but runs until the file `go` exists (or the test's home is removed, so a failed test leaves nothing running). */
const gate = (file: string, name: string, go: string) => ['sh', '-c', `echo "${name} start" >> ${file}; while [ ! -f ${go} ] && [ -d ${dirname(go)} ]; do sleep 0.05; done; echo "${name} end" >> ${file}`];

test('hold --slots: arguments are checked; --shared and --slots cannot be combined', () => {
  assert.deepEqual(parseHold(['build', '--slots', '4', '--', 'cargo', 'test']), { resource: 'build', mode: 'counted', slots: 4, argv: ['cargo', 'test'] });
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => parseHold(['build', '--slots', bad, '--', 'x']), /--slots must be an integer >= 1/);
  assert.throws(() => parseHold(['build', '--slots']), /--slots needs a value|needs -- before/);
  assert.throws(() => parseHold(['build', '--slots', '2', '--shared', '--', 'x']), /--slots and --shared cannot be combined/);
  assert.throws(() => parseHold(['build', '--shared', '--slots', '2', '--', 'x']), /--slots and --shared cannot be combined/);
});

test('hold --slots: blockers count granted tickets and never overtake an earlier waiter', () => {
  const t = (seq: number, mode: 'exclusive' | 'shared' | 'counted', granted: boolean, slots?: number) =>
    ({ seq, mode, ...(slots ? { slots } : {}), ...(granted ? { grantedAt: 1 } : {}) }) as LeaseTicket;
  const c = (seq: number, slots: number) => t(seq, 'counted', false, slots);
  // Free slots, nothing waits ahead: granted.
  assert.deepEqual(blockers(c(3, 3), [t(1, 'counted', true, 3), t(2, 'shared', true)]), []);
  // Full: every granted ticket keeps it, a later granted shared one included.
  assert.deepEqual(blockers(c(3, 2), [t(1, 'counted', true, 2), c(3, 2), t(4, 'shared', true)]).map(x => x.seq), [1, 4]);
  // Behind a waiting exclusive request: kept although slots are free.
  assert.deepEqual(blockers(c(3, 5), [t(1, 'counted', true, 5), t(2, 'exclusive', false)]).map(x => x.seq), [2]);
  // An earlier counted waiter (here with a smaller N) is not overtaken; nor is an earlier shared waiter.
  assert.deepEqual(blockers(c(3, 2), [t(1, 'counted', true, 1), c(2, 1)]).map(x => x.seq), [2]);
  assert.deepEqual(blockers(c(3, 9), [t(1, 'exclusive', true), t(2, 'shared', false)]).map(x => x.seq), [1, 2]);
  // An exclusive request still waits for any earlier ticket; a shared one ignores slots.
  assert.deepEqual(blockers(t(4, 'exclusive', false), [t(1, 'counted', true, 4)]).map(x => x.seq), [1]);
  assert.deepEqual(blockers(t(4, 'shared', false), [t(1, 'counted', true, 1), c(2, 1)]), []);
});

test('hold --slots 2: two run together, the third waits until one exits; leases show k/N', async t => {
  const home = await root(t), file = join(home, 'log'), goA = join(home, 'go-a'), goB = join(home, 'go-b');
  const a = run(home, ['build', '--slots', '2', '--note', 'n1', '--', ...gate(file, 'a', goA)]);
  await until(() => granted(home, 'build', a.child.pid!));
  const b = run(home, ['build', '--slots', '2', '--', ...gate(file, 'b', goB)]);
  await until(() => granted(home, 'build', b.child.pid!));
  assert.equal(queued(home, 'build', a.child.pid!)!.slots, 2);
  const c = run(home, ['build', '--slots', '2', '--', ...step(file, 'c', 0)]);
  await until(() => /position 1, held 2\/2/.test(c.stderr()), 20_000);
  assert.match(c.stderr(), /hold: waiting for build \(slot, position 1, held 2\/2\); held by pid \d+ `sh -c .*` \(slot, \d+s\), pid \d+ /);
  assert.ok(!granted(home, 'build', c.child.pid!), 'the third is not granted');
  // Visibility: text, JSON and status.
  const state = leaseState(home);
  assert.equal(state[0]!.slots, 2); assert.equal(state[0]!.held, 2);
  assert.match(leaseLines(state, Date.now())[0]!, /^build 2\/2 held: pid \d+ `sh -c .*` \(slot, \d+s, n1\), pid \d+ `sh -c .*` \(slot, \d+s\); waiting: 1 \(first: pid \d+ `sh -c .*`, \d+s\)$/);
  const lines: string[] = [];
  assert.equal(await main(['leases', '--json'], { env: { DSA_HOME: home }, write: l => lines.push(l) }), 0);
  const json = JSON.parse(lines.join('\n'));
  assert.equal(json[0].slots, 2); assert.equal(json[0].held, 2);
  assert.deepEqual(json[0].holders.map((x: LeaseTicket) => [x.mode, x.slots]), [['counted', 2], ['counted', 2]]);
  assert.match(statusView(home).leases![0]!, /^build 2\/2 held: /);
  // One exits: the waiter runs while the other holder still runs.
  await writeFile(goA, '');
  assert.equal(await c.exit, 0);
  assert.ok(!log(file).includes('b end'), 'c ran while b still held its slot');
  assert.match(c.stderr(), /hold: build granted after/);
  await writeFile(goB, '');
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
  assert.deepEqual(leaseState(home), []);
});

test('hold --slots: a counted request behind a waiting exclusive one waits although slots are free; an earlier counted waiter is not overtaken', async t => {
  const home = await root(t), file = join(home, 'log'), go = join(home, 'go'), go2 = join(home, 'go2');
  const a = run(home, ['build', '--slots', '3', '--', ...gate(file, 'a', go)]);
  await until(() => granted(home, 'build', a.child.pid!));
  const e = run(home, ['build', '--', ...step(file, 'e', 0.2)]);
  await until(() => queued(home, 'build', e.child.pid!));
  const c = run(home, ['build', '--slots', '3', '--', ...step(file, 'c', 0)]);
  await until(() => /position 2, held 1\/3/.test(c.stderr()), 20_000);
  assert.ok(!granted(home, 'build', c.child.pid!), 'not granted with 2 of 3 slots free');
  await writeFile(go, '');
  assert.deepEqual(await Promise.all([a.exit, e.exit, c.exit]), [0, 0, 0]);
  assert.deepEqual(log(file), ['a start', 'a end', 'e start', 'e end', 'c start', 'c end']);
  // N=1 holder and waiter, then a request with N=2 that would fit by its own count: it queues behind the waiter.
  const h = run(home, ['gpu', '--slots', '1', '--', ...gate(file, 'h', go2)]);
  await until(() => granted(home, 'gpu', h.child.pid!));
  const w = run(home, ['gpu', '--slots', '1', '--', ...step(file, 'w', 0.3)]);
  await until(() => queued(home, 'gpu', w.child.pid!));
  const late = run(home, ['gpu', '--slots', '2', '--', ...step(file, 'late', 0)]);
  await until(() => /position 2, held 1\/2/.test(late.stderr()), 20_000);
  assert.ok(!granted(home, 'gpu', late.child.pid!), 'the later request does not overtake the earlier waiter');
  await writeFile(go2, '');
  assert.deepEqual(await Promise.all([h.exit, w.exit, late.exit]), [0, 0, 0]);
  // Once h ends, w is granted first and late then fits beside it (its own N is 2), so the two may start in either order.
  const order = log(file).slice(6);
  assert.deepEqual(order.slice(0, 2), ['h start', 'h end']);
  assert.ok(order.includes('w start') && order.includes('late start'));
});

test('hold --slots --no-wait: granted while a slot is free, else refused without ever writing a ticket', async t => {
  const home = await root(t), file = join(home, 'log'), go = join(home, 'go');
  const a = run(home, ['build', '--slots', '2', '--no-wait', '--', ...gate(file, 'a', go)]);
  await until(() => granted(home, 'build', a.child.pid!));
  const b = run(home, ['build', '--slots', '2', '--max-wait', '0', '--', ...gate(file, 'b', go)]);
  await until(() => granted(home, 'build', b.child.pid!));
  assert.equal(a.stderr() + b.stderr(), '');
  const before = (await readdir(leaseDir(home, 'build'))).filter(n => n.endsWith('.json')).sort();
  const top = Math.max(...before.map(n => Number.parseInt(n, 10)));
  const seen: string[] = [], watcher = watch(leaseDir(home, 'build'), (_event, name) => { if (name) seen.push(String(name)); });
  const refused = run(home, ['build', '--slots', '2', '--no-wait', '--', ...step(file, 'refused', 0)]);
  assert.equal(await refused.exit, 75);
  await delay(100); watcher.close();
  assert.match(refused.stderr(), /hold: build is not free now \(pid \d+ `sh -c .*` \(slot, \d+s\), pid \d+ `sh -c .*` \(slot, \d+s\)\); not running the command \(exit 75\)/);
  assert.deepEqual(seen.filter(n => /^\d{12}\.json/.test(n) && Number.parseInt(n, 10) > top), [], 'no ticket of the refused probe was written');
  assert.deepEqual((await readdir(leaseDir(home, 'build'))).filter(n => n.endsWith('.json')).sort(), before);
  await writeFile(go, '');
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0]);
  assert.ok(!log(file).some(l => l.startsWith('refused')), 'the refused command never ran');
});

test('hold --slots: the restart refusal names counted leases with k/N', async t => {
  const home = await root(t), now = Date.now();
  await mkdir(leaseDir(home, 'build'), { recursive: true });
  const base = { resource: 'build', mode: 'counted' as const, slots: 3, wrapper: { pid: process.pid }, cwd: home, since: now, grantedAt: now };
  await writeFile(join(leaseDir(home, 'build'), '000000000001.json'), JSON.stringify({ ...base, seq: 1, argv: ['cargo', 'test'], call: 'W1@1/a@1' }));
  await writeFile(join(leaseDir(home, 'build'), '000000000002.json'), JSON.stringify({ ...base, seq: 2, argv: ['make'] }));
  const text = restartRefusal(home, [{ wid: 'W1', key: 'a', gen: 1, callId: 'W1@1/a@1', exec: 'W1@1/a@1#1.1', since: now, phase: 'child' }] as never, {}, false, now)!;
  assert.match(text, /\n  W1\/a 0s holds lease build 2\/3 \(slot, 0s, `cargo test`\)\n/);
  assert.match(text, /\n  build 2\/3 held by pid \d+ `make` \(slot, 0s\)\n/);
});
