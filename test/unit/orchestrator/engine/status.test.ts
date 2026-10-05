import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { journalPath, orchLedger } from '../../../../src/paths.ts';
import { finishedText } from '../../../../src/orchestrator/engine.ts';
import { eventsFromEntries, renderEvent, snapshotFromEntries, statusDetail, statusView } from '../../../../src/orchestrator/snapshot.ts';
import { JT, type Entry } from '../../../../src/types.ts';

const e = (seq: number, type: string, f: Record<string, unknown> = {}) => ({ seq, ts: 1_700_000_000_000 + seq, type, ...f }) as Entry;
const u = (input: number, output: number, costUsd: number) => ({ input, output, costUsd });
const res = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ key, gen: 1, status, ok: status === 'ok', output: '', ...extra });

// One revision boundary, a reused seal, deduplicated usage entries, a stopped seal carrying usage, and a live call.
const entries = [
  e(1, 'wf-created', { name: 'nightly', origin: 'main:o', cwd: '/', revision: 1 }),
  e(2, 'call', { key: 'old', gen: 1, spec: { agent: 'x' } }),
  e(3, 'usage', { call: 'w@1/old@1', id: 'm1', usage: u(100, 10, 0.01) }),
  e(4, 'sealed', { call: 'w@1/old@1', result: res('old', 'ok', { output: 'a\nfinal old\n', usage: u(100, 10, 0.01) }) }),
  e(5, 'revised', { revision: 2 }),
  e(6, 'reused', { key: 'old', gen: 1, from: 'w@1/old@1', spec: { agent: 'x' } }),
  e(7, 'call', { key: 'b', gen: 1, spec: { agent: 'x' } }),
  e(8, 'exec', { call: 'w@2/b@1', exec: 'w@2/b@1#1.1' }),
  e(9, 'selected', { exec: 'w@2/b@1#1.1', model: { provider: 'p', id: 'm' } }),
  e(10, 'observation', { exec: 'w@2/b@1#1.1', event: { type: 'tool_execution_start', toolName: 'bash' } }),
  e(11, 'observation', { exec: 'w@2/b@1#1.1', event: { type: 'tool_execution_end', toolName: 'bash' } }),
  e(12, 'usage', { call: 'w@2/b@1', id: 'm2', usage: u(1000, 50, 0.1) }),
  e(13, 'usage', { call: 'w@2/b@1', id: 'm2', usage: u(1000, 50, 0.1) }),
  e(14, 'loss', { exec: 'w@2/b@1#1.1' }),
  e(15, 'time', { exec: 'w@2/b@1#1.1', active: 5 }),
  e(16, 'stop-intent', { call: 'w@2/b@1' }),
  e(17, 'sealed', { call: 'w@2/b@1', exec: 'w@2/b@1#1.1', result: res('b', 'stopped', { usage: u(1200, 60, 0.12) }) }),
  e(18, 'call', { key: 'c', gen: 1, spec: { agent: 'x' } }),
  e(19, 'exec', { call: 'w@2/c@1', exec: 'w@2/c@1#1.1' }),
  e(20, 'usage', { call: 'w@2/c@1', id: 'm3', usage: u(7, 3, 0) }),
  e(21, 'workflow-done', { status: 'stopped' }),
];

test('P31: snapshots carry per-call and workflow usage from seals and deduplicated usage entries', () => {
  const snap = snapshotFromEntries('w', entries);
  const by = Object.fromEntries(snap.calls.map(c => [c.key, c]));
  assert.deepEqual(by.old!.usage, u(100, 10, 0.01));
  assert.deepEqual(by.b!.usage, u(1200, 60, 0.12), 'the seal is authoritative over partial usage entries');
  assert.deepEqual(by.c!.usage, u(7, 3, 0), 'live usage before a seal');
  assert.equal(by.b!.tools, 1); assert.equal(by.b!.model, 'p/m');
  assert.equal(snap.usage!.input, 1307); assert.equal(snap.usage!.output, 73); assert.ok(Math.abs(snap.usage!.costUsd - 0.13) < 1e-9);
  assert.equal(finishedText('w', entries), 'nightly (w) stopped: 1 ok; b stopped. Usage: 1.3K in / 73 out, $0.13. Details: subagents status.');
});

test('T10: events keep the meaningful timeline only', () => {
  const events = eventsFromEntries(entries);
  assert.deepEqual(events.map(x => x.event), ['created', 'call', 'sealed', 'revised', 'reused', 'call', 'exec', 'model', 'loss', 'stop', 'sealed', 'call', 'exec', 'done']);
  assert.deepEqual(events.find(x => x.event === 'sealed' && x.call === 'w@2/b@1'), { seq: 17, ts: entries[16]!.ts, event: 'sealed', call: 'w@2/b@1', status: 'stopped', ok: false, usage: u(1200, 60, 0.12) });
  assert.match(renderEvent(events.at(-1)!), /^2023-\S+Z #21 done\s+status=stopped$/);
  assert.match(renderEvent(events[10]!), /usage="1.2K in \/ 60 out, \$0.12"/);
});

test('T10: status view is compact, own first, newest first, collapses older finished workflows; detail has no entries', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  const write = async (wid: string, origin: string, list: Entry[]) => {
    await ledger.append(JT.created, { rid: `r-${wid}`, wid, origin });
    const journal = await openJournal(journalPath(home, wid));
    for (const { seq: _s, ts: _t, type, ...fields } of list) await journal.append(type, fields);
    await journal.close();
  };
  const long = `${'x'.repeat(400)}\nlast line`;
  for (let i = 0; i < 12; i++) await write(`01F${String(i).padStart(2, '0')}`, 'main:other', [e(1, 'wf-created', { revision: 1, origin: 'main:other' }), e(2, 'workflow-done', { status: 'done' })]);
  await write('01A00', 'main:me', [e(1, 'wf-created', { revision: 1, origin: 'main:me' }), e(2, 'workflow-done', { status: 'done' })]);
  await write('01Z00', 'main:other', [e(1, 'wf-created', { revision: 1, origin: 'main:other' }), e(2, 'call', { key: 'k', gen: 1, spec: { agent: 'x' } }),
    e(3, 'sealed', { call: '01Z00@1/k@1', result: res('k', 'ok', { output: long, usage: u(5, 6, 0) }) })]);
  await ledger.close();
  const view = statusView(home, { origin: 'main:me' });
  // 01A00 is own (first, kept) although it is the oldest; finished ones beyond the first 10 in that order collapse.
  assert.deepEqual(view.workflows.map(w => w.wid), ['01A00', '01Z00', ...Array.from({ length: 9 }, (_, i) => `01F${String(11 - i).padStart(2, '0')}`)]);
  assert.equal(view.olderFinished, 3);
  const running = view.workflows[1]!;
  assert.deepEqual(running.calls, [{ key: 'k', gen: 1, callId: '01Z00@1/k@1', phase: 'sealed', status: 'ok', ok: true, usage: u(5, 6, 0), lastLine: 'last line' }]);
  assert.deepEqual(running.usage, u(5, 6, 0));
  assert.ok(!JSON.stringify(view).includes('xxxx'), 'no full outputs in the compact view');
  assert.ok(!('entries' in running));
  const detail = statusDetail(home, '01Z00');
  assert.equal(detail.calls[0]!.result!.output, long);
  assert.ok(!('entries' in detail)); assert.equal(detail.scriptLog, undefined);
  assert.throws(() => statusDetail(home, '../escape'), /Unknown workflow/);
});
