import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { main, parseArgs } from '../../../src/cli/main.ts';
import { pendingWork } from '../../../src/cli/control.ts';
import { OsLock } from '../../../src/platform/lock.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, orchLock, workflowDir } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';
import { JT } from '../../../src/types.ts';

async function root(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-housekeeping-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
async function until(fn: () => boolean) {
  const end = performance.now() + 10_000;
  while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await delay(20); }
}
const cli = async (args: string[], env: NodeJS.ProcessEnv, extra: { now?: number; waitMs?: number } = {}) => {
  const out: string[] = [];
  const code = await main(args, { env, write: s => { out.push(s); }, ...extra });
  return { code, text: out.join('\n') };
};

test('prune and doctor parse their options and reject ambiguous ones', () => {
  assert.deepEqual(parseArgs(['prune']), { command: 'prune', json: false });
  assert.deepEqual(parseArgs(['prune', 'w']), { command: 'prune', target: 'w', json: false });
  assert.deepEqual(parseArgs(['prune', '--older-than', '7']), { command: 'prune', json: false, olderThanDays: 7 });
  assert.deepEqual(parseArgs(['doctor', '--json']), { command: 'doctor', json: true });
  for (const args of [['prune', 'w', '--older-than', '1'], ['prune', '--older-than'], ['prune', '--older-than', '-1'], ['prune', '--older-than', 'x'],
    ['prune', '--json'], ['prune', 'a', 'b'], ['doctor', 'w'], ['status', '--older-than', '1'], ['prune', '../x']]) assert.throws(() => parseArgs(args), args.join(' '));
});

test('CLI prune and doctor against journals written by the real engine with the fake executor', { timeout: 60_000 }, async t => {
  const home = await root(t), env = { HOME: home, DSA_HOME: home };
  // The test is the orchestrator: holding its lock keeps the CLI from spawning a real one.
  const held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held);
  await mkdir(join(home, 'agent/agents'), { recursive: true });
  await writeFile(join(home, 'agent/agents/test.md'), '---\nname: test\ndescription: test\n---\nTest');
  const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: {} };
  const engine = new Engine(ledgers, fakeExecutor(ledgers), { discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  const ticker = setInterval(() => { void engine.intake().catch(() => {}); }, 30);
  t.after(async () => { clearInterval(ticker); await engine.close(); await orch.close(); await held.release(); });
  await engine.recover();
  const run = async (rid: string, sseq: number, source: string) => {
    await publishRequest(orchInbox(home), { rid, from: 'test', to: 'orch', sseq, kind: 'run', body: { cwd: home, source } });
    await until(() => orch.entries().some(e => e.type === JT.created && e.rid === rid));
    const wid = String(orch.entries().find(e => e.type === JT.created && e.rid === rid)!.wid);
    await until(() => engine.store.workflows.get(wid)!.journal.entries().some(e => e.type === JT.done));
    return wid;
  };
  const one = await run('one', 1, "return await runs.run('a',{agent:'test',task:'hello'});");
  const two = await run('two', 2, "return await runs.run('b',{agent:'test',task:'world'});");
  const parked = await run('three', 3, "return await runs.run('c',{agent:'nobody',task:'x'});");

  // Healthy: everything is reported, nothing is actionable.
  let r = await cli(['doctor', '--json'], env);
  const report = JSON.parse(r.text);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(report.workflows, { done: 2, parked: 1 });
  assert.ok(report.bytes > 0 && report.ledger.entries === orch.entries().length && report.ledger.bytes > 0);
  assert.deepEqual(report.largestJournals.map((j: { wid: string }) => j.wid).sort(), [one, two, parked].sort());
  assert.deepEqual(report.parked.map((p: { wid: string }) => p.wid), [parked]);
  assert.deepEqual([report.orchestrator, report.service, report.findings], ['running', 'not installed', []]);
  r = await cli(['doctor'], env);
  assert.equal(r.code, 0);
  assert.match(r.text, /^DSA_HOME .*: \d/); assert.match(r.text, /workflows: 2 done, 1 parked \(3 total\)/);
  assert.match(r.text, /orchestrator: running \(holds the lock\)/); assert.match(r.text, /nothing actionable$/);

  // Actionable: parked > 24 h, unresolved fence failure, orphan staging, leftover tmp file; one command each.
  const journal = engine.store.workflows.get(two)!.journal, exec = `${two}@1/b@1#1.1`;
  await journal.append('fence-failed', { exec, error: 'Fence timeout' });
  await journal.append(JT.attention, { item: { id: 'q:x', rev: 1, kind: 'question', text: 'which?', wid: two } });
  await mkdir(join(home, 'staging', 'ghost'), { recursive: true });
  await writeFile(join(workflowDir(home, one), '.01ABC.tmp'), 'partial');
  r = await cli(['doctor', '--json'], env, { now: Date.now() + 25 * 3_600_000 });
  assert.equal(r.code, 1);
  const findings = JSON.parse(r.text).findings as { kind: string; command: string }[];
  assert.deepEqual(findings.map(f => f.kind).sort(), ['fence-failed', 'orphan-staging', 'parked', 'tmp-file']);
  assert.equal(findings.find(f => f.kind === 'parked')!.command, `pi-durable-subagents resume ${parked}`);
  assert.match(findings.find(f => f.kind === 'fence-failed')!.command, new RegExp(`DSA_EXEC=${exec.replace(/[.@/#]/g, '\\$&')}`));
  assert.equal(findings.find(f => f.kind === 'orphan-staging')!.command, `rm -rf '${join(home, 'staging', 'ghost')}'`);
  assert.equal(findings.find(f => f.kind === 'tmp-file')!.command, `rm -f '${join(workflowDir(home, one), '.01ABC.tmp')}'`);
  assert.deepEqual(JSON.parse(r.text).attention.map((a: { id: string }) => a.id), ['q:x']);
  r = await cli(['doctor'], env, { now: Date.now() + 25 * 3_600_000 });
  assert.equal(r.code, 1); assert.match(r.text, /4 actionable finding\(s\):[\s\S]*\n {4}pi-durable-subagents resume /);
  // The open attention item alone (age > 1 h) is reported but not actionable.
  await journal.append(JT.attentionResolved, { id: `fence:${exec}`, rev: 1, resolution: 'fenced' });
  await rm(join(home, 'staging', 'ghost'), { recursive: true }); await rm(join(workflowDir(home, one), '.01ABC.tmp'));
  r = await cli(['doctor', '--json'], env, { now: Date.now() + 2 * 3_600_000 });
  assert.equal(r.code, 0, r.text); assert.equal(JSON.parse(r.text).attention.length, 1);

  // prune: a named ineligible workflow is rejected with its reason; a bulk prune reports count and bytes.
  r = await cli(['prune', parked], env);
  assert.deepEqual([r.code, r.text], [1, 'prune rejected: not-finished:parked']);
  r = await cli(['prune', 'NOSUCH'], env);
  assert.deepEqual([r.code, r.text], [1, 'prune rejected: unknown-workflow']);
  r = await cli(['prune', '--older-than', '1'], env);
  assert.deepEqual([r.code, r.text], [0, 'pruned 0 workflows, freed 0 B']);
  r = await cli(['prune'], env);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`^pruned 2 workflows, freed \\d+(\\.\\d)? (B|KiB|MiB)\n  ${[one, two].sort().join('\n  ')}$`));
  assert.ok(!existsSync(workflowDir(home, one)) && !existsSync(workflowDir(home, two)) && existsSync(workflowDir(home, parked)));
  r = await cli(['doctor', '--json'], env);
  assert.deepEqual(JSON.parse(r.text).workflows, { parked: 1 });
  // A pruned workflow is never pending work for `start` or the main agent's starter.
  assert.equal(await pendingWork(home), false);
});

test('CLI prune reports a request the orchestrator has not resolved yet', { timeout: 20_000 }, async t => {
  const home = await root(t), held = await new OsLock().tryAcquire(orchLock(home)); assert.ok(held);
  t.after(() => held.release());
  const r = await cli(['prune', 'w'], { HOME: home, DSA_HOME: home }, { waitMs: 200 });
  assert.equal(r.code, 1);
  assert.match(r.text, /^submitted prune \S+; not resolved within 0 s \(is the orchestrator running\? see: pi-durable-subagents doctor\)$/);
});
