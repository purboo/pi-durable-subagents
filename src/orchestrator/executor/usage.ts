// Private entries (P31): usage{call,id,usage}; each completed assistant message is recorded once.
import { contentHash } from "../../kernel/ids.ts";
import { budgets } from "../../kernel/guards.ts";
import type { CallResult, Entry } from "../../types.ts";
import type { SessionEntry } from "./session.ts";
export type Usage = NonNullable<CallResult["usage"]>;

/** P31: Use the provider message identity, or native timestamp/content identity when pi omits an id. */
export function messageUsage(message: Record<string, unknown>) {
  if (message.role !== "assistant" || !message.usage) return;
  const raw = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  return { id: String(message.id ?? message.timestamp ?? contentHash(message)), usage: {
    input: (raw.input ?? 0) + (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0), output: raw.output ?? 0, costUsd: raw.cost?.total ?? 0,
  } };
}
/** P31: Reconstruct usage from native messages with the same identity as RPC observations. */
export function sessionUsage(entries: SessionEntry[]) {
  return entries.flatMap(e => { const u = e.message && messageUsage(e.message as Record<string, unknown>); return u ? [u] : []; });
}
/** P31: Sum deduplicated committed message usage across executions, optionally across a whole workflow. */
export function totalUsage(entries: readonly Entry[], call?: string): Usage {
  const seen = new Set<string>(), total = { input: 0, output: 0, costUsd: 0 };
  for (const e of entries) if (e.type === "usage" && (call === undefined || e.call === call)) {
    const id = `${e.call}:${e.id}`; if (seen.has(id)) continue; seen.add(id);
    const u = e.usage as Usage; total.input += u.input; total.output += u.output; total.costUsd += u.costUsd;
  }
  return total;
}
/** V8: Reached means either configured limit has been consumed, including truthful overshoot. */
export function reached(usage: Usage, budget?: { tokens?: number; costUsd?: number }): boolean {
  return !budgets({ workflow: { usage: { tokens: usage.input + usage.output, costUsd: usage.costUsd }, budget } }, { kind: "dispatch" });
}
/** P18, P31: Keep only slim evidence; never persist tool arguments, results or update payloads. */
export function observation(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = event.type, m = event.message as Record<string, unknown> | undefined;
  if (type === "message_start") return { type, provider: m?.provider, model: m?.model };
  if (type === "message_end") { const u = m && messageUsage(m); return u ? { type, ...u } : undefined; }
  if (type === "tool_execution_start" || type === "tool_execution_end") return { type, toolName: event.toolName, toolCallId: event.toolCallId };
}
