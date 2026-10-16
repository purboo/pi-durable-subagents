import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frameLine, readJournalFold, findJournalEntry, type JournalFold } from '../../../src/kernel/journal.ts';
import type { Entry } from '../../../src/types.ts';
const framed = (entries: Entry[]) => entries.map(e => frameLine(JSON.stringify(e))).join('');
function random(seed: number): (n: number) => number { return n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }; }
const broken = (line: string) => (line[0] === '0' ? '1' : '0') + line.slice(1);

test('filtered folds equal full folds over 400 randomized multi-chunk journals and appended polls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-filtered-fold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal'), replacement = join(dir, 'replacement');
  const ids = ['a', 'b.c', 'x+y', '\u00e9\u96ea', 'q|z', 'req:k:[1]'];
  const sizes = [0, 10, 1000, 30000, 65000, 65536 - 40, 70000];
  const counts = new Set<number>(); let splitUtf8 = false;
  for (let seed = 1; seed <= 400; seed++) {
    const pick = random(seed), wanted = ids.slice(0, 1 + seed % 6), needles = wanted.map(id => JSON.stringify(id));
    counts.add(needles.length);
    // Every history spans several chunks; needles occur both before and after long padding in different records.
    const entries: Entry[] = Array.from({ length: 12 + pick(16) }, (_, i) => {
      const id = ids[pick(ids.length)]!, pad = 'p'.repeat((sizes[i % sizes.length] ?? 0) + pick(50));
      return { seq: i + 1, ts: i, type: pick(3) ? 'unrelated' : 'wanted',
        ...(i % 2 ? { pad, rid: id } : { rid: id, pad }), body: { falsePositive: ids[pick(ids.length)], text: '\u96ea' } };
    });
    type State = [number, number][];
    const apply = (state: State, entry: Entry, offset: number) => {
      if (entry.type === 'wanted' && wanted.includes(String(entry.rid))) state.push([entry.seq, offset]);
    };
    const full = (prior?: JournalFold<State>) => readJournalFold(path, prior, () => [], apply)!;
    const filtered = (prior?: JournalFold<State>) => readJournalFold(path, prior, () => [], apply, { needles })!;
    const check = (actual: JournalFold<State>, expected: JournalFold<State>, phase: string) => assert.deepEqual(actual, expected, `seed=${seed} phase=${phase}`);
    const base = Buffer.from(framed(entries)); assert.ok(base.length > 64 * 1024);
    const next: Entry = { seq: entries.length + 1, ts: 99, type: 'wanted', pad: 't'.repeat(70000), rid: wanted[0] };
    const tail = Buffer.from(frameLine(JSON.stringify(next))), cut = 1 + pick(tail.length - 2), bytes = Buffer.concat([base, tail.subarray(0, cut)]);
    // Split arbitrary bytes, occasionally inside a multibyte string, rather than only between framed lines.
    const utf8 = bytes.indexOf(Buffer.from('\u96ea'));
    const split = seed % 5 ? 1 + pick(base.length - 1) : utf8 + 1;
    if (seed % 5 === 0) splitUtf8 = true;
    await writeFile(path, bytes.subarray(0, split));
    let a = filtered(), b = full(); check(a, b, 'partial initial poll');
    await appendFile(path, bytes.subarray(split));
    a = filtered(a); b = full(b); check(a, b, 'growth with partial long tail');
    assert.equal(a.seen, entries.length);
    await appendFile(path, tail.subarray(cut));
    a = filtered(a); b = full(b); check(a, b, 'growth completes long tail');
    assert.equal(a.seen, next.seq);
    const extra: Entry = { seq: next.seq + 1, ts: 100, type: 'unrelated', body: wanted[0] };
    await appendFile(path, frameLine(JSON.stringify(extra)));
    a = filtered(a); b = full(b); check(a, b, 'growth with false positive');
    await writeFile(path, Buffer.concat([base, Buffer.from(broken(tail.toString()))]));
    a = filtered(a); b = full(b); check(a, b, 'bad CRC final newline');
    assert.equal(a.length, base.length);
    const changed = entries.map(e => ({ ...e, ts: Number(e.ts) + 10 }));
    await writeFile(replacement, framed(changed)); await rename(replacement, path);
    a = filtered(a); b = full(b); check(a, b, 'replacement');
    await writeFile(path, framed(changed.slice(0, 2)));
    a = filtered(a); b = full(b); check(a, b, 'shrink'); assert.equal(a.seen, 2);
    for (const candidate of [true, false]) {
      const bad: Entry = { seq: 2, ts: 1, type: 'wanted', pad: 'b'.repeat(70000), rid: candidate ? wanted[0] : 'no-needle' };
      await writeFile(path, framed([entries[0]!]) + broken(frameLine(JSON.stringify(bad))) + framed([{ seq: 3, ts: 2, type: 'wanted', rid: wanted[0] }]));
      assert.throws(() => filtered(), /Journal corruption at byte/);
      assert.throws(() => full(), /Journal corruption at byte/);
    }
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3, 4, 5, 6]); assert.ok(splitUtf8);
});

test('filtering skips parsing/apply only, counts every framed line, and preserves first-match semantics', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-filtered-cost-')), path = join(dir, 'journal');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries: Entry[] = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, ts: i, type: 'irrelevant', body: 'x'.repeat(200) }));
  entries[500] = { seq: 501, ts: 500, type: 'irrelevant', body: 'target' }; // A false positive still must not match.
  entries[1000] = { seq: 1001, ts: 1000, type: 'wanted', rid: 'target', value: 'first' };
  entries[1500] = { seq: 1501, ts: 1500, type: 'wanted', rid: 'target', value: 'second' };
  await writeFile(path, framed(entries));
  const parse = JSON.parse; let parsed = 0;
  JSON.parse = function (...args: Parameters<typeof JSON.parse>) { parsed++; return parse(...args); };
  try {
    const record = readJournalFold(path, undefined, () => [] as Entry[], (state, entry) => { state.push(entry); }, { needles: [JSON.stringify('target')] })!;
    assert.equal(record.seen, entries.length); assert.equal(record.state.length, 3); assert.equal(parsed, 3);
    parsed = 0;
    assert.equal(findJournalEntry(path, e => e.type === 'wanted' && e.rid === 'target', { needles: [JSON.stringify('target')] })?.value, 'first');
    assert.equal(parsed, 3);
    parsed = 0;
    const noMatch = readJournalFold(path, undefined, () => 0, () => { throw new Error('must not apply'); }, { needles: [] })!;
    assert.equal(parsed, 0); assert.equal(noMatch.seen, entries.length);
  } finally { JSON.parse = parse; }
  // A matching record and an unrelated record can each span several bounded read chunks.
  const large: Entry[] = [{ seq: 1, ts: 1, type: 'irrelevant', body: 'x'.repeat(140_000) },
    { seq: 2, ts: 2, type: 'wanted', body: 'y'.repeat(140_000), rid: 'target' }];
  const bytes = framed(large), offsets: number[] = []; await writeFile(path, bytes);
  const record = readJournalFold(path, undefined, () => [] as Entry[], (state, entry, offset) => { state.push(entry); offsets.push(offset); }, { needles: [JSON.stringify('target'), '"type":"not-present"'] })!;
  assert.deepEqual(record.state, [large[1]]); assert.equal(record.seen, 2); assert.equal(record.length, Buffer.byteLength(bytes));
  assert.deepEqual(offsets, [Buffer.byteLength(framed([large[0]!]))]);
});

test('type needles do not match escaped JSON inside strings; skipped lines retain framing but not JSON validation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-filtered-envelope-')), path = join(dir, 'journal');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { needles: ['"type":"wanted"'] };
  const fold = () => readJournalFold(path, undefined, () => [] as Entry[], (state, entry) => { state.push(entry); }, options)!;
  await writeFile(path, framed([{ seq: 1, ts: 1, type: 'other', body: 'embedded "type":"wanted"' }, { seq: 2, ts: 2, type: 'wanted' }]));
  assert.deepEqual(fold().state.map(e => e.seq), [2]);
  assert.equal(readJournalFold(path, undefined, () => [] as Entry[], (state, entry) => { state.push(entry); }, { needles: ['\n'] })!.state.length, 0);
  assert.equal(readJournalFold(path, undefined, () => [] as Entry[], (state, entry) => { state.push(entry); }, { needles: ['', 'never matches'] })!.state.length, 2);
  // Without JSON.parse, the skipped line's JSON syntax/seq cannot be validated. Its frame still counts toward seq.
  await writeFile(path, frameLine('not JSON') + framed([{ seq: 2, ts: 2, type: 'wanted' }]));
  assert.equal(fold().seen, 2);
  assert.throws(() => readJournalFold(path, undefined, () => [], () => {}), /corruption/);
  await writeFile(path, framed([{ seq: 8, ts: 1, type: 'wanted' }, { seq: 2, ts: 2, type: 'other' }]));
  assert.throws(fold, /corruption/);
  // An empty JSON payload is an invalid frame even when no needle matches.
  await writeFile(path, frameLine('') + framed([{ seq: 2, ts: 2, type: 'wanted' }]));
  assert.throws(fold, /corruption/);
});
