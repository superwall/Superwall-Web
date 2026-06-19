import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { STORAGE_KEYS } from "../types.ts";
import {
  ConfigService,
  ConfigState,
  ConfigUpdates,
  configServiceLayer,
  extractEntitlementsByProductId,
  extractEntitlementsByReferenceName,
  getConfig,
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
    build_id: "abc123",
    trigger_options: [
      {
        event_name: "checkout",
        rules: [
          {
            experiment_id: "exp_1",
            experiment_group_id: "grp_1",
            expression_cel: "user.plan == 'free'",
            variants: [
              {
                variant_id: "v_a",
                variant_type: "TREATMENT",
                paywall_identifier: "pw_1",
              },
              { variant_id: "v_b", variant_type: "HOLDOUT" },
            ],
          },
        ],
      },
    ],
    paywall_responses: [
      {
        identifier: "pw_1",
        name: "Pro Pricing",
        url: "https://paywalls.superwall.test/pw_1",
        products: [{ product: "primary", product_id: "pro_yearly" }],
        feature_gating: "GATED",
      },
    ],
    products: [
      {
        sw_composite_product_id: "pro_yearly",
        name: "Pro Yearly",
        store_product: { store: "STRIPE", product_identifier: "pro_yearly" },
        entitlements: [{ identifier: "pro", type: "SERVICE_LEVEL" }],
      },
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
  expect(cfg.paywallResponses[0]!.productIds).toEqual(["pro_yearly"]);
  expect(cfg.paywallResponses[0]!.featureGatingBehavior).toBe("gated");
  expect(cfg.products[0]!.id).toBe("pro_yearly");
  expect(cfg.products[0]!.store).toBe("stripe");
  expect(cfg.products[0]!.entitlements).toEqual([{ id: "pro" }]);
  expect(cfg.toggles).toEqual([{ key: "experimentalCheckout", enabled: true }]);
  expect(cfg.locales).toEqual(["en-US", "fr-FR"]);
});

test("parseConfig reads the real snake_case wire shape (trigger_options, paywall_responses, store_product, etc.)", () => {
  const cfg = parseConfig({
    build_id: "wire_build",
    trigger_options: [
      {
        event_name: "test_web",
        rules: [
          {
            experiment_id: "140039",
            experiment_group_id: "83733",
            expression_cel: "size(device.activeEntitlements) == 0",
            variants: [
              { variant_id: "507319", variant_type: "HOLDOUT", percentage: 0 },
              {
                variant_id: "507321",
                variant_type: "TREATMENT",
                percentage: 100,
                paywall_identifier: "new-paywall-38fe-2025-05-08",
              },
            ],
          },
        ],
      },
    ],
    paywall_responses: [
      {
        identifier: "new-paywall-38fe-2025-05-08",
        name: "Stripe Product Example",
        url: "https://user-content.example.com/abc",
        product_ids: ["superwall_pro_3999"],
        feature_gating: "NON_GATED",
      },
    ],
    products: [
      {
        sw_composite_product_id: "superwall_pro_3999",
        store_product: {
          store: "STRIPE",
          product_identifier: "superwall_pro_3999",
        },
        entitlements: [{ identifier: "pro", type: "SERVICE_LEVEL" }],
      },
    ],
  });
  // Triggers
  expect(cfg.triggerOptions).toHaveLength(1);
  expect(cfg.triggerOptions[0]!.placementName).toBe("test_web");
  expect(cfg.triggerOptions[0]!.rules).toHaveLength(1);
  const rule = cfg.triggerOptions[0]!.rules[0]!;
  expect(rule.expression).toBe("size(device.activeEntitlements) == 0");
  expect(rule.experiment.id).toBe("140039");
  expect(rule.experiment.groupId).toBe("83733");
  expect(rule.experiment.variants).toHaveLength(2);
  expect(rule.experiment.variants[0]!.type).toBe("holdout");
  expect(rule.experiment.variants[1]!.type).toBe("treatment");
  expect(rule.experiment.variants[1]!.paywallId).toBe(
    "new-paywall-38fe-2025-05-08",
  );
  // Paywalls
  expect(cfg.paywallResponses).toHaveLength(1);
  expect(cfg.paywallResponses[0]!.identifier).toBe(
    "new-paywall-38fe-2025-05-08",
  );
  expect(cfg.paywallResponses[0]!.url).toBe("https://user-content.example.com/abc");
  expect(cfg.paywallResponses[0]!.productIds).toEqual(["superwall_pro_3999"]);
  expect(cfg.paywallResponses[0]!.featureGatingBehavior).toBe("nonGated");
  // Products
  expect(cfg.products).toHaveLength(1);
  expect(cfg.products[0]!.id).toBe("superwall_pro_3999");
  expect(cfg.products[0]!.store).toBe("stripe");
  expect(cfg.products[0]!.entitlements).toEqual([{ id: "pro" }]);
});

test("parseConfig is lenient — missing arrays default to []", () => {
  const cfg = parseConfig({ build_id: "x" });
  expect(cfg.triggerOptions).toEqual([]);
  expect(cfg.paywallResponses).toEqual([]);
  expect(cfg.products).toEqual([]);
  expect(cfg.toggles).toEqual([]);
  expect(cfg.locales).toEqual([]);
});

test("parseConfig drops malformed entries silently", () => {
  const cfg = parseConfig({
    build_id: "x",
    trigger_options: [
      "string-not-object",
      { event_name: "valid", rules: [] },
      { /* missing event_name */ rules: [] },
      { event_name: "rule-with-bad-experiment", rules: [{ expression_cel: "" }] },
    ],
    paywall_responses: [
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
    build_id: "x",
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
  return { adapter, layer: configServiceLayer("pk_test", upstream) };
};

const sampleConfig = JSON.stringify({
  build_id: "build_1",
  trigger_options: [
    {
      event_name: "checkout",
      rules: [
        {
          experiment_id: "exp_1",
          experiment_group_id: "grp_1",
          expression_cel: "user.plan == 'free'",
          variants: [],
        },
      ],
    },
  ],
  paywall_responses: [
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

// ---------------------------------------------------------------------------
// ConfigState actor — pure reducers + transition observability
// ---------------------------------------------------------------------------

test("extractEntitlementsByProductId: builds productId → entitlementIds map", () => {
  const map = extractEntitlementsByProductId([
    { id: "pro_yearly", entitlements: [{ id: "pro" }] },
    { id: "pro_monthly", entitlements: [{ id: "pro" }] },
    { id: "vip", entitlements: [{ id: "pro" }, { id: "vip_only" }] },
    { id: "no_entitlements" },
  ]);
  expect(map.get("pro_yearly")).toEqual(["pro"]);
  expect(map.get("pro_monthly")).toEqual(["pro"]);
  expect(map.get("vip")).toEqual(["pro", "vip_only"]);
  expect(map.has("no_entitlements")).toBe(false);
});

test("extractEntitlementsByProductId: empty input → empty map", () => {
  expect(extractEntitlementsByProductId([]).size).toBe(0);
});

test("extractEntitlementsByReferenceName: builds reference_name → entitlementIds map from per-paywall productsV2", () => {
  const map = extractEntitlementsByReferenceName([
    {
      identifier: "pw_a",
      name: "A",
      url: "https://x",
      productIds: [],
      productsV2: [
        {
          reference_name: "primary",
          entitlements: [{ identifier: "pro" }, { identifier: "premium" }],
        },
        { reference_name: "secondary", entitlements: [{ identifier: "basic" }] },
        // No entitlements → skipped.
        { reference_name: "tertiary", entitlements: [] },
      ],
    },
    {
      identifier: "pw_b",
      name: "B",
      url: "https://y",
      productIds: [],
      productsV2: [
        { reference_name: "primary", entitlements: [{ identifier: "pro" }] },
      ],
    },
  ]);
  expect(map.get("primary")).toEqual(["pro"]);
  expect(map.get("secondary")).toEqual(["basic"]);
  expect(map.has("tertiary")).toBe(false);
});

test("ConfigUpdates.SetRetrieving transitions any prior state to Retrieving", () => {
  expect(ConfigUpdates.SetRetrieving(ConfigState.None)).toEqual({
    _tag: "Retrieving",
  });
  expect(
    ConfigUpdates.SetRetrieving(ConfigState.Failed(new Error("x"), 3)),
  ).toEqual({ _tag: "Retrieving" });
});

test("ConfigUpdates.SetRetrieved replaces any prior state with the new config", () => {
  const cfg = { buildId: "b" } as unknown as RawConfig;
  expect(ConfigUpdates.SetRetrieved(cfg)(ConfigState.Retrieving)).toEqual({
    _tag: "Retrieved",
    config: cfg,
  });
});

test("ConfigUpdates.SetFailed carries error + retryCount", () => {
  const err = new Error("boom");
  expect(ConfigUpdates.SetFailed(err, 2)(ConfigState.Retrieving)).toEqual({
    _tag: "Failed",
    error: err,
    retryCount: 2,
  });
});

test("getConfig: only Retrieved yields the underlying config", () => {
  const cfg = { buildId: "b" } as unknown as RawConfig;
  expect(getConfig(ConfigState.None)).toBeNull();
  expect(getConfig(ConfigState.Retrieving)).toBeNull();
  expect(getConfig(ConfigState.Retrying)).toBeNull();
  expect(getConfig(ConfigState.Retrieved(cfg))).toBe(cfg);
  expect(getConfig(ConfigState.Failed(new Error("x")))).toBeNull();
});

test("ConfigService.fetch transitions None → Retrieved on success", async () => {
  const { layer } = buildStack(
    mockFetch(() => new Response(sampleConfig, { status: 200 })),
  );
  const final = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      const before = yield* c.state();
      expect(before._tag).toBe("None");
      yield* c.fetch();
      return yield* c.state();
    }).pipe(Effect.provide(layer)) as Effect.Effect<ConfigState, never, never>,
  );
  expect(final._tag).toBe("Retrieved");
});

test("ConfigService.fetch surfaces Retrying between attempts (fail → retry → succeed)", async () => {
  // Capture the state tag observed at the *first* failed attempt — by then
  // the fetch is mid-flight and the second attempt hasn't started yet.
  let calls = 0;
  let stateAtSecondAttempt: ConfigState | null = null;
  const responder = async () => {
    calls++;
    if (calls === 1) return new Response("nope", { status: 500 });
    // Slow second attempt so the poller can observe Retrying.
    await new Promise<void>((r) => setTimeout(r, 30));
    return new Response(sampleConfig, { status: 200 });
  };
  const { layer } = buildStack(mockFetch(responder));
  const final = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      // Snapshot state from inside fetch's lifetime — fork a poller that
      // captures whatever tag is set at the moment the second network call
      // fires. We poll because we don't own the network mock's await point.
      const poll: Effect.Effect<void> = Effect.gen(function* () {
        while (true) {
          if (calls >= 2 && stateAtSecondAttempt === null) {
            stateAtSecondAttempt = yield* c.state();
            return;
          }
          yield* Effect.sleep("1 millis");
        }
      });
      const fiber = yield* Effect.fork(poll);
      yield* c.fetch();
      yield* fiber;
      return yield* c.state();
    }).pipe(Effect.provide(layer)) as Effect.Effect<ConfigState, never, never>,
  );
  expect(final._tag).toBe("Retrieved");
  expect(calls).toBe(2);
  // Between attempts the actor is in Retrying.
  expect(stateAtSecondAttempt?._tag).toBe("Retrying");
});

test("ConfigService.fetch transitions to Failed on fetch error", async () => {
  const { layer } = buildStack(
    mockFetch(() => new Response("nope", { status: 500 })),
  );
  const final = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      yield* c.fetch().pipe(Effect.either);
      return yield* c.state();
    }).pipe(Effect.provide(layer)) as Effect.Effect<ConfigState, never, never>,
  );
  expect(final._tag).toBe("Failed");
});

test("ConfigService: reset queued behind a slow fetch lands strictly after it", async () => {
  // Slow fetch (resolves after 50ms) + immediate reset(). The serializer
  // must run reset *after* fetch finishes; otherwise reset would clobber
  // the about-to-be-set Retrieved state and we'd be stuck somewhere weird.
  const fetchImpl = mockFetch(async () => {
    await new Promise<void>((r) => setTimeout(r, 50));
    return new Response(sampleConfig, { status: 200 });
  });
  const { layer } = buildStack(fetchImpl);
  const finalState = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      // Fire fetch + reset concurrently. Both go through the same
      // serializer; reset queues behind fetch.
      yield* Effect.all([c.fetch().pipe(Effect.either), c.reset()], {
        concurrency: "unbounded",
      });
      return yield* c.state();
    }).pipe(Effect.provide(layer)) as Effect.Effect<ConfigState, never, never>,
  );
  // After the fetch+reset sequence, state must end up at None (reset wins
  // because it ran second per arrival order).
  expect(finalState._tag).toBe("None");
});

test("ConfigService.fetch concurrent calls serialize through the actor", async () => {
  // Two concurrent fetches each hit the network — the semaphore queues
  // them serially, but each runs to completion. (We dropped the
  // dedup-on-Retrieved short-circuit because it silently no-op'd
  // intentional refresh calls; serialization alone preserves ordering.)
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = mockFetch(async () => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(sampleConfig, { status: 200 });
  });
  const { layer } = buildStack(fetchImpl);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      const [a, b] = yield* Effect.all([c.fetch(), c.fetch()], {
        concurrency: "unbounded",
      });
      expect(a.buildId).toBe(b.buildId);
    }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>,
  );
  expect(calls).toBe(2);
  // Strict serialization — never two fetches in flight at the same time.
  expect(maxInFlight).toBe(1);
});

test("ConfigService.hydrateFromStorage seeds the actor in Retrieved", async () => {
  const { adapter, layer } = buildStack(
    mockFetch(() => Promise.reject(new Error("offline"))),
  );
  await adapter.set(
    STORAGE_KEYS.config,
    JSON.stringify({
      buildId: "cached_build",
      payload: JSON.parse(sampleConfig),
    }),
  );
  const final = await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const c = yield* ConfigService;
      yield* c.hydrateFromStorage();
      return yield* c.state();
    }).pipe(Effect.provide(layer)) as Effect.Effect<ConfigState, never, never>,
  );
  expect(final._tag).toBe("Retrieved");
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

test("parseConfig parses paywall.surveys with snake_case wire fields", () => {
  const cfg = parseConfig({
    build_id: "b",
    paywall_responses: [
      {
        identifier: "pw_1",
        url: "https://paywalls.example/pw_1",
        surveys: [
          {
            id: "s_1",
            assignment_key: "ak_1",
            title: "Why are you leaving?",
            message: "Pick one",
            options: [{ id: "a", title: "Too expensive" }],
            presentation_condition: "ON_MANUAL_CLOSE",
            presentation_probability: 0.5,
            include_other_option: true,
            include_close_option: true,
          },
        ],
      },
    ],
  });
  const surveys = cfg.paywallResponses[0]!.surveys;
  expect(surveys).toHaveLength(1);
  expect(surveys![0]).toEqual({
    id: "s_1",
    assignmentKey: "ak_1",
    title: "Why are you leaving?",
    message: "Pick one",
    options: [{ id: "a", title: "Too expensive" }],
    presentationCondition: "ON_MANUAL_CLOSE",
    presentationProbability: 0.5,
    includeOtherOption: true,
    includeCloseOption: true,
  });
});

test("parseConfig skips surveys without required fields", () => {
  const cfg = parseConfig({
    build_id: "b",
    paywall_responses: [
      {
        identifier: "pw_1",
        url: "https://x",
        surveys: [
          { /* no id */ assignment_key: "ak_1", title: "t", message: "m", presentation_condition: "ON_PURCHASE" },
          { id: "s_2", /* no assignmentKey */ title: "t", message: "m", presentation_condition: "ON_PURCHASE" },
          { id: "s_3", assignment_key: "ak_3", title: "t", message: "m", presentation_condition: "INVALID" },
        ],
      },
    ],
  });
  expect(cfg.paywallResponses[0]!.surveys ?? []).toHaveLength(0);
});

test("parseConfig clamps presentation_probability to [0,1]", () => {
  const cfg = parseConfig({
    build_id: "b",
    paywall_responses: [
      {
        identifier: "pw_1",
        url: "https://x",
        surveys: [
          {
            id: "s_lo",
            assignment_key: "ak_lo",
            title: "t",
            message: "m",
            presentation_condition: "ON_PURCHASE",
            presentation_probability: -1,
          },
          {
            id: "s_hi",
            assignment_key: "ak_hi",
            title: "t",
            message: "m",
            presentation_condition: "ON_PURCHASE",
            presentation_probability: 5,
          },
        ],
      },
    ],
  });
  const surveys = cfg.paywallResponses[0]!.surveys!;
  expect(surveys[0]!.presentationProbability).toBe(0);
  expect(surveys[1]!.presentationProbability).toBe(1);
});
