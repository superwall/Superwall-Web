import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SuperwallAuthError,
  SuperwallDecodingError,
  SuperwallNetworkError,
  SuperwallNotFoundError,
  SuperwallTimeoutError,
} from "@superwall/core";
import { fetchEntitlements, type FetcherConfig } from "./fetcher.ts";
import type { FetchLike } from "./types.ts";

const realFetch = globalThis.fetch;
const setFetch = (impl: FetchLike): void => {
  (globalThis as unknown as { fetch: FetchLike }).fetch = impl;
};

interface MockResponseInit {
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
}

const mockResponse = (init: MockResponseInit = {}): Response => {
  const status = init.status ?? 200;
  const body: string | null =
    init.json !== undefined ? JSON.stringify(init.json) : null;
  const res = new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
  if (init.jsonThrows) {
    Object.defineProperty(res, "json", {
      value: () => Promise.reject(new SyntaxError("bad json")),
    });
  }
  return res;
};

const baseConfig = (overrides: Partial<FetcherConfig> = {}): FetcherConfig => ({
  apiKey: "key_test",
  environment: "release",
  timeoutMs: 1000,
  ...overrides,
});

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

afterEach(() => {
  (globalThis as unknown as { fetch: typeof realFetch }).fetch = realFetch;
});

describe("fetchEntitlements", () => {
  test("parses customerInfo.entitlements envelope", async () => {
    setFetch(async () =>
      mockResponse({
        json: {
          customerInfo: {
            entitlements: [
              { id: "pro", isActive: true, productIds: ["p1"] },
              { id: "team", isActive: false, productIds: [] },
            ],
          },
        },
      }),
    );
    const ents = await fetchEntitlements(baseConfig(), "user_1");
    expect(ents.active.map((e) => e.id)).toEqual(["pro"]);
    expect(ents.inactive.map((e) => e.id)).toEqual(["team"]);
    expect(ents.all).toHaveLength(2);
  });

  test("parses top-level entitlements array", async () => {
    setFetch(async () =>
      mockResponse({
        json: {
          entitlements: [{ id: "pro", isActive: true, productIds: [] }],
        },
      }),
    );
    const ents = await fetchEntitlements(baseConfig(), "user_1");
    expect(ents.active.map((e) => e.id)).toEqual(["pro"]);
  });

  test("encodes the userId in the URL path", async () => {
    let calledUrl = "";
    setFetch(async (input) => {
      calledUrl = urlOf(input);
      return mockResponse({ json: { entitlements: [] } });
    });
    await fetchEntitlements(baseConfig(), "user/special:1");
    expect(calledUrl).toContain("/users/user%2Fspecial%3A1/entitlements");
  });

  test("includes Authorization and X-App-User-ID headers", async () => {
    let calledHeaders: Headers | null = null;
    setFetch(async (_input, init) => {
      calledHeaders = new Headers(init?.headers);
      return mockResponse({ json: { entitlements: [] } });
    });
    await fetchEntitlements(baseConfig(), "user_1");
    expect(calledHeaders!.get("authorization")).toBe("Bearer key_test");
    expect(calledHeaders!.get("x-app-user-id")).toBe("user_1");
    expect(calledHeaders!.get("x-platform")).toBe("Server");
  });

  test("401 → SuperwallAuthError", async () => {
    setFetch(async () => mockResponse({ status: 401 }));
    await expect(fetchEntitlements(baseConfig(), "u")).rejects.toBeInstanceOf(
      SuperwallAuthError,
    );
  });

  test("403 → SuperwallAuthError", async () => {
    setFetch(async () => mockResponse({ status: 403 }));
    await expect(fetchEntitlements(baseConfig(), "u")).rejects.toBeInstanceOf(
      SuperwallAuthError,
    );
  });

  test("404 → SuperwallNotFoundError", async () => {
    setFetch(async () => mockResponse({ status: 404 }));
    await expect(fetchEntitlements(baseConfig(), "u")).rejects.toBeInstanceOf(
      SuperwallNotFoundError,
    );
  });

  test("500 → SuperwallNetworkError with status", async () => {
    setFetch(async () => mockResponse({ status: 500 }));
    try {
      await fetchEntitlements(baseConfig(), "u");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SuperwallNetworkError);
      expect((err as SuperwallNetworkError).status).toBe(500);
    }
  });

  test("fetch throw → SuperwallNetworkError", async () => {
    setFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchEntitlements(baseConfig(), "u")).rejects.toBeInstanceOf(
      SuperwallNetworkError,
    );
  });

  test("AbortError → SuperwallTimeoutError", async () => {
    setFetch(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(
      fetchEntitlements(baseConfig({ timeoutMs: 5 }), "u"),
    ).rejects.toBeInstanceOf(SuperwallTimeoutError);
  });

  test("malformed JSON → SuperwallDecodingError", async () => {
    setFetch(async () => mockResponse({ jsonThrows: true }));
    await expect(fetchEntitlements(baseConfig(), "u")).rejects.toBeInstanceOf(
      SuperwallDecodingError,
    );
  });

  test("uses the configured environment for the host", async () => {
    let calledUrl = "";
    setFetch(async (input) => {
      calledUrl = urlOf(input);
      return mockResponse({ json: { entitlements: [] } });
    });
    await fetchEntitlements(baseConfig({ environment: "developer" }), "u");
    expect(calledUrl).toContain("subscriptions-api.superwall.dev");
  });
});
