import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameLine, readJournalFold } from '../../../src/kernel/journal.ts';
import { orchLedger } from '../../../src/paths.ts';
import { READER_ENTRY_TYPES, applyReaderLedger, emptyReaderLedger, readerLedger } from '../../../src/orchestrator/reader-ledger.ts';
import { LEDGER_ENTRY_TYPES, emptyLedger, foldLedger } from '../../../src/orchestrator/ledger.ts';
import { EXHAUSTION_ENTRY_TYPES } from '../../../src/orchestrator/providers.ts';
import { HOLD_ENTRY_TYPES, heldIn } from '../../../src/orchestrator/snapshot.ts';
import { FENCE_LEDGER_TYPES, fenceReason } from '../../../src/events/fence.ts';
import { descriptionNeedles } from '../../../src/cli/requests.ts';
import { JT, type Entry } from '../../../src/types.ts';
const lines = (entries: Entry[]) => entries.map(entry => frameLine(JSON.stringify(entry))).join('');

test('filtered reader projections equal full projections across every consumed entry type and appended polls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsa-reader-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const types = [...new Set([...READER_ENTRY_TYPES, ...LEDGER_ENTRY_TYPES, 'unrelated'])];
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

test('shared type lists cover reducer branches so a new type cannot silently bypass byte filtering', async () => {
  const cases = [
    ['../../../src/orchestrator/ledger.ts', 'export function applyLedger', '/** Fold the entries', LEDGER_ENTRY_TYPES],
    ['../../../src/orchestrator/providers.ts', 'export function foldExhaustion', undefined, EXHAUSTION_ENTRY_TYPES],
    ['../../../src/events/fence.ts', 'export function fenceReason', '/** The fence of', FENCE_LEDGER_TYPES],
    ['../../../src/orchestrator/snapshot.ts', 'export function holdOf', '/** Drain: whether', HOLD_ENTRY_TYPES],
    ['../../../src/orchestrator/reader-ledger.ts', 'export function applyReaderLedger', 'export function readerHold', READER_ENTRY_TYPES],
  ] as const;
  for (const [path, start, end, types] of cases) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const body = source.slice(source.indexOf(start), end ? source.indexOf(end, source.indexOf(start)) : undefined);
    const consumed = [...body.matchAll(/(?:\.type\s*===\s*|isEntry\(\w+,\s*)["']([^"']+)["']/g)].map(match => match[1]!);
    for (const match of body.matchAll(/\.type\s*===\s*JT\.(\w+)/g)) consumed.push(JT[match[1] as keyof typeof JT]);
    // applyReaderLedger also branches on hold to compact applyLedger's input; it is in the shared ledger list.
    const declared: readonly string[] = path.includes('reader-ledger') ? [...types, ...LEDGER_ENTRY_TYPES]
      : path.includes('fence.ts') ? [...types, JT.exec] : types;
    for (const type of consumed) assert.ok(declared.includes(type), `${path}: reducer type ${type} needs a shared filter type`);
  }
});

test('describe workflow ledger filtering equals full foldLedger, heldIn and fenceReason over randomized histories', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-describe-filter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const types = [...new Set([...LEDGER_ENTRY_TYPES, ...HOLD_ENTRY_TYPES, ...FENCE_LEDGER_TYPES, 'pruned', 'request', 'send-note', 'unrelated'])];
  const path = orchLedger(home);
  for (let seed = 1; seed <= 300; seed++) {
    let state = seed;
    const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const entries: Entry[] = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, ts: i * 10,
      // Include every type in each history, followed by randomized ordering and fields.
      type: types[i < types.length ? i : pick(types.length)]!, wid: `w${pick(4)}`, rid: `r${pick(4)}`,
      ...(pick(3) ? { origin: `main:s${pick(3)}` } : {}), exec: `e${pick(3)}`, pool: 'p', provider: 'p', slot: pick(2),
      model: 'p/model', until: pick(1000), root: `root${pick(3)}`, call: `call${pick(3)}`, pid: pick(3), force: !!pick(2),
      live: [`e${pick(3)}`], since: 1, nextTry: 9999, error: 'error', reason: 'reason', signal: 'SIGTERM',
      version: '1.0.43', recovery: true, ms: 5, hash: 'h', config: { providers: { p: { slots: 2 } } },
      request: { kind: 'run', rid: `r${pick(4)}`, body: { labels: { team: 'green' } } } }));
    // Exercise both global and scoped hold precedence, unrelated workflows' origins and creation ordering.
    for (const entry of entries) if ((entry.type === 'drain' || entry.type === 'undrain') && pick(3) === 0) { delete entry.wid; delete entry.origin; }
    await writeFile(path, lines(entries));
    const filtered = readJournalFold(path, undefined, () => [] as Entry[], (out, entry) => { out.push(entry); }, { needles: [...descriptionNeedles, JSON.stringify('w0')] })!.state;
    const project = (ledger: Entry[]) => {
      const { seen: _seen, last: _last, ...domain } = foldLedger(emptyLedger(), ledger);
      const held = heldIn(ledger);
      const fences = ['e0', 'e1', 'e2'].flatMap(exec => [200, 600, 1200].map(ts => {
        const journal: Entry[] = [{ seq: 1, ts: 0, type: JT.exec, exec }];
        return fenceReason(journal, ledger, { seq: 2, ts, type: JT.fenced, exec });
      }));
      return { domain, held: ['w0', 'w1', 'w2', 'w3', 'absent'].map(wid => held(wid)), fences };
    };
    // Bookkeeping seen/last measures candidate count, not domain state, and is intentionally excluded.
    assert.deepEqual(project(filtered), project(entries), `describe ledger seed ${seed}`);
  }
});
