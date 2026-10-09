// The event log file (append, reopen with the start skip, torn tail, corruption kept aside, compaction) and the pump
// (backfill, watermark resume, retention keeps unfinished workflows, prune).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../src/kernel/journal.ts';
import { eventsLog, journalPath, orchLedger } from '../../../src/paths.ts';
import { EventLog, readHead, readPage } from '../../../src/events/log.ts';
import { EventPump } from '../../../src/events/pump.ts';
import { EVENT_SEQ_SKIP, type EventDraft } from '../../../src/events/types.ts';
import { JT, type Entry, type JournalHandle } from '../../../src/types.ts';

async function home(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-events-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const draft = (n: number, wid = 'W'): EventDraft => ({ id: `${wid}:${n}:sealed`, ts: n, type: 'sealed', wid, status: 'ok' });
const seqs = (path: string, since = 0) => readPage(path, since, 1000)!.events.map(e => Number(e.cursor.split(':')[1]));

test('event log: append is durable and ordered; every open skips EVENT_SEQ_SKIP ahead; the epoch stays', async t => {
  const path = eventsLog(await home(t));
  const first = await EventLog.open(path);
  assert.equal(first.created, true); assert.match(first.log.epoch, /^[0-9a-f]{16}$/);
  const appended = await first.log.append([draft(1), draft(2)], new Map([['orch', 3]]));
  assert.deepEqual(appended.map(e => e.cursor), [`${first.log.epoch}:1`, `${first.log.epoch}:2`]);
  assert.deepEqual(Object.keys(appended[0]!).slice(0, 2), ['id', 'cursor']);
  await first.log.close();
  assert.deepEqual(readHead(path), { epoch: first.log.epoch, dropped: 0, head: 2 });
  const second = await EventLog.open(path);
  assert.equal(second.created, false); assert.equal(second.log.epoch, first.log.epoch);
  assert.deepEqual([...second.marks], [['orch', 3]]);
  assert.equal(second.log.head, 2 + EVENT_SEQ_SKIP, 'the start skip is durable before any event');
  assert.equal(readHead(path)!.head, 2 + EVENT_SEQ_SKIP, 'the head names a seq no event has');
  const [next] = await second.log.append([draft(3)]);
  assert.equal(next!.cursor, `${first.log.epoch}:${2 + EVENT_SEQ_SKIP + 1}`);
  await second.log.close();
  assert.deepEqual(seqs(path), [1, 2, 1003]);
  assert.deepEqual(seqs(path, 2), [1003]);
  // More than EVENT_SEQ_SKIP drafts are written in several fsynced batches; seqs stay dense within the start.
  const third = await EventLog.open(path);
  const many = await third.log.append(Array.from({ length: EVENT_SEQ_SKIP + 5 }, (_, i) => draft(10 + i)));
  assert.equal(many.length, EVENT_SEQ_SKIP + 5);
  assert.equal(Number(many.at(-1)!.cursor.split(':')[1]) - Number(many[0]!.cursor.split(':')[1]), EVENT_SEQ_SKIP + 4);
  await third.log.close();
});

test('event log: a torn final line is ignored by readers and cut by the next open; corruption before the end is kept aside', async t => {
  const dir = await home(t), path = eventsLog(dir);
  const { log } = await EventLog.open(path);
  await log.append([draft(1), draft(2)]); await log.close();
  await appendFile(path, '0000abcd {"k":"ev","seq":3');
  assert.deepEqual(seqs(path), [1, 2], 'a reader ignores the torn tail');
  assert.equal(readHead(path)!.head, 2);
  const reopened = await EventLog.open(path);
  assert.equal(reopened.created, false);
  await reopened.log.append([draft(3)]); await reopened.log.close();
  assert.deepEqual(seqs(path), [1, 2, 1003]);
  // Damage a middle line: the next open renames the file aside and starts a new epoch (no silent truncation).
  const text = await readFile(path, 'utf8'), lines = text.split('\n');
  lines[1] = lines[1]!.replace('"ok"', '"OK"');
  await writeFile(path, lines.join('\n'));
  assert.throws(() => readPage(path, 0, 10), /corrupt/);
  const fresh = await EventLog.open(path);
  assert.equal(fresh.created, true); assert.notEqual(fresh.log.epoch, log.epoch); assert.match(fresh.corrupt!, /kept as/);
  await fresh.log.close();
  assert.ok((await readdir(dir)).some(name => name.startsWith('events.jsonl.corrupt-')));
  assert.deepEqual(seqs(path), []);
});

test('event log: compaction drops only selected events, keeps marks and head, and dropped is monotone', async t => {
  const path = eventsLog(await home(t));
  const { log } = await EventLog.open(path);
  await log.append([draft(1, 'A'), draft(2, 'B'), draft(3, 'A'), draft(4, 'B')], new Map([['A', 9], ['B', 7]]));
  assert.equal(await log.compact(r => r.e.wid === 'A', new Map([['A', 9], ['B', 7]])), 2);
  assert.equal(log.dropped, 3);
  assert.deepEqual(readHead(path), { epoch: log.epoch, dropped: 3, head: 4 });
  assert.deepEqual(seqs(path), [2, 4], 'B kept, also its event below dropped');
  assert.equal(await log.compact(r => r.seq === 2, new Map([['A', 9], ['B', 7]])), 1);
  assert.equal(log.dropped, 3, 'dropped never decreases');
  assert.equal(await log.compact(() => false, new Map()), 0, 'nothing to drop: no rewrite');
  await log.append([draft(5, 'B')]); await log.close();
  const again = await EventLog.open(path);
  assert.deepEqual([...again.marks].sort(), [['A', 9], ['B', 7]]);
  assert.equal(again.log.dropped, 3); assert.equal(again.log.head, 5 + EVENT_SEQ_SKIP);
  await again.log.close();
});

test('event log: a large log pages from any cursor (byte-offset search) exactly like a full scan', async t => {
  const path = eventsLog(await home(t));
  let { log } = await EventLog.open(path);
  const pad = 'p'.repeat(200);
  // Several starts (skips and head records) and marks interleaved: ~2000 events, about 600 KiB.
  for (let start = 0; start < 4; start++) {
    for (let i = 0; i < 5; i++) await log.append(Array.from({ length: 100 }, (_, k) => ({ ...draft(start * 1000 + i * 100 + k), error: pad })), new Map([['orch', start * 10 + i]]));
    await log.close();
    ({ log } = await EventLog.open(path));
  }
  await log.close();
  const all = readPage(path, 0, 5000)!.events.map(e => Number(e.cursor.split(':')[1]));
  assert.equal(all.length, 2000);
  assert.ok((await readFile(path)).length > 512 * 1024);
  for (const since of [0, 1, 99, 500, 1499, 1500, 1501, all[1234]!, all[1999]! - 1, all[1999]!, 4500]) {
    const page = readPage(path, since, 7)!;
    const expected = all.filter(s => s > since).slice(0, 7);
    assert.deepEqual(page.events.map(e => Number(e.cursor.split(':')[1])), expected, `since ${since}`);
    assert.equal(page.more, all.filter(s => s > since).length > 7, `more since ${since}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Pump over real journals.
// ---------------------------------------------------------------------------------------------------------------------
async function sources(t: TestContext) {
  const dir = await home(t), orch = await openJournal(orchLedger(dir));
  const workflows = new Map<string, { journal: JournalHandle }>();
  const store: { workflows: Map<string, { journal: JournalHandle }>; appended?: (wid: string) => void } = { workflows };
  const add = async (wid: string, rid = `req:${wid}`, labels?: Record<string, string>) => {
    await orch.append('request', { request: { rid, from: 'cli:t@h', to: 'orch', sseq: 1, kind: 'run', body: { cwd: dir, call: { agent: 'a', task: 't' }, ...(labels ? { labels } : {}) } } });
    const journal = await openJournal(journalPath(dir, wid));
    journal.onAppend = () => store.appended?.(wid);
    workflows.set(wid, { journal });
    await journal.append('wf-created', { rid });
    await orch.append(JT.created, { rid, wid });
    return journal;
  };
  t.after(async () => { await orch.close(); for (const w of workflows.values()) await w.journal.close(); });
  let retention = 7 * 86_400_000;
  const pump = () => new EventPump({ home: dir, orch, store, delayMs: 5, retentionMs: () => retention });
  return { dir, orch, store, add, pump, path: eventsLog(dir), setRetention: (ms: number) => { retention = ms; } };
}
const C = (wid: string, key = 'a', gen = 1) => `${wid}@1/${key}@${gen}`;
const read = (path: string, since = 0) => readPage(path, since, 1000)!.events;
async function until(fn: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } }

test('event pump: a new log backfills everything on disk; appends are derived promptly; labels and request echo', async t => {
  const s = await sources(t);
  const a = await s.add('A', 'req:ra', { node: 'n1' });
  await a.append(JT.exec, { call: C('A'), exec: `${C('A')}#1.1` });
  const p = s.pump();
  await p.open();
  assert.equal(p.backfilled, true);
  assert.deepEqual(read(s.path).map(e => [e.type, e.wid, e.request, e.labels]), [['submitted', 'A', 'ra', { node: 'n1' }], ['started', 'A', 'ra', { node: 'n1' }]]);
  await a.append(JT.sealed, { call: C('A'), result: { key: 'a', gen: 1, status: 'ok', ok: true, output: 'x' } });
  await until(() => read(s.path).some(e => e.type === 'sealed'));
  const b = await s.add('B', '01PLAINULID');
  await b.append(JT.done, { status: 'done' });
  await until(() => read(s.path).some(e => e.wid === 'B' && e.type === 'workflow-done'));
  const events = read(s.path);
  assert.deepEqual(events.filter(e => e.wid === 'B').map(e => [e.type, e.request, e.labels]), [['submitted', undefined, undefined], ['workflow-done', undefined, undefined]]);
  // Waiting/moving drafts go through the same sink; labels and request are echoed when the draft has none.
  await p.emit([{ id: 'A:w1', ts: 5, type: 'waiting', wid: 'A', key: 'a', gen: 1, call: C('A'), reason: 'slot', detail: 'probe 1/1', since: 5 }]);
  assert.deepEqual(read(s.path).at(-1)!.labels, { node: 'n1' });
  await p.close();
  assert.equal(new Set(read(s.path).map(e => e.id)).size, read(s.path).length, 'no duplicates');
});

test('event pump: a restart resumes after the watermarks (nothing derived twice), and derives what came while it was down', async t => {
  const s = await sources(t);
  const a = await s.add('A');
  await a.append(JT.exec, { call: C('A'), exec: `${C('A')}#1.1` });
  const first = s.pump(); await first.open(); await first.close();
  const before = read(s.path);
  // Appended while no orchestrator derives (an old version, or the window before open).
  await a.append(JT.sealed, { call: C('A'), result: { status: 'ok' } });
  const second = s.pump(); await second.open();
  assert.equal(second.backfilled, false);
  const after = read(s.path);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map(e => e.type), ['sealed']);
  assert.equal(Number(after.at(-1)!.cursor.split(':')[1]), Number(before.at(-1)!.cursor.split(':')[1]) + EVENT_SEQ_SKIP + 1);
  await second.close();
});

test('event pump: a crash after events but before their watermark re-derives them with the same ids (at least once, no gap)', async t => {
  const s = await sources(t);
  const a = await s.add('A');
  const p = s.pump(); await p.open();
  t.after(() => p.close()); // the "crashed" writer's handle (its late writes go to the replaced file)
  await a.append(JT.exec, { call: C('A'), exec: `${C('A')}#1.1` });
  await p.flush();
  // Simulate a lost watermark: drop the trailing mark record of the last write (the events stay).
  const lines = (await readFile(s.path, 'utf8')).split('\n').filter(Boolean);
  assert.match(lines.at(-1)!, /"k":"mark"/);
  await writeFile(s.path, lines.slice(0, -1).join('\n') + '\n');
  const again = s.pump(); await again.open(); await again.close();
  const started = read(s.path).filter(e => e.type === 'started');
  assert.equal(started.length, 2); assert.equal(started[0]!.id, started[1]!.id);
});

test('event pump: retention drops old events of quiet or pruned workflows only; unsealed, asking and parked ones stay', async t => {
  const s = await sources(t);
  const done = await s.add('DONE'), asking = await s.add('ASK'), running = await s.add('RUN'), parked = await s.add('PARK'), gone = await s.add('GONE');
  await done.append('call', { pos: 0, key: 'a', gen: 1 });
  await done.append(JT.sealed, { call: C('DONE'), result: { status: 'ok' } });
  await done.append(JT.done, { status: 'done' });
  await asking.append(JT.attention, { item: { id: `q:${C('ASK')}:Q`, rev: 1, kind: 'question', text: '?', wid: 'ASK', call: C('ASK'), qid: 'Q' } });
  await asking.append(JT.done, { status: 'done' });
  await running.append('call', { pos: 0, key: 'a', gen: 1 });
  await running.append(JT.exec, { call: C('RUN'), exec: `${C('RUN')}#1.1` });
  await running.append(JT.done, { status: 'done' });
  await parked.append(JT.done, { status: 'parked' });
  await gone.append(JT.done, { status: 'done' });
  const first = s.pump(); await first.open(); await first.close();
  const all = read(s.path);
  // GONE is pruned: its journal leaves the store and the ledger records it.
  await s.orch.append('pruned', { rid: 'p', wid: 'GONE' });
  await s.store.workflows.get('GONE')!.journal.close(); s.store.workflows.delete('GONE');
  s.setRetention(1);
  await new Promise(r => setTimeout(r, 5));
  const second = s.pump(); await second.open(); await second.close();
  const kept = read(s.path), head = readHead(s.path)!;
  assert.deepEqual([...new Set(kept.map(e => e.wid))].sort(), ['ASK', 'PARK', 'RUN']);
  const droppedSeqs = all.filter(e => e.wid === 'DONE' || e.wid === 'GONE').map(e => Number(e.cursor.split(':')[1]));
  assert.equal(head.dropped, Math.max(...droppedSeqs));
  // The watermarks survived the compaction: a third start derives nothing again.
  const third = s.pump(); await third.open(); await third.close();
  assert.deepEqual(read(s.path).map(e => e.id), kept.map(e => e.id));
  assert.equal(readHead(s.path)!.dropped, head.dropped, 'dropped is monotone across starts');
});

test('event pump: flush derives a workflow before it is pruned; a pruned workflow is forgotten', async t => {
  const s = await sources(t);
  const a = await s.add('A');
  const p = s.pump(); await p.open();
  await a.append(JT.done, { status: 'done' });
  await p.flush();
  assert.ok(read(s.path).some(e => e.type === 'workflow-done'));
  await s.orch.append('pruned', { rid: 'p', wid: 'A' });
  await a.close(); s.store.workflows.delete('A');
  await p.close();
  const again = await EventLog.open(s.path);
  assert.ok(again.marks.has('A'), 'its mark stays in the file until compaction');
  await again.log.close();
  const q = s.pump(); await q.open(); await q.close();
  assert.equal(read(s.path).filter(e => e.wid === 'A' && e.type === 'submitted').length, 1, 'not derived again');
});

// ---------------------------------------------------------------------------------------------------------------------
// Failure paths.
// ---------------------------------------------------------------------------------------------------------------------
test('event log: failed writes never spend more than EVENT_SEQ_SKIP seqs past the durable head (no seq reuse after reopen)', async t => {
  const dir = await home(t);
  /** Partial writes then ENOSPC (the complete lines are visible to a reader until the writer cuts them); `only` picks
   *  the writes that fail. Returns the highest seq a reader saw. */
  const failing = (path: string, log: EventLog, only: (text: string) => boolean) => {
    const file = (log as unknown as { file: { write: (text: string) => Promise<unknown> } }).file, write = file.write.bind(file);
    const state = { seen: 0, fail: true };
    file.write = async (text: string) => {
      if (!state.fail || !only(text)) return write(text);
      await write(text.slice(0, Math.floor(text.length / 2)));
      state.seen = Math.max(state.seen, ...seqs(path));
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    };
    return state;
  };
  for (const [name, only] of [['every write fails', () => true], ['only event writes fail', (text: string) => text.includes('"k":"ev"')]] as const) {
    const path = join(dir, `${name.replaceAll(' ', '-')}.jsonl`);
    const { log } = await EventLog.open(path);
    await log.append([draft(0)]);
    const state = failing(path, log, only);
    for (let r = 0; r < 3; r++) await assert.rejects(log.append(Array.from({ length: 600 }, (_, i) => draft(i))), /ENOSPC/);
    assert.ok(state.seen > 0, name);
    if (name === 'only event writes fail') {
      // A later write first makes the spent seqs durable (a lone head record), then writes its events after them.
      state.fail = false;
      const [late] = await log.append([draft(7)]);
      assert.ok(Number(late!.cursor.split(':')[1]) > state.seen, name);
      state.fail = true;
      await assert.rejects(log.append(Array.from({ length: 600 }, (_, i) => draft(i))), /ENOSPC/);
    }
    state.fail = false;
    await log.close();
    const again = await EventLog.open(path);
    const [next] = await again.log.append([draft(9)]);
    assert.ok(Number(next!.cursor.split(':')[1]) > state.seen, `${name}: seq ${next!.cursor} reused, a reader at seq ${state.seen} would skip it`);
    await again.log.close();
  }
});

test('event log: a compaction that fails after its rename leaves the log broken (appends throw); open removes stale temp files', async t => {
  const dir = await home(t), path = eventsLog(dir);
  await writeFile(`${path}.0badc0de.tmp`, 'stale');
  const { log } = await EventLog.open(path);
  assert.ok(!(await readdir(dir)).some(n => n.endsWith('.tmp')), 'stale temp file removed');
  await log.append([draft(1, 'A'), draft(2, 'B')]);
  const file = (log as unknown as { file: { close: () => Promise<void> } }).file, close = file.close.bind(file);
  file.close = async () => { throw new Error('EIO on close'); };
  await assert.rejects(log.compact(r => r.e.wid === 'A', new Map()), /EIO/);
  assert.equal(log.broken, true);
  // The old handle names the replaced inode: writing there would lose the events.
  await assert.rejects(log.append([draft(3, 'B')]), /EIO/);
  await close();
  assert.deepEqual(seqs(path), [2]);
});

test('event pump: flush rejects when the pass could not log what it derived; the retry logs it', async t => {
  const s = await sources(t);
  const a = await s.add('A');
  const p = s.pump(); await p.open();
  t.after(() => p.close());
  const original = EventLog.prototype.append;
  EventLog.prototype.append = function () { return Promise.reject(new Error('ENOSPC')); };
  try {
    await a.append(JT.done, { status: 'done' });
    await assert.rejects(p.flush(), /ENOSPC/);
  } finally { EventLog.prototype.append = original; }
  await p.flush();
  assert.ok(read(s.path).some(e => e.type === 'workflow-done'));
});

test('event pump: after a compaction broke the log, the next pass reopens it and logs to the live file', async t => {
  const s = await sources(t);
  const a = await s.add('A'), b = await s.add('B');
  await a.append(JT.done, { status: 'done' });
  const p = s.pump(); await p.open();
  t.after(() => p.close());
  const log = (p as unknown as { log: EventLog }).log, file = (log as unknown as { file: { close: () => Promise<void> } }).file;
  file.close = async () => { throw new Error('EIO on close'); };
  s.setRetention(1); await new Promise(r => setTimeout(r, 5));
  await (p as unknown as { compact: () => Promise<void> }).compact();
  await b.append(JT.done, { status: 'done' });
  await p.flush();
  assert.ok(read(s.path).some(e => e.wid === 'B' && e.type === 'workflow-done'), 'logged to the file readers see');
  assert.ok(Number(read(s.path).at(-1)!.cursor.split(':')[1]) > EVENT_SEQ_SKIP, 'the reopen applied the start skip');
});

test('event pump: a pass appends in chunks of at most EVENT_SEQ_SKIP with partial watermarks; a failed chunk is re-derived', async t => {
  const s = await sources(t);
  // A large backfill: one workflow whose journal derives more than two chunks of events (a plain array journal).
  const entries: Entry[] = [{ seq: 1, ts: 1, type: 'wf-created' } as Entry];
  const n = EVENT_SEQ_SKIP * 2 + 10;
  for (let i = 0; i < n; i++) entries.push({ seq: entries.length + 1, ts: 2, type: JT.exec, call: C('BIG', `k${i}`), exec: `${C('BIG', `k${i}`)}#1.1` } as Entry);
  await s.orch.append('request', { request: { rid: 'req:big', from: 'cli:t@h', to: 'orch', sseq: 1, kind: 'run', body: { cwd: s.dir } } });
  await s.orch.append(JT.created, { rid: 'req:big', wid: 'BIG' });
  s.store.workflows.set('BIG', { journal: { path: '', entries: () => entries, committed: () => entries, close: async () => {} } as unknown as JournalHandle });
  const original = EventLog.prototype.append, sizes: number[] = [];
  let calls = 0;
  EventLog.prototype.append = function (drafts, marks) {
    sizes.push(drafts.length);
    if (++calls === 2) return Promise.reject(new Error('ENOSPC'));
    return original.call(this, drafts, marks);
  };
  const p = s.pump();
  try { await p.open(); await p.flush(); } finally { EventLog.prototype.append = original; }
  await p.close();
  assert.ok(sizes.every(size => size <= EVENT_SEQ_SKIP), `chunks ${sizes.join(',')}`);
  const all: string[] = [];
  for (let since = 0, page = readPage(s.path, 0, 1000)!; ; page = readPage(s.path, since, 1000)!) {
    all.push(...page.events.filter(e => e.type === 'started').map(e => e.id));
    if (!page.more) break;
    since = Number(page.events.at(-1)!.cursor.split(':')[1]);
  }
  assert.equal(new Set(all).size, n, 'every event logged (at least once) after the failed chunk');
  assert.equal(all.length, n, 'the chunk logged before the failure is not derived again (its partial watermark)');
  const q = s.pump(); await q.open(); await q.close();
  let again = 0;
  for (let since = 0, page = readPage(s.path, 0, 1000)!; ; page = readPage(s.path, since, 1000)!) {
    again += page.events.filter(e => e.type === 'started').length;
    if (!page.more) break;
    since = Number(page.events.at(-1)!.cursor.split(':')[1]);
  }
  assert.equal(again, all.length, 'the watermarks cover everything: a restart derives nothing again');
});
