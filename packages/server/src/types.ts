import type { Entitlements, NetworkEnvironment } from "@superwall/core";

/**
 * Entitlement spec accepted by `sw.requires()` and `sw.userHas()`.
 *
 * - `"pro"` — single entitlement (must be active)
 * - `["pro", "team"]` — multiple entitlements, ALL required
 * - `{ all: [...] }` — explicit AND
 * - `{ any: [...] }` — OR (any of the listed must be active)
 */
export type EntitlementSpec =
  | string
  | ReadonlyArray<string>
  | { readonly all: ReadonlyArray<string> }
  | { readonly any: ReadonlyArray<string> };

/**
 * Cache adapter shape. The built-in `"memory"` storage implements this.
 * Plug in Redis, KV, or any async store with the same surface.
 *
 * Keys are app-user IDs. Values are the parsed Entitlements bucket plus
 * the timestamp it expires at.
 */
export interface CacheAdapter {
  get(key: string): Promise<CacheEntry | null> | CacheEntry | null;
  set(key: string, value: CacheEntry): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface CacheEntry {
  readonly value: Entitlements;
  readonly expiresAt: number;
}

export interface CacheOptions {
  /** Time-to-live in milliseconds. Default 60_000 (60s). */
  ttlMs?: number;
  /** LRU cap; oldest evicted first. Default 10_000. */
  maxEntries?: number;
  /** `"memory"` or a custom adapter. Default `"memory"`. */
  storage?: "memory" | CacheAdapter;
}

/**
 * Extracts the user identifier from whatever request shape your framework
 * uses. Safety-critical knob: read from authenticated session, never from
 * request body / query string / unverified header.
 */
export type UserIdExtractor<TReq = unknown> = (
  req: TReq,
) => string | null | undefined | Promise<string | null | undefined>;

export interface RequestInfo {
  readonly userId: string;
  readonly entitlements: ReadonlyArray<string>;
  readonly cacheHit: boolean;
  readonly durationMs: number;
}

export interface SuperwallOptions<TReq = unknown> {
  /** Superwall API key. Read from `process.env.SUPERWALL_API_KEY`. */
  apiKey: string;
  /** Environment selector. Default `"release"`. */
  environment?: NetworkEnvironment;
  cache?: CacheOptions;
  /** Default userId extractor; can be overridden per-call on `requires()`. */
  userId?: UserIdExtractor<TReq>;
  /** Hook invoked after every entitlement check. Use for tracing. */
  onRequest?: (info: RequestInfo) => void;
  /** Request timeout in milliseconds for outbound calls to Superwall. Default 5_000. */
  timeoutMs?: number;
}

/**
 * Narrow internal `fetch` surface. Not exported as a public option — server
 * runtimes (Node 18+, Bun, Deno, Workers) all carry `globalThis.fetch`
 * natively, and unlike the browser there's no CORS proxy use case. Tests
 * stub `globalThis.fetch` directly.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// Connect-style middleware signature — req/res/next, duck-typed. Compatible
// with Express, Connect, and shimmable from Bun.serve / Hono / Next.

export interface ConnectStyleResponse {
  status(code: number): ConnectStyleResponse;
  json(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
}

export type ConnectStyleNext = (err?: unknown) => void;

export type ConnectStyleRequest = Record<string, unknown>;

export interface UnauthorizedContext {
  readonly userId: string | null;
  readonly entitlement: string;
  readonly missing: ReadonlyArray<string>;
  readonly reason: "no_user_id" | "not_entitled";
}

export interface RequiresOptions<TReq = unknown> {
  /** Per-route userId override (rare). */
  userId?: UserIdExtractor<TReq>;
  /**
   * Custom rejection handler. Default: respond `403 { error:
   * "entitlement_required", entitlement }`.
   */
  onUnauthorized?: (
    req: TReq,
    res: ConnectStyleResponse,
    ctx: UnauthorizedContext,
  ) => void | Promise<void>;
  /**
   * Allow anonymous requests (no userId extracted) to fall through to the
   * route handler. Defaults to `false` — fail closed. Set `true` when the
   * route handler itself decides what to render for guests vs. entitled users.
   */
  allowAnonymous?: boolean;
}

// The object returned by Superwall(options). Methods bind back to the
// shared cache + fetcher so a single instance fronts the entire process.
export interface SuperwallInstance<TReq = unknown> {
  requires(
    spec: EntitlementSpec,
    options?: RequiresOptions<TReq>,
  ): (req: TReq, res: ConnectStyleResponse, next: ConnectStyleNext) => Promise<void>;
  userHas(userId: string, spec: EntitlementSpec): Promise<boolean>;
  getEntitlements(userId: string): Promise<Entitlements>;
  invalidate(userId: string): Promise<void>;
  invalidateAll(): Promise<void>;
}
