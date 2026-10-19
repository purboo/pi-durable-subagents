// 1.2 model intent is opt-in: legacy forwards retain their execution-only meaning.
// model-choice {rid, call, model}: a sealed call's next-generation choice, committed before its reply.
// forward {..., choice?: string}: the original manual model/pool name, before resolving a live switch.
import type { Entry } from "../types.ts";

/** Latest surviving manual choice in this generation. Earlier generations already carried theirs into the spec.
 * Delivery consumes the live request, not the choice; a refusal or withdrawal disqualifies the request. Failover
 * never contributes intent, even if its selected model later answers. A revision's entries scope the call identity. */
export function generationModel(log: readonly Entry[], call: string): string | undefined {
  const refused = new Set(log.filter(e => e.type === "forward-delivered" && e.reason !== undefined).map(e => String(e.rid2)));
  const withdrawn = new Set(log.filter(e => e.type === "forward" && e.dest === call && (e.envelope as { kind?: string } | undefined)?.kind === "withdraw")
    .flatMap(e => (e.envelope as { body?: { rids?: string[] } }).body?.rids ?? []));
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.type === "model-choice" && e.call === call && typeof e.model === "string") return e.model;
    if (e.type === "forward" && e.dest === call && typeof e.choice === "string" && !e.failover &&
      (e.envelope as { kind?: string } | undefined)?.kind === "model" && !refused.has(String(e.rid2)) && !withdrawn.has(String(e.rid2))) return e.choice;
  }
  return undefined;
}
