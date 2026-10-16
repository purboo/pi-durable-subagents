import type { Request } from '../types.ts';
import { contentHash } from './ids.ts';
import { dependency } from './guards.ts';
import { OverlayMap, OverlaySet } from './overlay.ts';

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
type Admitted = Extract<DecisionRecord, { type: 'admitted' }>;
type Resolved = Extract<DecisionRecord, { type: 'applied' | 'rejected' }>;
/** Journal records are deeply frozen. Mutable inputs still get a defensive copy. */
const retained = <T extends DecisionRecord>(record: T): T => Object.isFrozen(record) ? record : structuredClone(record);
/** A1, A3, P5, P6: The left fold of committed decisions, with an admission-ordered open frontier. */
export class LifecycleFold implements LifecycleView {
  admitted: Map<string, Admitted> | OverlayMap<string, Admitted> = new Map();
  order: Map<string, number> | OverlayMap<string, number> = new Map();
  resolved: Map<string, Resolved> | OverlayMap<string, Resolved> = new Map();
  tombstones: Set<string> | OverlaySet<string> = new Set();
  high: Map<string, number> | OverlayMap<string, number> = new Map();
  readonly open = new Map<string, Admitted>();
  apply(record: DecisionRecord): void {
    if (record.type === 'admitted') {
      if (!this.admitted.has(record.rid)) {
        const entry = retained(record);
        this.admitted.set(record.rid, entry); this.order.set(record.rid, this.order.size);
        if (!this.resolved.has(record.rid)) this.open.set(record.rid, entry);
      }
      this.high.set(record.from, Math.max(this.high.get(record.from) ?? 0, record.sseq));
    } else if (record.type === 'withdrawn') {
      for (const rid of record.rids) this.tombstones.add(rid);
    } else if (isResolution(record) && !this.resolved.has(record.rid)) {
      this.resolved.set(record.rid, retained(record)); this.open.delete(record.rid);
    }
  }
  /** O(open requests), with O(1) overlays over history. The source must not change until this copy is discarded. */
  copy(): LifecycleFold {
    const copy = new LifecycleFold();
    copy.admitted = new OverlayMap(this.admitted); copy.order = new OverlayMap(this.order);
    copy.resolved = new OverlayMap(this.resolved); copy.tombstones = new OverlaySet(this.tombstones); copy.high = new OverlayMap(this.high);
    for (const [rid, record] of this.open) copy.open.set(rid, record);
    return copy;
  }
  view(): LifecycleView { return { admitted: this.admitted, order: this.order, resolved: this.resolved, tombstones: this.tombstones, high: this.high }; }
}
/** Whether a record can be the first terminal decision for a rid; identity conflicts never resolve it. */
export function isResolution(record: { type: string; reason?: unknown }): record is Resolved {
  return record.type === 'applied' || record.type === 'rejected' && record.reason !== 'identity-conflict';
}
/** Direct equivalent of reduceLifecycle(records).resolved.get(rid), with no cloning. */
export function lifecycleResolution<T extends { type: string; rid?: unknown; reason?: unknown }>(records: readonly T[], rid: string): (T & Resolved) | undefined {
  return records.find((record): record is T & Resolved => record.rid === rid && isResolution(record));
}
/** A1, A3, P5, P6: Rebuild lifecycle state solely from committed decisions. */
export function reduceLifecycle(records: readonly DecisionRecord[]): LifecycleView {
  const fold = new LifecycleFold();
  for (const record of records) fold.apply(record);
  return fold.view();
}
/** A3, A4/V5, P5, P6: Plan deterministic intake and resolution without I/O or effects.
 *  The decider receives a defensive request copy and a read-only lifecycle view valid only during that call.
 *  A supplied fold stays unchanged; its source must stay unchanged throughout this synchronous call. */
export function planDecisions(records: readonly DecisionRecord[] | LifecycleFold, candidates: readonly Request[], decide: (request: Request, view: LifecycleView) => Decision): DecisionRecord[] {
  const output: DecisionRecord[] = [];
  const view = records instanceof LifecycleFold ? records.copy() : new LifecycleFold();
  if (!(records instanceof LifecycleFold)) for (const record of records) view.apply(record);
  const emit = (record: DecisionRecord) => { output.push(record); view.apply(record); };
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
  for (const [rid, admitted] of view.open) {
    if (admitted.kind !== 'withdraw') continue;
    const req = envelopes.get(rid);
    if (!req) continue;
    if (view.tombstones.has(rid)) { emit({ type: 'rejected', rid, reason: 'withdrawn' }); continue; }
    const state = { order: view.order, resolved: view.resolved };
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'admission' })) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'application' })) continue;
    const targets = (req.body as { rids?: unknown } | null)?.rids;
    if (!Array.isArray(targets) || !targets.every(target => typeof target === 'string')) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    const rids = [...new Set(targets as string[])].sort();
    emit({ type: 'withdrawn', rids });
    for (const target of rids) if (target !== rid && view.admitted.has(target) && !view.resolved.has(target)) emit({ type: 'rejected', rid: target, reason: 'withdrawn' });
    emit({ type: 'applied', rid });
  }
  for (const [rid, admitted] of view.open) {
    if (admitted.kind === 'withdraw') continue;
    const req = envelopes.get(rid);
    if (!req) continue; // The recipient retains pending request files until durable resolution.
    if (view.tombstones.has(rid)) { emit({ type: 'rejected', rid, reason: 'withdrawn' }); continue; }
    const state = { order: view.order, resolved: view.resolved };
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'admission' })) { emit({ type: 'rejected', rid, reason: 'malformed' }); continue; }
    if (!dependency(state, { rid, after: req.cond?.after, phase: 'application' })) continue;
    const decision = decide(structuredClone(req), view.view());
    if (decision.action === 'apply') emit({ type: 'applied', rid });
    else if (decision.action === 'reject') emit({ type: 'rejected', rid, reason: decision.reason });
  }
  return output;
}
