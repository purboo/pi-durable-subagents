import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, appendFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { frameLine, hasJournalSnapshot, openJournal } from '../../../src/kernel/journal.ts';
import { findRequest } from '../../../src/requests.ts';
import { orchLedger, orchLock, outboxRoot } from '../../../src/paths.ts';
import { OsLock } from '../../../src/platform/lock.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';
import type { Request } from '../../../src/types.ts';

const request = (rid: string): Request => ({ rid, from: 'other', to: 'orch', sseq: 1, kind: 'send', body: { to: 'absent/key', kind: 'steer', message: rid } });
const line = (seq: number, type: string, fields: object = {}) => frameLine(JSON.stringify({ seq, ts: seq, type, ...fields }));
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-request-filter-')), dir = join(outboxRoot(home), 'outbox');
  await mkdir(dir, { recursive: true });
  const unrelated = { probeUnrelated: true, payload: 'x'.repeat(2048) };
  await writeFile(orchLedger(home), Array.from({ length: 1000 }, (_, i) => line(i + 1, 'unrelated', unrelated)).join(''));
  const foreign = join(dir, 'a.jsonl');
  await writeFile(foreign, Array.from({ length: 1000 }, (_, i) => line(i + 1, 'sent', { request: { ...request(`old-${i}`), body: unrelated } })).join(''));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, dir, foreign };
}
test('request lookup parses no unrelated ledger/outbox line, preserves first matches and retains no snapshots', async t => {
  const { home, dir, foreign } = await fixture(t);
  const first = request('req:wanted'), second = { ...first, body: { changed: true } };
  await writeFile(join(dir, 'b.jsonl'), line(1, 'sent', { request: first }) + line(2, 'sent', { request: second }));
  await writeFile(join(dir, 'c.jsonl'), line(1, 'sent', { request: second }));
  const parse = JSON.parse; let unrelated = 0, parsed = 0;
  JSON.parse = function (...args: Parameters<typeof JSON.parse>) { parsed++; if (args[0].includes('"probeUnrelated":true')) unrelated++; return parse(...args); };
  try {
    assert.equal(await findRequest(home, 'missing'), undefined);
    assert.equal(parsed, 0);
    assert.deepEqual(await findRequest(home, first.rid), { request: first, admitted: false });
    assert.equal(unrelated, 0); assert.equal(parsed, 2);
    await appendFile(orchLedger(home), line(1001, 'request', { request: second }));
    assert.deepEqual(await findRequest(home, first.rid), { request: second, admitted: true });
    assert.equal(unrelated, 0);
    assert.equal(await findRequest(home, 'new-tail', ['hinted-tail']), undefined);
    const grown = request('new-tail'); await appendFile(foreign, line(1001, 'sent', { request: grown }));
    assert.deepEqual(await findRequest(home, grown.rid), { request: grown, admitted: false }, 'a cached miss still reads growth');
    const hinted = request('hinted-tail'); await appendFile(foreign, line(1002, 'sent', { request: hinted }));
    assert.deepEqual(await findRequest(home, hinted.rid), { request: hinted, admitted: false }, 'a hinted miss still reads fresh growth');
    assert.equal(await findRequest(home, 'replaced'), undefined);
    const replaced = request('replaced'), replacement = join(dir, 'replacement');
    await writeFile(replacement, line(1, 'sent', { request: replaced })); await rename(replacement, foreign);
    assert.deepEqual(await findRequest(home, replaced.rid), { request: replaced, admitted: false }, 'a cached miss rebuilds on replacement');
    assert.equal(await findRequest(home, 'shrunk'), undefined);
    const shrunk = request('shrunk'); await writeFile(foreign, line(1, 'sent', { request: shrunk }));
    assert.deepEqual(await findRequest(home, shrunk.rid), { request: shrunk, admitted: false }, 'a cached miss rebuilds on shrink');
    assert.equal(await findRequest(home, 'repaired'), undefined);
    const repaired = request('repaired'), tail = line(2, 'sent', { request: repaired });
    const broken = (tail[0] === '0' ? '1' : '0') + tail.slice(1), prefix = line(1, 'sent', { request: shrunk });
    await writeFile(foreign, prefix + broken);
    assert.equal(await findRequest(home, repaired.rid), undefined);
    await writeFile(foreign, prefix + tail);
    assert.deepEqual(await findRequest(home, repaired.rid), { request: repaired, admitted: false }, 'a torn tail repaired at the same size is fresh');
    assert.equal(unrelated, 0);
    for (const path of [orchLedger(home), foreign, join(dir, 'b.jsonl'), join(dir, 'c.jsonl')]) assert.equal(hasJournalSnapshot(path), false, path);
  } finally { JSON.parse = parse; }
});

test('hinted misses keep one position per file across 400 outboxes and invalidate appended hints', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-miss-files-')), dir = join(outboxRoot(home), 'outbox');
  await mkdir(dir, { recursive: true }); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(orchLedger(home), line(1, 'unrelated'));
  for (let i = 0; i < 400; i++) await writeFile(join(dir, `${String(i).padStart(3, '0')}.jsonl`), line(1, 'sent', { request: request(`old-${i}`) }));
  const read = fs.readSync; let reads = 0, fromStart = 0;
  fs.readSync = ((...args: unknown[]) => { reads++; if (args[4] === 0) fromStart++; return Reflect.apply(read, fs, args); }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.equal(await findRequest(home, 'missing', ['hint1', 'hint2', 'hint3']), undefined);
    assert.equal(fromStart, 401);
    reads = 0; fromStart = 0;
    assert.equal(await findRequest(home, 'missing', ['hint1', 'hint2', 'hint3']), undefined);
    assert.equal(reads, 0, 'hinted lookup must reuse all its own file positions');
    for (let i = 0; i < 400; i++) await appendFile(join(dir, `${String(i).padStart(3, '0')}.jsonl`), line(2, 'resolved', { rid: `old-${i}` }));
    assert.equal(await findRequest(home, 'hint3'), undefined);
    assert.equal(reads, 400); assert.equal(fromStart, 0, 'only suffixes are read for each hinted file');
    const hinted = request('hint1'); await appendFile(orchLedger(home), line(2, 'request', { request: hinted }));
    assert.equal(await findRequest(home, 'missing'), undefined); // Must invalidate hint1 even though not asked for.
    assert.deepEqual(await findRequest(home, 'hint1'), { request: hinted, admitted: true });
    // A read applies a hinted invalidation, then fails: neither the position nor partial state may survive repair.
    const tail = line(3, 'request', { request: request('hint2') }), broken = (tail[0] === '0' ? '1' : '0') + tail.slice(1);
    await appendFile(orchLedger(home), broken + line(4, 'unrelated'));
    await assert.rejects(findRequest(home, 'missing'), /Journal corruption/);
    await writeFile(orchLedger(home), line(1, 'unrelated') + line(2, 'request', { request: hinted }) + tail + line(4, 'unrelated'));
    assert.deepEqual(await findRequest(home, 'hint2'), { request: request('hint2'), admitted: true });
    // Beyond the file budget keep the first 1024 positions; do not cycle-evict them within the lookup.
    for (let i = 400; i < 1100; i++) await writeFile(join(dir, `${String(i).padStart(4, '0')}.jsonl`), line(1, 'unrelated'));
    assert.equal(await findRequest(home, 'overflow', ['overflow1', 'overflow2']), undefined);
    reads = 0; fromStart = 0;
    assert.equal(await findRequest(home, 'overflow', ['overflow1', 'overflow2']), undefined);
    assert.equal(reads, 77); assert.equal(fromStart, 77, 'only files beyond the bounded prefix budget are reread');
  } finally { fs.readSync = read; syncBuiltinESMExports(); }
});

test('pending session outboxes fold only new bytes and drop resolved identities and failed positions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-pending-fold-')), path = join(home, 'a.jsonl'), other = join(home, 'b.jsonl');
  t.after(() => rm(home, { recursive: true, force: true }));
  const { PendingOutboxReader } = await import('../../../src/agent/main/snapshots.ts');
  const reader = new PendingOutboxReader();
  await writeFile(path, line(1, 'sent', { request: request('a') }) + line(2, 'sent', { request: request('b') }));
  await writeFile(other, line(1, 'sent', { request: request('other') }));
  const read = fs.readSync; let reads = 0, fromStart = 0;
  fs.readSync = ((...args: unknown[]) => { reads++; if (args[4] === 0) fromStart++; return Reflect.apply(read, fs, args); }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.deepEqual([...reader.read(path)], ['a', 'b']); assert.deepEqual([...reader.read(other)], ['other']);
    reads = 0; fromStart = 0;
    assert.deepEqual([...reader.read(path)], ['a', 'b']); assert.equal(reads, 0);
    await appendFile(path, line(3, 'resolved', { rid: 'a' }) + line(4, 'sent', { request: request('c') }));
    assert.deepEqual([...reader.read(path)], ['b', 'c']); assert.equal(fromStart, 0);
    assert.deepEqual([...reader.read(other)], ['other']);
    await writeFile(path, line(1, 'sent', { request: request('shrunk') }));
    assert.deepEqual([...reader.read(path)], ['shrunk']);
    const replacement = join(home, 'replacement'); await writeFile(replacement, line(1, 'sent', { request: request('replaced') })); await rename(replacement, path);
    assert.deepEqual([...reader.read(path)], ['replaced']);
    const tail = line(2, 'resolved', { rid: 'replaced' }), broken = (tail[0] === '0' ? '1' : '0') + tail.slice(1);
    await appendFile(path, broken); assert.deepEqual([...reader.read(path)], ['replaced']);
    await writeFile(path, line(1, 'sent', { request: request('replaced') }) + tail);
    assert.equal(reader.read(path).size, 0, 'same-size tail repair is not cached');
    // Apply a resolution before encountering mid-file corruption, then rebuild from a repaired same-size file.
    await writeFile(path, line(1, 'sent', { request: request('replaced') })); reader.read(path);
    await appendFile(path, tail + broken + line(4, 'unrelated'));
    assert.throws(() => reader.read(path), /Journal corruption/);
    await writeFile(path, line(1, 'sent', { request: request('replaced') }) + line(2, 'unrelated') + line(3, 'unrelated') + line(4, 'unrelated'));
    assert.deepEqual([...reader.read(path)], ['replaced'], 'failed fold cannot retain partial resolutions');
    await rm(path); assert.equal(reader.read(path).size, 0);
    await writeFile(path, line(1, 'sent', { request: request('new') })); assert.deepEqual([...reader.read(path)], ['new']);
    reader.clear(); reads = 0; assert.deepEqual([...reader.read(other)], ['other']); assert.ok(reads > 0);
  } finally { fs.readSync = read; syncBuiltinESMExports(); }
});

test('a pi-process run and send tool call add no outbox snapshot or unrelated decoded records', async t => {
  const { home, dir, foreign } = await fixture(t);
  const keys = ['HOME', 'DSA_HOME', 'DSA_SESSION', 'DSA_ORCHESTRATOR_ENTRY', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, DSA_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1' });
  const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: {} };
  const lock = await new OsLock().tryAcquire(orchLock(home)); assert.ok(lock);
  const engine = new Engine(ledgers, fakeExecutor(ledgers), { evaluator: { async start() {}, send() {}, async close() {} }, discovery: { home, agentDir: join(home, 'agent'), globalNpmRoot: null } });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let tool: { execute: (...args: unknown[]) => Promise<{ details: unknown }> } | undefined;
  const context = { cwd: home, hasUI: false, isIdle: () => false, ui: { notify() {} },
    sessionManager: { getSessionId: () => 'filter-session', getSessionFile: () => undefined, getLeafId: () => undefined } };
  const { registerMain } = await import('../../../src/agent/main.ts');
  registerMain({ on(name: string, fn: never) { handlers.set(name, fn); }, registerTool(value: never) { tool = value; }, sendMessage() {} } as never);
  await handlers.get('session_start')!({}, context);
  const timer = setInterval(() => void engine.intake(), 20);
  const parse = JSON.parse; let unrelated = 0;
  t.after(async () => {
    JSON.parse = parse; clearInterval(timer);
    await handlers.get('session_shutdown')!({ reason: 'reload' }, context);
    await engine.close(); await orch.close(); await lock.release();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  });
  JSON.parse = function (...args: Parameters<typeof JSON.parse>) { if (args[0].includes('"probeUnrelated":true')) unrelated++; return parse(...args); };
  const run = (await tool!.execute('run', { action: 'run', request: 'filtered-run', source: 'export default async () => 1' }, undefined, undefined, context)).details as { wid?: string };
  assert.ok(run.wid);
  const sent = (await tool!.execute('send', { action: 'send', request: 'filtered-send', to: 'absent/key', kind: 'steer', message: 'hello' }, undefined, undefined, context)).details as { applied: boolean };
  assert.equal(sent.applied, false);
  assert.equal(unrelated, 0);
  for (const path of [foreign, join(dir, 'main:filter-session.jsonl')]) assert.equal(hasJournalSnapshot(path), false, path);
});
