import type { Request } from '../types.ts';
import { contentHash } from './ids.ts';
import { dependency } from './guards.ts';

export type DecisionRecord =
  | { type: 'admitted'; rid: string; from: string; sseq: number; hash: string; kind: Request['kind'] }
  | { type: 'applied'; rid: string }
  | { type: 'rejected'; rid: string; reason: string }
  | { type: 'withdrawn'; rids: string[] };
export interface LifecycleView {
  readonly admitted: ReadonlyMap<string, Extract<DecisionRecord, { type: 'admitted' }>>;
  readonly order: ReadonlyMap<string, number>;
  readonly resolved: ReadonlyMap<string, Extract<DecisionRecord, { type: 'applied' | 'rejected' }>>;
  readonly tombstones: ReadonlySet<string>;
  readonly high: ReadonlyMap<string, number>;
}
export type Decision = { action: 'apply' } | { action: 'reject'; reason: string } | { action: 'defer' };
/** A1, A3, P5, P6: Rebuild lifecycle state solely from committed decisions. */
export function reduceLifecycle(records: readonly DecisionRecord[]): LifecycleView {
  const admitted = new Map<string, Extract<DecisionRecord, { type: 'admitted' }>>(), order = new Map<string, number>();
  const resolved = new Map<string, Extract<DecisionRecord, { type: 'applied' | 'rejected' }>>(), tombstones = new Set<string>(), high = new Map<string, number>();
  for (const record of records) {
    if (record.type === 'admitted') {
      if (!admitted.has(record.rid)) { admitted.set(record.rid, structuredClone(record)); order.set(record.rid, order.size); }
      high.set(record.from, Math.max(high.get(record.from) ?? 0, record.sseq));
    } else if (record.type === 'withdrawn') {
      for (const rid of record.rids) tombstones.add(rid);
    } else if (!(record.type === 'rejected' && record.reason === 'identity-conflict') && !resolved.has(record.rid)) {
      resolved.set(record.rid, structuredClone(record));
    }
  }
  return { admitted, order, resolved, tombstones, high };
}
/** A3, A4/V5, P5, P6: Plan deterministic intake and resolution without I/O or effects. */
export function planDecisions(records: readonly DecisionRecord[], candidates: readonly Request[], decide: (request: Request, view: LifecycleView) => Decision): DecisionRecord[] {
  const output: DecisionRecord[] = [];
  let view = reduceLifecycle(records);
  const emit = (record: DecisionRecord) => { output.push(record); view = reduceLifecycle([...records, ...output]); };
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const sorted = candidates.map(req => ({ req: structuredClone(req), hash: contentHash(req) })).sort((a, b) => cmp(a.req.from, b.req.from) || a.req.sseq - b.req.sseq || cmp(a.req.rid, b.req.rid) || cmp(a.hash, b.hash));
  const envelopes = new Map<string, Request>(), conflicts = new Set<string>();
  for (const { req, hash } of sorted) {
    const bound = view.admitted.get(req.rid);
    if (bound) {
      if (bound.hash === hash) envelopes.set(req.rid, req);
      // A1: a conflicting duplicate of a resolved rid is only dropped (its file still goes); it never records a decision.
      else if (!view.resolved.has(req.rid) && !conflicts.has(req.rid)) { conflicts.add(req.rid); emit({ type: 'rejected', rid: req.rid, reason: 'identity-conflict' }); }
      continue;
    }
    if (req.sseq !== (view.high.get(req.from) ?? 0) + 1) continue;
    emit({ type: 'admitted', rid: req.rid, from: req.from, sseq: req.sseq, hash, kind: req.kind });
    envelopes.set(req.rid, req);
  }
  // P6 bypasses ordinary consideration, but a withdrawal still obeys its own V5 dependency.
  for (const [rid, admitted] of view.admitted) {
    if (admitted.kind !== 'withdraw' || view.resolved.has(rid)) continue;
    const req = envelopes.get(rid);
    if (!req) continue;
    if (view.tombstones.has(rid)) { emit({ type: 'rejected', rid, reason: 'withdrawn' }); continue; }
    const state = { order: view.order, resolved: new Set(view.resolved.keys()) };
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'admission' })) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'application' })) continue;
    const targets = (req.body as { rids?: unknown } | null)?.rids;
    if (!Array.isArray(targets) || !targets.every(target => typeof target === 'string')) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    const rids = [...new Set(targets as string[])].sort();
    emit({ type: 'withdrawn', rids });
    for (const target of rids) if (target !== rid && view.admitted.has(target) && !view.resolved.has(target)) emit({ type: 'rejected', rid: target, reason: 'withdrawn' });
    emit({ type: 'applied', rid });
  }
  for (const [rid, admitted] of view.admitted) {
    if (admitted.kind === 'withdraw' || view.resolved.has(rid)) continue;
    const req = envelopes.get(rid);
    if (!req) continue; // The recipient retains pending request files until durable resolution.
    if (view.tombstones.has(rid)) { emit({ type: 'rejected', rid, reason: 'withdrawn' }); continue; }
    const state = { order: view.order, resolved: new Set(view.resolved.keys()) };
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'admission' })) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'application' })) continue;
    const decision = decide(structuredClone(req), structuredClone(view));
    if (decision.action === 'apply') emit({ type: 'applied', rid });
    else if (decision.action === 'reject') emit({ type: 'rejected', rid, reason: decision.reason });
  }
  return output;
}
