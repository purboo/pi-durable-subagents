// Real pi + faux provider: the caller uses its bash tool to start a durable command, ends its turn, then wakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FAUX, REPO, script, tempRoot } from '../../harness/pi.ts';
import { callSession, journalPath, orchInbox, orchLedger } from '../../../src/paths.ts';
import { readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { publishRequest } from '../../../src/kernel/mailbox.ts';
import { main } from '../../../src/orchestrator/main.ts';
import { describe } from '../../../src/cli/requests.ts';
import { Containment } from '../../../src/platform/containment.ts';
import { JT, type Request } from '../../../src/types.ts';

async function until<T>(get: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 60_000;
  for (;;) { const value = await get(); if (value) return value as NonNullable<T>; if (Date.now() > deadline) throw new Error(`timeout: ${what}`); await delay(25); }
}

test('wake caller E2E: a real child bash starts a command that survives its turn, appears in awaiting and opens generation 2 with exit and output', { timeout: 120_000, skip: process.platform === 'win32' ? 'POSIX bash tool command and an inherited-process tree' : false }, async t => {
  const root = tempRoot('dsa-e2e-wake-'), home = join(root, 'dsa'), cwd = join(root, 'work'), agentDir = join(root, 'agent');
  const values = { HOME: root, DSA_HOME: home, PATH: `${join(REPO, 'node_modules/.bin')}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PROBE_DIR: root };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  await mkdir(join(cwd, '.pi/agents'), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [FAUX], defaultProvider: 'probe', defaultModel: 'scripted' }));
  await writeFile(join(cwd, '.pi/agents/test.md'), '---\nname: test\ndescription: test\nmodel: probe/scripted\n---\nTest.');
  const controller = new AbortController(), running = main({ home, signal: controller.signal, discovery: { home: root } });
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  t.after(async () => {
    controller.abort(); await running;
    for (const e of ledger().filter(e => e.type === JT.created)) for (const entry of journal(String(e.wid)))
      if (entry.type === 'command-intent') await new Containment().fence(String(entry.id), []).catch(() => {});
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (process.env.DSA_KEEP) t.diagnostic(`kept ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });
  const task = script([{ tool: 'bash', args: { command: "pi-durable-subagents run --request durable-check --wake caller -- sh -c 'sleep 1; echo wake-out; exit 3'" } }, { text: 'Durable command started; ending this turn.' }]);
  await publishRequest(orchInbox(home), { rid: 'req:caller', from: 'main:wake-test', to: 'orch', sseq: 1, kind: 'run', body: { cwd, source: `return await runs.run('worker', {agent:'test', writer:false, task:${JSON.stringify(task)}});` } } as Request);
  const parent = await until(() => ledger().find(e => e.type === JT.created && e.rid === 'req:caller'), 'caller created'), wid = String(parent.wid);
  const awaiting = await until(async () => (await describe(home, { request: 'caller' })).calls?.find(c => c.key === 'worker')?.awaiting?.find(a => a.request === 'durable-check' && a.state === 'running'), 'awaiting command while it runs');
  assert.ok(awaiting.wid);
  await until(() => journal(wid).find(e => e.type === 'generation' && e.gen === 2), 'caller generation 2');
  await until(() => journal(wid).find(e => e.type === JT.sealed && e.call === `${wid}@1/worker@2`), 'caller generation 2 sealed');
  const opened = journal(wid).filter(e => e.type === 'generation');
  assert.equal(opened.length, 1);
  const message = (opened[0]!.opening as { message: string }).message;
  assert.match(message, /^Durable run durable-check \(.*\) that you started with --wake caller finished: done\./);
  assert.match(message, /exit 3/); assert.match(message, /wake-out/);
  const command = await describe(home, { request: 'durable-check' });
  assert.equal(command.status, 'done'); assert.equal(command.calls![0]!.status, 'failed'); assert.equal(command.wake?.state, 'applied');
  assert.equal((await describe(home, { wid })).calls![0]!.awaiting, undefined);
  const firstSeal = journal(wid).find(e => e.type === JT.sealed && e.call === `${wid}@1/worker@1`)!;
  const childSeal = journal(awaiting.wid!).find(e => e.type === JT.sealed)!;
  assert.ok(firstSeal.ts < childSeal.ts, 'the durable command outlived the caller turn');
  const session = await readFile(callSession(home, wid, 'worker', 2), 'utf8');
  assert.ok(session.includes('wake-out'), 'the opening message reaches the real resumed pi session');
});
