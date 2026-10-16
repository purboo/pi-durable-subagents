export type CapacityState = { kind: 'provider' | 'integration'; holders: number; capacity: number } | { kind: 'memory'; available: number; reserve: number; perChild: number };
/** A4, V1, P29: Admit holds only within capacity or recorded memory headroom. */
export function capacity(state: CapacityState): boolean {
  return state.kind === 'memory' ? state.available - state.reserve >= state.perChild : state.holders + 1 <= state.capacity;
}
/** A4, V2: Seal an unsealed call only under its current execution identity. */
export function seal(state: { sealed: boolean; exec: string }, transition: { exec: string }): boolean {
  return !state.sealed && state.exec === transition.exec;
}
/** A4, V3: Every supplied epoch, revision and incarnation must still be current. */
export function currency(state: Readonly<Record<string, string | number | undefined>>, transition: Readonly<Record<string, string | number | undefined>>): boolean {
  return Object.entries(transition).every(([key, value]) => value === undefined || state[key] === value);
}
type Question = { qid: string; rev: number };
/** A4, V4, P28: An answer requires an open question: the current revision of a question the call asked (`open`), not yet
 *  answered or superseded (`closed`, keys `qid@rev`). Any open question takes its answer, blocked in an ask or not. */
export function openness(state: { open: readonly Question[]; closed: ReadonlySet<string> }, transition: Question): boolean {
  return state.open.some(q => q.qid === transition.qid && q.rev === transition.rev) && !state.closed.has(`${transition.qid}@${transition.rev}`);
}
/** A4, V5, P5: Dependencies must be earlier admissions, and resolved before application. */
export function dependency(state: { order: ReadonlyMap<string, number>; resolved: Pick<ReadonlySet<string>, 'has'> }, transition: { rid: string; after?: string; phase: 'admission' | 'application' }): boolean {
  if (transition.after === undefined) return true;
  const earlier = state.order.get(transition.after), current = state.order.get(transition.rid);
  return earlier !== undefined && current !== undefined && earlier < current && (transition.phase === 'admission' || state.resolved.has(transition.after));
}
/** A4, V6, P18: Active-time checkpoints cannot decrease recorded time. */
export function monotoneTime(state: { active: number }, transition: { active: number }): boolean {
  return Number.isFinite(transition.active) && transition.active >= state.active;
}
/** A4, V7, P15: Each item revision is presented at most once. */
export function singlePresentation(state: { presented: readonly { id: string; rev: number }[] }, transition: { id: string; rev: number }): boolean {
  return !state.presented.some(item => item.id === transition.id && item.rev === transition.rev);
}
type Usage = { tokens: number; costUsd: number };
type Budget = { tokens?: number; costUsd?: number };
/** A4, V8, P31: Workflow limits gate dispatch; call limits gate provider boundaries; usage always records. */
export function budgets(state: { workflow: { usage: Usage; budget?: Budget }; call?: { usage: Usage; budget?: Budget } }, transition: { kind: 'dispatch' | 'continuation' | 'provider' | 'usage' }): boolean {
  const below = (level: { usage: Usage; budget?: Budget } | undefined) => !level || !level.budget ||
    ((level.budget.tokens === undefined || level.usage.tokens < level.budget.tokens) && (level.budget.costUsd === undefined || level.usage.costUsd < level.budget.costUsd));
  return transition.kind === 'usage' || below(transition.kind === 'provider' ? state.call : state.workflow);
}
