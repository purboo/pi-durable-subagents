import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeCache } from '../../../src/kernel/cache.ts';
import { openJournal } from '../../../src/kernel/journal.ts';
import { journalPath } from '../../../src/paths.ts';
import { readSettled, settledPath, SETTLED_VERSION } from '../../../src/orchestrator/settled.ts';
import { RECOVERY_VERSION } from '../../../src/orchestrator/executor/recovered.ts';

test('older settled records discard fenced process lineage while preserving every execution tag', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-settled-memory-'));
  const path = journalPath(home, 'w'), journal = await openJournal(path);
  t.after(async () => { await journal.close(); await rm(home, { recursive: true, force: true }); });
  const record = { v: SETTLED_VERSION, recovery: RECOVERY_VERSION, wid: 'w', journal: { size: 1 },
    done: { type: 'workflow-done', status: 'done' }, revision: 1, resumed: [], calls: 2,
    sweep: [{ exec: 'w@1/a@1#1.1', call: 'w@1/a@1', tracked: ['4242 77'] }, { exec: 'w@1/b@1#1.1', call: 'w@1/b@1', tracked: [] }] };
  writeCache(settledPath(home, 'w'), record, path);
  assert.deepEqual(readSettled(home, 'w')?.sweep, ['w@1/a@1#1.1', 'w@1/b@1#1.1']);
  writeCache(settledPath(home, 'w'), { ...record, sweep: ['w@1/a@1#1.1', 'w@1/b@1#1.1'] }, path);
  assert.deepEqual(readSettled(home, 'w')?.sweep, ['w@1/a@1#1.1', 'w@1/b@1#1.1']);
});
