import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox, publishFile } from '../../../src/kernel/mailbox.ts';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsa-publish-race-')), target = join(root, 'pending.json');
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, target };
}

test('publication retries when a recipient unlinks the file between EEXIST and the identity read', async t => {
  const { root, target } = await fixture(t), box = await Outbox.open(root, 'sender', () => root);
  t.after(() => box.close());
  const request = await box.send('orch', 'stop', {}, undefined, { rid: 'pending' });
  const read = fs.readFile;
  let injected = false;
  t.mock.method(fs, 'readFile', async (path: Parameters<typeof read>[0], ...args: unknown[]) => {
    if (!injected && path === target) { injected = true; await fs.unlink(target); }
    return (read as (...args: unknown[]) => Promise<unknown>)(path, ...args);
  });
  syncBuiltinESMExports();
  await box.republishPending();
  assert.equal(injected, true);
  assert.deepEqual(JSON.parse(await read(target, 'utf8')), request);
  assert.deepEqual([...box.pendingRids()], ['pending']);
});

for (const collisions of [4, 5]) test(`publication bounds consumed-file retries at five attempts (${collisions} collisions)`, async t => {
  const { root, target } = await fixture(t), link = fs.link, read = fs.readFile;
  let attempts = 0, reads = 0;
  t.mock.method(fs, 'link', async (from: Parameters<typeof link>[0], to: Parameters<typeof link>[1]) => {
    if (to === target && ++attempts <= collisions) await fs.writeFile(target, 'same');
    return link(from, to);
  });
  t.mock.method(fs, 'readFile', async (path: Parameters<typeof read>[0], ...args: unknown[]) => {
    if (path === target) { reads++; await fs.unlink(target); }
    return (read as (...args: unknown[]) => Promise<unknown>)(path, ...args);
  });
  syncBuiltinESMExports();
  assert.equal(await publishFile(root, 'pending.json', 'same'), collisions === 4 ? 'published' : 'conflict');
  assert.equal(attempts, 5); assert.equal(reads, collisions);
  assert.deepEqual(await fs.readdir(root), collisions === 4 ? ['pending.json'] : [], 'temporary publication files are removed');
});

test('publication preserves conflicts for unreadable, different or invalid existing content', async t => {
  const { root, target } = await fixture(t), read = fs.readFile;
  await fs.writeFile(target, 'different');
  assert.equal(await publishFile(root, 'pending.json', 'same'), 'conflict');
  assert.equal(await publishFile(root, 'pending.json', 'same', () => { throw new Error('invalid'); }), 'conflict');
  let reads = 0;
  t.mock.method(fs, 'readFile', async (path: Parameters<typeof read>[0], ...args: unknown[]) => {
    if (path === target) { reads++; throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }
    return (read as (...args: unknown[]) => Promise<unknown>)(path, ...args);
  });
  syncBuiltinESMExports();
  assert.equal(await publishFile(root, 'pending.json', 'same'), 'conflict');
  assert.equal(reads, 1); assert.equal(await read(target, 'utf8'), 'different');
});
