// R7 across a log replaced while the orchestrator runs (review recheck P3): a broken log reopened as a new epoch has
// none of the waits emitted so far, so the tracker resets and the new epoch gets the current waits again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPage } from '../../../src/events/log.ts';
import { EventPump } from '../../../src/events/pump.ts';
import { R7Tracker, startR7, type Wait } from '../../../src/events/r7.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { eventsLog, journalPath, orchLedger } from '../../../src/paths.ts';

test('R7: a broken log reopened as a new epoch gets the waiting of a call still waiting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-r7-epoch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(dir)), j = await openJournal(journalPath(dir, 'A'));
  const store = { workflows: new Map([['A', { journal: j }]]), appended: undefined as ((wid: string) => void) | undefined };
  const pump = new EventPump({ home: dir, orch, store, delayMs: 100_000 });
  await pump.open();
  const call = 'A@1/a@1', wait: Wait = { reason: 'slot', detail: 'waiting for a slot', since: 1 };
  const meta = new Map([[call, { wid: 'A', key: 'a', gen: 1, call }]]);
  const r7 = startR7({ collect: () => ({ current: new Map([[call, wait]]), meta }), sink: pump, intervalMs: 1e9, tracker: new R7Tracker(), log: () => {}, epoch: () => pump.head?.epoch });
  await r7.tick();
  const before = readPage(eventsLog(dir), 0, 1000)!;
  assert.ok(before.events.some(e => e.type === 'waiting' && e.call === call));
  // The log breaks (a failure after a compaction's rename) and its file is gone: the pump reopens a new epoch.
  (pump as unknown as { log: { failed: unknown } }).log.failed = new Error('EIO');
  await rm(eventsLog(dir));
  await j.append('workflow-done', { status: 'done' }); store.appended?.('A');
  await pump.flush().catch(() => {}); await pump.flush().catch(() => {});
  for (let i = 0; i < 3; i++) await r7.tick();
  const after = readPage(eventsLog(dir), 0, 1000)!;
  await r7.stop(); await pump.close(); await j.close(); await orch.close();
  assert.notEqual(after.epoch, before.epoch);
  assert.ok(after.events.some(e => e.type === 'waiting' && e.call === call), after.events.map(e => `${e.type}:${e.call ?? ''}`).join(' '));
});
