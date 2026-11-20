import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { replacePath } from '../../../src/kernel/fsx.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { Outbox } from '../../../src/kernel/mailbox.ts';
import { orchInbox, orchLedger, outboxRoot } from '../../../src/paths.ts';
import { resolution, submitIdentified } from '../../../src/cli/control.ts';
import { fileId } from '../../../src/kernel/ids.ts';

test('resolution follows appended decisions, ignores identity conflicts and keeps the first terminal outcome', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-resolution-tail-')), orch = await openJournal(orchLedger(home));
  t.after(async () => { await orch.close(); await rm(home, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) await orch.append('applied', { rid: `old-${i}` });
  await orch.append('rejected', { rid: 'pending', reason: 'identity-conflict' });
  assert.equal(await resolution(home, 'pending', 0), undefined);
  const waiting = resolution(home, 'pending', 2000, 10);
  await delay(30);
  await orch.append('rejected', { rid: 'pending', reason: 'domain' });
  await orch.append('applied', { rid: 'pending' });
  assert.deepEqual(await waiting, { type: 'rejected', reason: 'domain' });
  assert.deepEqual(await resolution(home, 'pending', 0), { type: 'rejected', reason: 'domain' });
});
test('resolution polling rebuilds its compact state when the ledger is replaced', { skip: process.platform === 'win32' ? 'Windows cannot replace a ledger another handle has open' : false }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-resolution-replace-'));
  const orch = await openJournal(orchLedger(home)), replacement = await openJournal(join(home, 'replacement'));
  t.after(async () => { await orch.close(); await replacement.close(); await rm(home, { recursive: true, force: true }); });
  await orch.append('applied', { rid: 'other' });
  const waiting = resolution(home, 'pending', 2000, 10);
  await delay(30);
  await replacement.append('rejected', { rid: 'pending', reason: 'replaced' });
  await replacePath(replacement.path, orchLedger(home));
  assert.deepEqual(await waiting, { type: 'rejected', reason: 'replaced' });
});
test('CLI sender only acknowledges its pending ids, in first-resolution ledger order', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-cli-pending-')), sender = `cli:${userInfo().username}@${hostname()}`;
  const orch = await openJournal(orchLedger(home));
  const outbox = await Outbox.open(outboxRoot(home), sender, () => orchInbox(home));
  t.after(async () => { await outbox.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  const one = await outbox.send('orch', 'stop', { target: 'one' }), two = await outbox.send('orch', 'stop', { target: 'two' });
  await outbox.close();
  for (let i = 0; i < 30; i++) await orch.append('applied', { rid: `unrelated-${i}` });
  await orch.append('rejected', { rid: one.rid, reason: 'identity-conflict' });
  await orch.append('applied', { rid: two.rid });
  await orch.append('rejected', { rid: one.rid, reason: 'domain' });
  await orch.append('applied', { rid: one.rid });
  const marked: string[] = [], original = Outbox.prototype.markResolved;
  Outbox.prototype.markResolved = function (rid) { marked.push(rid); return original.call(this, rid); };
  try { await submitIdentified(home, 'req:new', 'stop', { target: 'new' }, undefined, {}, async () => {}); }
  finally { Outbox.prototype.markResolved = original; }
  assert.deepEqual(marked, [two.rid, one.rid]);
  const resolved = readJournalSnapshot(join(outboxRoot(home), 'outbox', `${fileId(sender)}.jsonl`)).filter(e => e.type === 'resolved');
  assert.deepEqual(resolved.map(e => e.rid), [two.rid, one.rid]);
});
