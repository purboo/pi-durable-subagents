import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from '../../../src/types.ts';
import { planDecisions, reduceLifecycle } from '../../../src/kernel/lifecycle.ts';
import type { DecisionRecord, Decision } from '../../../src/kernel/lifecycle.ts';

const request = (rid: string, sseq: number, extra: Partial<Request> = {}): Request => ({ rid, sseq, from: 'sender', to: 'orch', kind: 'steer', body: {}, ...extra });
const apply = (): Decision => ({ action: 'apply' });
const defer = (): Decision => ({ action: 'defer' });
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [result[i], result[j]] = [result[j]!, result[i]!]; }
  return result;
}
test('random arrival order yields identical decisions for gaps, dependencies, withdrawal and conflict', () => {
  const input = [request('a', 1), request('b', 2, { cond: { after: 'a' } }), request('c', 3, { cond: { after: 'future' } }),
    request('w', 4, { kind: 'withdraw', body: { rids: ['b', 'late'] } }), request('late', 5), request('gap', 7),
    request('other', 1, { from: 'z' }), request('a', 1, { body: { conflicting: true } })];
  const expected = planDecisions([], input, apply);
  for (let seed = 1; seed <= 250; seed++) assert.deepEqual(planDecisions([], shuffle(input, seed), apply), expected, `seed ${seed}`);
  const state = reduceLifecycle(expected);
  assert.equal(state.admitted.has('gap'), false);
  assert.deepEqual(state.resolved.get('b'), { type: 'rejected', rid: 'b', reason: 'withdrawn' });
  assert.equal(expected.filter(r => r.type === 'rejected' && r.reason === 'identity-conflict').length, 1);
});
test('random incremental arrivals close gaps in exactly sender FIFO order', () => {
  const requests = Array.from({ length: 12 }, (_, i) => request(`r${i}`, i + 1, i ? { cond: { after: `r${i - 1}` } } : {}));
  const expected = requests.map(r => r.rid);
  for (let seed = 1; seed <= 100; seed++) {
    const records: DecisionRecord[] = [], available: Request[] = [];
    for (const req of shuffle(requests, seed)) { available.push(req); records.push(...planDecisions(records, available, apply)); }
    assert.deepEqual(records.filter(r => r.type === 'admitted').map(r => r.rid), expected);
    assert.deepEqual(records.filter(r => r.type === 'applied').map(r => r.rid), expected);
    assert.deepEqual(planDecisions(records, available, apply), []);
  }
});
test('after earlier pending defers, rejected resolves, unknown/later/self are malformed', () => {
  const candidates = [request('a', 1), request('b', 2, { cond: { after: 'a' } }), request('c', 3, { cond: { after: 'later' } }), request('later', 4), request('unknown', 5, { cond: { after: 'missing' } }), request('self', 6, { cond: { after: 'self' } })];
  const records = planDecisions([], candidates, req => req.rid === 'a' ? defer() : apply());
  const state = reduceLifecycle(records); assert.equal(state.resolved.has('b'), false);
  for (const rid of ['c', 'unknown', 'self']) assert.deepEqual(state.resolved.get(rid), { type: 'rejected', rid, reason: 'malformed' });
  const next = planDecisions(records, candidates, req => req.rid === 'a' ? { action: 'reject', reason: 'domain' } : apply());
  assert.deepEqual(next, [{ type: 'rejected', rid: 'a', reason: 'domain' }, { type: 'applied', rid: 'b' }]);
});
test('withdraw pending and unseen targets; applied target stays unchanged; withdraw never waits for targets', () => {
  const a = request('applied', 1), pending = request('pending', 2);
  const records = planDecisions([], [a, pending], req => req.rid === a.rid ? apply() : defer());
  const w = request('w', 3, { kind: 'withdraw', cond: { after: 'applied' }, body: { rids: ['applied', 'pending', 'unseen'] } });
  records.push(...planDecisions(records, [w, pending], defer));
  let state = reduceLifecycle(records);
  assert.equal(state.resolved.get('applied')?.type, 'applied'); assert.equal(state.resolved.get('w')?.type, 'applied');
  assert.deepEqual(state.resolved.get('pending'), { type: 'rejected', rid: 'pending', reason: 'withdrawn' });
  records.push(...planDecisions(records, [request('unseen', 4)], apply)); state = reduceLifecycle(records);
  assert.deepEqual(state.resolved.get('unseen'), { type: 'rejected', rid: 'unseen', reason: 'withdrawn' });
});
test('V5 withdrawal rejects unknown, later and self dependencies without effects', () => {
  for (const after of ['unknown', 'later', 'w']) {
    const candidates = [request('target', 1), request('w', 2, { kind: 'withdraw', cond: { after }, body: { rids: ['target', 'unseen'] } }), request('later', 3)];
    const records = planDecisions([], candidates, defer), state = reduceLifecycle(records);
    assert.deepEqual(state.resolved.get('w'), { type: 'rejected', rid: 'w', reason: 'malformed' });
    assert.equal(state.resolved.has('target'), false);
    assert.equal(state.tombstones.size, 0);
    assert.equal(records.some(record => record.type === 'withdrawn'), false);
  }
});
test('V5 withdrawal leaves targets untouched until its earlier dependency resolves', () => {
  for (const terminal of ['applied', 'rejected'] as const) {
    const dep = request('dep', 1), target = request('target', 2);
    const w = request('w', 3, { kind: 'withdraw', cond: { after: 'dep' }, body: { rids: ['target', 'unseen'] } });
    const candidates = [dep, target, w];
    const records = planDecisions([], candidates, defer);
    let state = reduceLifecycle(records);
    assert.equal(state.resolved.has('w'), false);
    assert.equal(state.resolved.has('target'), false);
    assert.equal(state.tombstones.size, 0);
    assert.deepEqual(planDecisions(records, [w], apply), []);
    // Resolution committed in an ordinary pass must not send the deferred withdrawal to decide.
    records.push(...planDecisions(records, candidates, req => {
      assert.notEqual(req.kind, 'withdraw');
      return req.rid === 'dep' ? (terminal === 'applied' ? apply() : { action: 'reject', reason: 'domain' }) : defer();
    }));
    state = reduceLifecycle(records);
    assert.equal(state.resolved.get('dep')?.type, terminal);
    assert.equal(state.resolved.has('w'), false);
    assert.equal(state.tombstones.size, 0);
    records.push(...planDecisions(records, candidates, defer));
    state = reduceLifecycle(records);
    assert.equal(state.resolved.get('w')?.type, 'applied');
    assert.deepEqual(state.resolved.get('target'), { type: 'rejected', rid: 'target', reason: 'withdrawn' });
    assert.equal(state.tombstones.has('unseen'), true);
  }
});
test('withdraw before target with random candidate order and tombstoned withdrawals', () => {
  const w = request('w', 1, { kind: 'withdraw', body: { rids: ['target', 'w2'] } });
  const records = planDecisions([], [w], apply);
  const later = [request('target', 2), request('w2', 3, { kind: 'withdraw', body: { rids: ['untouched'] } })];
  for (let seed = 1; seed <= 40; seed++) {
    const result = planDecisions(records, shuffle(later, seed), apply);
    const state = reduceLifecycle([...records, ...result]);
    assert.equal(state.tombstones.has('untouched'), false);
    for (const rid of ['target', 'w2']) assert.deepEqual(state.resolved.get(rid), { type: 'rejected', rid, reason: 'withdrawn' });
  }
});
test('identity conflict cannot replace original pending binding or terminal resolution', () => {
  const a = request('a', 1), changed = { ...a, body: { changed: true } };
  const records = planDecisions([], [a], defer);
  const hash = reduceLifecycle(records).admitted.get('a')!.hash;
  records.push(...planDecisions(records, [changed], apply));
  assert.equal(reduceLifecycle(records).resolved.has('a'), false);
  assert.equal(reduceLifecycle(records).admitted.get('a')!.hash, hash);
  records.push(...planDecisions(records, [a], apply));
  records.push(...planDecisions(records, [changed], apply));
  assert.equal(reduceLifecycle(records).resolved.get('a')?.type, 'applied');
  assert.equal(records.filter(r => r.type === 'applied').length, 1);
});
test('planning and a mutating domain decider cannot mutate input or lifecycle state', () => {
  const req = request('a', 1), original = structuredClone(req);
  planDecisions([], [req], (r, state) => { r.body = 'mutated'; (state.admitted as Map<string, unknown>).clear(); return apply(); });
  assert.deepEqual(req, original);
});
test('R1: a conflicting duplicate of a resolved rid records nothing and never replaces the resolution', () => {
  const original = request('req:job', 1, { kind: 'run', body: { spec: 1 } });
  const records = planDecisions([], [original], apply);
  assert.deepEqual(records.map(r => r.type), ['admitted', 'applied']);
  // Same rid, other content (even from another sender): no rejected{identity-conflict}, before or after a restart replay.
  const duplicates = [request('req:job', 1, { kind: 'run', body: { spec: 2 } }), request('req:job', 4, { from: 'other', kind: 'stop', body: {} })];
  assert.deepEqual(planDecisions(records, [original, ...duplicates], apply), []);
  assert.deepEqual(planDecisions(records, duplicates, () => ({ action: 'reject', reason: 'never' })), []);
  assert.deepEqual(reduceLifecycle(records).resolved.get('req:job'), { type: 'applied', rid: 'req:job' });
  // While the original is still unresolved the conflict is reported once, as before, and does not resolve it either.
  const admittedOnly = planDecisions([], [original], defer);
  const conflict = planDecisions(admittedOnly, duplicates, defer);
  assert.deepEqual(conflict, [{ type: 'rejected', rid: 'req:job', reason: 'identity-conflict' }]);
  assert.equal(reduceLifecycle([...admittedOnly, ...conflict]).resolved.has('req:job'), false);
});
