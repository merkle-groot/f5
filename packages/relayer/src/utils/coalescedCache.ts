type CacheEntry<V> = {
  value?: V;
  hasValue: boolean;
  fetchedAt: number;
  inFlight?: Promise<V>;
};

/** A small in-memory TTL cache that also collapses concurrent loads per key. */
export class CoalescedTtlCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(key: K, loader: () => Promise<V>, { force = false } = {}): Promise<V> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { hasValue: false, fetchedAt: 0 };
      this.entries.set(key, entry);
    }
    if (!force && entry.hasValue && this.now() - entry.fetchedAt < this.ttlMs) {
      return entry.value as V;
    }
    // `!force`: joining the in-flight load is the whole point of coalescing, but a
    // caller that asked for fresh data would otherwise silently receive the result of
    // a load that started before it asked — which is exactly what `force` rules out.
    if (!force && entry.inFlight) return entry.inFlight;

    entry.inFlight = loader()
      .then((value) => {
        entry!.value = value;
        entry!.hasValue = true;
        entry!.fetchedAt = this.now();
        return value;
      })
      .finally(() => {
        entry!.inFlight = undefined;
      });
    return entry.inFlight;
  }
}
