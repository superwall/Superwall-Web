// ConfigService — fetches /api/v1/static_config, parses to typed Config,
// caches by buildId in storage for revalidation. Only fields actually
// consumed are modeled; the rest is preserved on `.raw`.

import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { STORAGE_KEYS, type JsonValue } from "../types.ts";
import { makeActor } from "./actor.ts";
import { asStorageKey } from "./brands.ts";
import { ConfigParseError } from "./errors.ts";
import { NetworkService } from "./network.ts";
import { StorageService } from "./storage.ts";

const CONFIG_KEY = asStorageKey(STORAGE_KEYS.config);

/** Top-level parsed config. Wire shape from `/api/v1/static_config`. */
export interface RawConfig {
  readonly buildId: string;
  /** One entry per placement. */
  readonly triggerOptions: ReadonlyArray<RawTrigger>;
  /** Paywall definitions, indexed by `identifier`. */
  readonly paywallResponses: ReadonlyArray<RawPaywallResponse>;
  readonly products: ReadonlyArray<RawProductItem>;
  readonly toggles: ReadonlyArray<{ key: string; enabled: boolean }>;
  readonly locales: ReadonlyArray<string>;
  /** Web-to-app routing config — present when this app has a Superwall
   *  Web Project. Lets the SDK route `register()` to a hosted paywall URL
   *  (e.g. `https://{tenant}.superwall.app/{placement}`) instead of
   *  presenting an iframe. */
  readonly web2appConfig?: RawWeb2AppConfig;
  /** Untyped backing payload — preserves fields we don't model. */
  readonly raw: Record<string, JsonValue>;
}

export interface RawWeb2AppConfig {
  /** Deep-link scheme back to the consumer's app, e.g. `sw-test-bed`.
   *  Stripe success_url uses this so the redirect lands in-app. */
  readonly urlSchema?: string;
  /** Hosted "manage subscription" page on the Superwall Web Project. The
   *  origin doubles as the base for placement URLs:
   *  `https://{origin}/{placement}` is the hosted paywall. */
  readonly restoreAccessUrl?: string;
  /** TTL for the cached web entitlements list. */
  readonly entitlementsMaxAgeMs?: number;
}

export interface RawTrigger {
  readonly placementName: string;
  readonly rules: ReadonlyArray<RawAudienceRule>;
}

export interface RawAudienceRule {
  /** CEL expression string. Empty string ⇒ matches all. */
  readonly expression: string;
  readonly experiment: RawExperimentRef;
}

export interface RawExperimentRef {
  readonly id: string;
  readonly groupId: string;
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
  /** Per-paywall product slot mapping. Wire shape from the paywall config:
   *  `[{product: "primary", productId, product_id, product_id_android}, …]`.
   *  Forwarded verbatim to the paywall iframe's `template_variables.products`
   *  + `products` event, since the iframe's checkout-click handler keys off
   *  the `product` (slot name) field. */
  readonly products?: ReadonlyArray<Record<string, JsonValue>>;
  /** Pre-encoded base64 array of `[{event_name:"template_substitutions",…},
   *  {event_name:"page_styles",…}]`. The paywall expects this as a separate
   *  `accept64` message after the templates bundle. Decoded + re-sent
   *  verbatim by the presenter. */
  readonly paywalljsEvent?: string;
  /** Per-paywall override of how to present:
   *    `"web"` (or any non-`"embedded"` value) → navigate to the Web
   *      Project paywall URL instead of presenting an iframe.
   *    `"embedded"` / null → SDK iframe (current default). */
  readonly webCheckoutDestination?: string;
}

export interface RawProductItem {
  readonly id: string;
  readonly name?: string;
  readonly entitlements?: ReadonlyArray<{ id: string }>;
  readonly store?: string;
}

// Lenient parser — unknown fields preserved on `.raw`, missing fields fall
// back to empty arrays / strings.

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read the first non-null/string value from a list of candidate keys.
 *  Wire is snake_case; the camelCase fallbacks accommodate test fixtures
 *  authored before the wire shape was nailed down. */
const pickString = (
  raw: Record<string, unknown>,
  keys: readonly string[],
  fallback = "",
): string => {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string") return v;
  }
  return fallback;
};

const pickArray = (
  raw: Record<string, unknown>,
  keys: readonly string[],
): unknown[] => {
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) return v;
  }
  return [];
};

const variantTypeFromWire = (
  v: unknown,
): "treatment" | "holdout" => {
  // Wire ships uppercase ("TREATMENT" / "HOLDOUT"); legacy fixtures use lowercase.
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return s === "holdout" ? "holdout" : "treatment";
};

const featureGatingFromWire = (
  v: unknown,
): "gated" | "nonGated" | undefined => {
  // Wire: "GATED" / "NON_GATED" (Android `FeatureGatingBehavior`). Legacy
  // tests pass camelCase ("gated" / "nonGated") directly.
  if (v === "GATED" || v === "gated") return "gated";
  if (v === "NON_GATED" || v === "nonGated") return "nonGated";
  return undefined;
};

const parseExperimentRefFromRule = (
  raw: Record<string, unknown>,
): RawExperimentRef | null => {
  // Wire shape: trigger rule has experiment_id + experiment_group_id +
  // variants[] inline (no nested `experiment` object). Legacy fixtures
  // wrap in `experiment: {id, groupId, variants}` — handle both.
  const nested = raw["experiment"];
  if (isObject(nested)) {
    const id = pickString(nested, ["id", "experiment_id"]);
    if (!id) return null;
    return {
      id,
      groupId: pickString(nested, ["groupId", "group_id", "experiment_group_id"]),
      variants: parseVariants(nested),
    };
  }
  const id = pickString(raw, ["experiment_id", "experimentId", "id"]);
  if (!id) return null;
  return {
    id,
    groupId: pickString(raw, [
      "experiment_group_id",
      "experimentGroupId",
      "groupId",
    ]),
    variants: parseVariants(raw),
  };
};

const parseVariants = (
  raw: Record<string, unknown>,
): RawExperimentRef["variants"] => {
  const list = pickArray(raw, ["variants"]);
  return list
    .map((v): RawExperimentRef["variants"][number] | null => {
      if (!isObject(v)) return null;
      const variantId = pickString(v, ["variant_id", "id"]);
      if (!variantId) return null;
      const out: { id: string; type: "treatment" | "holdout"; paywallId?: string; percentage?: number } = {
        id: variantId,
        type: variantTypeFromWire(v["variant_type"] ?? v["type"]),
      };
      const paywallId = v["paywall_identifier"] ?? v["paywallId"];
      if (typeof paywallId === "string") out.paywallId = paywallId;
      const percentage = v["percentage"];
      if (typeof percentage === "number") out.percentage = percentage;
      return out;
    })
    .filter((x): x is RawExperimentRef["variants"][number] => x !== null);
};

const parseRule = (raw: unknown): RawAudienceRule | null => {
  if (!isObject(raw)) return null;
  const exp = parseExperimentRefFromRule(raw);
  if (!exp) return null;
  // Wire CEL lives in `expression_cel` (V2). `expression` is the legacy
  // pre-CEL audience filter format; `expression_js` is the JS variant.
  // Empty/null all → match-all (audience eval treats "" as match).
  const expr =
    pickString(raw, ["expression_cel", "expression", "expression_js"]);
  return { expression: expr, experiment: exp };
};

const parseTrigger = (raw: unknown): RawTrigger | null => {
  if (!isObject(raw)) return null;
  const placementName = pickString(raw, [
    "event_name",
    "eventName",
    "placementName",
  ]);
  if (!placementName) return null;
  const rulesRaw = pickArray(raw, ["rules", "audiences"]);
  return {
    placementName,
    rules: rulesRaw
      .map(parseRule)
      .filter((r): r is RawAudienceRule => r !== null),
  };
};

const parsePaywallResponse = (raw: unknown): RawPaywallResponse | null => {
  if (!isObject(raw)) return null;
  const identifier = pickString(raw, ["identifier"]);
  if (!identifier) return null;
  // Some paywalls expose product IDs only via the per-paywall `products`
  // array (with `product_id` per slot); `product_ids` may be empty.
  const productsRaw = pickArray(raw, ["products"]);
  const productIdsRaw = pickArray(raw, ["product_ids", "productIds"]);
  const productIdsFromIds = productIdsRaw.filter(
    (p): p is string => typeof p === "string",
  );
  const productIdsFromProducts = productsRaw
    .map((p) =>
      isObject(p) ? pickString(p, ["product_id", "productId"]) : "",
    )
    .filter((s): s is string => s !== "");
  const productIds =
    productIdsFromIds.length > 0 ? productIdsFromIds : productIdsFromProducts;

  const products = productsRaw.filter(isObject) as ReadonlyArray<
    Record<string, JsonValue>
  >;
  const paywalljsEvent = pickString(raw, [
    "paywalljs_event",
    "paywalljsEvent",
  ]);

  const webCheckoutDestination = pickString(raw, [
    "web_checkout_destination",
    "webCheckoutDestination",
  ]);
  const out: RawPaywallResponse = {
    identifier,
    name: pickString(raw, ["name"], identifier),
    url: pickString(raw, ["url"]),
    productIds,
    ...(products.length > 0 && { products }),
    ...(paywalljsEvent && { paywalljsEvent }),
    ...(webCheckoutDestination && { webCheckoutDestination }),
    ...((): { featureGatingBehavior?: "gated" | "nonGated" } => {
      const fg = featureGatingFromWire(
        raw["feature_gating"] ?? raw["featureGatingBehavior"],
      );
      return fg !== undefined ? { featureGatingBehavior: fg } : {};
    })(),
  };
  return out;
};

const parseProduct = (raw: unknown): RawProductItem | null => {
  if (!isObject(raw)) return null;
  // Wire shape: top-level has `sw_composite_product_id` + `store_product`
  // (with `product_identifier` + `store`) + `entitlements`. Legacy/test
  // fixtures put `id` + `store` + `name` flat at the top level.
  const storeProduct = isObject(raw["store_product"])
    ? (raw["store_product"] as Record<string, unknown>)
    : null;
  const id =
    pickString(raw, ["sw_composite_product_id", "id", "productIdentifier"]) ||
    (storeProduct ? pickString(storeProduct, ["product_identifier", "id"]) : "");
  if (!id) return null;
  const out: RawProductItem = { id };
  const name = pickString(raw, ["name"]);
  if (name) (out as { name?: string }).name = name;
  const ents = raw["entitlements"];
  if (Array.isArray(ents)) {
    (out as { entitlements?: ReadonlyArray<{ id: string }> }).entitlements =
      ents
        .map((e): { id: string } | null => {
          if (!isObject(e)) return null;
          const entId = pickString(e, ["identifier", "id"]);
          return entId ? { id: entId } : null;
        })
        .filter((x): x is { id: string } => x !== null);
  }
  // Wire: `store_product.store` is uppercase ("APP_STORE", "STRIPE", "PLAY_STORE").
  // Map to our public ProductStore values; unrecognised falls through to "stripe".
  const wireStore =
    (storeProduct && pickString(storeProduct, ["store"])) ||
    pickString(raw, ["store"]);
  if (wireStore) {
    const normalized = normaliseStore(wireStore);
    if (normalized) (out as { store?: string }).store = normalized;
  }
  return out;
};

const normaliseStore = (s: string): string | null => {
  switch (s) {
    case "APP_STORE":
    case "appStore":
      return "appStore";
    case "PLAY_STORE":
    case "playStore":
      return "playStore";
    case "STRIPE":
    case "stripe":
      return "stripe";
    case "PADDLE":
    case "paddle":
      return "paddle";
    case "SUPERWALL":
    case "superwall":
      return "superwall";
    case "OTHER":
    case "other":
      return "other";
    default:
      return null;
  }
};

/** Parse the raw `static_config` JSON into a typed `RawConfig`. Throws
 *  `ConfigParseError` only when the shape isn't an object or `buildId` is
 *  absent. */
export const parseConfig = (input: JsonValue): RawConfig => {
  if (!isObject(input)) {
    throw new ConfigParseError({
      message: `static_config response is not an object (got ${typeof input})`,
    });
  }
  const buildId = pickString(input, ["build_id", "buildId"]);
  if (!buildId) {
    throw new ConfigParseError({
      message: "static_config response is missing `buildId`",
    });
  }
  // Wire is snake_case; legacy test fixtures use camelCase. Read both.
  const triggersRaw = pickArray(input, ["trigger_options", "triggerOptions"]);
  const paywallsRaw = pickArray(input, [
    "paywall_responses",
    "paywallResponses",
  ]);
  return {
    buildId,
    triggerOptions: triggersRaw
      .map(parseTrigger)
      .filter((t): t is RawTrigger => t !== null),
    paywallResponses: paywallsRaw
      .map(parsePaywallResponse)
      .filter((p): p is RawPaywallResponse => p !== null),
    products: pickArray(input, ["products"])
      .map(parseProduct)
      .filter((p): p is RawProductItem => p !== null),
    toggles: pickArray(input, ["toggles"])
      .map((t): { key: string; enabled: boolean } | null => {
        if (!isObject(t)) return null;
        const key = pickString(t, ["key"]);
        if (!key) return null;
        return { key, enabled: t["enabled"] === true };
      })
      .filter((x): x is { key: string; enabled: boolean } => x !== null),
    locales: (() => {
      const loc = input["localization"];
      if (!isObject(loc)) return [];
      const list = pickArray(loc, ["locales"]);
      return list
        .map((l) =>
          isObject(l) && typeof l["locale"] === "string"
            ? (l["locale"] as string)
            : null,
        )
        .filter((x): x is string => x !== null);
    })(),
    ...((): { web2appConfig?: RawWeb2AppConfig } => {
      const w2a = input["web2app_config"] ?? input["web2appConfig"];
      if (!isObject(w2a)) return {};
      const cfg: RawWeb2AppConfig = {};
      const urlSchema = pickString(w2a, ["url_schema", "urlSchema"]);
      if (urlSchema) (cfg as { urlSchema?: string }).urlSchema = urlSchema;
      const restoreUrl = pickString(w2a, [
        "restore_access_url",
        "restoreAccessUrl",
      ]);
      if (restoreUrl)
        (cfg as { restoreAccessUrl?: string }).restoreAccessUrl = restoreUrl;
      const maxAge = w2a["entitlements_max_age_ms"] ?? w2a["entitlementsMaxAgeMs"];
      if (typeof maxAge === "number")
        (cfg as { entitlementsMaxAgeMs?: number }).entitlementsMaxAgeMs = maxAge;
      return { web2appConfig: cfg };
    })(),
    raw: input as Record<string, JsonValue>,
  };
};

// Typed actor state machine. Updates are pure reducers; the service
// dispatches them through a SubscriptionRef so callers can observe
// transitions. `getConfig(state)` projects the underlying RawConfig.

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

/** Project the underlying config out of any ConfigState. Null unless Retrieved. */
export const getConfig = (s: ConfigState): RawConfig | null =>
  s._tag === "Retrieved" ? s.config : null;

/** Build a `productId → entitlementIds[]` map from config products. */
export const extractEntitlementsByProductId = (
  products: ReadonlyArray<RawProductItem>,
): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const p of products) {
    const ents = p.entitlements ?? [];
    if (ents.length === 0) continue;
    out.set(
      p.id,
      ents.map((e) => e.id),
    );
  }
  return out;
};

export interface ConfigServiceImpl {
  /** Fetch fresh config, parse, publish state transitions, persist. */
  readonly fetch: () => Effect.Effect<RawConfig, ConfigParseError | Error>;
  /** Read the current parsed config (null unless Retrieved). */
  readonly current: () => Effect.Effect<RawConfig | null>;
  readonly state: () => Effect.Effect<ConfigState>;
  /** Subscribe to state transitions. */
  readonly stateRef: SubscriptionRef.SubscriptionRef<ConfigState>;
  /** Replay cached config from storage. Returns null if no cache. */
  readonly hydrateFromStorage: () => Effect.Effect<RawConfig | null>;
  /** Look up a placement by name. */
  readonly getPlacement: (
    placementName: string,
  ) => Effect.Effect<RawTrigger | null>;
  /** Look up a paywall response by identifier. */
  readonly getPaywall: (
    identifier: string,
  ) => Effect.Effect<RawPaywallResponse | null>;
  readonly getProducts: () => Effect.Effect<ReadonlyArray<RawProductItem>>;
  readonly reset: () => Effect.Effect<void>;
  /** Stub seam for warming paywall iframes. No-op when config isn't loaded. */
  readonly preload: () => Effect.Effect<void>;
}

const make = (apiKey: string) =>
  Effect.gen(function* () {
  const network = yield* NetworkService;
  const storage = yield* StorageService;
  const actor = yield* makeActor<ConfigState>(ConfigState.None);
  const { stateRef, dispatch } = actor;

  const update = (reducer: (s: ConfigState) => ConfigState) =>
    SubscriptionRef.update(stateRef, reducer);

  const persist = (cfg: RawConfig) =>
    storage
      .set(
        CONFIG_KEY,
        JSON.stringify({ apiKey, buildId: cfg.buildId, payload: cfg.raw }),
      )
      .pipe(Effect.catchAll(() => Effect.void));

  const hydrateFromStorage: ConfigServiceImpl["hydrateFromStorage"] = () =>
    dispatch(
      "ConfigService.hydrateFromStorage",
      Effect.gen(function* () {
        const cached = yield* storage
          .get(CONFIG_KEY)
          .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
        if (cached === null) return null;
        try {
          const decoded = JSON.parse(cached) as {
            apiKey?: string;
            buildId?: string;
            payload?: JsonValue;
          };
          if (!decoded.payload) return null;
          // Cache scoped by api key — switching keys (different app /
          // environment) MUST NOT serve the previous app's config.
          // Legacy entries without `apiKey` get evicted on next persist.
          if (decoded.apiKey !== undefined && decoded.apiKey !== apiKey) {
            yield* storage
              .remove(CONFIG_KEY)
              .pipe(Effect.catchAll(() => Effect.void));
            return null;
          }
          const parsed = parseConfig(decoded.payload);
          yield* update(ConfigUpdates.SetRetrieved(parsed));
          return parsed;
        } catch {
          return null;
        }
      }),
    );

  const fetch: ConfigServiceImpl["fetch"] = () =>
    dispatch(
      "ConfigService.fetch",
      Effect.gen(function* () {
        // Capture pre-fetch state so a caller-side interrupt (e.g.
        // `Effect.timeout`) can restore it — without this a timed-out
        // fetch would leave the actor stuck at Retrieving forever.
        const current = yield* SubscriptionRef.get(stateRef);
        const prior = current;
        // Don't downgrade `Retrieved → Retrieving` for a background
        // revalidation — that would make `current()` return null while a
        // hot cache is still valid, breaking register() between hydrate +
        // fresh fetch. Only mark Retrieving when there's no prior config.
        if (prior._tag !== "Retrieved") {
          yield* update(ConfigUpdates.SetRetrieving);
        }

        // Bounded retry — single retry max:
        //   Retrieving → (fail) → Retrying → (attempt 2) → Retrieved | Failed
        const tryFetch = () =>
          network.getStaticConfig().pipe(
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => parseConfig(raw),
                catch: (e) =>
                  e instanceof ConfigParseError
                    ? e
                    : new ConfigParseError({
                        message: String(e),
                        cause: e,
                      }),
              }),
            ),
          );

        return yield* tryFetch()
          .pipe(
            Effect.catchAll((err) =>
              update(ConfigUpdates.SetRetrying).pipe(
                Effect.flatMap(() => tryFetch()),
                Effect.tapError((finalErr) =>
                  update(ConfigUpdates.SetFailed(finalErr as Error, 1)),
                ),
                // Surface the original error type to the outer pipe.
                Effect.catchAll(() => Effect.fail(err)),
              ),
            ),
            Effect.tap((parsed) => persist(parsed)),
            Effect.tap((parsed) => update(ConfigUpdates.SetRetrieved(parsed))),
            Effect.onInterrupt(() => update(() => prior)),
          );
      }),
    );

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
    dispatch(
      "ConfigService.reset",
      Effect.gen(function* () {
        yield* SubscriptionRef.set(stateRef, ConfigState.None);
        yield* storage
          .remove(CONFIG_KEY)
          .pipe(Effect.catchAll(() => Effect.void));
      }),
    );

  const preload: ConfigServiceImpl["preload"] = () =>
    dispatch(
      "ConfigService.preload",
      Effect.gen(function* () {
        const cfg = getConfig(yield* SubscriptionRef.get(stateRef));
        if (!cfg) return;
        // TODO: warm an iframe pool for likely placements.
        return;
      }),
    );

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
    preload,
  } satisfies ConfigServiceImpl;
});

export class ConfigService extends Context.Tag("@superwall/ConfigService")<
  ConfigService,
  ConfigServiceImpl
>() {}

/** Build a Layer over an upstream that already provides `NetworkService`
 *  (which itself provides `StorageService`). The `apiKey` scopes the
 *  persisted config cache so switching keys never serves stale data. */
export const configServiceLayer = (
  apiKey: string,
  upstream: Layer.Layer<NetworkService | StorageService>,
): Layer.Layer<ConfigService | NetworkService | StorageService, never, never> =>
  Layer.provideMerge(
    Layer.effect(ConfigService, make(apiKey)),
    upstream,
  ) as Layer.Layer<
    ConfigService | NetworkService | StorageService,
    never,
    never
  >;
