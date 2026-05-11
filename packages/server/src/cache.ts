import type { CacheAdapter, CacheEntry } from "./types.ts";

/**
 * In-memory LRU cache. Entries are evicted (a) on TTL expiry when read,
 * and (b) when the map exceeds `maxEntries` (oldest-insertion-order first).
 *
 * Single-process only. For multi-instance deployments, supply a Redis or
 * KV adapter via `cache.storage`.
 */
export class InMemoryCache implements CacheAdapter {
  readonly #map = new Map<string, CacheEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  get(key: string): CacheEntry | null {
    const entry = this.#map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.#map.delete(key);
      return null;
    }
    // Refresh LRU position — re-insert moves to the end.
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry;
  }

  set(key: string, value: CacheEntry): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }

  // Test helper — current size.
  get size(): number {
    return this.#map.size;
  }
}
