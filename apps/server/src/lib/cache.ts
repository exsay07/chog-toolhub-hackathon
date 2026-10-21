/**
 * In-process TTL cache with single-flight de-duplication and stale-while-error.
 *
 * Interface is intentionally small so a Redis-backed implementation can replace it when the server
 * is scaled horizontally (see docs/ARCHITECTURE.md#scaling).
 */
interface Entry<T> {
  value: T;
  at: number;
  ttl: number;
}

export interface Cached<T> {
  value: T;
  /** ms epoch of when the value was fetched upstream. */
  fetchedAt: number;
  /** True when upstream failed and an expired value was served. */
  stale: boolean;
}

export class TtlCache {
  private map = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 5000) {}

  async get<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    maxStaleMs = 10 * 60_000,
  ): Promise<Cached<T>> {
    const now = Date.now();
    const hit = this.map.get(key) as Entry<T> | undefined;
    if (hit && now - hit.at < hit.ttl) return { value: hit.value, fetchedAt: hit.at, stale: false };

    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = loader().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const value = await p;
      this.set(key, value, ttlMs);
      return { value, fetchedAt: Date.now(), stale: false };
    } catch (e) {
      if (hit && now - hit.at < maxStaleMs) return { value: hit.value, fetchedAt: hit.at, stale: true };
      throw e;
    }
  }

  peek<T>(key: string): Cached<T> | undefined {
    const hit = this.map.get(key) as Entry<T> | undefined;
    return hit ? { value: hit.value, fetchedAt: hit.at, stale: Date.now() - hit.at >= hit.ttl } : undefined;
  }

  set<T>(key: string, value: T, ttlMs: number) {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now(), ttl: ttlMs });
  }

  get size() {
    return this.map.size;
  }
}
