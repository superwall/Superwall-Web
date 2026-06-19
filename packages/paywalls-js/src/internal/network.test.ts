import { it, expect } from "@effect/vitest";
import { Effect, Either } from "effect";
import { SDK_VERSION } from "../version.ts";
import {
  NetworkDecodingError,
  NetworkRequestError,
} from "./errors.ts";
import { IdentityService, identityWithStorage } from "./identity.ts";
import {
  networkServiceLayer,
  NetworkService,
  resolveHosts,
  type EventEnvelope,
  type NetworkConfig,
} from "./network.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

const mockFetch = (
  responder: (call: RecordedCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
};

const baseConfig = (override: Partial<NetworkConfig> = {}): NetworkConfig => ({
  apiKey: "pk_test_abc",
  environment: "release",
  appVersion: "1.2.3",
  bundleId: "test.example.com",
  urlScheme: "https://test.example.com",
  ...override,
});

const buildStack = (fetchImpl: typeof fetch, configOverride: Partial<NetworkConfig> = {}) => {
  const config: NetworkConfig = { ...baseConfig(configOverride), fetch: fetchImpl };
  const adapter = createMemoryStorage();
  const id = identityWithStorage(StorageService.fromAdapter(adapter));
  return networkServiceLayer(config, id);
};

// ---------------------------------------------------------------------------
// resolveHosts
// ---------------------------------------------------------------------------

it("resolveHosts returns the right base/collector/enrichment per env", () => {
  expect(resolveHosts("release").base).toBe("api.superwall.me");
  expect(resolveHosts("release").collector).toBe("collector.superwall.com");
  expect(resolveHosts("releaseCandidate").base).toBe("api.superwallcanary.com");
  expect(resolveHosts("developer").base).toBe("api.superwall.dev");
  expect(
    resolveHosts({
      custom: {
        base: "api.local",
        collector: "c.local",
        enrichment: "e.local",
        subscriptions: "s.local",
      },
    }).base,
  ).toBe("api.local");
});

// ---------------------------------------------------------------------------
// buildHeaders
// ---------------------------------------------------------------------------

it.effect("buildHeaders includes the §11.3 header set with identity values", () => {
  const { fetch } = mockFetch(() => new Response("{}", { status: 200 }));
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate({ appUserId: "u_42" });
    const net = yield* NetworkService;
    const headers = yield* net.buildHeaders();
    expect(headers.Authorization).toBe("Bearer pk_test_abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Platform"]).toBe("Web");
    expect(headers["X-Platform-Wrapper"]).toBe("Web");
    expect(headers["X-App-User-ID"]).toBe("u_42");
    expect(headers["X-Alias-ID"]).toMatch(/^\$SuperwallAlias:/);
    expect(headers["X-Vendor-ID"]).toMatch(/[0-9a-f-]+/);
    expect(headers["X-App-Version"]).toBe("1.2.3");
    expect(headers["X-Bundle-ID"]).toBe("test.example.com");
    expect(headers["X-URL-Scheme"]).toBe("https://test.example.com");
    expect(headers["X-SDK-Version"]).toBe(SDK_VERSION);
    expect(headers["X-Is-Sandbox"]).toBe("false");
    expect(headers["X-Current-Time"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(headers["X-Device-Locale"]).toBeTruthy();
    expect(headers["X-Device-Language-Code"]).toBeTruthy();
    expect(headers["X-Device-Timezone-Offset"]).toMatch(/^-?\d+$/);
    expect(headers["X-Device-Interface-Style"]).toMatch(/^(light|dark)$/);
  }).pipe(Effect.provide(stack));
});

it.effect("buildHeaders marks custom environments as PRODUCTION (P1)", () => {
  const { fetch } = mockFetch(() => new Response("{}"));
  const stack = buildStack(fetch, {
    environment: {
      custom: {
        base: "api.proxy.example",
        collector: "collector.proxy.example",
        enrichment: "enrich.proxy.example",
        subscriptions: "subs.proxy.example",
      },
    },
  });
  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    const headers = yield* net.buildHeaders();
    // Custom env defaults to production (sandbox=false). Dev sets up their
    // own header override if they need it.
    expect(headers["X-Is-Sandbox"]).toBe("false");
  }).pipe(Effect.provide(stack));
});

it.effect("buildHeaders marks dev/RC environments as sandbox", () => {
  const { fetch } = mockFetch(() => new Response("{}"));
  const stack = buildStack(fetch, { environment: "developer" });

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    const headers = yield* net.buildHeaders();
    expect(headers["X-Is-Sandbox"]).toBe("true");
  }).pipe(Effect.provide(stack));
});

it.effect("buildHeaders accepts extra headers (last wins)", () => {
  const { fetch } = mockFetch(() => new Response("{}"));
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    const headers = yield* net.buildHeaders({
      "X-Extra": "1",
      "X-Platform": "OverriddenPlatform",
    });
    expect(headers["X-Extra"]).toBe("1");
    expect(headers["X-Platform"]).toBe("OverriddenPlatform");
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// getStaticConfig
// ---------------------------------------------------------------------------

it.effect("getStaticConfig hits the right URL with all required headers", () => {
  const { fetch, calls } = mockFetch(
    () => new Response(JSON.stringify({ buildId: "abc" }), { status: 200 }),
  );
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate({ appUserId: "u_42" });
    const net = yield* NetworkService;
    const result = yield* net.getStaticConfig();
    expect(result).toEqual({ buildId: "abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.superwall.me/api/v1/static_config?pk=pk_test_abc",
    );
    expect(calls[0]!.init?.method).toBe("GET");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-App-User-ID"]).toBe("u_42");
    expect(headers["Authorization"]).toBe("Bearer pk_test_abc");
  }).pipe(Effect.provide(stack));
});

it.effect("getStaticConfig URL-encodes the apiKey", () => {
  const { fetch, calls } = mockFetch(() => new Response("{}", { status: 200 }));
  const stack = buildStack(fetch, { apiKey: "pk live/ABC+xyz" });

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    yield* net.getStaticConfig();
    expect(calls[0]!.url).toBe(
      "https://api.superwall.me/api/v1/static_config?pk=pk%20live%2FABC%2Bxyz",
    );
  }).pipe(Effect.provide(stack));
});

it.effect("getStaticConfig surfaces non-2xx as NetworkRequestError with status", () => {
  const { fetch } = mockFetch(
    () => new Response("forbidden", { status: 403 }),
  );
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const net = yield* NetworkService;
      return yield* net.getStaticConfig();
    }).pipe(Effect.either);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NetworkRequestError);
      expect((result.left as NetworkRequestError).status).toBe(403);
      expect((result.left as NetworkRequestError).method).toBe("GET");
    }
  }).pipe(Effect.provide(stack));
});

it.effect("getStaticConfig surfaces fetch rejection as NetworkRequestError without status", () => {
  const { fetch } = mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const net = yield* NetworkService;
      return yield* net.getStaticConfig();
    }).pipe(Effect.either);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NetworkRequestError);
      expect((result.left as NetworkRequestError).status).toBeUndefined();
      expect((result.left as NetworkRequestError).message).toContain("ECONNREFUSED");
    }
  }).pipe(Effect.provide(stack));
});

it.effect("getStaticConfig surfaces invalid JSON as NetworkDecodingError", () => {
  const { fetch } = mockFetch(
    () => new Response("not-json", { status: 200 }),
  );
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const net = yield* NetworkService;
      return yield* net.getStaticConfig();
    }).pipe(Effect.either);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NetworkDecodingError);
    }
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// postEnrichment
// ---------------------------------------------------------------------------

it.effect("postEnrichment POSTs { user, device } to the enrichment host and merges the response", () => {
  const { fetch, calls } = mockFetch(
    () =>
      new Response(JSON.stringify({ user: { plan: "pro" }, device: {} }), {
        status: 200,
      }),
  );
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    const result = yield* net.postEnrichment({
      user: { country: "US" },
      device: { vendorId: "v1" },
    });
    expect(result.user.plan).toBe("pro");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://enrichment-api.superwall.com/api/v1/enrich",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      user: { country: "US" },
      device: { vendorId: "v1" },
    });
  }).pipe(Effect.provide(stack));
});

// Uses real clock (Effect-based 1s timeout needs real time — it.effect uses frozen TestClock)
it("postEnrichment enforces a hard 1s timeout (NetworkRequestError, no hang)", async () => {
  const { fetch } = mockFetch(() => new Promise<Response>(() => {}));
  const stack = buildStack(fetch);

  await Effect.runPromise(
    Effect.gen(function* () {
      const start = Date.now();
      const result = yield* Effect.gen(function* () {
        yield* IdentityService.hydrate();
        const net = yield* NetworkService;
        return yield* net.postEnrichment({ user: {}, device: {} });
      }).pipe(Effect.either);
      const elapsed = Date.now() - start;

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(NetworkRequestError);
        expect((result.left as NetworkRequestError).message).toContain("timed out");
      }
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
    }).pipe(Effect.provide(stack)),
  );
}, 10_000);

// ---------------------------------------------------------------------------
// postEvents
// ---------------------------------------------------------------------------

it.effect("postEvents POSTs the §11.4 envelope to the collector host", () => {
  const { fetch, calls } = mockFetch(() => new Response("", { status: 204 }));
  const stack = buildStack(fetch);

  const events: EventEnvelope[] = [
    {
      event_id: "evt_1",
      event_name: "paywall_open",
      parameters: { paywall_info: { identifier: "pw_1" } },
      created_at: "2026-04-26T12:00:00.000Z",
    },
  ];

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    yield* net.postEvents(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.superwall.com/api/v1/events");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ events });
  }).pipe(Effect.provide(stack));
});

it.effect("postEvents on non-2xx returns NetworkRequestError with status", () => {
  const { fetch } = mockFetch(() => new Response("rate limited", { status: 429 }));
  const stack = buildStack(fetch);

  return Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const net = yield* NetworkService;
      yield* net.postEvents([]);
    }).pipe(Effect.either);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect((result.left as NetworkRequestError).status).toBe(429);
    }
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// custom environment hosts
// ---------------------------------------------------------------------------

it.effect("custom environment routes to the supplied hosts", () => {
  const { fetch, calls } = mockFetch(() => new Response("{}"));
  const stack = buildStack(fetch, {
    environment: {
      custom: {
        base: "api.local.test",
        collector: "collector.local.test",
        enrichment: "enrich.local.test",
        subscriptions: "subs.local.test",
      },
    },
  });

  // Single effect so the same Layer-instantiated services are shared
  // across both calls. (Each Effect.provide materializes the Layer afresh.)
  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const net = yield* NetworkService;
    yield* net.getStaticConfig();
    yield* net.postEvents([]);
    expect(calls[0]!.url).toBe(
      "https://api.local.test/api/v1/static_config?pk=pk_test_abc",
    );
    expect(calls[1]!.url).toBe("https://collector.local.test/api/v1/events");
  }).pipe(Effect.provide(stack));
});
