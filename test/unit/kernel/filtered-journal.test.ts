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

test('filtered folds equal full folds over 400 randomized journals, tails, growth, replacement and shrink', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-filtered-fold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal'), replacement = join(dir, 'replacement');
  for (let seed = 1; seed <= 400; seed++) {
    const pick = random(seed), rid = `wanted-${seed}${seed % 3 ? '' : '\u96ea'}${seed % 5 ? '' : '.+[\\]'}`, extraNeedle = `extra.+[\\]${seed}`;
    const needles = [JSON.stringify(rid), ...(seed % 2 ? [] : [JSON.stringify(extraNeedle)])];
    const entries: Entry[] = Array.from({ length: 10 + pick(40) }, (_, i) => ({
      seq: i + 1, ts: i, type: pick(3) ? 'unrelated' : 'wanted', rid: pick(4) ? `other-${i}` : rid,
      body: { text: pick(3) ? 'plain\u96ea' : rid, nested: pick(5) ? {} : { rid }, extra: pick(4) ? '' : extraNeedle },
    }));
    const apply = (state: Entry[], entry: Entry) => { if (entry.type === 'wanted' && entry.rid === rid) state.push(entry); };
    const full = (prior?: JournalFold<Entry[]>) => readJournalFold(path, prior, () => [], apply)!;
    const filtered = (prior?: JournalFold<Entry[]>) => readJournalFold(path, prior, () => [], apply, { needles })!;
    const check = (actual: JournalFold<Entry[]>, expected: JournalFold<Entry[]>, phase: string) => assert.deepEqual(actual, expected, `seed=${seed} phase=${phase}`);
    const base = framed(entries), next: Entry = { seq: entries.length + 1, ts: 99, type: 'wanted', rid };
    const tail = frameLine(JSON.stringify(next)), cut = 1 + pick(tail.length - 2);
    await writeFile(path, base + tail.slice(0, cut));
    let a = filtered(), b = full(); check(a, b, 'torn no newline');
    assert.equal(a.seen, entries.length);
    await appendFile(path, tail.slice(cut));
    a = filtered(a); b = full(b); check(a, b, 'growth completes tail');
    assert.equal(a.seen, next.seq);
    const extra: Entry = { seq: next.seq + 1, ts: 100, type: 'unrelated', body: rid };
    await appendFile(path, frameLine(JSON.stringify(extra)));
    a = filtered(a); b = full(b); check(a, b, 'growth with false positive');
    await writeFile(path, base + broken(tail));
    a = filtered(a); b = full(b); check(a, b, 'shrink with bad CRC final newline');
    assert.equal(a.length, Buffer.byteLength(base));
    const changed = entries.map(e => ({ ...e, ts: Number(e.ts) + 10 }));
    await writeFile(replacement, framed(changed)); await rename(replacement, path);
    a = filtered(a); b = full(b); check(a, b, 'replacement');
    await writeFile(path, framed(changed.slice(0, 2)));
    a = filtered(a); b = full(b); check(a, b, 'shrink');
    assert.equal(a.seen, 2);
    // CRC corruption is detected before filtering, including on a line that contains no needle.
    for (const candidate of [true, false]) {
      const bad: Entry = { seq: 2, ts: 1, type: 'wanted', rid: candidate ? rid : 'unrelated', body: '' };
      await writeFile(path, framed([entries[0]!]) + broken(frameLine(JSON.stringify(bad))) + framed([{ seq: 3, ts: 2, type: 'wanted', rid }]));
      assert.throws(() => filtered(), /Journal corruption at byte/);
      assert.throws(() => full(), /Journal corruption at byte/);
    }
  }
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
