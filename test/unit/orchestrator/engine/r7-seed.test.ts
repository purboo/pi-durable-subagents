// R7 seed at orchestrator start (engine startR7): the tracker starts from the log's latest waiting/moving per call,
// read from seq 0 (retained events below `dropped` count), so a restart repeats no logged `waiting` and a call that
// stopped waiting meanwhile gets its `moving`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { publishRequest } from '../../../../src/kernel/mailbox.ts';
import { eventsLog, journalPath, orchInbox, orchLedger } from '../../../../src/paths.ts';
import { Engine } from '../../../../src/orchestrator/engine.ts';
import { EventLog, readPage } from '../../../../src/events/log.ts';
import { JT, type OrchToEval, type Request, type RunBody } from '../../../../src/types.ts';
import type { Event } from '../../../../src/events/types.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import type { EvaluatorTransport } from '../../../../src/orchestrator/evaluator-client.ts';
import { fakeExecutor } from './fake.ts';

class ManualEvaluator implements EvaluatorTransport {
  messages: OrchToEval[] = [];
  async start() {}
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
}

test('R7 engine seed: a restart repeats no logged waiting (also below dropped); a call that moved meanwhile gets moving', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-r7seed-'));
  await mkdir(join(dir, 'project/.pi/agents'), { recursive: true });
  await writeFile(join(dir, 'project/.pi/agents/test.md'), '---\nname: test\ndescription: Test agent\n---\nSynthetic.');
  const open: { engine: Engine; ledgers: Ledgers }[] = [];
  t.after(async () => { for (const b of open) { await b.engine.close().catch(() => {}); await b.ledgers.orch.close(); } await rm(dir, { recursive: true, force: true }); });
  const boot = async () => {
    const ledgers: Ledgers = { home: dir, config: { k: { idleExitMs: 30, r7Ms: 3_600_000 } }, orch: await openJournal(orchLedger(dir)) };
    const engine = new Engine(ledgers, fakeExecutor(ledgers), { evaluator: new ManualEvaluator(), discovery: { home: dir, agentDir: join(dir, 'config'), globalNpmRoot: null } });
    await engine.recover();
    const b = { engine, ledgers }; open.push(b);
    return { ...b, tick: () => (engine as unknown as { r7: { tick(): Promise<void> } }).r7.tick() };
  };
  const r7 = () => { const out: Event[] = []; for (let since = 0, more = true; more;) { const p = readPage(eventsLog(dir), since, 1000)!; out.push(...p.events); more = p.more; if (p.events.length) since = Number(p.events.at(-1)!.cursor.split(':')[1]); } return out.filter(e => e.type === 'waiting' || e.type === 'moving').map(e => [e.type, e.key]); };

  const first = await boot();
  await publishRequest(orchInbox(dir), { rid: 'r1', from: 'cli:seed-test', to: 'orch', sseq: 1, kind: 'run', body: { cwd: join(dir, 'project'), source: 'unused' } satisfies RunBody } as Request);
  await first.engine.intake();
  const wid = String(first.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === 'r1')!.wid);
  const wf = first.engine.store.workflows.get(wid)!, A = `${wid}@1/a@1`, B = `${wid}@1/b@1`;
  // Two queued calls behind a writer lock (synthetic journal entries: the R7 sources).
  for (const [pos, key, c] of [[0, 'a', A], [1, 'b', B]] as const) {
    await wf.journal.append('call', { pos, key, gen: 1, spec: { agent: 'test', task: key } });
    await wf.journal.append(JT.exec, { call: c, exec: `${c}#1.1` });
    await wf.journal.append('writer-wait', { call: c, root: '/repo', holder: 'other' });
  }
  await first.tick();
  assert.deepEqual(r7(), [['waiting', 'a'], ['waiting', 'b']]);
  await first.engine.close(); await first.ledgers.orch.close(); open.length = 0;

  // While down: a moves on (lock acquired, launched); retention drops a later event, so both waits lie below `dropped`.
  const journal = await openJournal(journalPath(dir, wid));
  await journal.append('writer-acquired', { call: A, root: '/repo' });
  await journal.append('selected', { exec: `${A}#1.1`, model: { provider: 'probe', id: 'm' } });
  await journal.close();
  const { log } = await EventLog.open(eventsLog(dir));
  await log.append([{ id: 'GONE:1:sealed', ts: 1, type: 'sealed', wid: 'GONE', status: 'ok' }]);
  await log.compact(r => r.e.wid === 'GONE', new Map());
  const dropped = log.dropped; await log.close();
  assert.ok(readPage(eventsLog(dir), 0, 1000)!.events.filter(e => e.type === 'waiting').every(e => Number(e.cursor.split(':')[1]) < dropped));

  const second = await boot();
  await second.tick();
  assert.deepEqual(r7(), [['waiting', 'a'], ['waiting', 'b'], ['moving', 'a']], 'no repeated waiting for b; moving for a');
});
