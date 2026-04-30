import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { STORAGE_KEYS } from "../types.ts";
import {
  ConfigService,
  configServiceLayer,
  parseConfig,
  type RawConfig,
} from "./config.ts";
import { ConfigParseError } from "./errors.ts";
import {
  IdentityService,
  identityWithStorage,
} from "./identity.ts";
import {
  networkServiceLayer,
  type NetworkConfig,
} from "./network.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

// ---------------------------------------------------------------------------
// parseConfig — unit tests for the lenient parser
// ---------------------------------------------------------------------------

test("parseConfig lifts top-level fields", () => {
  const cfg = parseConfig({
    buildId: "abc123",
    triggerOptions: [
      {
        placementName: "checkout",
        rules: [
          {
            expression: "user.plan == 'free'",
            experiment: {
              id: "exp_1",
              groupId: "grp_1",
              variants: [
                { id: "v_a", type: "treatment", paywallId: "pw_1" },
                { id: "v_b", type: "holdout" },
              ],
            },
          },
        ],
      },
    ],
    paywallResponses: [
      {
        identifier: "pw_1",
        name: "Pro Pricing",
        url: "https://paywalls.superwall.test/pw_1",
        productIds: ["pro_yearly"],
        featureGatingBehavior: "gated",
      },
    ],
    products: [
      { id: "pro_yearly", name: "Pro Yearly", store: "stripe", entitlements: [{ id: "pro" }] },
    ],
    toggles: [{ key: "experimentalCheckout", enabled: true }],
    localization: { locales: [{ locale: "en-US" }, { locale: "fr-FR" }] },
  });

  expect(cfg.buildId).toBe("abc123");
  expect(cfg.triggerOptions).toHaveLength(1);
  expect(cfg.triggerOptions[0]!.placementName).toBe("checkout");
  expect(cfg.triggerOptions[0]!.rules[0]!.experiment.id).toBe("exp_1");
  expect(cfg.triggerOptions[0]!.rules[0]!.experiment.variants).toHaveLength(2);
  expect(cfg.paywallResponses[0]!.identifier).toBe("pw_1");
  expect(cfg.paywallResponses[0]!.featureGatingBehavior).toBe("gated");
  expect(cfg.products[0]!.id).toBe("pro_yearly");
  expect(cfg.products[0]!.entitlements).toEqual([{ id: "pro" }]);
  expect(cfg.toggles).toEqual([{ key: "experimentalCheckout", enabled: true }]);
  expect(cfg.locales).toEqual(["en-US", "fr-FR"]);
});

test("parseConfig accepts the legacy `build_id` snake_case key", () => {
  const cfg = parseConfig({ build_id: "snake" });
  expect(cfg.buildId).toBe("snake");
});

test("parseConfig is lenient — missing arrays default to []", () => {
  const cfg = parseConfig({ buildId: "x" });
  expect(cfg.triggerOptions).toEqual([]);
  expect(cfg.paywallResponses).toEqual([]);
  expect(cfg.products).toEqual([]);
  expect(cfg.toggles).toEqual([]);
  expect(cfg.locales).toEqual([]);
});

test("parseConfig drops malformed entries silently", () => {
  const cfg = parseConfig({
    buildId: "x",
    triggerOptions: [
      "string-not-object",
      { placementName: "valid", rules: [] },
      { /* missing placementName */ rules: [] },
      { placementName: "rule-with-bad-experiment", rules: [{ expression: "" }] },
    ],
    paywallResponses: [
      { identifier: "kept", url: "https://x" },
      { /* missing identifier */ url: "https://y" },
    ],
  });
  expect(cfg.triggerOptions.map((t) => t.placementName)).toEqual([
    "valid",
    "rule-with-bad-experiment",
  ]);
  // The rule with no experiment got dropped from rules[].
  expect(cfg.triggerOptions[1]!.rules).toHaveLength(0);
  expect(cfg.paywallResponses).toHaveLength(1);
  expect(cfg.paywallResponses[0]!.identifier).toBe("kept");
});

test("parseConfig throws ConfigParseError when the input isn't an object", () => {
  expect(() => parseConfig("nope" as never)).toThrow(ConfigParseError);
  expect(() => parseConfig(null as never)).toThrow(ConfigParseError);
});

test("parseConfig throws ConfigParseError when buildId is missing", () => {
  expect(() => parseConfig({ triggerOptions: [] } as never)).toThrow(
    ConfigParseError,
  );
});

test("parseConfig preserves unknown top-level fields on .raw", () => {
  const cfg = parseConfig({
    buildId: "x",
    web2app_config: { someField: 1 },
    prioritized_campaign_id: "campaign_42",
  });
  expect(cfg.raw["web2app_config"]).toEqual({ someField: 1 });
  expect(cfg.raw["prioritized_campaign_id"]).toBe("campaign_42");
});

// ---------------------------------------------------------------------------
// ConfigService — service-level tests with mock NetworkService
// ---------------------------------------------------------------------------

const mockFetch = (
  responder: () => Response | Promise<Response>,
): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) return responder();
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;

const buildStack = (fetchImpl: typeof fetch) => {
  const adapter = createMemoryStorage();
  const storage = StorageService.fromAdapter(adapter);
  const identity = identityWithStorage(storage);
  const networkConfig: NetworkConfig = {
    apiKey: "pk_test",
    environment: "release",
    fetch: fetchImpl,
  };
  const network = networkServiceLayer(networkConfig, identity);
  const upstream = Layer.merge(network, storage);
  return { adapter, layer: configServiceLayer(upstream) };
};

const sampleConfig = JSON.stringify({
  buildId: "build_1",
  triggerOptions: [
    {
      placementName: "checkout",
      rules: [
        {
          expression: "user.plan == 'free'",
          experiment: { id: "exp_1", groupId: "grp_1", variants: [] },
        },
      ],
    },
  ],
  paywallResponses: [
    { identifier: "pw_1", url: "https://paywalls.superwall.test/pw_1" },
  ],
  products: [],
  toggles: [],
  localization: { locales: [{ locale: "en-US" }] },
});

test("ConfigService.fetch hits the network, parses, and caches to storage", async () => {
  const { adapter, layer } = buildStack(
    mockFetch(() => new Response(sampleConfig, { status: 200 })),
  );

  const cfg = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      return yield* c.fetch();
    }).pipe(Effect.provide(layer)) as Effect.Effect<RawConfig, never, never>,
  );

  expect(cfg.buildId).toBe("build_1");
  expect(cfg.triggerOptions[0]!.placementName).toBe("checkout");

  // Persisted to storage for offline replay.
  const cached = await adapter.get(STORAGE_KEYS.config);
  expect(cached).not.toBeNull();
  const decoded = JSON.parse(cached!) as { buildId: string };
  expect(decoded.buildId).toBe("build_1");
});

test("ConfigService.hydrateFromStorage replays a cached config without a network call", async () => {
  const { adapter, layer } = buildStack(
    mockFetch(() => Promise.reject(new Error("offline"))),
  );
  // Pre-seed the cache as if a previous session wrote it.
  await adapter.set(
    STORAGE_KEYS.config,
    JSON.stringify({
      buildId: "cached_build",
      payload: JSON.parse(sampleConfig),
    }),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      return yield* c.hydrateFromStorage();
    }).pipe(Effect.provide(layer)) as Effect.Effect<RawConfig | null, never, never>,
  );

  expect(result).not.toBeNull();
  expect(result!.buildId).toBe("build_1"); // from the inner payload
  expect(result!.triggerOptions[0]!.placementName).toBe("checkout");
});

test("ConfigService.hydrateFromStorage returns null when no cache exists", async () => {
  const { layer } = buildStack(mockFetch(() => new Response("", { status: 204 })));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      return yield* c.hydrateFromStorage();
    }).pipe(Effect.provide(layer)) as Effect.Effect<RawConfig | null, never, never>,
  );
  expect(result).toBeNull();
});

test("ConfigService.getPlacement returns the parsed trigger when found", async () => {
  const { layer } = buildStack(
    mockFetch(() => new Response(sampleConfig, { status: 200 })),
  );
  const trigger = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      yield* c.fetch();
      return yield* c.getPlacement("checkout");
    }).pipe(Effect.provide(layer)) as Effect.Effect<unknown, never, never>,
  );
  expect(trigger).not.toBeNull();
  expect((trigger as { placementName: string }).placementName).toBe("checkout");
});

test("ConfigService.getPlacement returns null for unknown placement", async () => {
  const { layer } = buildStack(
    mockFetch(() => new Response(sampleConfig, { status: 200 })),
  );
  const trigger = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      yield* c.fetch();
      return yield* c.getPlacement("nonexistent");
    }).pipe(Effect.provide(layer)) as Effect.Effect<unknown, never, never>,
  );
  expect(trigger).toBeNull();
});

test("ConfigService.fetch failure on a malformed payload surfaces ConfigParseError", async () => {
  const { layer } = buildStack(
    mockFetch(() => new Response("[]", { status: 200 })), // array, not object
  );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      return yield* c.fetch();
    }).pipe(Effect.provide(layer)) as Effect.Effect<unknown, ConfigParseError, never>,
  );
  expect(exit._tag).toBe("Failure");
});

test("ConfigService.reset wipes both ref + storage", async () => {
  const { adapter, layer } = buildStack(
    mockFetch(() => new Response(sampleConfig, { status: 200 })),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      yield* c.fetch();
      yield* c.reset();
      const after = yield* c.current();
      expect(after).toBeNull();
    }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>,
  );
  expect(await adapter.get(STORAGE_KEYS.config)).toBeNull();
});
