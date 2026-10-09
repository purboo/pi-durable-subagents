// Restart: the orchestrator refuses while an execution runs (unless forced), exits when accepted, and the CLI starts
// its successor; an orchestrator older than the request is checked from the journals and ended with SIGTERM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { main, parseArgs } from '../../../src/cli/main.ts';
import { startOrchestrator } from '../../../src/cli/control.ts';
import { currentOrchestrator, decidedBy, journalLiveCalls, legacyRestart, waitExit } from '../../../src/cli/restart.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { reduceLifecycle, type DecisionRecord } from '../../../src/kernel/lifecycle.ts';
import { journalPath, orchInbox, orchLedger } from '../../../src/paths.ts';
import { captureStart } from '../../../src/platform/proctable.ts';
import { leaseDir, writeTicket } from '../../../src/platform/lease.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { restartToken, subagentRestartError } from '../../../src/orchestrator/restart.ts';
import { JT, type Request } from '../../../src/types.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';

const fake = fileURLToPath(new URL('../orchestrator/engine/fake.ts', import.meta.url));
async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-restart-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (performance.now() > end) throw new Error('Timed out'); await delay(20); }
}
const decision = (home: string, rid: string) => reduceLifecycle(readJournalSnapshot(orchLedger(home)).filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[]).resolved.get(rid);
/** One sender per home: its sequence numbers start at 1 and have no gaps (a gap defers its later requests). */
function sender(from = 'test') {
  let sseq = 0;
  return (kind: Request['kind'], body: unknown, rid?: string): Request => { sseq++; return { rid: rid ?? `r${sseq}`, from, to: 'orch', sseq, kind, body }; };
}

test('restart arguments: --force only for restart, no target', () => {
  assert.deepEqual(parseArgs(['restart']), { command: 'restart', json: false });
  assert.deepEqual(parseArgs(['restart', '--force']), { command: 'restart', json: false, force: true });
  assert.deepEqual(parseArgs(['restart', '--force', '0123456789ab', '--reason', 'upgrade']), { command: 'restart', json: false, force: '0123456789ab', reason: 'upgrade' });
  assert.deepEqual(parseArgs(['restart', '--reason', 'upgrade']), { command: 'restart', json: false, reason: 'upgrade' });
  for (const args of [['restart', 'w'], ['restart', '--json'], ['drain', '--force'], ['status', '--reason', 'why'], ['restart', '--reason'], ['restart', '--force', '--force']]) assert.throws(() => parseArgs(args));
});

test('engine: a live execution refuses the restart and launches continue; an idle one ends the loop once', { timeout: 15_000 }, async t => {
  const home = await root(t), orch = await openJournal(orchLedger(home)), request = sender();
  await mkdir(join(home, 'agent/agents'), { recursive: true });
  await writeFile(join(home, 'agent/agents/test.md'), '---\nname: test\ndescription: test\n---\nTest');
  const ledgers = { home, orch, config: { k: { idleExitMs: 60_000 } } };
  const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'a' }), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await orch.close(); });
  await engine.recover();
  await publishRequest(orchInbox(home), request('run', { cwd: home, source: "await runs.run('a',{agent:'test',task:'held'}); return await runs.run('b',{agent:'test',task:'next'});" }, 'run'));
  await engine.intake();
  const wid = String(orch.entries().find(e => e.type === JT.created)!.wid);
  const journal = () => readJournalSnapshot(journalPath(home, wid));
  await until(() => journal().some(e => e.type === 'fake-run' && e.key === 'a'));
  await publishRequest(orchInbox(home), request('restart', {}, 'refused'));
  await engine.intake();
  const refusal = String((decision(home, 'refused') as { reason?: string } | undefined)?.reason);
  assert.match(refusal, new RegExp(`^busy: 1 running execution — fencing them interrupts these sessions:\\ntest:\\n  ${wid}/a \\d+s`));
  const token = refusal.match(/token: ([a-f0-9]{12})/)![1]!;
  assert.equal(orch.entries().filter(e => e.type === 'restart').length, 0, 'a refused restart records nothing');
  assert.equal(engine.restartRequested, false);
  // The refusal lifted the launch gate: another workflow's call still launches and finishes.
  await publishRequest(orchInbox(home), request('run', { cwd: home, source: "return await runs.run('c',{agent:'test',task:'next'});" }, 'run2'));
  await engine.intake();
  const wid2 = String(orch.entries().find(e => e.type === JT.created && e.rid === 'run2')!.wid);
  await until(() => readJournalSnapshot(journalPath(home, wid2)).some(e => e.type === JT.done));
  const loop = engine.loop();
  await publishRequest(orchInbox(home), request('restart', { token, reason: 'upgrade after approval', initiator: { origin: 'main:approved' } }, 'accepted'));
  await until(() => decision(home, 'accepted'));
  assert.equal(decision(home, 'accepted')!.type, 'applied');
  await loop; // ends at once: the process exits and its successor takes over
  assert.equal(engine.restartRequested, true);
  assert.deepEqual(orch.entries().filter(e => e.type === 'restart').map(e => [e.rid, e.force, e.live]), [['accepted', true, [`${wid}@1/a@1#1.1`]]]);
  const accepted = orch.entries().find(e => e.type === 'restart')!;
  assert.equal(accepted.reason, 'upgrade after approval');
  assert.deepEqual(accepted.initiator, { origin: 'main:approved' });
  assert.equal(accepted.from, 'test');
  assert.ok(!journal().some(e => e.type === 'fake-run' && e.key === 'b'), 'nothing launched after the accepted restart');
});

test('engine: force guards — grouped refusal with lease and token, stale token, missing reason, subagent and bare force refused', { timeout: 15_000 }, async t => {
  const home = await root(t), orch = await openJournal(orchLedger(home)), request = sender(), other = sender('main:other');
  await mkdir(join(home, 'agent/agents'), { recursive: true });
  await writeFile(join(home, 'agent/agents/test.md'), '---\nname: test\ndescription: test\n---\nTest');
  const ledgers = { home, orch, config: { k: { idleExitMs: 60_000 } } };
  const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'a' }), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await orch.close(); });
  await engine.recover();
  const source = "return await runs.run('a',{agent:'test',task:'held'});";
  await publishRequest(orchInbox(home), request('run', { cwd: home, source }, 'run1'));
  await publishRequest(orchInbox(home), other('run', { cwd: home, source }, 'run2'));
  await engine.intake();
  const wid1 = String(orch.entries().find(e => e.type === JT.created && e.rid === 'run1')!.wid);
  const wid2 = String(orch.entries().find(e => e.type === JT.created && e.rid === 'run2')!.wid);
  await until(() => [wid1, wid2].every(w => readJournalSnapshot(journalPath(home, w)).some(e => e.type === 'fake-run')));
  // A lease held by wid1's call is annotated on its line.
  await mkdir(leaseDir(home, 'machine'), { recursive: true });
  await writeTicket(home, { seq: 1, resource: 'machine', mode: 'exclusive', wrapper: { pid: process.pid }, argv: ['sim'], cwd: home, since: Date.now(), grantedAt: Date.now(), call: `${wid1}@1/a@1` });
  const reason = (rid: string) => String((decision(home, rid) as { reason?: string } | undefined)?.reason);
  const ask = async (rid: string, body: unknown) => { await publishRequest(orchInbox(home), request('restart', body, rid)); await engine.intake(); await until(() => decision(home, rid)); return reason(rid); };
  const listed = await ask('list', {});
  const token = restartToken([{ exec: `${wid1}@1/a@1#1.1` }, { exec: `${wid2}@1/a@1#1.1` }]);
  const line = (w: string) => `  ${w}/a \\d+s${w === wid1 ? ' holds lease machine' : ''}`;
  assert.match(listed, new RegExp(`^busy: 2 running executions — fencing them interrupts these sessions:\\nmain:other:\\n${line(wid2)}\\ntest:\\n${line(wid1)}\\ntoken: ${token}\\nto fence exactly these: pi-durable-subagents restart --force ${token} --reason "<why>"$`));
  assert.match(await ask('stale', { token: '0123456789ab', reason: 'upgrade' }), new RegExp(`^the running executions changed since 0123456789ab\\nbusy: 2 running executions[^]*\\ntoken: ${token}\\n`));
  assert.match(await ask('noreason', { token }), /^restart reason must be non-empty/);
  assert.match(await ask('long', { token, reason: 'x'.repeat(501) }), /^restart reason must be non-empty and at most 500/);
  assert.equal(await ask('sub', { token, reason: 'upgrade', initiator: { call: `${wid1}@1/a@1` } }), subagentRestartError);
  await publishRequest(orchInbox(home), other('restart', { token, reason: 'upgrade', initiator: { call: `${wid2}@1/a@1` } }, 'submain'));
  await engine.intake(); await until(() => decision(home, 'submain'));
  assert.equal(reason('submain'), subagentRestartError, 'a main sender does not hide a subagent caller');
  assert.match(await ask('bare', { force: true }), /^force without a token is refused; first show the user the running executions\nbusy: 2/);
  for (const rid of ['list', 'stale', 'noreason', 'long', 'sub', 'bare']) assert.equal(decision(home, rid)!.type, 'rejected', rid);
  assert.equal(orch.entries().filter(e => e.type === 'restart').length, 0, 'refusals record nothing');
  assert.equal(engine.restartRequested, false);
  // A non-force restart from a subagent is allowed (and refused here only because work runs).
  assert.match(await ask('subplain', { initiator: { call: `${wid1}@1/a@1` } }), /^busy: 2 running executions/);
});

test('engine: an idle restart is accepted without force and replayed once', { timeout: 15_000 }, async t => {
  const home = await root(t), orch = await openJournal(orchLedger(home)), request = sender();
  const ledgers = { home, orch, config: { k: { idleExitMs: 60_000 } } };
  const engine = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await orch.close(); });
  await engine.recover();
  await publishRequest(orchInbox(home), request('restart', {}, 'idle'));
  await engine.intake();
  await until(() => decision(home, 'idle'));
  assert.equal(decision(home, 'idle')?.type, 'applied');
  assert.equal(engine.restartRequested, true);
  await engine.loop();
  assert.deepEqual(orch.entries().filter(e => e.type === 'restart').map(e => [e.rid, e.force, e.live]), [['idle', false, []]]);
});

for (const body of [{ token: '0123456789ab', reason: 'upgrade' }, { force: true }]) test(`engine: an idle restart sent as ${JSON.stringify(body)} fences nothing and is not recorded as a force`, { timeout: 15_000 }, async t => {
  const home = await root(t), orch = await openJournal(orchLedger(home)), request = sender();
  const ledgers = { home, orch, config: { k: { idleExitMs: 60_000 } } };
  const engine = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await orch.close(); });
  await engine.recover();
  await publishRequest(orchInbox(home), request('restart', body, 'idle'));
  await engine.intake();
  await until(() => decision(home, 'idle'));
  assert.equal(decision(home, 'idle')?.type, 'applied');
  assert.deepEqual(orch.entries().filter(e => e.type === 'restart').map(e => [e.force, e.live]), [[false, []]]);
});

test('CLI restart: refused while a call runs, --force replaces the orchestrator process and the call resumes', { timeout: 30_000 }, async t => {
  const request = sender(), home = await root(t), env = { ...process.env, NODE_TEST_CONTEXT: undefined, HOME: home, DSA_HOME: home, DSA_ORCHESTRATOR_ENTRY: fake, DSA_FAKE_HOLD: 'a' };
  t.after(() => { const o = currentOrchestrator(home); if (o) process.kill(o.pid, 'SIGTERM'); });
  const out: string[] = [], write = (s: string) => { out.push(s); };
  assert.equal(await main(['restart'], { env, write }), 0);
  assert.match(out.pop()!, /^restart: no orchestrator is running/);
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test\n---\nTest');
  await publishRequest(orchInbox(home), request('run', { cwd: join(home, 'project'), call: { agent: 'test', task: 'held', key: 'a' } }, 'run'));
  await startOrchestrator(home, env);
  const wid = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created)?.wid as string | undefined);
  await until(() => readJournalSnapshot(journalPath(home, wid)).some(e => e.type === 'fake-run'));
  const first = currentOrchestrator(home)!;
  assert.equal(await main(['restart'], { env, write }), 1);
  const refusal = out.pop()!;
  assert.match(refusal, new RegExp(`^restart refused: busy: 1 running execution — fencing them interrupts these sessions:\\ntest:\\n  ${wid}/a `));
  const token = refusal.match(/token: ([a-f0-9]{12})/)![1]!;
  assert.equal(currentOrchestrator(home)?.pid, first.pid, 'a refused restart leaves the orchestrator running');
  assert.equal(await main(['restart', '--force', token, '--reason', 'approved upgrade'], { env: { ...env, DSA_EXEC: 'self#1', DSA_CALL: 'self' }, write }), 1);
  assert.equal(out.pop(), `restart refused: ${subagentRestartError}`);
  assert.equal(currentOrchestrator(home)?.pid, first.pid);
  assert.equal(await main(['restart', '--force', token], { env, write }), 1);
  assert.match(out.pop()!, /reason must be non-empty/);
  assert.equal(await main(['restart', '--force', token, '--reason', 'approved upgrade'], { env, write }), 0);
  const line = out.pop()!;
  const second = currentOrchestrator(home)!;
  assert.notEqual(second.pid, first.pid);
  assert.equal(line, `restarted: orchestrator ${first.version} (pid ${first.pid}) → ${second.version} (pid ${second.pid})`);
  const entries = readJournalSnapshot(journalPath(home, wid));
  assert.ok(entries.some(e => e.type === 'fake-fenced'), 'the forced restart fenced the running call');
  await until(() => readJournalSnapshot(journalPath(home, wid)).filter(e => e.type === 'fake-run').length === 2);
  assert.equal(readJournalSnapshot(journalPath(home, wid)).filter(e => e.type === JT.sealed).length, 0);
  assert.deepEqual(readJournalSnapshot(orchLedger(home)).filter(e => e.type === 'restart').map(e => [e.force, e.live]), [[true, [`${wid}@1/a@1#1.1`]]]);
  const audit = readJournalSnapshot(orchLedger(home)).find(e => e.type === 'restart')!;
  const cli = (audit.initiator as { cli: { user: string; host: string; ppid: number; parent: string } }).cli;
  assert.equal(audit.reason, 'approved upgrade');
  assert.equal(cli.ppid, process.ppid);
  assert.ok(cli.user && cli.host && cli.parent.length <= 200, JSON.stringify(cli));
  assert.match(String(audit.from), /^cli:/);
});

test('an orchestrator without the restart request: journals decide, SIGTERM ends it', { timeout: 15_000 }, async t => {
  const home = await root(t);
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { old.kill('SIGKILL'); });
  const start = await captureStart(old.pid!).catch(() => '');
  const orch = await openJournal(orchLedger(home));
  await orch.append('orchestrator', { version: '1.0.17', pid: old.pid, ...(start ? { start } : {}) });
  await orch.close();
  const wid = '01RESTARTLEGACY', call = `${wid}@1/a@1`, exec = `${call}#1.1`, journal = await openJournal(journalPath(home, wid));
  await journal.append('wf-created', { wid, revision: 1, origin: 'main:s1', cwd: home });
  await journal.append('call', { key: 'a', gen: 1, pos: 0, spec: { agent: 'test', task: 't' } });
  await journal.append(JT.exec, { exec, call });
  await journal.append('selected', { exec, model: { provider: 'p', id: 'm' } });
  const running = currentOrchestrator(home)!;
  assert.equal(running.pid, old.pid);
  assert.equal(journalLiveCalls(home).length, 1);
  const refused = legacyRestart(home, running, {});
  assert.equal(refused.applied, false);
  assert.match((refused as { reason: string }).reason, new RegExp(`^busy: 1 running execution — fencing them interrupts these sessions:\\nmain:s1:\\n  ${wid}/a \\d+s`));
  const token = restartToken([{ exec }]);
  assert.ok((refused as { reason: string }).reason.endsWith(`token: ${token}\nto fence exactly these: pi-durable-subagents restart --force ${token} --reason "<why>"`));
  assert.match((legacyRestart(home, running, { token: '0123456789ab', reason: 'upgrade' }) as { reason: string }).reason, /^the running executions changed since 0123456789ab\n/);
  assert.match((legacyRestart(home, running, { token }) as { reason: string }).reason, /reason must be non-empty/);
  assert.equal((legacyRestart(home, running, { token, reason: 'upgrade' }, { subagent: true }) as { reason: string }).reason, subagentRestartError);
  assert.match((legacyRestart(home, running, { token: '0123456789ab', reason: 'upgrade' }, { tool: true }) as { reason: string }).reason, new RegExp(`to fence exactly these: subagents \\{action:"restart", force:"${token}", reason:"<why>"\\}$`));
  assert.equal(await waitExit(running, 200), false, 'a refusal sends no signal');
  await journal.append(JT.fenced, { exec });
  assert.deepEqual(journalLiveCalls(home), [], 'a fenced execution waits to run again: nothing runs');
  await journal.append(JT.exec, { exec: `${call}#2.1`, call });
  await journal.append('selected', { exec: `${call}#2.1`, model: { provider: 'p', id: 'm' } });
  await journal.close();
  const again = restartToken([{ exec: `${call}#2.1` }]);
  assert.notEqual(again, token, 'a new execution has a new token');
  assert.deepEqual(legacyRestart(home, running, { token: again, reason: 'approved upgrade' }), { applied: true });
  assert.equal(await waitExit(running, 5_000), true);
  assert.equal(currentOrchestrator(home), undefined);
});

/** submit() starts an orchestrator when its lock is free; these tests play the orchestrator through the ledger. */
async function inert(home: string) { const entry = join(home, 'inert.mjs'); await writeFile(entry, ''); return { DSA_HOME: home, DSA_ORCHESTRATOR_ENTRY: entry }; }
async function sleeper(t: test.TestContext) {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { p.kill('SIGKILL'); });
  return { p, start: await captureStart(p.pid!).catch(() => '') };
}
test('CLI restart waits for an orchestrator that has not reached the request (recovering); undecided → 75, pending', { timeout: 20_000 }, async t => {
  const home = await root(t), busy = await sleeper(t);
  const orch = await openJournal(orchLedger(home));
  await orch.append('orchestrator', { version: '1.0.19', pid: busy.p.pid, ...(busy.start ? { start: busy.start } : {}), restart: true });
  await orch.close();
  const lines: string[] = [];
  const code = await main(['restart'], { env: await inert(home), write: l => lines.push(l), waitMs: 100, pendingMs: 400, starter: async () => {} });
  assert.equal(code, 75);
  assert.match(lines[0]!, /^restart \S+: submitted; the orchestrator has not reached it yet \(it may still be recovering\) — waiting$/);
  assert.match(lines[1]!, /^restart \S+ is still pending: it is decided when an orchestrator reaches it \(do not resubmit/);
});
test('CLI restart decided by a successor orchestrator waits for that one, not the one it first saw', { timeout: 20_000 }, async t => {
  const home = await root(t), first = await sleeper(t), second = await sleeper(t), third = await sleeper(t);
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  const record = (s: { p: { pid?: number }; start: string }) => ({ version: '1.0.19', pid: s.p.pid, ...(s.start ? { start: s.start } : {}), restart: true });
  await orch.append('orchestrator', record(first));
  const lines: string[] = [];
  const done = main(['restart'], { env: await inert(home), write: l => lines.push(l), waitMs: 100, pendingMs: 10_000,
    starter: async () => { await orch.append('orchestrator', record(third)); } });
  const rid = await until(async () => (await readdir(orchInbox(home)).catch(() => [] as string[])).find(n => n.endsWith('.json'))?.replace(/\.json$/, ''));
  // The first orchestrator ends without deciding; its successor (still recovering at first) applies the restart and exits.
  first.p.kill('SIGKILL'); await orch.append('orchestrator-exit', { pid: first.p.pid });
  await orch.append('orchestrator', record(second));
  await delay(300);
  await orch.append(JT.applied, { rid });
  assert.equal(decidedBy(home, rid)!.pid, second.p.pid);
  second.p.kill('SIGKILL');
  assert.equal(await done, 0);
  assert.match(lines.at(-1)!, new RegExp(`^restarted: orchestrator 1\\.0\\.19 \\(pid ${second.p.pid}\\) → 1\\.0\\.19 \\(pid ${third.p.pid}\\)$`));
});
