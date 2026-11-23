// Private entries (P31): usage{call,id,usage}; each completed assistant message is recorded once.
import { contentHash } from "../../kernel/ids.ts";
import { budgets } from "../../kernel/guards.ts";
import { CT, type CallResult, type Entry } from "../../types.ts";
import type { RawUsage, SessionEntry } from "./session.ts";
export type Usage = NonNullable<CallResult["usage"]>;

function normalizeUsage(raw: RawUsage): Usage {
  return {
    input: (raw.input ?? 0) + (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0),
    output: raw.output ?? 0,
    costUsd: raw.cost?.total ?? 0,
  };
}

/** P31: Use the provider message identity, or native timestamp/content identity when pi omits an id. */
export function messageUsage(message: Record<string, unknown>) {
  if (message.role !== "assistant" || !message.usage) return;
  const raw = message.usage as RawUsage;
  return { id: String(message.id ?? message.timestamp ?? contentHash(message)), usage: normalizeUsage(raw) };
}
/** P31: Extract usage from either an assistant message entry or a standalone pi `usage` entry (e.g. `cache_warm`). */
export function entryUsage(entry: SessionEntry) {
  if (entry.message) return messageUsage(entry.message as Record<string, unknown>);
  if (entry.type === "usage" && entry.usage) {
    return { id: String(entry.id ?? entry.timestamp ?? contentHash(entry)), usage: normalizeUsage(entry.usage) };
  }
  return undefined;
}
/** P31: Charge only messages and usage entries in segments opened by this call, excluding inherited context. */
export function sessionUsage(entries: SessionEntry[], call: string) {
  let own = false;
  return entries.flatMap(e => {
    if (e.type === "custom" && e.customType === CT.exec) own = typeof e.data?.exec === "string" && e.data.exec.startsWith(`${call}#`);
    const u = own && entryUsage(e);
    return u ? [u] : [];
  });
}
/** P31: Sum deduplicated committed message usage across executions, optionally across a whole workflow. */
const totals = new WeakMap<readonly Entry[], { count: number; seen: Set<string>; total: Usage; calls: Map<string, Usage> }>();
export function totalUsage(entries: readonly Entry[], call?: string): Usage {
  let state = totals.get(entries);
  if (!state) { state = { count: 0, seen: new Set(), total: { input: 0, output: 0, costUsd: 0 }, calls: new Map() }; totals.set(entries, state); }
  while (state.count < entries.length) {
    const e = entries[state.count++]!;
    if (e.type !== "usage") continue;
    const id = `${e.call}:${e.id}`; if (state.seen.has(id)) continue; state.seen.add(id);
    const key = String(e.call), total = state.calls.get(key) ?? { input: 0, output: 0, costUsd: 0 }, u = e.usage as Usage;
    state.calls.set(key, total);
    for (const target of [total, state.total]) { target.input += u.input; target.output += u.output; target.costUsd += u.costUsd; }
  }
  return { ...(call === undefined ? state.total : state.calls.get(call) ?? { input: 0, output: 0, costUsd: 0 }) };
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
