// Sends to a command call: steer, follow-up, answer, model and notify are refused with one reason, running or sealed;
// an agent call addressed by the same multi-target send is decided on its own; stop still applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { JT, type Request, type RunBody } from '../../../../src/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import { fakeExecutor } from './fake.ts';

async function until<T>(fn: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error('Timed out'); await delay(10); }
}

test('command call: every send kind is refused with one reason, running or sealed; an agent target of the same send is unaffected', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-command-send-'));
  await mkdir(join(home, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(home, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const ledgers: Ledgers = { home, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(home)) };
  const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held' }), { discovery: { home, agentDir: join(home, 'config'), globalNpmRoot: null } });
  t.after(async () => { await engine.close(); await ledgers.orch.close(); await rm(home, { recursive: true, force: true }); });
  await engine.recover();
  let sseq = 0;
  const publish = async (kind: Request['kind'], body: unknown, rid: string, cond?: Request['cond']) => {
    await publishRequest(orchInbox(home), { rid, from: 'cli:test', to: 'orch', sseq: ++sseq, kind, body, ...(cond ? { cond } : {}) } as Request);
    return until(async () => { await engine.intake(); return ledgers.orch.entries().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid) ?? ledgers.orch.entries().find(e => e.type === JT.created && e.rid === rid); });
  };
  const source = `return await runs.all([{key:'held', command:['sleep','100']}, {key:'done', command:'true'}, {key:'a', agent:'test', task:'x'}]);`;
  await publish('run', { cwd: join(home, 'project'), source } satisfies RunBody, 'run-1');
  const wid = String(ledgers.orch.entries().find(e => e.type === JT.created && e.rid === 'run-1')!.wid);
  const journal = () => engine.store.workflows.get(wid)!.journal.entries();
  await until(() => journal().some(e => e.type === JT.sealed && String(e.call).endsWith('/done@1')) && journal().some(e => e.type === JT.sealed && String(e.call).endsWith('/a@1')));
  assert.ok(!journal().some(e => e.type === JT.sealed && String(e.call).endsWith('/held@1')), 'held runs');
  assert.ok(!journal().some(e => e.type === 'refused'), 'command specs are admitted');

  let n = 0;
  const bodies = (to: string) => [
    { kind: 'steer', body: { to, kind: 'steer', message: 'hi' } },
    { kind: 'follow-up', body: { to, kind: 'follow-up', message: 'more' } },
    { kind: 'answer', body: { to, kind: 'answer', message: 'yes' }, cond: { qid: 'Q1', rev: 1 } },
    { kind: 'model', body: { to, kind: 'model', model: 'p/m' } },
    { kind: 'notify', body: { to, kind: 'notify', message: 'note' } },
  ];
  for (const key of ['held', 'done']) for (const { kind, body, cond } of bodies(`${wid}/${key}`)) {
    const decision = await publish('send', body, `send-${++n}`, cond);
    assert.equal(decision.type, JT.rejected, `${kind} to ${key}`);
    assert.equal(decision.reason, `command call: ${kind} is not supported (stop it, or start a new call)`, `${kind} to ${key}`);
  }
  assert.ok(!journal().some(e => e.type === 'fake-forward' || e.type === 'generation' || e.type === 'pending-note'), 'nothing was forwarded, opened or noted');

  // One multi-target notify (one request per target, the same batch): the agent target is decided as before.
  const batch = 'b1', targets = [`${wid}/held`, `${wid}/a`, `${wid}/done`];
  const decisions = [];
  for (const [i, to] of targets.entries()) decisions.push(await publish('send', { to, kind: 'notify', message: 'x', batch }, `many:${i + 1}`));
  assert.deepEqual(decisions.map(d => [d.type, d.reason]), [
    [JT.rejected, 'command call: notify is not supported (stop it, or start a new call)'], [JT.applied, undefined],
    [JT.rejected, 'command call: notify is not supported (stop it, or start a new call)']]);
  assert.equal(ledgers.orch.entries().findLast(e => e.type === 'send-note' && e.rid === 'many:2')?.delivery, 'noted');
  // stop is unchanged: a running command call is stopped, a sealed one reports its seal.
  assert.equal((await publish('stop', { target: `${wid}/held` }, 'stop-1')).type, JT.applied);
  const sealedStop = await publish('stop', { target: `${wid}/done` }, 'stop-2');
  assert.deepEqual([sealedStop.type, sealedStop.reason], [JT.rejected, 'already-sealed:ok']);
});
