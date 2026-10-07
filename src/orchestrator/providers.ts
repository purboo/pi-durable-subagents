// Ops/P12: provider availability folded from the orchestrator ledger, shared by admission (executor) and `status`.
//   provider-exhausted{provider, exec, since, nextTry, error}: the provider's usage window is used up (a quota-class
//     error after pi's retries); no call is admitted to it before nextTry.
//   provider-probe{provider, exec}: after nextTry, the one call admitted to find out whether it accepts requests again.
//   provider-available{provider, exec}: it answered; a release of the probe's slot without an outcome frees the probe.
import type { Entry } from "../types.ts";

export interface Exhaustion { since: number; nextTry: number; error: string; probe?: string }

/** Apply one orchestrator ledger entry to the map of used-up providers. */
export function foldExhaustion(exhausted: Map<string, Exhaustion>, e: Entry): void {
  const provider = String(e.provider ?? e.pool ?? "");
  if (e.type === "provider-exhausted") exhausted.set(provider, { since: Number(e.since), nextTry: Number(e.nextTry), error: String(e.error ?? "") });
  else if (e.type === "provider-available") exhausted.delete(provider);
  else if (e.type === "provider-probe") { const x = exhausted.get(provider); if (x) x.probe = String(e.exec); }
  else if (e.type === "release") { const x = exhausted.get(provider); if (x && x.probe === e.exec) delete x.probe; }
}
