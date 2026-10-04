import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as guards from '../../../src/kernel/guards.ts';

function witness(name: string, allowed: () => boolean, forbidden: () => boolean): void {
  test(`${name}: valid transition allowed; removed-guard mutant violates invariant`, () => {
    assert.equal(allowed(), true);
    const verify = (guard: () => boolean) => assert.equal(guard(), false, `${name} forbidden transition committed`);
    verify(forbidden);
    assert.throws(() => verify(() => true), /forbidden transition committed/);
  });
}
witness('V1 capacity', () => guards.capacity({ kind: 'provider', holders: 0, capacity: 1 }), () => guards.capacity({ kind: 'provider', holders: 1, capacity: 1 }));
witness('V1 memory headroom', () => guards.capacity({ kind: 'memory', available: 2300, reserve: 2000, perChild: 300 }), () => guards.capacity({ kind: 'memory', available: 2299, reserve: 2000, perChild: 300 }));
witness('V2 seal', () => guards.seal({ sealed: false, exec: 'e' }, { exec: 'e' }), () => guards.seal({ sealed: true, exec: 'e' }, { exec: 'e' }));
witness('V2 current execution', () => guards.seal({ sealed: false, exec: 'e' }, { exec: 'e' }), () => guards.seal({ sealed: false, exec: 'e' }, { exec: 'old' }));
witness('V3 currency', () => guards.currency({ epoch: 'w@2', ev: 2 }, { epoch: 'w@2', ev: 2 }), () => guards.currency({ epoch: 'w@2', ev: 2 }, { epoch: 'w@2', ev: 1 }));
const q = { qid: 'q', rev: 2 };
witness('V4 openness', () => guards.openness({ open: [q], blocked: q }, q), () => guards.openness({ open: [], blocked: q }, q));
witness('V4 hibernated revision', () => guards.openness({ open: [q], hibernated: q }, q), () => guards.openness({ open: [q], hibernated: { ...q, rev: 1 } }, q));
witness('V4 interrupted question', () => guards.openness({ open: [q], blocked: q }, q), () => guards.openness({ open: [q] }, q));
const dep = { order: new Map([['a', 0], ['b', 1]]), resolved: new Set(['a']) };
witness('V5 earlier dependency', () => guards.dependency(dep, { rid: 'b', after: 'a', phase: 'application' }), () => guards.dependency(dep, { rid: 'a', after: 'b', phase: 'admission' }));
witness('V5 resolved dependency', () => guards.dependency(dep, { rid: 'b', after: 'a', phase: 'application' }), () => guards.dependency({ ...dep, resolved: new Set() }, { rid: 'b', after: 'a', phase: 'application' }));
witness('V6 monotone time', () => guards.monotoneTime({ active: 10 }, { active: 10 }), () => guards.monotoneTime({ active: 10 }, { active: 9 }));
witness('V7 single presentation', () => guards.singlePresentation({ presented: [{ id: 'i', rev: 1 }] }, { id: 'i', rev: 2 }), () => guards.singlePresentation({ presented: [{ id: 'i', rev: 1 }] }, { id: 'i', rev: 1 }));
const full = { usage: { tokens: 10, costUsd: 2 }, budget: { tokens: 10, costUsd: 2 } }, empty = { ...full, usage: { tokens: 0, costUsd: 0 } };
witness('V8 workflow dispatch', () => guards.budgets({ workflow: empty }, { kind: 'dispatch' }), () => guards.budgets({ workflow: full }, { kind: 'dispatch' }));
witness('V8 workflow continuation', () => guards.budgets({ workflow: empty }, { kind: 'continuation' }), () => guards.budgets({ workflow: full }, { kind: 'continuation' }));
witness('V8 call provider', () => guards.budgets({ workflow: full, call: empty }, { kind: 'provider' }), () => guards.budgets({ workflow: empty, call: full }, { kind: 'provider' }));
test('V8 workflow exhaustion does not stop children and overshoot always records', () => {
  assert.equal(guards.budgets({ workflow: full }, { kind: 'provider' }), true);
  assert.equal(guards.budgets({ workflow: full, call: full }, { kind: 'usage' }), true);
  assert.equal(guards.budgets({ workflow: { usage: { tokens: 0, costUsd: 2 }, budget: { costUsd: 2 } } }, { kind: 'dispatch' }), false);
});
