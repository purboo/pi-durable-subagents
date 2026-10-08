// A1, A4: the state of the orchestrator ledger that admission reads and `status` shows, folded by one reducer.
//   hold/release{pool,slot,exec}: provider and memory slots held (a release frees only its holder's slot).
//   switch-observed{exec,rid}: a model switch the execution's provider requests confirmed.
//   skip{pool,model,until}: a pool candidate skipped after repeated losses (K7).
//   provider-*: used-up usage windows (providers.ts).
//   config{hash,config}: the orchestrator settings in effect from here; config-rejected{error,hash?}: a change of
//     config.json refused, while the earlier settings stay (cleared by the next config record).
//   orchestrator{version,pid} / orchestrator-exit{pid}: the orchestrator running (its package version) and its exit.
import { foldExhaustion, type Exhaustion } from "./providers.ts";
import type { OrchestratorConfig } from "./contract.ts";
import { isEntry, type Entry, type EntryOf } from "../types.ts";

export interface LedgerState {
  /** Entries folded so far, and the last of them (a different entry there means another ledger: fold anew). */
  seen: number;
  last?: Entry;
  held: Map<string, EntryOf<"hold">>;
  observed: Set<string>;
  skips: Map<string, number>;
  exhausted: Map<string, Exhaustion>;
  config?: { hash: string; settings: OrchestratorConfig; ts: number };
  rejected?: { error: string; ts: number };
  /** `restart`: it decides restart requests (1.0.18+); an older one is checked and ended by the client instead. */
  orchestrator?: { version: string; pid: number; start?: string; ts: number; exited?: true; restart?: true };
}

export function emptyLedger(): LedgerState {
  return { seen: 0, held: new Map(), observed: new Set(), skips: new Map(), exhausted: new Map() };
}

/** Apply one orchestrator ledger entry. */
export function applyLedger(state: LedgerState, e: Entry): void {
  if (isEntry(e, "hold")) state.held.set(`${e.pool}:${e.slot}`, e);
  else if (isEntry(e, "release")) { const id = `${e.pool}:${e.slot}`; if (state.held.get(id)?.exec === e.exec) state.held.delete(id); }
  else if (isEntry(e, "switch-observed")) state.observed.add(`${e.exec}\n${e.rid}`);
  else if (isEntry(e, "skip")) state.skips.set(`${e.pool}\n${e.model}`, Math.max(Number(e.until), state.skips.get(`${e.pool}\n${e.model}`) ?? 0));
  else if (isEntry(e, "config")) { state.config = { hash: String(e.hash), settings: e.config as OrchestratorConfig, ts: e.ts }; delete state.rejected; }
  else if (isEntry(e, "config-rejected")) state.rejected = { error: String(e.error), ts: e.ts };
  else if (isEntry(e, "orchestrator")) state.orchestrator = { version: String(e.version), pid: Number(e.pid), ...(e.start ? { start: String(e.start) } : {}), ts: e.ts, ...(e.restart === true ? { restart: true as const } : {}) };
  else if (isEntry(e, "orchestrator-exit")) { if (state.orchestrator?.pid === e.pid) state.orchestrator.exited = true; }
  foldExhaustion(state.exhausted, e);
}

/** Fold the entries appended since `state` was last folded (the ledger only grows); a ledger that is not the one
 *  folded so far (shorter, or another entry where the last folded one was) is folded from the start. */
export function foldLedger(state: LedgerState, entries: readonly Entry[]): LedgerState {
  // Journal readers keep the entry objects of a ledger as it grows (kernel/journal.ts), so identity tells them apart.
  if (state.seen && entries[state.seen - 1] !== state.last) Object.assign(state, emptyLedger(), { config: undefined, rejected: undefined, orchestrator: undefined, last: undefined });
  for (; state.seen < entries.length; state.seen++) applyLedger(state, entries[state.seen]!);
  state.last = entries[state.seen - 1];
  return state;
}

/** The provider slots held now (memory slots included). */
export const holdings = (state: LedgerState) => [...state.held.values()];

/** A4: the settings guards read: the ones recorded last, else (a ledger that records none: an embedded or test
 *  orchestrator given its settings) the given ones. */
export const settingsOf = (state: LedgerState, given: OrchestratorConfig): OrchestratorConfig => state.config?.settings ?? given;
