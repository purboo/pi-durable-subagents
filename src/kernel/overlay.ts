/** A map copy that stores only writes; its source must stay unchanged for the copy's lifetime. */
export class OverlayMap<K, V> implements ReadonlyMap<K, V> {
  private writes = new Map<K, V>();
  private added = 0;
  private base: ReadonlyMap<K, V>;
  constructor(base: ReadonlyMap<K, V>) { this.base = base; }
  get size(): number { return this.base.size + this.added; }
  has(key: K): boolean { return this.writes.has(key) || this.base.has(key); }
  get(key: K): V | undefined { return this.writes.has(key) ? this.writes.get(key) : this.base.get(key); }
  set(key: K, value: V): void { if (!this.has(key)) this.added++; this.writes.set(key, value); }
  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) yield [key, this.writes.has(key) ? this.writes.get(key)! : value];
    for (const pair of this.writes) if (!this.base.has(pair[0])) yield pair;
  }
  *keys(): MapIterator<K> { for (const [key] of this) yield key; }
  *values(): MapIterator<V> { for (const [, value] of this) yield value; }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}
/** The set equivalent of OverlayMap. */
export class OverlaySet<T> implements ReadonlySet<T> {
  private writes = new Set<T>();
  private base: ReadonlySet<T>;
  constructor(base: ReadonlySet<T>) { this.base = base; }
  get size(): number { return this.base.size + this.writes.size; }
  has(value: T): boolean { return this.writes.has(value) || this.base.has(value); }
  add(value: T): void { if (!this.base.has(value)) this.writes.add(value); }
  *values(): SetIterator<T> { yield* this.base; yield* this.writes; }
  keys(): SetIterator<T> { return this.values(); }
  *entries(): SetIterator<[T, T]> { for (const value of this) yield [value, value]; }
  [Symbol.iterator](): SetIterator<T> { return this.values(); }
  forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this) callback.call(thisArg, value, value, this);
  }
}
