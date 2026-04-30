// ConfigService — fetches /api/v1/static_config, parses to typed Config
// objects, caches by buildId in storage for revalidation.
//
// v0 design notes:
// - The parsed shape mirrors Android's `Config.kt` only at the level we
//   actually consume in v0. Unknown fields are preserved as `unknown` on
//   the raw payload so downstream evaluators can read them without us
//   having to model every nested record up front.
// - Cache strategy: on fetch, write `{buildId, payload}` to storage under
//   `STORAGE_KEYS.config`. On next configure(), replay it (so offline-
//   first works); then attempt a revalidating fetch in the background
//   (the BE returns 304-equivalent semantics via `X-Static-Config-Build-Id`
//   on responses — handled by NetworkService caching, not here).
// - Audience-rule evaluation reads from this service via getPlacement(name)
//   to find the trigger's audience expression. The CEL evaluator itself is
//   still deferred (MISSING.md → Real placement evaluation).
//
// Internal-only — not exported from the package barrel.

import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { STORAGE_KEYS, type JsonValue } from "../types.ts";
import { asStorageKey } from "./brands.ts";
import { ConfigParseError } from "./errors.ts";
import { NetworkService } from "./network.ts";
import { StorageService } from "./storage.ts";

const CONFIG_KEY = asStorageKey(STORAGE_KEYS.config);

// ---------------------------------------------------------------------------
// Parsed config shape
// ---------------------------------------------------------------------------

/**
 * Top-level parsed config. Wire shape from the backend (matches Android
 * `Config.kt` field names; deserialized from `static_config` response).
 */
export interface RawConfig {
  readonly buildId: string;
  /**
   * Trigger options — one entry per placement. Each has a name + audience
   * filter list + experiment refs. Modeled loosely so v0 can do
   * `placementExists(name)` lookups without committing to the full
   * audience/experiment tree shape.
   */
  readonly triggerOptions: ReadonlyArray<RawTrigger>;
  /** Paywall response definitions (id → URL + metadata). Indexed by
   *  `identifier`. */
  readonly paywallResponses: ReadonlyArray<RawPaywallResponse>;
  /** Catalog products (id + price + entitlement metadata). */
  readonly products: ReadonlyArray<RawProductItem>;
  /** Feature toggles. */
  readonly toggles: ReadonlyArray<{ key: string; enabled: boolean }>;
  /** Locale list the BE supports. */
  readonly locales: ReadonlyArray<string>;
  /** Anything else the BE returns — preserved as `unknown` so downstream
   *  evaluators can read it without us modeling every shape. */
  readonly raw: Record<string, JsonValue>;
}

export interface RawTrigger {
  readonly placementName: string;
  /** Audience filter list (CEL expressions per Android). v0 stores raw
   *  strings + the experiment ref; CEL evaluator is deferred. */
  readonly rules: ReadonlyArray<RawAudienceRule>;
}

export interface RawAudienceRule {
  /** CEL expression string. Empty string ⇒ matches all. */
  readonly expression: string;
  /** Experiment to assign on match. */
  readonly experiment: RawExperimentRef;
}

export interface RawExperimentRef {
  readonly id: string;
  readonly groupId: string;
  /** Variant pool — assignment picker chooses one based on percent rollout. */
  readonly variants: ReadonlyArray<{
    readonly id: string;
    readonly type: "treatment" | "holdout";
    readonly paywallId?: string;
    readonly percentage?: number;
  }>;
}

export interface RawPaywallResponse {
  readonly identifier: string;
  readonly name: string;
  readonly url: string;
  readonly productIds: ReadonlyArray<string>;
  readonly featureGatingBehavior?: "gated" | "nonGated";
}

export interface RawProductItem {
  readonly id: string;
  readonly name?: string;
  readonly entitlements?: ReadonlyArray<{ id: string }>;
  readonly store?: string;
}

// ---------------------------------------------------------------------------
// Parser — lenient, field-by-field
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const asArray = <T>(v: unknown, mapper: (x: unknown) => T | null): T[] => {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const mapped = mapper(x);
    if (mapped !== null) out.push(mapped);
  }
  return out;
};

const parseExperimentRef = (raw: unknown): RawExperimentRef | null => {
  if (!isObject(raw)) return null;
  const id = asString(raw["id"]);
  if (!id) return null;
  return {
    id,
    groupId: asString(raw["groupId"]),
    variants: asArray(raw["variants"], (v) => {
      if (!isObject(v)) return null;
      const variantId = asString(v["id"]);
      if (!variantId) return null;
      const type = v["type"] === "holdout" ? "holdout" : "treatment";
      const out: RawExperimentRef["variants"][number] = {
        id: variantId,
        type,
      };
      const paywallId = v["paywallId"];
      if (typeof paywallId === "string") {
        (out as { paywallId?: string }).paywallId = paywallId;
      }
      const percentage = v["percentage"];
      if (typeof percentage === "number") {
        (out as { percentage?: number }).percentage = percentage;
      }
      return out;
    }),
  };
};

const parseRule = (raw: unknown): RawAudienceRule | null => {
  if (!isObject(raw)) return null;
  const exp = parseExperimentRef(raw["experiment"]);
  if (!exp) return null;
  return {
    expression: asString(raw["expression"]),
    experiment: exp,
  };
};

const parseTrigger = (raw: unknown): RawTrigger | null => {
  if (!isObject(raw)) return null;
  const placementName = asString(raw["placementName"] ?? raw["eventName"]);
  if (!placementName) return null;
  return {
    placementName,
    rules: asArray(raw["rules"] ?? raw["audiences"], parseRule),
  };
};

const parsePaywallResponse = (raw: unknown): RawPaywallResponse | null => {
  if (!isObject(raw)) return null;
  const identifier = asString(raw["identifier"]);
  if (!identifier) return null;
  const out: RawPaywallResponse = {
    identifier,
    name: asString(raw["name"], identifier),
    url: asString(raw["url"]),
    productIds: asArray(raw["productIds"], (x) =>
      typeof x === "string" ? x : null,
    ),
    ...(raw["featureGatingBehavior"] === "nonGated" ||
    raw["featureGatingBehavior"] === "gated"
      ? { featureGatingBehavior: raw["featureGatingBehavior"] as "gated" | "nonGated" }
      : {}),
  };
  return out;
};

const parseProduct = (raw: unknown): RawProductItem | null => {
  if (!isObject(raw)) return null;
  const id = asString(raw["id"] ?? raw["productIdentifier"]);
  if (!id) return null;
  const out: RawProductItem = { id };
  const name = raw["name"];
  if (typeof name === "string") (out as { name?: string }).name = name;
  const ents = raw["entitlements"];
  if (Array.isArray(ents)) {
    (out as { entitlements?: ReadonlyArray<{ id: string }> }).entitlements =
      ents
        .map((e) =>
          isObject(e) && typeof e["id"] === "string"
            ? { id: e["id"] }
            : null,
        )
        .filter((x): x is { id: string } => x !== null);
  }
  const store = raw["store"];
  if (typeof store === "string") (out as { store?: string }).store = store;
  return out;
};

/**
 * Parse the raw `static_config` JSON into a typed `RawConfig`. Lenient —
 * unknown fields are preserved on `.raw`; missing fields fall back to
 * empty arrays / strings. Throws `ConfigParseError` only when the shape
 * isn't an object at all.
 */
export const parseConfig = (input: JsonValue): RawConfig => {
  if (!isObject(input)) {
    throw new ConfigParseError({
      message: `static_config response is not an object (got ${typeof input})`,
    });
  }
  const buildId = asString(input["buildId"] ?? input["build_id"]);
  if (!buildId) {
    throw new ConfigParseError({
      message: "static_config response is missing `buildId`",
    });
  }
  return {
    buildId,
    triggerOptions: asArray(input["triggerOptions"], parseTrigger),
    paywallResponses: asArray(input["paywallResponses"], parsePaywallResponse),
    products: asArray(input["products"], parseProduct),
    toggles: asArray(input["toggles"], (t) => {
      if (!isObject(t)) return null;
      const key = asString(t["key"]);
      if (!key) return null;
      return { key, enabled: t["enabled"] === true };
    }),
    locales: (() => {
      const loc = input["localization"];
      if (!isObject(loc)) return [];
      return asArray(loc["locales"], (l) =>
        isObject(l) && typeof l["locale"] === "string"
          ? (l["locale"] as string)
          : null,
      );
    })(),
    raw: input as Record<string, JsonValue>,
  };
};

// ---------------------------------------------------------------------------
// ConfigState — typed actor state machine. Mirrors Android `ConfigState.kt`.
//
// Updates are pure reducers (`(s) => s'`); Actions live on the service
// (fetch / reset / etc.) and dispatch Updates through a SubscriptionRef so
// callers can observe transitions. Web's previous flat `RawConfig | null`
// ref is now derivable from this state via `getConfig()`.
// ---------------------------------------------------------------------------

export type ConfigState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Retrieving" }
  | { readonly _tag: "Retrying" }
  | { readonly _tag: "Retrieved"; readonly config: RawConfig }
  | {
      readonly _tag: "Failed";
      readonly error: Error;
      readonly retryCount: number;
    };

export const ConfigState = {
  None: { _tag: "None" } as const satisfies ConfigState,
  Retrieving: { _tag: "Retrieving" } as const satisfies ConfigState,
  Retrying: { _tag: "Retrying" } as const satisfies ConfigState,
  Retrieved: (config: RawConfig): ConfigState => ({
    _tag: "Retrieved",
    config,
  }),
  Failed: (error: Error, retryCount = 0): ConfigState => ({
    _tag: "Failed",
    error,
    retryCount,
  }),
};

/** Pure reducers. Match Android `ConfigState.Updates`. */
export const ConfigUpdates = {
  SetRetrieving: (_: ConfigState): ConfigState => ConfigState.Retrieving,
  SetRetrying: (_: ConfigState): ConfigState => ConfigState.Retrying,
  SetRetrieved:
    (config: RawConfig) =>
    (_: ConfigState): ConfigState =>
      ConfigState.Retrieved(config),
  SetFailed:
    (error: Error, retryCount = 0) =>
    (_: ConfigState): ConfigState =>
      ConfigState.Failed(error, retryCount),
};

/** Project the underlying config out of any ConfigState — null unless
 *  Retrieved. Equivalent to Kotlin's `ConfigState.getConfig()` extension. */
export const getConfig = (s: ConfigState): RawConfig | null =>
  s._tag === "Retrieved" ? s.config : null;

const isFetching = (s: ConfigState): boolean =>
  s._tag === "Retrieving" || s._tag === "Retrying";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ConfigServiceImpl {
  /**
   * Fetch fresh config from the backend, parse, publish state transitions
   * (Retrieving → Retrieved | Failed), persist to storage. Concurrent calls
   * are no-ops while in Retrieving|Retrying (matches Android `FetchConfig`).
   * Returns the parsed config or fails.
   */
  readonly fetch: () => Effect.Effect<
    RawConfig,
    ConfigParseError | Error
  >;
  /** Read the current parsed config (null unless Retrieved). */
  readonly current: () => Effect.Effect<RawConfig | null>;
  /** Read the full ConfigState — useful for guarding re-entry. */
  readonly state: () => Effect.Effect<ConfigState>;
  /** Subscribe to state transitions. */
  readonly stateRef: SubscriptionRef.SubscriptionRef<ConfigState>;
  /** Replay cached config from storage. Returns null if no cache. */
  readonly hydrateFromStorage: () => Effect.Effect<RawConfig | null>;
  /** Look up a placement by name. Returns null when not found in the
   *  current config. Used by `getPresentationResult` + audience eval. */
  readonly getPlacement: (
    placementName: string,
  ) => Effect.Effect<RawTrigger | null>;
  /** Look up a paywall response by identifier. */
  readonly getPaywall: (
    identifier: string,
  ) => Effect.Effect<RawPaywallResponse | null>;
  /** Returns the catalog products from the current config (empty if no
   *  config). */
  readonly getProducts: () => Effect.Effect<ReadonlyArray<RawProductItem>>;
  /** Wipe in-memory + storage cache. Called from `sw.reset()`. */
  readonly reset: () => Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const network = yield* NetworkService;
  const storage = yield* StorageService;
  const stateRef = yield* SubscriptionRef.make<ConfigState>(ConfigState.None);

  const update = (reducer: (s: ConfigState) => ConfigState) =>
    SubscriptionRef.update(stateRef, reducer);

  const persist = (cfg: RawConfig) =>
    storage
      .set(CONFIG_KEY, JSON.stringify({ buildId: cfg.buildId, payload: cfg.raw }))
      .pipe(Effect.catchAll(() => Effect.void));

  const hydrateFromStorage: ConfigServiceImpl["hydrateFromStorage"] = () =>
    Effect.gen(function* () {
      // Storage failures during hydrate are non-fatal — fresh fetch will
      // repopulate. Catch to keep the public-facing return type clean.
      const cached = yield* storage
        .get(CONFIG_KEY)
        .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
      if (cached === null) return null;
      try {
        const decoded = JSON.parse(cached) as { buildId?: string; payload?: JsonValue };
        if (!decoded.payload) return null;
        const parsed = parseConfig(decoded.payload);
        // Hydration counts as Retrieved; fresh fetch may transition us to
        // Retrieving and back. Matches Android: cache replay seeds the
        // state so consumers see a Retrieved state before network lands.
        yield* update(ConfigUpdates.SetRetrieved(parsed));
        return parsed;
      } catch {
        return null;
      }
    });

  const fetch: ConfigServiceImpl["fetch"] = () =>
    Effect.gen(function* () {
      // Re-entry guard — Android `FetchConfig` returns early if state is
      // Retrieving|Retrying. Concurrent fetch() calls observe the same
      // in-flight transition and don't kick another network round-trip.
      const current = yield* SubscriptionRef.get(stateRef);
      if (isFetching(current)) {
        // Wait for the in-flight fetch to settle, then return its outcome.
        // (Failed callers get the same error; Retrieved callers get the
        //  fresh config.) We poll the SubscriptionRef rather than wiring a
        //  proper join so this stays pure data — no extra fiber bookkeeping.
        return yield* awaitSettle(stateRef);
      }

      // Capture pre-fetch state so an interrupt (e.g. caller-side
      // `Effect.timeout`) can restore it. Without this, a timed-out fetch
      // would leave the actor stuck at Retrieving forever.
      const prior = current;
      yield* update(ConfigUpdates.SetRetrieving);
      const result = yield* network.getStaticConfig().pipe(
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseConfig(raw),
            catch: (e) =>
              e instanceof ConfigParseError
                ? e
                : new ConfigParseError({ reason: String(e) }),
          }),
        ),
        Effect.tap((parsed) => persist(parsed)),
        Effect.tap((parsed) => update(ConfigUpdates.SetRetrieved(parsed))),
        Effect.tapError((err) =>
          update(ConfigUpdates.SetFailed(err as Error)),
        ),
        Effect.onInterrupt(() => update(() => prior)),
      );
      return result;
    });

  /** Block until the state leaves Retrieving|Retrying. Returns the underlying
   *  config or fails with the captured error. Yields to the scheduler each
   *  loop iteration so the in-flight fetch fiber can advance. */
  const awaitSettle = (
    ref: SubscriptionRef.SubscriptionRef<ConfigState>,
  ): Effect.Effect<RawConfig, Error> =>
    Effect.gen(function* () {
      const s = yield* SubscriptionRef.get(ref);
      if (s._tag === "Retrieved") return s.config;
      if (s._tag === "Failed") return yield* Effect.fail(s.error);
      yield* Effect.yieldNow();
      return yield* awaitSettle(ref);
    });

  const current: ConfigServiceImpl["current"] = () =>
    SubscriptionRef.get(stateRef).pipe(Effect.map(getConfig));

  const state: ConfigServiceImpl["state"] = () => SubscriptionRef.get(stateRef);

  const getPlacement: ConfigServiceImpl["getPlacement"] = (placementName) =>
    Effect.gen(function* () {
      const cfg = getConfig(yield* SubscriptionRef.get(stateRef));
      if (!cfg) return null;
      return (
        cfg.triggerOptions.find((t) => t.placementName === placementName) ??
        null
      );
    });

  const getPaywall: ConfigServiceImpl["getPaywall"] = (identifier) =>
    Effect.gen(function* () {
      const cfg = getConfig(yield* SubscriptionRef.get(stateRef));
      if (!cfg) return null;
      return (
        cfg.paywallResponses.find((p) => p.identifier === identifier) ?? null
      );
    });

  const getProducts: ConfigServiceImpl["getProducts"] = () =>
    Effect.gen(function* () {
      const cfg = getConfig(yield* SubscriptionRef.get(stateRef));
      return cfg?.products ?? [];
    });

  const reset: ConfigServiceImpl["reset"] = () =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(stateRef, ConfigState.None);
      yield* storage
        .remove(CONFIG_KEY)
        .pipe(Effect.catchAll(() => Effect.void));
    });

  return {
    fetch,
    current,
    state,
    stateRef,
    hydrateFromStorage,
    getPlacement,
    getPaywall,
    getProducts,
    reset,
  } satisfies ConfigServiceImpl;
});

export class ConfigService extends Context.Tag("@superwall/ConfigService")<
  ConfigService,
  ConfigServiceImpl
>() {}

/** Build a Layer over an upstream that already provides `NetworkService`
 *  (which itself provides `StorageService`). */
export const configServiceLayer = (
  upstream: Layer.Layer<NetworkService | StorageService>,
): Layer.Layer<ConfigService | NetworkService | StorageService, never, never> =>
  Layer.provideMerge(
    Layer.effect(ConfigService, make),
    upstream,
  ) as Layer.Layer<
    ConfigService | NetworkService | StorageService,
    never,
    never
  >;
