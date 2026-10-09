// R7: whyWaiting per reason and precedence, the journal fold, the tracker's transitions, startR7 with a fake sink, the
// orchestrator collector on synthetic journals (and its agreement with `describe` from disk), and its cost per tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openJournal } from '../../../src/kernel/journal.ts';
import { journalPath, orchLedger } from '../../../src/paths.ts';
import { describe } from '../../../src/cli/requests.ts';
import { emptyLedger, foldLedger } from '../../../src/orchestrator/ledger.ts';
import { R7Tracker, SLOT_GRACE_MS, foldWaits, r7Collector, startR7, waitsOf, whyWaiting, type R7Collected, type Wait, type WaitInput, type WaitMeta } from '../../../src/events/r7.ts';
import { WAIT_REASONS, type EventDraft } from '../../../src/events/types.ts';
import type { Exhaustion } from '../../../src/orchestrator/providers.ts';
import type { Entry } from '../../../src/types.ts';

const NOW = 1_000_000;
const used = (entries: Record<string, Partial<Exhaustion>>) => new Map(Object.entries(entries).map(([p, x]) => [p, { since: 100, nextTry: NOW + 60_000, error: 'quota', ...x } as Exhaustion]));

test('R7 whyWaiting: each reason from its source; asking, sealed and moving calls have none', () => {
  const queued = { exec: { id: 'w@1/a@1#1.1', since: 500, selected: false } }, running = { exec: { id: 'w@1/a@1#1.1', since: 500, selected: true } };
  assert.equal(whyWaiting({}, NOW), undefined, 'not dispatched');
  assert.equal(whyWaiting(running, NOW), undefined, 'running');
  assert.deepEqual(whyWaiting({ ...queued, providers: ['probe'], slot: 'probe 1/1' }, NOW), { reason: 'slot', detail: 'waiting for a slot: probe 1/1', since: 500 });
  assert.deepEqual(whyWaiting(queued, NOW), { reason: 'slot', detail: 'waiting for a slot', since: 500 });
  // A launch passes through the queued state while it prepares and is admitted: a slot wait only once every provider is
  // full, or after the grace period.
  const fresh = { exec: { ...queued.exec, since: NOW - SLOT_GRACE_MS + 1 } };
  assert.equal(whyWaiting({ ...fresh, providers: ['probe'], slot: 'probe 0/1' }, NOW), undefined);
  assert.equal(whyWaiting({ ...fresh, providers: ['probe'], slot: 'probe 1/1', full: true }, NOW)?.reason, 'slot');
  assert.equal(whyWaiting({ ...fresh, providers: ['probe'], slot: 'probe 0/1' }, NOW + 1)?.reason, 'slot');
  assert.deepEqual(whyWaiting({ ...queued, writerWait: { root: '/repo', holder: 'w/b', since: 600 } }, NOW),
    { reason: 'writer-lock', detail: 'waits for the writer lock of /repo: w/b holds it or is ahead in the queue', since: 600 });
  assert.deepEqual(whyWaiting({ ...running, lease: { detail: 'waiting for lease machine 3m', since: 700 } }, NOW), { reason: 'lease', detail: 'waiting for lease machine 3m', since: 700 });
  assert.equal(whyWaiting({ ...queued, lease: { detail: 'x', since: 1 } }, NOW)?.reason, 'slot', 'a lease needs a running call');
  const stall = { id: 'stall:w@1/a@1', kind: 'stall', text: 'w/a: no execution activity observed for 10m; running bash `make` for 10m', since: 800 };
  assert.deepEqual(whyWaiting({ ...running, attention: [stall] }, NOW), { reason: 'silent', detail: stall.text, since: 800 });
  const fence = { id: 'fence:w@1/a@1#1.1', kind: 'unknown', text: 'Processes of execution … did not exit after SIGKILL', since: 900 };
  assert.deepEqual(whyWaiting({ attention: [fence] }, NOW), { reason: 'unconfirmed-stop', detail: fence.text, since: 900 });
  assert.equal(whyWaiting({ ...running, attention: [{ ...fence, id: 'unknown:w@1/a@1' }] }, NOW), undefined, 'an unknown outcome accompanies a seal: no wait');
  // provider-exhausted: a running call on a used-up provider (not its probe); a queued call whose every candidate is used up.
  const x = used({ probe: { since: 300 } });
  assert.deepEqual(whyWaiting({ ...running, providers: ['probe'], exhausted: x }, NOW), { reason: 'provider-exhausted', detail: 'probe exhausted since 17m ago (quota), next try in 1m', since: 300 });
  assert.equal(whyWaiting({ ...running, providers: ['probe'], exhausted: used({ probe: { probe: 'w@1/a@1#1.1' } }) }, NOW), undefined, 'the probe itself moves');
  assert.equal(whyWaiting({ ...queued, providers: ['probe'], exhausted: x }, NOW)?.reason, 'provider-exhausted');
  assert.equal(whyWaiting({ ...queued, providers: ['probe'], exhausted: used({ probe: { nextTry: NOW - 1 } }) }, NOW)?.reason, 'slot', 'its next try is due: it is admitted as the probe');
  assert.equal(whyWaiting({ ...queued, providers: ['probe'], exhausted: used({ probe: { nextTry: NOW - 1, probe: 'other#1.1' } }) }, NOW)?.reason, 'provider-exhausted', 'another call probes it');
  const pool = whyWaiting({ ...queued, providers: ['a', 'b'], exhausted: used({ a: { since: 100 }, b: { since: 200 } }) }, NOW)!;
  assert.equal(pool.reason, 'provider-exhausted'); assert.equal(pool.since, 200); assert.match(pool.detail, /^a exhausted .*; b exhausted /);
  assert.equal(whyWaiting({ ...queued, providers: ['a', 'b'], exhausted: used({ a: {} }) }, NOW)?.reason, 'slot', 'one pool candidate is free');
  // An asking (hibernated or not) or sealed call never waits, whatever else holds.
  assert.equal(whyWaiting({ ...queued, asking: true, attention: [fence] }, NOW), undefined);
  assert.equal(whyWaiting({ ...queued, sealed: true }, NOW), undefined);
});

test('R7 whyWaiting precedence follows WAIT_REASONS: removing the winner exposes the next', () => {
  const fence = { id: 'fence:x', kind: 'unknown', text: 'stuck', since: 1 }, stall = { id: 'stall:x', kind: 'stall', text: 'silent', since: 2 };
  const exhausted = used({ p: {} });
  // A queued call: unconfirmed-stop > provider-exhausted > writer-lock > slot.
  let input: WaitInput = { exec: { id: 'x#1.1', since: 3, selected: false }, providers: ['p'], exhausted, writerWait: { root: '/r', holder: 'w/b', since: 4 }, attention: [fence, stall] };
  const seen: string[] = [];
  for (const strip of [(i: WaitInput) => ({ ...i, attention: [stall] }), (i: WaitInput) => ({ ...i, exhausted: new Map() }), (i: WaitInput) => { const { writerWait: _, ...rest } = i; return rest; }]) {
    seen.push(whyWaiting(input, NOW)!.reason); input = strip(input);
  }
  seen.push(whyWaiting(input, NOW)!.reason);
  assert.deepEqual(seen, ['unconfirmed-stop', 'provider-exhausted', 'writer-lock', 'slot']);
  // A running call: provider-exhausted > lease > silent.
  const running: WaitInput = { exec: { id: 'x#1.1', since: 3, selected: true }, providers: ['p'], exhausted, lease: { detail: 'waiting for lease m 1s', since: 5 }, attention: [stall] };
  assert.equal(whyWaiting(running, NOW)!.reason, 'provider-exhausted');
  assert.equal(whyWaiting({ ...running, exhausted: new Map() }, NOW)!.reason, 'lease');
  assert.equal(whyWaiting({ ...running, exhausted: new Map(), lease: undefined }, NOW)!.reason, 'silent');
  assert.deepEqual([...WAIT_REASONS], ['unconfirmed-stop', 'provider-exhausted', 'writer-lock', 'lease', 'slot', 'silent']);
});

// ---------------------------------------------------------------------------------------------------------------------
let seq = 0;
const entry = (type: string, fields: Record<string, unknown> = {}, ts = ++seq * 10): Entry => Object.freeze({ ...fields, seq, ts, type }) as Entry;
/** A journal handle like kernel/journal.ts: `entries()` is a frozen view rebuilt only after an append. */
function journal(initial: Entry[] = []) {
  const list = [...initial];
  let view: Entry[] | undefined, reads = 0;
  return {
    path: '', get reads() { return reads; },
    entries: () => { reads++; return view ??= Object.freeze(list.slice()) as Entry[]; },
    add(type: string, fields: Record<string, unknown> = {}, ts?: number) { const e = Object.freeze({ ...fields, seq: list.length + 1, ts: ts ?? ++seq * 10, type }) as Entry; list.push(e); view = undefined; return e; },
  };
}
const call = (wid: string, key: string, gen = 1) => `${wid}@1/${key}@${gen}`;

test('R7 fold: writer-wait → slot (since the acquisition) → moving; stall and fence items; asking; seal, revision and workflow end', () => {
  const wid = 'W1', a = call(wid, 'a'), b = call(wid, 'b'), j = journal();
  const env = () => ({ now: NOW, ledger: emptyLedger() });
  const reasons = () => Object.fromEntries([...waitsOf(foldWaits(wid, j.entries()), env())].map(([c, w]) => [c.split('/')[1], w.reason]));
  j.add('wf-created', { revision: 1 });
  j.add('call', { pos: 0, key: 'a', gen: 1, spec: { agent: 'x', model: 'probe/m' } }); j.add('call', { pos: 1, key: 'b', gen: 1, spec: { agent: 'x' } });
  assert.deepEqual(reasons(), {}, 'not dispatched yet');
  j.add('exec', { exec: `${a}#1.1`, call: a }, 100);
  j.add('exec', { exec: `${b}#1.1`, call: b }, 110);
  const wait = j.add('writer-wait', { call: b, root: '/repo', holder: a }, 120);
  assert.deepEqual(reasons(), { 'a@1': 'slot', 'b@1': 'writer-lock' });
  let w = waitsOf(foldWaits(wid, j.entries()), env());
  assert.deepEqual(w.get(a), { reason: 'slot', detail: 'waiting for a slot: probe 0 (no limit)', since: 100 });
  assert.deepEqual(w.get(b), { reason: 'writer-lock', detail: `waits for the writer lock of /repo: ${wid}/a holds it or is ahead in the queue`, since: wait.ts });
  j.add('selected', { exec: `${a}#1.1`, model: { provider: 'probe', id: 'm' } });
  j.add('writer-wait', { call: b, root: '/repo', holder: call(wid, 'c') }, 130);
  assert.equal(waitsOf(foldWaits(wid, j.entries()), env()).get(b)?.since, 120, 'a new holder continues the same wait');
  j.add('writer-acquired', { call: b, root: '/repo' }, 140);
  w = waitsOf(foldWaits(wid, j.entries()), env());
  assert.deepEqual([w.has(a), w.get(b)?.reason, w.get(b)?.since], [false, 'slot', 140]);
  j.add('selected', { exec: `${b}#1.1`, model: { provider: 'probe', id: 'm' } });
  assert.deepEqual(reasons(), {});
  const stall = j.add('attention', { item: { id: `stall:${b}`, rev: 1, kind: 'stall', text: 'W1/b: no execution activity observed for 10m', wid, call: b } });
  w = waitsOf(foldWaits(wid, j.entries()), env());
  assert.deepEqual(w.get(b), { reason: 'silent', detail: 'W1/b: no execution activity observed for 10m', since: stall.ts });
  j.add('attention-resolved', { id: `stall:${b}`, rev: 1, resolution: 'activity' });
  assert.deepEqual(reasons(), {});
  // A question makes the call asking (no wait), also over a fence failure; answered, the stuck fence shows.
  j.add('attention', { item: { id: `q:${a}:1`, rev: 1, kind: 'question', text: 'go?', wid, call: a, qid: 'q1' } });
  j.add('attention', { item: { id: `fence:${a}#1.1`, rev: 1, kind: 'unknown', text: 'Processes of execution did not exit', wid, call: a } });
  assert.deepEqual(reasons(), {});
  j.add('attention-resolved', { id: `q:${a}:1`, rev: 1, resolution: 'answered' });
  assert.deepEqual(reasons(), { 'a@1': 'unconfirmed-stop' });
  // A fenced execution waits for nothing the R7 sources name (a drain, a hibernation) until its next exec.
  j.add('attention-resolved', { id: `fence:${a}#1.1`, rev: 1, resolution: 'fenced' });
  j.add('fenced', { exec: `${a}#1.1` });
  assert.deepEqual(reasons(), {});
  j.add('exec', { exec: `${a}#1.2`, call: a }, 500);
  assert.deepEqual(waitsOf(foldWaits(wid, j.entries()), env()).get(a), { reason: 'slot', detail: 'waiting for a slot: probe 0 (no limit)', since: 500 });
  // Incremental folding equals a fold from scratch.
  const scratch = foldWaits(wid, j.entries()), parts = foldWaits(wid, j.entries().slice(0, 7));
  assert.deepEqual(waitsOf(foldWaits(wid, j.entries(), parts), env()), waitsOf(scratch, env()));
  // Seals drop calls and their items; a finished workflow keeps only follow-up generations live.
  j.add('sealed', { call: b, exec: `${b}#1.1`, result: { status: 'ok' } });
  j.add('workflow-done', { status: 'done' });
  assert.deepEqual(reasons(), {}, 'a done workflow: the unsealed non-generation call is not live');
  j.add('generation', { key: 'b', gen: 2, spec: { agent: 'x', model: 'probe/m' } });
  j.add('exec', { exec: `${call(wid, 'b', 2)}#1.1`, call: call(wid, 'b', 2) });
  assert.deepEqual(reasons(), { 'b@2': 'slot' });
  const f = foldWaits(wid, j.entries());
  assert.equal(f.calls.size, 2); assert.equal(f.items.size, 0);
  j.add('revised', { revision: 2 });
  assert.equal(foldWaits(wid, j.entries(), f).calls.size, 0, 'a revision retires the earlier calls');
});

test('R7 env: pool candidates, an agent\'s pinned model and the configured default decide a queued call\'s providers', () => {
  const wid = 'W2', a = call(wid, 'a'), j = journal();
  j.add('wf-created', { revision: 1 });
  j.add('call', { pos: 0, key: 'a', gen: 1, spec: { agent: 'pinned' } });
  j.add('exec', { exec: `${a}#1.1`, call: a });
  const ledger = foldLedger(emptyLedger(), [
    entry('config', { hash: 'h', config: { pools: { pool: ['x/1', 'y/1'] }, providers: { x: { slots: 1 } } } }),
    entry('hold', { pool: 'x', slot: 0, exec: 'other#1.1' }),
    entry('provider-exhausted', { provider: 'x', exec: 'other#1.1', since: 50, nextTry: NOW + 1000, error: 'quota' }),
  ]);
  const wait = (agentModel?: string) => waitsOf(foldWaits(wid, j.entries()), { now: NOW, ledger }, agentModel ? () => agentModel : undefined).get(a);
  assert.deepEqual(wait('x/1'), { reason: 'provider-exhausted', detail: 'x exhausted since 17m ago (quota), next try in 1s', since: 50 });
  assert.deepEqual(wait('pool'), { reason: 'slot', detail: 'waiting for a slot: x 1/1, y 0 (no limit)', since: wait('pool')!.since }, 'y is free');
  assert.equal(wait(undefined)?.detail, 'waiting for a slot', 'unknown model: no provider named');
  ledger.config!.settings.defaultModel = 'x/1';
  assert.equal(wait(undefined)?.reason, 'provider-exhausted');
});

test('R7 tracker: appear, change, clear, seal while waiting, unchanged detail → nothing; seed suppresses a repeated waiting', () => {
  const meta = (key: string): WaitMeta => ({ wid: 'W', key, gen: 1, call: `W@1/${key}@1`, request: 'run-1', labels: { node: 'n' } });
  const metas = new Map([meta('a'), meta('b')].map(m => [m.call, m]));
  const A = 'W@1/a@1', B = 'W@1/b@1', tracker = new R7Tracker();
  const slot: Wait = { reason: 'slot', detail: 'waiting for a slot: p 1/1', since: 10 };
  let drafts = tracker.diff(100, new Map([[A, slot]]), metas);
  assert.deepEqual(drafts, [{ id: `${A}:waiting:slot:100`, ts: 10, type: 'waiting', wid: 'W', request: 'run-1', key: 'a', gen: 1, call: A, labels: { node: 'n' }, reason: 'slot', detail: slot.detail, since: 10 }]);
  assert.deepEqual(tracker.diff(200, new Map([[A, { ...slot, detail: 'waiting for a slot: p 2/1' }]]), metas), [], 'detail alone changes nothing');
  drafts = tracker.diff(300, new Map([[A, { reason: 'writer-lock', detail: 'w', since: 250 }], [B, undefined]]), metas);
  assert.deepEqual(drafts.map(d => [d.type, d.call, 'reason' in d ? d.reason : undefined]), [['waiting', A, 'writer-lock']], 'a change emits the new waiting only');
  drafts = tracker.diff(400, new Map([[A, undefined], [B, slot]]), metas);
  assert.deepEqual(drafts.map(d => [d.type, d.call, 'after' in d ? d.after : 'reason' in d ? d.reason : undefined, d.id]),
    [['moving', A, 'writer-lock', `${A}:moving:writer-lock:400`], ['waiting', B, 'slot', `${B}:waiting:slot:400`]]);
  // B seals (it disappears from the waits) while waiting: moving, with the labels of its last waiting.
  drafts = tracker.diff(500, new Map(), new Map());
  assert.deepEqual(drafts, [{ id: `${B}:moving:slot:500`, ts: 500, type: 'moving', wid: 'W', request: 'run-1', key: 'b', gen: 1, call: B, labels: { node: 'n' }, after: 'slot' }]);
  assert.deepEqual(tracker.diff(600, new Map(), new Map()), []);
  // The same cause again after it cleared is a new waiting with its own id (a refused probe keeps `since`).
  const again = [...tracker.diff(700, new Map([[A, slot]]), metas), ...tracker.diff(800, new Map(), metas), ...tracker.diff(900, new Map([[A, slot]]), metas)];
  assert.equal(new Set(again.map(d => d.id)).size, 3);
  // After a restart: seeded from the log's latest waiting/moving per call, an unchanged wait repeats nothing.
  const restarted = new R7Tracker();
  restarted.seed(new Map([[A, { type: 'waiting', reason: 'slot', since: 10, detail: 'x', wid: 'W', key: 'a', gen: 1, call: A }], [B, { type: 'moving', wid: 'W', key: 'b', gen: 1, call: B }]]));
  assert.deepEqual(restarted.diff(1000, new Map([[A, slot]]), metas), []);
  assert.deepEqual([...restarted.waiting().keys()], [A]);
  assert.deepEqual(restarted.diff(1100, new Map([[B, slot]]), metas).map(d => [d.type, d.call]), [['moving', A], ['waiting', B]]);
  const fresh = new R7Tracker();
  assert.equal(fresh.diff(1000, new Map([[A, slot]]), metas).length, 1, 'without the seed it would repeat');
});

test('startR7: ticks never overlap; an emit failure is retried first on the next tick with the same drafts, nothing lost', async () => {
  const A = 'W@1/a@1', meta = new Map([[A, { wid: 'W', key: 'a', gen: 1, call: A }]]);
  const states: R7Collected[] = [
    { current: new Map([[A, { reason: 'slot', detail: 's', since: 1 }]]), meta },
    { current: new Map([[A, { reason: 'writer-lock', detail: 'w', since: 2 }]]), meta },
    { current: new Map(), meta },
  ];
  let n = 0, active = 0, overlap = false, failNext = false;
  const logged: EventDraft[] = [], attempts: string[][] = [], lines: string[] = [];
  const collect = async () => { active++; if (active > 1) overlap = true; await delay(30); active--; return states[Math.min(n++, states.length - 1)]!; };
  const sink = { async emit(drafts: readonly EventDraft[]) { attempts.push(drafts.map(d => d.id)); if (failNext) { failNext = false; throw new Error('disk full'); } logged.push(...drafts); } };
  let clock = 1000;
  const r7 = startR7({ collect, sink, intervalMs: 60_000, now: () => clock++, log: line => lines.push(line) });
  try {
    await Promise.all([r7.tick(), r7.tick(), r7.tick()]);
    assert.equal(overlap, false); assert.equal(n, 1, 'concurrent ticks join the running one');
    assert.deepEqual(logged.map(d => d.type), ['waiting']);
    failNext = true;
    await r7.tick();
    assert.equal(logged.length, 1); assert.match(lines.join('\n'), /1 R7 event\(s\) not logged, retried next tick: Error: disk full/);
    await r7.tick();
    assert.deepEqual(logged.map(d => [d.type, 'reason' in d ? d.reason : 'after' in d ? d.after : '']), [['waiting', 'slot'], ['waiting', 'writer-lock'], ['moving', 'writer-lock']]);
    assert.deepEqual(attempts[2], attempts[1]!.concat(attempts[2]!.slice(1)), 'the failed drafts are re-emitted first, with their ids');
    assert.equal(attempts[1]![0], attempts[2]![0]);
    // A collection failure is logged; the next tick works again.
    const broken = startR7({ collect: () => { throw new Error('boom'); }, sink, intervalMs: 60_000, log: line => lines.push(line) });
    await broken.tick(); await broken.stop();
    assert.match(lines.at(-1)!, /R7 collection failed: Error: boom/);
  } finally { await r7.stop(); }
  // The timer runs it on its own.
  let ticks = 0;
  const timed = startR7({ collect: () => { ticks++; return { current: new Map(), meta: new Map() }; }, sink, intervalMs: 10 });
  await delay(100); await timed.stop();
  const after = ticks; await delay(40);
  assert.ok(ticks >= 3, String(ticks)); assert.equal(ticks, after, 'stopped');
});

// ---------------------------------------------------------------------------------------------------------------------
test('R7 collector: in-memory journals and ledger → waits with request id and labels; folds only what changed; skips finished workflows', () => {
  const orch = journal();
  orch.add('config', { hash: 'h', config: { providers: { probe: { slots: 1 } } } });
  orch.add('request', { request: { rid: 'req:job-1', kind: 'run', body: { cwd: '/w', labels: { owed_node: 'n1' } } } });
  orch.add('created', { rid: 'req:job-1', wid: 'W1' });
  orch.add('request', { request: { rid: '01ULID', kind: 'run', body: { cwd: '/w' } } });
  orch.add('created', { rid: '01ULID', wid: 'W2' });
  orch.add('hold', { pool: 'probe', slot: 0, exec: `${call('W2', 'a')}#1.1` });
  const w1 = journal(), w2 = journal(), done = journal();
  for (const [j, wid] of [[w1, 'W1'], [w2, 'W2'], [done, 'W3']] as const) { j.add('wf-created', { revision: 1 }); j.add('call', { pos: 0, key: 'a', gen: 1, spec: { agent: 'x', model: 'probe/m' } }); j.add('exec', { exec: `${call(wid, 'a')}#1.1`, call: call(wid, 'a') }, 100); }
  w2.add('selected', { exec: `${call('W2', 'a')}#1.1`, model: { provider: 'probe', id: 'm' } });
  done.add('sealed', { call: call('W3', 'a'), result: { status: 'ok' } }); done.add('workflow-done', { status: 'done' });
  let leaseReads = 0;
  const workflows = [{ wid: 'W1', journal: w1 }, { wid: 'W2', journal: w2 }, { wid: 'W3', journal: done }];
  const collect = r7Collector({ home: '/nonexistent', workflows: () => workflows, orch, leases: () => { leaseReads++; return [{ resource: 'machine', holders: [], waiters: [{ seq: 1, resource: 'machine', mode: 'exclusive', wrapper: { pid: 1 }, argv: ['make'], cwd: '/', since: 900, call: call('W2', 'a') }] }]; } });
  let got = collect(NOW);
  assert.deepEqual(got.current.get(call('W1', 'a')), { reason: 'slot', detail: 'waiting for a slot: probe 1/1', since: 100 });
  assert.deepEqual(got.meta.get(call('W1', 'a')), { wid: 'W1', key: 'a', gen: 1, call: call('W1', 'a'), request: 'job-1', labels: { owed_node: 'n1' } });
  assert.deepEqual(got.current.get(call('W2', 'a')), { reason: 'lease', detail: 'waiting for lease machine 17m', since: 900 });
  assert.deepEqual(got.meta.get(call('W2', 'a')), { wid: 'W2', key: 'a', gen: 1, call: call('W2', 'a') }, 'no request id for a ULID rid, no labels');
  assert.equal(got.current.has(call('W3', 'a')), false); assert.equal(leaseReads, 1);
  // Unchanged journals are not re-read beyond the cached view; a change folds only the new entries.
  const reads = [w1.reads, w2.reads, done.reads];
  got = collect(NOW);
  assert.deepEqual([w1.reads, w2.reads, done.reads], reads.map(n => n + 1), 'one entries() per workflow per tick');
  w1.add('selected', { exec: `${call('W1', 'a')}#1.1`, model: { provider: 'probe', id: 'm' } });
  got = collect(NOW);
  assert.equal(got.current.has(call('W1', 'a')), false);
  // A used-up provider recorded in the ledger is seen at the next tick; a pruned workflow leaves the collector.
  orch.add('provider-exhausted', { provider: 'probe', exec: 'other#1.1', since: 700, nextTry: NOW + 5000, error: 'quota' });
  got = collect(NOW);
  assert.equal(got.current.get(call('W1', 'a'))?.reason, 'provider-exhausted');
  workflows.splice(0, 1); orch.add('pruned', { wid: 'W1' });
  got = collect(NOW);
  assert.equal(got.current.has(call('W1', 'a')), false);
  // No running call: the lease state is not read.
  w2.add('sealed', { call: call('W2', 'a'), result: { status: 'ok' } });
  const before = leaseReads; collect(NOW);
  assert.equal(leaseReads, before);
});

test('R7: describe (CLI, disk snapshots) and the collector (orchestrator memory) agree on the same journals', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-r7-')); t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home)), wid = '01R7AGREE', j = await openJournal(journalPath(home, wid));
  t.after(async () => { await j.close(); await orch.close(); });
  await orch.append('config', { hash: 'h', config: { providers: { probe: { slots: 1 } } } });
  await orch.append('request', { request: { rid: 'req:agree', kind: 'run', from: 'cli:x', to: 'orch', sseq: 1, body: { cwd: home, labels: { role: 'r' } } } });
  await orch.append('created', { rid: 'req:agree', wid, origin: 'cli:x' });
  await j.append('wf-created', { rid: 'req:agree', origin: 'cli:x', cwd: home, revision: 1 });
  const a = `${wid}@1/a@1`, b = `${wid}@1/b@1`;
  await j.append('call', { pos: 0, key: 'a', gen: 1, spec: { agent: 'x', task: 't', model: 'probe/m' } });
  await j.append('call', { pos: 1, key: 'b', gen: 1, spec: { agent: 'x', task: 't', model: 'probe/m' } });
  await j.append('exec', { exec: `${a}#1.1`, call: a }); await j.append('exec', { exec: `${b}#1.1`, call: b });
  await j.append('selected', { exec: `${a}#1.1`, model: { provider: 'probe', id: 'm' } });
  await orch.append('hold', { pool: 'probe', slot: 0, exec: `${a}#1.1` });
  await j.append('writer-wait', { call: b, root: home, holder: a });
  const collect = r7Collector({ home, workflows: () => [{ wid, journal: j }], orch });
  const compare = async () => {
    const now = Date.now(), d = await describe(home, { request: 'agree' }, now), mem = collect(now);
    for (const c of d.calls!) {
      const w = mem.current.get(`${wid}@1/${c.key}@1`);
      assert.deepEqual(c.waiting?.reason ? { reason: c.waiting.reason, detail: c.waiting.detail, since: c.waiting.since } : undefined, w, c.key);
    }
    return d;
  };
  const d = await compare();
  assert.deepEqual(d.labels, { role: 'r' });
  assert.equal(d.calls![1]!.waiting!.reason, 'writer-lock'); assert.deepEqual(d.calls![1]!.waiting!.writerWait, { root: home, holder: `${wid}/a` }, 'the existing fields stay');
  await j.append('writer-acquired', { call: b, root: home });
  assert.equal((await compare()).calls![1]!.waiting!.reason, 'slot');
  await j.append('attention', { item: { id: `stall:${a}`, rev: 1, kind: 'stall', text: 'quiet', wid, call: a } });
  assert.equal((await compare()).calls![0]!.waiting!.reason, 'silent');
});

test('R7 collector cost: 30 finished and 3 running workflows in memory, per tick', t => {
  const orch = journal(), workflows: { wid: string; journal: ReturnType<typeof journal> }[] = [];
  for (let i = 0; i < 2000; i++) orch.add(i % 2 ? 'release' : 'hold', { pool: 'probe', slot: 0, exec: `x${i >> 1}#1.1` });
  const big = (wid: string, finished: boolean) => {
    const j = journal(), a = call(wid, 'a');
    j.add('wf-created', { revision: 1 }); j.add('call', { pos: 0, key: 'a', gen: 1, spec: { agent: 'x', model: 'probe/m' } }); j.add('exec', { exec: `${a}#1.1`, call: a });
    j.add('selected', { exec: `${a}#1.1`, model: { provider: 'probe', id: 'm' } });
    for (let i = 0; i < 2000; i++) j.add(i % 10 ? 'observation' : 'time', { exec: `${a}#1.1`, event: { type: 'message_update' } });
    if (finished) { j.add('sealed', { call: a, result: { status: 'ok' } }); j.add('workflow-done', { status: 'done' }); }
    workflows.push({ wid, journal: j });
    return j;
  };
  for (let i = 0; i < 30; i++) big(`F${i}`, true);
  const running = [0, 1, 2].map(i => big(`R${i}`, false));
  const collect = r7Collector({ home: '/nonexistent', workflows: () => workflows, orch, leases: () => [] });
  collect(); // first fold of every journal (startup)
  const measure = (viewed: boolean) => {
    const ticks = 500;
    let total = 0;
    for (let i = 0; i < ticks; i++) {
      // Between ticks every running workflow appends (observations) and the ledger moves. In the orchestrator the
      // executor reads them right after, so the views are rebuilt before the tick (viewed); otherwise the tick pays it.
      for (const j of running) { j.add('observation', { event: { type: 'message_update' } }); if (viewed) j.entries(); }
      orch.add('mem', { available: 1000, admitted: true, exec: 'x' }); if (viewed) orch.entries();
      const start = performance.now(); collect(); total += performance.now() - start;
    }
    return total / ticks;
  };
  const viewed = measure(true), copying = measure(false);
  t.diagnostic(`collector: ${(viewed * 1000).toFixed(1)} µs per tick; ${(copying * 1000).toFixed(1)} µs when it also rebuilds the 4 changed journal views (30 finished + 3 running workflows of ~2000 entries, ledger ~3000)`);
  assert.ok(viewed < 5 && copying < 5, `${viewed} / ${copying} ms per tick`);
});
