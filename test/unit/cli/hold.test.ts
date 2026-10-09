// Resource leases: `pi-durable-subagents hold` runs one command at a time per exclusive resource (shared holders
// together), strictly in request order, keeps the lease while the command lives even if the wrapper is killed, ends the
// command's leftovers before releasing, and shows holders and waiters in `leases` and status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHold } from '../../../src/cli/hold.ts';
import { main, renderView } from '../../../src/cli/main.ts';
import { blockers, groupAlive, leaseCalls, leaseDir, leaseLines, leaseState, orphaned, readTickets, writeShim, type LeaseTicket } from '../../../src/platform/lease.ts';
import { statusBrief, statusView } from '../../../src/orchestrator/snapshot.ts';

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
