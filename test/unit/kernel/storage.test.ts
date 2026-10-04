import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, writeFile, rm, stat, unlink, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { publishRequest, scanInbox, Outbox } from '../../../src/kernel/mailbox.ts';
import { contentHash, forwardRid, ulid } from '../../../src/kernel/ids.ts';
import type { Request } from '../../../src/types.ts';

const req: Request = { rid: 'r1', from: 'main:test', to: 'orch', sseq: 1, kind: 'run', body: { x: 1 } };
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-kernel-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test('journal serializes concurrent appends; snapshots cannot mutate committed entries', async t => {
  const path = join(await fixture(t), 'journal'); const journal = await openJournal(path);
  const records = await Promise.all(Array.from({ length: 40 }, (_, n) => journal.append('event', { n, seq: 999, type: 'override' })));
  assert.deepEqual(records.map(e => e.seq), Array.from({ length: 40 }, (_, n) => n + 1));
  records[0]!.n = 'tampered';
  assert.equal(journal.entries()[0]!.n, 0);
  assert.equal(readJournalSnapshot(path).length, 40);
  await journal.close(); await assert.rejects(journal.append('late', {}), /closed/);
});
test('crash recovery truncates torn and CRC-invalid tails; snapshot stays read-only', async t => {
  const path = join(await fixture(t), 'journal');
  let journal = await openJournal(path); await journal.append('kept', { text: '中文' }); await journal.close();
  const good = await readFile(path);
  for (const tail of ['1234 {"seq":2', '00000000 {"seq":2,"ts":1,"type":"bad"}\n']) {
    await appendFile(path, tail);
    assert.equal(readJournalSnapshot(path).length, 1);
    assert.equal((await stat(path)).size, good.length + Buffer.byteLength(tail));
    journal = await openJournal(path);
    assert.deepEqual(await readFile(path), good);
    const appended = await journal.append('next', {}); assert.equal(appended.seq, 2);
    await journal.close(); await writeFile(path, good);
  }
});
test('mid-file corruption throws in both writer and snapshot without modifying bytes', async t => {
  const path = join(await fixture(t), 'journal'); const journal = await openJournal(path);
  await journal.append('first', {}); await journal.append('second', {}); await journal.close();
  const bytes = await readFile(path); bytes[0] = bytes[0] === 48 ? 49 : 48; await writeFile(path, bytes);
  await assert.rejects(openJournal(path), /corruption/); assert.throws(() => readJournalSnapshot(path), /corruption/);
  assert.deepEqual(await readFile(path), bytes);
});
test('publication is atomic no-replace and scan reports malformed envelopes', async t => {
  const dir = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => publishRequest(dir, req)));
  assert.equal(results.filter(r => r === 'published').length, 1);
  assert.equal(results.filter(r => r === 'exists-identical').length, 7);
  assert.equal(await publishRequest(dir, { ...req, body: { x: 2 } }), 'conflict');
  await writeFile(join(dir, '.partial.tmp'), '{'); await writeFile(join(dir, 'bad.json'), '{');
  await writeFile(join(dir, 'invalid.json'), '{}');
  const errors: string[] = [];
  assert.deepEqual(await scanInbox(dir, path => errors.push(path)), [req]); assert.equal(errors.length, 2);
  await assert.rejects(publishRequest(dir, { ...req, rid: '../escape' }), /identity/);
});
test('outbox high-water survives resolution and reopen; replay is idempotent', async t => {
  const dir = await fixture(t), inbox = join(dir, 'inbox');
  let box = await Outbox.open(dir, 'main:test', () => inbox);
  const first = await box.send('orch', 'run', {}); await box.markResolved(first.rid); await unlink(join(inbox, `${first.rid}.json`)); await box.close();
  box = await Outbox.open(dir, 'main:test', () => inbox);
  const second = await box.send('orch', 'run', {}); assert.equal(second.sseq, 2);
  assert.equal((await box.send('child', 'task', {})).sseq, 1);
  await unlink(join(inbox, `${second.rid}.json`)); await box.republishPending(); await box.republishPending();
  assert.equal((await scanInbox(inbox)).length, 2);
  await box.close();
});
test('failed publication stays durable and is recovered before next sequence', async t => {
  const dir = await fixture(t), inbox = join(dir, 'inbox'); await writeFile(inbox, 'blocked');
  let box = await Outbox.open(dir, 'sender', () => inbox);
  await assert.rejects(box.send('orch', 'run', {})); await box.close(); await unlink(inbox); await mkdir(inbox);
  box = await Outbox.open(dir, 'sender', () => inbox); await box.republishPending();
  assert.equal((await scanInbox(inbox))[0]!.sseq, 1); assert.equal((await box.send('orch', 'run', {})).sseq, 2); await box.close();
});
test('tail truncation and appends fsync before success; file creation syncs directory', async t => {
  const dir = await fixture(t), path = join(dir, 'journal');
  const probe = await open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync, originalTruncate = prototype.truncate;
  const events: string[] = [];
  t.mock.method(prototype, 'sync', async function (this: typeof probe) {
    events.push((await this.stat()).isDirectory() ? 'directory-sync' : 'file-sync');
    return originalSync.call(this);
  });
  t.mock.method(prototype, 'truncate', async function (this: typeof probe, length: number) {
    events.push('truncate'); return originalTruncate.call(this, length);
  });
  await probe.close();
  let journal = await openJournal(path);
  assert.deepEqual(events, ['file-sync', 'directory-sync']);
  events.length = 0; await journal.append('kept', {}); assert.deepEqual(events, ['file-sync']); await journal.close();
  await appendFile(path, 'torn'); events.length = 0;
  journal = await openJournal(path); assert.deepEqual(events, ['truncate', 'file-sync']); await journal.close();
  events.length = 0; await publishRequest(join(dir, 'inbox'), req);
  assert.deepEqual(events, ['file-sync', 'directory-sync']);
});
test('canonical identities and monotonic ULIDs', () => {
  assert.equal(contentHash({ z: [1, { b: 2, a: 3 }], a: 0 }), contentHash({ a: 0, z: [1, { a: 3, b: 2 }] }));
  assert.equal(contentHash({ at: new Date(0), sparse: Array(2) }), contentHash({ at: '1970-01-01T00:00:00.000Z', sparse: [null, null] }));
  assert.notEqual(forwardRid('r', 'w@1', 'k', 'h'), forwardRid('r', 'w@2', 'k', 'h'));
  const values = Array.from({ length: 1000 }, ulid); assert.deepEqual(values, [...values].sort()); assert.equal(new Set(values).size, values.length);
});

test('P7, P38: Outbox.send with a fixed rid is idempotent across reopen and rejects conflicting reuse', async () => {
  const { mkdtemp, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Outbox } = await import('../../../src/kernel/mailbox.ts');
  const root = await mkdtemp(join(tmpdir(), 'dsa-outbox-rid-'));
  const inbox = join(root, 'inbox');
  let box = await Outbox.open(root, 'orch', () => inbox);
  const a = await box.send('call-1', 'steer', { message: 'x' }, undefined, { rid: 'fwd-1' });
  await box.close();
  box = await Outbox.open(root, 'orch', () => inbox);
  const b = await box.send('call-1', 'steer', { message: 'x' }, undefined, { rid: 'fwd-1' });
  assert.equal(b.sseq, a.sseq); assert.equal(b.rid, 'fwd-1');
  const c = await box.send('call-1', 'steer', { message: 'y' });
  assert.equal(c.sseq, a.sseq + 1);
  await assert.rejects(box.send('call-1', 'steer', { message: 'DIFFERENT' }, undefined, { rid: 'fwd-1' }), /identity conflict/);
  assert.deepEqual((await readdir(inbox)).filter(n => n.endsWith('.json')).sort(), ['fwd-1.json', `${c.rid}.json`].sort());
  await box.close();
});
