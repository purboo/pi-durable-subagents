import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from '../../../src/types.ts';
import { LifecycleFold, lifecycleResolution, planDecisions, reduceLifecycle, type Decision, type DecisionRecord, type LifecycleView } from '../../../src/kernel/lifecycle.ts';
import { planDecisions as baselinePlan, reduceLifecycle as baselineReduce } from './lifecycle-oracle.ts';

function materialize(view: LifecycleView): LifecycleView {
  return { admitted: new Map(view.admitted), order: new Map(view.order), resolved: new Map(view.resolved), tombstones: new Set(view.tombstones), high: new Map(view.high) };
}
function random(seed: number): (n: number) => number {
  return n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
}
test('incremental lifecycle and planning equal the independent baseline over randomized multi-pass histories', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const pick = random(seed), records: DecisionRecord[] = [], candidates: Request[] = [], fold = new LifecycleFold();
    const seq = [0, 0, 0];
    for (let pass = 0; pass < 12; pass++) {
      for (let i = 0, n = 1 + pick(5); i < n; i++) {
        const sender = pick(3), rid = `r${seed}-${candidates.length}`;
        const request: Request = { rid, from: `s${sender}`, sseq: ++seq[sender]!, to: 'orch', kind: pick(4) ? 'steer' : 'withdraw', body: { value: pick(10) } };
        if (request.kind === 'withdraw') request.body = pick(5) ? { rids: [candidates[pick(candidates.length)]?.rid ?? 'unseen', `future-${pick(4)}`] } : { rids: 1 };
        if (pick(2)) request.cond = { after: [candidates[pick(candidates.length)]?.rid ?? 'unknown', rid, `future-${pick(4)}`][pick(3)]! };
        candidates.push(request);
        if (pick(3) === 0) candidates.push(structuredClone(request));
        if (pick(3) === 0) candidates.push({ ...request, from: pick(2) ? request.from : 'conflict', body: { different: true } });
      }
      // Occasionally omit envelopes; unresolved admissions must survive until a later pass.
      const available = candidates.filter(() => pick(5) > 0).sort(() => pick(3) - 1);
      const decide = (request: Request, view: LifecycleView): Decision => {
        const choice = (request.rid.length + pass + view.resolved.size) % 3;
        return choice === 0 ? { action: 'defer' } : choice === 1 ? { action: 'apply' } : { action: 'reject', reason: 'domain' };
      };
      const expected = baselinePlan(records, available, decide);
      const before = materialize(fold);
      assert.deepEqual(planDecisions(fold, available, decide), expected, `fold plan seed=${seed} pass=${pass}`);
      assert.deepEqual(planDecisions(records, available, decide), expected, `array plan seed=${seed} pass=${pass}`);
      assert.deepEqual(materialize(fold), before, 'planning does not modify its source fold');
      for (const record of expected) { records.push(record); fold.apply(record); }
      assert.deepEqual(materialize(fold), baselineReduce(records), `fold seed=${seed} pass=${pass}`);
      assert.deepEqual(reduceLifecycle(records), baselineReduce(records));
      assert.deepEqual([...fold.open.keys()], [...fold.admitted.keys()].filter(rid => !fold.resolved.has(rid)));
    }
  }
});
test('left fold preserves first decisions, duplicate admission order, high water and resolutions before admission', () => {
  const records: DecisionRecord[] = [
    { type: 'rejected', rid: 'a', reason: 'identity-conflict' }, { type: 'applied', rid: 'a' },
    { type: 'admitted', rid: 'a', from: 's', sseq: 2, hash: 'a', kind: 'steer' },
    { type: 'admitted', rid: 'a', from: 'other', sseq: 9, hash: 'changed', kind: 'withdraw' },
    { type: 'rejected', rid: 'a', reason: 'late' }, { type: 'withdrawn', rids: ['a', 'unseen'] },
  ];
  const fold = new LifecycleFold();
  for (const record of records) { fold.apply(record); assert.deepEqual(lifecycleResolution(records.slice(0, records.indexOf(record) + 1), 'a'), fold.resolved.get('a')); }
  assert.deepEqual(materialize(fold), baselineReduce(records));
  assert.equal(fold.open.size, 0);
  assert.strictEqual(lifecycleResolution(records, 'a'), records[1]);
});
test('frozen journal decisions are shared; mutable inputs and decider requests stay isolated', () => {
  const admitted: DecisionRecord = { type: 'admitted', rid: 'a', from: 's', sseq: 1, hash: 'hash', kind: 'steer' };
  const applied: DecisionRecord = Object.freeze({ type: 'applied', rid: 'b' });
  const fold = new LifecycleFold(); fold.apply(admitted); fold.apply(applied);
  assert.notStrictEqual(fold.admitted.get('a'), admitted);
  admitted.hash = 'changed'; assert.equal(fold.admitted.get('a')?.hash, 'hash');
  assert.strictEqual(fold.resolved.get('b'), applied);
  const frozen = Object.freeze({ ...admitted, rid: 'c' }); fold.apply(frozen);
  assert.strictEqual(fold.admitted.get('c'), frozen);
  const request: Request = { rid: 'next', from: 'next', sseq: 1, to: 'orch', kind: 'steer', body: { nested: ['original'] } };
  const copy = structuredClone(request);
  planDecisions(fold, [request], req => { (req.body as { nested: string[] }).nested.push('mutated'); return { action: 'apply' }; });
  assert.deepEqual(request, copy);
});
test('planning on a cached fold neither clones nor iterates resolved history', () => {
  const fold = new LifecycleFold();
  for (let i = 0; i < 500; i++) {
    fold.apply(Object.freeze({ type: 'admitted', rid: `old${i}`, from: 's', sseq: i + 1, hash: 'old', kind: 'steer' }));
    fold.apply(Object.freeze({ type: 'applied', rid: `old${i}` }));
  }
  for (const map of [fold.admitted, fold.order, fold.resolved, fold.high]) {
    Object.defineProperty(map, Symbol.iterator, { value: () => { throw new Error('history iterated'); } });
    Object.defineProperty(map, 'keys', { value: () => { throw new Error('history keys iterated'); } });
  }
  const req: Request = { rid: 'new', from: 's', sseq: 501, to: 'orch', kind: 'steer', body: {} };
  assert.deepEqual(planDecisions(fold, [], () => ({ action: 'apply' })), []);
  assert.deepEqual(planDecisions(fold, [req], (_req, view) => { assert.equal(view.resolved.has('old499'), true); return { action: 'apply' }; }).map(r => r.type), ['admitted', 'applied']);
});
