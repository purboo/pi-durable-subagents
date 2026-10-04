export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof thinkingLevels[number];
export interface Model { provider?: string; id: string; thinking?: Thinking }
export type ModelPools = Readonly<Record<string, readonly string[]>>;

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

/** P11, P35: Resolve a pool into ordered candidates without making an unrecorded selection. */
export function resolveModel(value: string, pools: ModelPools = {}): Model[] {
  const expand = (name: string, seen: Set<string>): Model[] => {
    if (!Object.hasOwn(pools, name)) return [parseModel(name)];
    if (seen.has(name)) throw new Error(`Cyclic model pool: ${name}`);
    const entries = pools[name]!;
    if (!entries.length) throw new Error(`Empty model pool: ${name}`);
    return entries.flatMap(entry => expand(entry, new Set([...seen, name])));
  };
  return expand(value.trim(), new Set());
}
