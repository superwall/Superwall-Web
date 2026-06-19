// ConfigService — fetches /api/v1/static_config, parses to typed Config,
// caches by buildId in storage for revalidation. Only fields actually
// consumed are modeled; the rest is preserved on `.raw`.

import { Context, Effect, Layer, Option, Schema, SubscriptionRef } from "effect";
import {
  STORAGE_KEYS,
  type JsonValue,
  type PaywallPresentationStyle,
  type Survey,
  type SurveyShowCondition,
} from "../types.ts";
import { makeActor } from "./actor.ts";
import { asStorageKey } from "./brands.ts";
import { ConfigParseError } from "./errors.ts";
import { NetworkService } from "./network.ts";
import { StorageService } from "./storage.ts";

const CONFIG_KEY = asStorageKey(STORAGE_KEYS.config);

/** An entry of `test_mode_user_ids`: which identity field to match, and the
 *  value to match it against (e.g. `{ type: "aliasId", value: "$Superwall…" }`). */
export interface TestModeUserId {
  readonly type: "aliasId" | "appUserId" | "deviceId" | (string & {});
  readonly value: string;
}

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
  /** Identities flagged as test users in the dashboard (`test_mode_user_ids`).
   *  When `testModeBehavior` is `automatic`/`whenEnabledForUser`, the SDK runs
   *  in test mode (simulated purchases) only when the current user matches one
   *  of these. */
  readonly testModeUserIds: ReadonlyArray<TestModeUserId>;
  /** Web-to-app routing config — present when this app has a Superwall
   *  Web Project. Lets the SDK route `register()` to a hosted paywall URL
   *  (e.g. `https://{tenant}.superwall.app/{placement}`) instead of
   *  presenting an iframe. */
  readonly web2appConfig?: RawWeb2AppConfig;
  /** Application metadata from the BE — shipped into the iframe's
   *  `#init=` hash so the controller can render the app name + icon
   *  on default/error chrome. */
  readonly application?: { readonly name?: string; readonly iconUrl?: string };
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
   *  `[{product: "primary", product_id, product_id_android}, …]`. Forwarded
   *  verbatim to the paywall iframe's `template_variables.products` + `products`
   *  event, since the iframe's checkout-click handler keys off the `product`
   *  (slot name) field. */
  readonly products?: ReadonlyArray<Record<string, JsonValue>>;
  /** Pre-encoded base64 array of `[{event_name:"template_substitutions",…},
   *  {event_name:"page_styles",…}]`. The paywall expects this as a separate
   *  `accept64` message after the templates bundle. Decoded + re-sent
   *  verbatim by the presenter. */
  readonly paywalljsEvent?: string;
  /** Weighted load-balanced endpoints. When >1, picked by cumulative-weight
   *  random selection at iframe-mount time; when absent or empty, falls back
   *  to `url`. */
  readonly urlEndpoints?: ReadonlyArray<{
    readonly url: string;
    readonly percentage: number;
    readonly timeoutMs?: number;
  }>;
  readonly backgroundColorHex?: string;
  readonly darkBackgroundColorHex?: string;
  /** v2 product list — `[{ sw_composite_product_id, reference_name,
   *  store_product, entitlements }]`. Forwarded verbatim into the init
   *  payload alongside `resolveVariables: true` so the server resolves
   *  per-locale `ProductVariables`. */
  readonly productsV2?: ReadonlyArray<Record<string, JsonValue>>;
  /** Per-paywall destination flag from the dashboard. Kept on the type for
   *  downstream consumers; the SDK no longer branches on it for URL
   *  derivation — every paywall is iframed at its own editor URL. */
  readonly webCheckoutDestination?: string;
  /** Per-paywall presentation style from the dashboard
   *  (`presentation_style_v3`). Drawer/Popup carry their own dimensions.
   *  Defaults to `{ type: "MODAL" }` when the wire omits / sends an
   *  unrecognized value. */
  readonly presentationStyle?: PaywallPresentationStyle;
  /** Post-paywall surveys attached at the paywall level. Empty when the
   *  wire omits the field. */
  readonly surveys?: ReadonlyArray<Survey>;
}

export interface RawProductItem {
  readonly id: string;
  readonly name?: string;
  readonly entitlements?: ReadonlyArray<{ id: string }>;
  readonly store?: string;
}

// ── Wire decoding ──────────────────────────────────────────────────────────
// `/api/v1/static_config` has ONE snake_case shape. We validate each piece with
// Effect Schema and map it to the domain `Raw*` types. Collections are decoded
// per-item so a single malformed entry is dropped rather than failing the whole
// config (the SDK degrades gracefully on partial data). Unknown fields are
// ignored by `Schema.Struct` and preserved wholesale on `RawConfig.raw`.

const Records = Schema.Array(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

/** Decode each element of an unknown array, dropping the ones that don't match. */
const decodeItems = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): A[] => {
  if (!Array.isArray(value)) return [];
  const decode = Schema.decodeUnknownOption(schema);
  const out: A[] = [];
  for (const item of value) {
    const decoded = decode(item);
    if (Option.isSome(decoded)) out.push(decoded.value);
  }
  return out;
};

/** Decode a single value, or `undefined` on mismatch. */
const decodeOne = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): A | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

const recordsOf = (value: unknown): ReadonlyArray<Record<string, JsonValue>> =>
  (decodeOne(Records, value) ?? []) as ReadonlyArray<Record<string, JsonValue>>;

// test_mode_user_ids: [{ type, value }]
const TestModeUserIdSchema: Schema.Schema<TestModeUserId> = Schema.Struct({
  type: Schema.String,
  value: Schema.String,
});

// Variants ───────────────────────────────────────────────────────────────────
const VariantWire = Schema.Struct({
  variant_id: Schema.String,
  variant_type: Schema.optional(Schema.String),
  paywall_identifier: Schema.optional(Schema.String),
  percentage: Schema.optional(Schema.Number),
});
const toVariant = (
  w: Schema.Schema.Type<typeof VariantWire>,
): RawExperimentRef["variants"][number] => ({
  id: w.variant_id,
  type: w.variant_type === "HOLDOUT" ? "holdout" : "treatment",
  ...(w.paywall_identifier !== undefined && { paywallId: w.paywall_identifier }),
  ...(w.percentage !== undefined && { percentage: w.percentage }),
});

// Rules ────────────────────────────────────────────────────────────────────
const RuleWire = Schema.Struct({
  experiment_id: Schema.String,
  experiment_group_id: Schema.optional(Schema.String),
  // CEL audience filter. `null`/absent ⇒ match-all (audience eval treats "").
  expression_cel: Schema.optional(Schema.NullOr(Schema.String)),
  variants: Schema.optional(Schema.Unknown),
});
const toRule = (
  w: Schema.Schema.Type<typeof RuleWire>,
): RawAudienceRule => ({
  expression: w.expression_cel ?? "",
  experiment: {
    id: w.experiment_id,
    groupId: w.experiment_group_id ?? "",
    variants: decodeItems(VariantWire, w.variants).map(toVariant),
  },
});

// Triggers ───────────────────────────────────────────────────────────────────
const TriggerWire = Schema.Struct({
  event_name: Schema.String,
  rules: Schema.optional(Schema.Unknown),
});
const toTrigger = (
  w: Schema.Schema.Type<typeof TriggerWire>,
): RawTrigger => ({
  placementName: w.event_name,
  rules: decodeItems(RuleWire, w.rules).map(toRule),
});

// Weighted paywall endpoints (`url_config.endpoints`) ─────────────────────────
const EndpointWire = Schema.Struct({
  url: Schema.String,
  percentage: Schema.optional(Schema.Number),
  timeout_ms: Schema.optional(Schema.Number),
});
const toEndpoint = (w: Schema.Schema.Type<typeof EndpointWire>) => ({
  url: w.url,
  percentage: w.percentage ?? 100,
  ...(w.timeout_ms !== undefined && { timeoutMs: w.timeout_ms }),
});

// Surveys ────────────────────────────────────────────────────────────────────
const SURVEY_CONDITIONS: readonly SurveyShowCondition[] = [
  "ON_MANUAL_CLOSE",
  "ON_PURCHASE",
];
const SurveyOptionWire = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
});
const SurveyWire = Schema.Struct({
  id: Schema.String,
  assignment_key: Schema.String,
  title: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  // A survey with no recognized show-condition is invalid → dropped.
  presentation_condition: Schema.String.pipe(
    Schema.filter((s): s is SurveyShowCondition =>
      (SURVEY_CONDITIONS as readonly string[]).includes(s.toUpperCase()),
    ),
  ),
  options: Schema.optional(Schema.Unknown),
  presentation_probability: Schema.optional(Schema.Number),
  include_other_option: Schema.optional(Schema.Boolean),
  include_close_option: Schema.optional(Schema.Boolean),
});
const toSurvey = (w: Schema.Schema.Type<typeof SurveyWire>): Survey => ({
  id: w.id,
  assignmentKey: w.assignment_key,
  title: w.title ?? "",
  message: w.message ?? "",
  options: decodeItems(SurveyOptionWire, w.options),
  presentationCondition: w.presentation_condition.toUpperCase() as SurveyShowCondition,
  presentationProbability:
    w.presentation_probability !== undefined
      ? Math.max(0, Math.min(1, w.presentation_probability))
      : 0,
  includeOtherOption: w.include_other_option === true,
  includeCloseOption: w.include_close_option === true,
});

// Presentation style ─────────────────────────────────────────────────────────
const PresentationStyleV3Wire = Schema.Struct({
  type: Schema.String,
  height: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  corner_radius: Schema.optional(Schema.Number),
});
const styleFromString = (
  s: string | undefined,
): PaywallPresentationStyle | undefined => {
  switch (s?.toUpperCase()) {
    case "MODAL":
      return { type: "MODAL" };
    case "FULLSCREEN":
      return { type: "FULLSCREEN" };
    case "NO_ANIMATION":
      return { type: "NO_ANIMATION" };
    case "PUSH":
      return { type: "PUSH" };
    case "NONE":
      return { type: "NONE" };
    default:
      return undefined;
  }
};

// Products (top-level catalog) ───────────────────────────────────────────────
const ProductEntitlementWire = Schema.Struct({ identifier: Schema.String });
const StoreProductWire = Schema.Struct({
  store: Schema.optional(Schema.String),
  product_identifier: Schema.optional(Schema.String),
});
const ProductWire = Schema.Struct({
  sw_composite_product_id: Schema.optional(Schema.String),
  store_product: Schema.optional(StoreProductWire),
  entitlements: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.String),
});
const STORE_BY_WIRE: Readonly<Record<string, string>> = {
  APP_STORE: "appStore",
  PLAY_STORE: "playStore",
  STRIPE: "stripe",
  PADDLE: "paddle",
  SUPERWALL: "superwall",
  OTHER: "other",
};
const toProduct = (
  w: Schema.Schema.Type<typeof ProductWire>,
): RawProductItem | null => {
  const id = w.sw_composite_product_id ?? w.store_product?.product_identifier ?? "";
  if (!id) return null;
  const entitlements = decodeItems(ProductEntitlementWire, w.entitlements).map(
    (e) => ({ id: e.identifier }),
  );
  const store = w.store_product?.store
    ? STORE_BY_WIRE[w.store_product.store]
    : undefined;
  return {
    id,
    ...(w.name !== undefined && { name: w.name }),
    ...(entitlements.length > 0 && { entitlements }),
    ...(store !== undefined && { store }),
  };
};

// Paywall responses ──────────────────────────────────────────────────────────
const ProductSlotWire = Schema.Struct({ product_id: Schema.String });
const UrlConfigWire = Schema.Struct({ endpoints: Schema.optional(Schema.Unknown) });
const PaywallWire = Schema.Struct({
  identifier: Schema.String,
  name: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  product_ids: Schema.optional(Schema.Array(Schema.String)),
  products: Schema.optional(Schema.Unknown),
  products_v2: Schema.optional(Schema.Unknown),
  url_config: Schema.optional(UrlConfigWire),
  presentation_style_v3: Schema.optional(Schema.Unknown),
  presentation_style_v2: Schema.optional(Schema.String),
  presentation_style: Schema.optional(Schema.String),
  feature_gating: Schema.optional(Schema.String),
  background_color_hex: Schema.optional(Schema.String),
  dark_background_color_hex: Schema.optional(Schema.String),
  surveys: Schema.optional(Schema.Unknown),
  paywalljs_event: Schema.optional(Schema.String),
  web_checkout_destination: Schema.optional(Schema.String),
});
const toPaywall = (
  w: Schema.Schema.Type<typeof PaywallWire>,
): RawPaywallResponse => {
  const products = recordsOf(w.products);
  // `product_ids` is authoritative when present; otherwise fall back to the
  // per-slot `products[].product_id`.
  const productIds =
    w.product_ids && w.product_ids.length > 0
      ? [...w.product_ids]
      : decodeItems(ProductSlotWire, w.products).map((p) => p.product_id);
  const urlEndpoints = decodeItems(EndpointWire, w.url_config?.endpoints).map(
    toEndpoint,
  );
  const productsV2 = recordsOf(w.products_v2);
  const surveys = decodeItems(SurveyWire, w.surveys).map(toSurvey);
  const v3 = decodeOne(PresentationStyleV3Wire, w.presentation_style_v3);
  const presentationStyle =
    (v3 && presentationStyleFromV3(v3)) ??
    styleFromString(w.presentation_style_v2 ?? w.presentation_style);
  const featureGatingBehavior =
    w.feature_gating === "GATED"
      ? ("gated" as const)
      : w.feature_gating === "NON_GATED"
        ? ("nonGated" as const)
        : undefined;
  return {
    identifier: w.identifier,
    name: w.name ?? w.identifier,
    url: w.url ?? "",
    productIds,
    ...(products.length > 0 && { products }),
    ...(w.paywalljs_event !== undefined && { paywalljsEvent: w.paywalljs_event }),
    ...(w.web_checkout_destination !== undefined && {
      webCheckoutDestination: w.web_checkout_destination,
    }),
    ...(urlEndpoints.length > 0 && { urlEndpoints }),
    ...(w.background_color_hex !== undefined && {
      backgroundColorHex: w.background_color_hex,
    }),
    ...(w.dark_background_color_hex !== undefined && {
      darkBackgroundColorHex: w.dark_background_color_hex,
    }),
    ...(productsV2.length > 0 && { productsV2 }),
    ...(presentationStyle && { presentationStyle }),
    ...(surveys.length > 0 && { surveys }),
    ...(featureGatingBehavior !== undefined && { featureGatingBehavior }),
  };
};

const presentationStyleFromV3 = (
  v3: Schema.Schema.Type<typeof PresentationStyleV3Wire>,
): PaywallPresentationStyle | undefined => {
  const h = v3.height ?? 0;
  const w = v3.width ?? 0;
  const r = v3.corner_radius ?? 0;
  switch (v3.type.toUpperCase()) {
    case "MODAL":
      return { type: "MODAL" };
    case "FULLSCREEN":
      return { type: "FULLSCREEN" };
    case "NO_ANIMATION":
      return { type: "NO_ANIMATION" };
    case "PUSH":
      return { type: "PUSH" };
    case "NONE":
      return { type: "NONE" };
    case "DRAWER":
      return { type: "DRAWER", height: h, cornerRadius: r };
    case "POPUP":
      return { type: "POPUP", height: h, width: w, cornerRadius: r };
    default:
      return undefined;
  }
};

// Top-level config ───────────────────────────────────────────────────────────
const LocaleWire = Schema.Struct({ locale: Schema.String });
const ToggleWire = Schema.Struct({
  key: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
});
const ApplicationWire = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon_url: Schema.optional(Schema.String),
});
const Web2AppWire = Schema.Struct({
  url_schema: Schema.optional(Schema.String),
  restore_access_url: Schema.optional(Schema.String),
  entitlements_max_age_ms: Schema.optional(Schema.Number),
});

const toApplication = (
  value: unknown,
): Pick<RawConfig, "application"> => {
  const a = decodeOne(ApplicationWire, value);
  if (!a) return {};
  const out: { name?: string; iconUrl?: string } = {};
  if (a.name !== undefined) out.name = a.name;
  if (a.icon_url !== undefined) out.iconUrl = a.icon_url;
  return Object.keys(out).length > 0 ? { application: out } : {};
};

const toWeb2App = (
  value: unknown,
): Pick<RawConfig, "web2appConfig"> => {
  const w = decodeOne(Web2AppWire, value);
  if (!w) return {};
  const cfg: RawWeb2AppConfig = {
    ...(w.url_schema !== undefined && { urlSchema: w.url_schema }),
    ...(w.restore_access_url !== undefined && {
      restoreAccessUrl: w.restore_access_url,
    }),
    ...(w.entitlements_max_age_ms !== undefined && {
      entitlementsMaxAgeMs: w.entitlements_max_age_ms,
    }),
  };
  return { web2appConfig: cfg };
};

/**
 * Decode a `/api/v1/static_config` payload into `RawConfig`. Throws
 * `ConfigParseError` only when the shape isn't an object or `build_id` is
 * missing — everything else degrades to empty/default rather than throwing,
 * and the original payload is preserved on `.raw`.
 */
export const parseConfig = (input: JsonValue): RawConfig => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ConfigParseError({
      message: `static_config response is not an object (got ${typeof input})`,
    });
  }
  const root = input as Record<string, JsonValue>;
  const buildId = typeof root["build_id"] === "string" ? root["build_id"] : "";
  if (!buildId) {
    throw new ConfigParseError({
      message: "static_config response is missing `build_id`",
    });
  }

  const localization = root["localization"];
  const locales =
    typeof localization === "object" &&
    localization !== null &&
    !Array.isArray(localization)
      ? decodeItems(
          LocaleWire,
          (localization as Record<string, JsonValue>)["locales"],
        ).map((l) => l.locale)
      : [];

  return {
    buildId,
    triggerOptions: decodeItems(TriggerWire, root["trigger_options"]).map(
      toTrigger,
    ),
    paywallResponses: decodeItems(PaywallWire, root["paywall_responses"]).map(
      toPaywall,
    ),
    products: decodeItems(ProductWire, root["products"])
      .map(toProduct)
      .filter((p): p is RawProductItem => p !== null),
    toggles: decodeItems(ToggleWire, root["toggles"]).map((t) => ({
      key: t.key,
      enabled: t.enabled === true,
    })),
    locales,
    testModeUserIds: decodeItems(TestModeUserIdSchema, root["test_mode_user_ids"]),
    ...toApplication(root["application"]),
    ...toWeb2App(root["web2app_config"]),
    raw: root,
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

/** Build a `reference_name → entitlementIds[]` map by walking every paywall's
 *  `products_v2` entries. `post_checkout_complete.product_identifier` carries
 *  the slot reference name (e.g. `"primary"`), NOT the Stripe product id —
 *  this map is the right lookup for the post-purchase entitlement flip. */
export const extractEntitlementsByReferenceName = (
  paywallResponses: ReadonlyArray<RawPaywallResponse>,
): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const pw of paywallResponses) {
    for (const p of pw.productsV2 ?? []) {
      const referenceName =
        typeof p["reference_name"] === "string" ? p["reference_name"] : null;
      if (!referenceName) continue;
      const ents = Array.isArray(p["entitlements"])
        ? (p["entitlements"] as ReadonlyArray<unknown>)
        : [];
      const ids = ents
        .map((e) =>
          e &&
          typeof e === "object" &&
          typeof (e as { identifier?: unknown }).identifier === "string"
            ? (e as { identifier: string }).identifier
            : null,
        )
        .filter((s): s is string => s !== null);
      if (ids.length > 0) out.set(referenceName, ids);
    }
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
