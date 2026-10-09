// R2: the deriver maps journal / ledger entries to event drafts; ids are pure functions of the source entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveCreated, deriveEntry, answeredBy, callParts, labelsOf } from '../../../src/events/derive.ts';
import { JT, type Entry, type Request } from '../../../src/types.ts';
import { EVENT_DATA_INLINE_MAX, type EventDraft } from '../../../src/events/types.ts';
import { lastFence } from '../../../src/cli/requests.ts';

const W = '01WID', C = `${W}@1/a@1`;
const journal = (...rows: [string, Record<string, unknown>?][]) => rows.map(([type, fields], i) => ({ seq: i + 1, ts: 1000 + i, type, ...fields }) as Entry);
const all = (entries: Entry[], orch: Entry[] = [], id = {}) => entries.flatMap((_, i) => deriveEntry(W, entries, i, orch, id));
const types = (events: EventDraft[]) => events.map(e => e.type);
const orchEntry = (seq: number, type: string, fields: Record<string, unknown> = {}, ts = seq) => ({ seq, ts, type, ...fields }) as Entry;

test('R2 deriver: call ids split into key and gen (a key may contain / and @)', () => {
  assert.deepEqual(callParts(`${W}@2/x/y@z@3`), { key: 'x/y@z', gen: 3 });
  assert.equal(callParts('nonsense'), undefined);
});

test('R2 deriver: started once per call (generation), with exec; a second generation starts again', () => {
  const entries = journal(['wf-created'], [JT.exec, { call: C, exec: `${C}#1.1` }], ['settled', { exec: `${C}#1.1` }], [JT.fenced, { exec: `${C}#1.1` }],
    [JT.exec, { call: C, exec: `${C}#1.2` }], [JT.exec, { call: `${W}@1/a@2`, exec: `${W}@1/a@2#1.1` }]);
  const events = all(entries, [], { request: 'R', labels: { node: 'n1' } });
  assert.deepEqual(events, [
    { id: `${W}:2:started`, ts: 1001, wid: W, request: 'R', labels: { node: 'n1' }, type: 'started', key: 'a', gen: 1, call: C, exec: `${C}#1.1` },
    { id: `${W}:6:started`, ts: 1005, wid: W, request: 'R', labels: { node: 'n1' }, type: 'started', key: 'a', gen: 2, call: `${W}@1/a@2`, exec: `${W}@1/a@2#1.1` },
  ], 'settled before the fence: the second execution of a@1 is no fenced event');
});

test('R2 deriver: fenced follows the lastFence classification (interrupted vs settled vs hibernated vs once-unknown)', () => {
  const x1 = `${C}#1.1`, x2 = `${C}#1.2`;
  const interrupted = journal([JT.exec, { call: C, exec: x1 }], [JT.fenced, { exec: x1 }], ['loss', { exec: x1 }], [JT.exec, { call: C, exec: x2 }]);
  const clean = [orchEntry(1, 'orchestrator', { pid: 1 }, 0), orchEntry(2, 'orchestrator-exit', { pid: 1 }, 0), orchEntry(3, 'orchestrator', { pid: 2 }, 0)];
  const fenced = all(interrupted, clean).filter(e => e.type === 'fenced');
  assert.deepEqual(fenced, [{ id: `${W}:4:fenced`, ts: 1003, wid: W, type: 'fenced', key: 'a', gen: 1, call: C, exec: x1, reason: 'process-died', at: 1001 }]);
  // The same fence as describe's lastFence (one classification).
  assert.deepEqual(lastFence(interrupted, clean), { at: 1001, exec: x1, reason: 'process-died' });
  const forced = [...clean, orchEntry(4, 'restart', { force: true, live: [x1] }, 0)];
  assert.equal((all(interrupted, forced).find(e => e.type === 'fenced') as { reason: string }).reason, 'restart-force');
  const crashed = [orchEntry(1, 'orchestrator', { pid: 1 }, 0), orchEntry(2, 'orchestrator', { pid: 2 }, 1001)];
  assert.equal((all(interrupted, crashed).find(e => e.type === 'fenced') as { reason: string }).reason, 'orchestrator-crash');
  // Planned fences: the turn settled before the fence, or the asker hibernated.
  const settled = journal([JT.exec, { call: C, exec: x1 }], ['settled', { exec: x1 }], [JT.fenced, { exec: x1 }], [JT.exec, { call: C, exec: x2 }]);
  assert.deepEqual(types(all(settled)), ['started']);
  const hibernated = journal([JT.exec, { call: C, exec: x1 }], [JT.fenced, { exec: x1 }], ['hibernated', { call: C, exec: x1, qid: 'q', rev: 1 }], [JT.exec, { call: C, exec: x2 }]);
  assert.deepEqual(types(all(hibernated)), ['started']);
  // A settle after the fence does not make it planned.
  const late = journal([JT.exec, { call: C, exec: x1 }], [JT.fenced, { exec: x1 }], ['settled', { exec: x1 }], [JT.exec, { call: C, exec: x2 }]);
  assert.deepEqual(types(all(late)), ['started', 'fenced']);
  // once + cut off in a tool: sealed unknown, never resumed: sealed{unknown}, no fenced.
  const unknown = journal([JT.exec, { call: C, exec: x1 }], [JT.fenced, { exec: x1 }], [JT.sealed, { call: C, exec: x1, result: { key: 'a', gen: 1, status: 'unknown', ok: false, output: '', error: 'Unknown tool outcomes: bash' } }]);
  const events = all(unknown);
  assert.deepEqual(types(events), ['started', 'sealed']);
  assert.deepEqual(events[1], { id: `${W}:3:sealed`, ts: 1002, wid: W, type: 'sealed', key: 'a', gen: 1, call: C, status: 'unknown', error: 'Unknown tool outcomes: bash' });
});

test('R2 deriver: fenced reads only entries before the new exec (a later settle or seal does not change it)', () => {
  const x1 = `${C}#1.1`, x2 = `${C}#1.2`;
  const base = journal([JT.exec, { call: C, exec: x1 }], [JT.fenced, { exec: x1 }], [JT.exec, { call: C, exec: x2 }]);
  const later = [...base, ...journal(['settled', { exec: x1 }], [JT.sealed, { call: C, exec: x1, result: { status: 'ok' } }]).map((e, i) => ({ ...e, seq: 4 + i }))];
  assert.deepEqual(deriveEntry(W, base, 2, [], {}), deriveEntry(W, later, 2, [], {}));
  assert.equal(deriveEntry(W, base, 2, [], {})[0]!.type, 'fenced');
});

test('R2 deriver: asking carries the full question, qid, rev and answer address; answered carries sender, sha256 and UTF-16 length', () => {
  const question = `Which? ${'long '.repeat(200)}`;
  const item = { id: `q:${C}:Q1`, rev: 2, kind: 'question', text: question, wid: W, call: C, qid: 'Q1' };
  const answer = 'blue 🎨';
  const forwarded = journal([JT.attention, { item }], ['forward', { rid: 'A1', rid2: 'f1', dest: C, envelope: { to: C, kind: 'answer', body: { message: answer }, cond: { qid: 'Q1', rev: 2 } } }],
    [JT.attentionResolved, { id: item.id, rev: 2, resolution: 'answered' }]);
  const request = (from: string, by?: string): Entry => orchEntry(1, 'request', { request: { rid: 'A1', from, to: 'orch', sseq: 1, kind: 'send', cond: { qid: 'Q1', rev: 2 }, body: { to: C, kind: 'answer', message: answer, ...(by ? { by } : {}) } } });
  const events = all(forwarded, [request('main:S1')]);
  assert.deepEqual(events[0], { id: `${W}:1:asking`, ts: 1000, wid: W, type: 'asking', key: 'a', gen: 1, call: C, qid: 'Q1', rev: 2, question, to: `${W}/a` });
  const digest = createHash('sha256').update(answer, 'utf8').digest('hex');
  assert.deepEqual(events[1], { id: `${W}:3:answered`, ts: 1002, wid: W, type: 'answered', key: 'a', gen: 1, call: C, qid: 'Q1', rev: 2, by: 'session:S1', digest, length: answer.length });
  assert.equal(answer.length, 7, 'length counts UTF-16 units (the emoji is 2)');
  assert.deepEqual(answeredBy(request('main:S1', 'user').request as Request), { by: 'session:S1', via: 'ui' });
  assert.deepEqual(answeredBy(request('cli:me@host').request as Request), { by: 'cli:me@host' });
  assert.deepEqual(answeredBy(request('eval:x').request as Request), { by: 'unknown' });
  assert.deepEqual(answeredBy(undefined), { by: 'unknown' });
  // Hibernated asker: answer-bound names the request; its decorated message is not the answer text.
  const bound = journal([JT.attention, { item }], ['answer-bound', { call: C, qid: 'Q1', rev: 2, rid: 'A1', rid2: 'b1', message: 'note\nAnswer: x' }],
    [JT.attentionResolved, { id: item.id, rev: 2, resolution: 'answered' }]);
  const viaBound = all(bound, [request('cli:me@host')])[1] as { by: string; digest: string };
  assert.equal(viaBound.by, 'cli:me@host'); assert.equal(viaBound.digest, digest);
  // Other resolutions and other kinds of attention are no events.
  assert.deepEqual(all(journal([JT.attention, { item: { ...item, kind: 'stall' } }], [JT.attentionResolved, { id: item.id, rev: 2, resolution: 'activity' }])), []);
});

test('R2 deriver: sealed inlines small data and reports the size of large data; workflow-done; stable ids on re-derivation', () => {
  const small = { colour: 'blue' }, large = { blob: 'x'.repeat(EVENT_DATA_INLINE_MAX) };
  const entries = journal([JT.sealed, { call: C, result: { status: 'ok', ok: true, output: 'o', data: small } }],
    [JT.sealed, { call: `${W}@1/b@1`, result: { status: 'failed', ok: false, output: '', error: 'E'.repeat(5000), data: large } }],
    [JT.done, { status: 'failed', error: 'script failed' }]);
  const events = all(entries);
  assert.deepEqual((events[0] as { data: unknown }).data, small);
  assert.equal((events[1] as { data_omitted: number }).data_omitted, Buffer.byteLength(JSON.stringify(large)));
  assert.equal((events[1] as { data?: unknown }).data, undefined);
  assert.equal((events[1] as { error: string }).error.length, 5000, 'error unclipped');
  assert.deepEqual(events[2], { id: `${W}:3:workflow-done`, ts: 1002, wid: W, type: 'workflow-done', status: 'failed', error: 'script failed' });
  assert.deepEqual(all(entries), events, 'same entries, same events and ids');
});

test('R2 deriver: submitted from the ledger created entry, with request id, name and labels', () => {
  const orch = [orchEntry(1, 'create-intent', { rid: 'req:X', wid: W, name: 'nightly' }), orchEntry(2, JT.created, { rid: 'req:X', wid: W, origin: 'cli:x' }, 77)];
  assert.deepEqual(deriveCreated(orch, 1, { labels: { role: 'writer' } }), { id: `${W}:submitted`, ts: 77, type: 'submitted', wid: W, request: 'X', labels: { role: 'writer' }, name: 'nightly' });
  const plain = [orchEntry(1, JT.created, { rid: '01ULID', wid: W })];
  assert.deepEqual(deriveCreated(plain, 0, {}), { id: `${W}:submitted`, ts: 1, type: 'submitted', wid: W });
});

test('R6 deriver: empty labels are no labels (as describe and the R7 collector treat them)', () => {
  assert.equal(labelsOf({ labels: {} }), undefined);
  assert.deepEqual(labelsOf({ labels: { a: 'b' } }), { a: 'b' });
  assert.equal(labelsOf({ labels: { a: 1 } }), undefined);
});
