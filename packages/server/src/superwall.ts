import type { Entitlements } from "@superwall/core";
import { InMemoryCache } from "./cache.ts";
import { fetchEntitlements, type FetcherConfig } from "./fetcher.ts";
import { findMissing, normalizeSpec } from "./spec.ts";
import { makeRequires } from "./requires.ts";
import type {
  CacheAdapter,
  EntitlementSpec,
  RequestInfo,
  RequiresOptions,
  SuperwallInstance,
  SuperwallOptions,
} from "./types.ts";

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Construct a Superwall server instance. One per process — internally
 * shares the cache and outbound HTTP config across all middleware and
 * direct calls.
 *
 * ```ts
 * const sw = Superwall({
 *   apiKey: process.env.SUPERWALL_API_KEY!,
 *   userId: (req) => req.session?.userId ?? null,
 * })
 * ```
 */
export const Superwall = <TReq = unknown>(
  options: SuperwallOptions<TReq>,
): SuperwallInstance<TReq> => {
  if (!options.apiKey || typeof options.apiKey !== "string") {
    throw new TypeError("Superwall: `apiKey` is required.");
  }

  const cacheOpts = options.cache ?? {};
  const ttlMs = cacheOpts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = cacheOpts.maxEntries ?? DEFAULT_CACHE_MAX;
  const cache: CacheAdapter =
    cacheOpts.storage === undefined || cacheOpts.storage === "memory"
      ? new InMemoryCache(maxEntries)
      : cacheOpts.storage;

  const fetcherConfig: FetcherConfig = {
    apiKey: options.apiKey,
    environment: options.environment ?? "release",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  /** Fetch + cache for one userId. Inflight de-dup is intentionally
   *  omitted for v0 — callers rarely concurrently lookup the same user
   *  thousands of times, and the trade-off (extra closure per request)
   *  isn't worth it before we measure. */
  const loadEntitlements = async (userId: string): Promise<{
    entitlements: Entitlements;
    cacheHit: boolean;
  }> => {
    const cached = await cache.get(userId);
    if (cached) return { entitlements: cached.value, cacheHit: true };
    const ents = await fetchEntitlements(fetcherConfig, userId);
    await cache.set(userId, { value: ents, expiresAt: Date.now() + ttlMs });
    return { entitlements: ents, cacheHit: false };
  };

  const emitRequest = (info: RequestInfo): void => {
    if (!options.onRequest) return;
    try {
      options.onRequest(info);
    } catch {
      // Telemetry hooks never break the request.
    }
  };

  const getEntitlements = async (userId: string): Promise<Entitlements> => {
    const start = Date.now();
    const { entitlements, cacheHit } = await loadEntitlements(userId);
    emitRequest({
      userId,
      entitlements: entitlements.active.map((e) => e.id),
      cacheHit,
      durationMs: Date.now() - start,
    });
    return entitlements;
  };

  const userHas = async (
    userId: string,
    spec: EntitlementSpec,
  ): Promise<boolean> => {
    const normalized = normalizeSpec(spec);
    const ents = await getEntitlements(userId);
    return findMissing(normalized, ents).length === 0;
  };

  const invalidate = async (userId: string): Promise<void> => {
    await cache.delete(userId);
  };

  const invalidateAll = async (): Promise<void> => {
    await cache.clear();
  };

  const requires = makeRequires<TReq>({
    defaultUserIdExtractor: options.userId,
    loadEntitlements,
    emitRequest,
  });

  return {
    requires,
    userHas,
    getEntitlements,
    invalidate,
    invalidateAll,
  };
};

// Re-export for tests that need to construct fetcher config directly.
export type { FetcherConfig };
