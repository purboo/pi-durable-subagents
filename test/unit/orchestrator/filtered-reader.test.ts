import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameLine } from '../../../src/kernel/journal.ts';
import { orchLedger } from '../../../src/paths.ts';
import { applyReaderLedger, emptyReaderLedger, readerLedger } from '../../../src/orchestrator/reader-ledger.ts';
import type { Entry } from '../../../src/types.ts';
const lines = (entries: Entry[]) => entries.map(entry => frameLine(JSON.stringify(entry))).join('');

test('filtered reader projections equal full projections across every consumed entry type and appended polls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-reader-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const types = ['created', 'create-intent', 'revise-intent', 'request', 'pruned', 'drain', 'undrain', 'applied', 'rejected',
    'send-note', 'hold', 'release', 'config', 'config-rejected', 'restart', 'orchestrator', 'orchestrator-exit', 'recovered',
    'provider-exhausted', 'provider-available', 'provider-probe', 'switch-observed', 'skip', 'writer-hold', 'writer-release', 'unrelated'];
  for (let seed = 1; seed <= 300; seed++) {
    let state = seed;
    const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const home = join(root, String(seed)); await mkdir(home);
    const entries: Entry[] = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, ts: i, type: types[pick(types.length)]!,
      wid: `w${pick(3)}`, rid: `r${pick(3)}`, origin: 'main:s', revision: pick(3), pool: 'p', provider: 'p', slot: 0, exec: `e${pick(3)}`,
      pid: pick(2), reason: pick(2) ? 'domain' : 'identity-conflict', version: '1.0.42', hash: 'h', config: { providers: { p: { slots: 2 } } },
      error: 'error', since: 1, nextTry: 2, force: true, request: { rid: `r${pick(3)}`, kind: pick(2) ? 'run' : 'send', body: { labels: { team: 'blue' }, session: 's' } } }));
    const full = () => { const ix = emptyReaderLedger(); for (const entry of entries) applyReaderLedger(ix, entry); return ix; };
    await writeFile(orchLedger(home), lines(entries.slice(0, 50)));
    const first = emptyReaderLedger(); for (const entry of entries.slice(0, 50)) applyReaderLedger(first, entry);
    assert.deepEqual(readerLedger(home).state, first, `initial seed ${seed}`);
    await appendFile(orchLedger(home), lines(entries.slice(50)));
    const read = readerLedger(home);
    assert.equal(read.seen, entries.length); assert.deepEqual(read.state, full(), `growth seed ${seed}`);
    const replacement = join(home, 'replacement'); await writeFile(replacement, lines(entries.slice(0, 5))); await rename(replacement, orchLedger(home));
    const replaced = emptyReaderLedger(); for (const entry of entries.slice(0, 5)) applyReaderLedger(replaced, entry);
    assert.deepEqual(readerLedger(home).state, replaced, `replacement seed ${seed}`);
  }
});
