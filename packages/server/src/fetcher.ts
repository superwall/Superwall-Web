import {
  parseEntitlements,
  resolveHosts,
  SuperwallAuthError,
  SuperwallDecodingError,
  SuperwallNetworkError,
  SuperwallNotFoundError,
  SuperwallTimeoutError,
  type Entitlements,
  type NetworkEnvironment,
  type WebEntitlementsResponse,
} from "@superwall/core";
import type { FetchLike } from "./types.ts";

const SDK_VERSION = "0.0.0";

export interface FetcherConfig {
  readonly apiKey: string;
  readonly environment: NetworkEnvironment;
  readonly timeoutMs: number;
}

const requireFetch = (): FetchLike => {
  if (typeof globalThis !== "undefined" && "fetch" in globalThis) {
    return globalThis.fetch.bind(globalThis) as FetchLike;
  }
  throw new SuperwallNetworkError(
    "No fetch implementation available — Superwall needs `globalThis.fetch` (Node 18+, Bun, Deno, Workers).",
  );
};

/**
 * GET /subscriptions-api/public/v1/users/{userId}/entitlements
 *
 * Maps status codes to typed error classes. Returns the parsed
 * Entitlements bucket on success.
 */
export const fetchEntitlements = async (
  cfg: FetcherConfig,
  userId: string,
): Promise<Entitlements> => {
  const hosts = resolveHosts(cfg.environment);
  const url = `https://${hosts.subscriptions}/subscriptions-api/public/v1/users/${encodeURIComponent(userId)}/entitlements`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    "X-Platform": "Server",
    "X-Platform-Environment": "SDK",
    "X-Platform-Wrapper": "Server",
    "X-SDK-Version": SDK_VERSION,
    "X-App-User-ID": userId,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let response: Response;
  try {
    response = await requireFetch()(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(timer);
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new SuperwallTimeoutError(
        `Entitlements request timed out after ${cfg.timeoutMs}ms`,
        { url, timeoutMs: cfg.timeoutMs },
      );
    }
    throw new SuperwallNetworkError(
      `Entitlements network error: ${describe(cause)}`,
      { url, cause },
    );
  }
  clearTimeout(timer);

  if (response.status === 401 || response.status === 403) {
    throw new SuperwallAuthError(
      `Entitlements auth failed (status ${response.status}). Check SUPERWALL_API_KEY.`,
      { url },
    );
  }
  if (response.status === 404) {
    throw new SuperwallNotFoundError(
      `Entitlements lookup returned 404 for user ${userId}.`,
      { url },
    );
  }
  if (!response.ok) {
    throw new SuperwallNetworkError(
      `Entitlements returned ${response.status}`,
      { url, status: response.status },
    );
  }

  let body: WebEntitlementsResponse;
  try {
    body = (await response.json()) as WebEntitlementsResponse;
  } catch (cause) {
    throw new SuperwallDecodingError(
      `Entitlements JSON decode failed: ${describe(cause)}`,
      { url, cause },
    );
  }

  return parseEntitlements(body);
};

const describe = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : JSON.stringify(cause);
