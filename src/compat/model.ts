export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof thinkingLevels[number];
/** `afterMs`: a pool entry that a waiting call may take only after it waited this long for a slot (resolveModel). */
export interface Model { provider?: string; id: string; thinking?: Thinking; afterMs?: number }
/** A pool entry: "provider/id[:thinking]" or a pool name; the object form takes it only after waiting `afterMs`. */
export type PoolEntry = string | { readonly model: string; readonly afterMs?: number };
export type ModelPools = Readonly<Record<string, readonly PoolEntry[]>>;
/** The model without scheduling fields, as recorded and launched. */
export const plainModel = (m: Model): Model => ({ ...(m.provider !== undefined ? { provider: m.provider } : {}), id: m.id, ...(m.thinking ? { thinking: m.thinking } : {}) });

/** P35: Parse Pi model identifiers, preserving colons that are not thinking suffixes. */
export function parseModel(value: string): Model {
  let id = value.trim();
  if (!id || /\s/.test(id)) throw new Error(`Invalid model: ${value}`);
  const suffix = id.slice(id.lastIndexOf(":") + 1);
  const thinking = id.includes(":") && thinkingLevels.includes(suffix as Thinking) ? suffix as Thinking : undefined;
  if (thinking) id = id.slice(0, -(thinking.length + 1));
  const slash = id.indexOf("/");
  if (!id || slash === 0 || slash === id.length - 1) throw new Error(`Invalid model: ${value}`);
  return { ...(slash < 0 ? {} : { provider: id.slice(0, slash) }), id: slash < 0 ? id : id.slice(slash + 1), ...(thinking ? { thinking } : {}) };
}

/** P11, P35: Resolve a pool into ordered candidates without making an unrecorded selection. An object entry's
 *  `afterMs` applies to every model it expands to; nested ones keep the larger value. */
export function resolveModel(value: string, pools: ModelPools = {}): Model[] {
  const expand = (name: string, seen: Set<string>, after: number): Model[] => {
    if (!Object.hasOwn(pools, name)) { const m = parseModel(name); return [after > 0 ? { ...m, afterMs: after } : m]; }
    if (seen.has(name)) throw new Error(`Cyclic model pool: ${name}`);
    const entries = pools[name]!;
    if (!entries.length) throw new Error(`Empty model pool: ${name}`);
    return entries.flatMap(entry => typeof entry === "string" ? expand(entry, new Set([...seen, name]), after)
      : expand(entry.model, new Set([...seen, name]), Math.max(after, entry.afterMs ?? 0)));
  };
  return expand(value.trim(), new Set(), 0);
}
