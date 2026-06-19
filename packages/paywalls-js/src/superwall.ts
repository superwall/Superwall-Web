// Public Superwall instance + factory. Internals run on Effect (services +
// Layer + ManagedRuntime); one ManagedRuntime per instance so service state
// is shared across method calls. Public methods are thin Promise façades.

import { Array as Arr, Effect, Layer, ManagedRuntime, Match, Option, Stream } from "effect";
import { _clearDefault, _registerDefault } from "./default.ts";
import { SDK_VERSION } from "./version.ts";
import {
  NoPresenterRegisteredError,
  NotConfiguredError,
  PaywallAlreadyPresentedError,
  PaywallNotAvailableError,
  PresenterError,
} from "./errors.ts";
import {
  SuperwallEventTarget,
  type AllSuperwallEvents,
  type SuperwallDelegate,
} from "./events.ts";
import type {
  CustomPaywallRenderer,
  PaywallPresenter,
  PresentationContext,
  SurveyPresenter,
} from "./presenter.ts";
import { createCustomPaywallPresenter } from "./internal/customPaywallPresenter.ts";
import { presentSurveyIfAvailable } from "./internal/survey.ts";
import { asReadable, createSignal, type Readable } from "./signal.ts";
import {
  STORAGE_KEYS,
  type ConfigurationStatus,
  type ConfirmedAssignment,
  type Entitlement,
  type RedemptionResult,
  type Experiment,
  type IdentityOptions,
  type IntegrationAttribute,
  type JsonValue,
  type LogLevel,
  type LogScope,
  type PartialSuperwallOptions,
  closeReasonShouldComplete,
  type PaywallCloseReason,
  type PaywallInfo,
  type PaywallPresentationStyle,
  type PaywallResult,
  type PaywallSkippedReason,
  type PlacementParams,
  type PurchaseController,
  type PurchaseResult,
  type RestorationResult,
  type PresentationResult,
  type Product,
  type StorageAdapter,
  type SubscriptionStatus,
  type TriggerResult,
  type UserAttributes,
  type CustomerInfo,
} from "./types.ts";
import { asPresentationId, asStorageKey, type PresentationId } from "./internal/brands.ts";
import {
  EventBus,
  eventBusLayerWithTarget,
  type EventBusImpl,
} from "./internal/eventBus.ts";
import { Logger, loggerLayer } from "./internal/logger.ts";
import {
  ComputedProperties,
  computedPropertiesLayer,
} from "./internal/computed.ts";
import {
  ConfigService,
  configServiceLayer,
  extractEntitlementsByProductId,
  extractEntitlementsByReferenceName,
  type ConfigServiceImpl,
} from "./internal/config.ts";
import {
  AudienceEvaluator,
  audienceEvaluatorLayer,
} from "./internal/audience.ts";
import {
  AssignmentService,
  assignmentServiceLayer,
  type AssignmentServiceImpl,
} from "./internal/assignments.ts";
import {
  IdentityPending,
  IdentityService,
  identityWithStorage,
  type IdentitySnapshot,
  type IdentitySeed,
} from "./internal/identity.ts";
import {
  isSandbox,
  networkServiceLayer,
  NetworkService,
  resolveHosts,
  type NetworkConfig,
} from "./internal/network.ts";
import {
  buildDeviceAttributes,
  type DeviceAttributesInput,
} from "./internal/deviceAttributes.ts";
import { createMemoryStorage, StorageService } from "./internal/storage.ts";
// Safe to import statically — DOM access is `typeof`-guarded, no top-level use.
import { createBrowserStorage } from "./browser/storage.ts";
import { translateInternalError } from "./internal/translate.ts";
import {
  RedemptionService,
  redemptionServiceLayer,
  RedeemType,
  type RedemptionServiceImpl,
} from "./internal/redemption.ts";
import { createAutomaticPurchaseController } from "./internal/automaticPurchaseController.ts";
import type { PaywallPurchaseEvent } from "./presenter.ts";

// ---------------------------------------------------------------------------
// Public namespace shapes
// ---------------------------------------------------------------------------

export interface UserNamespace {
  readonly id: Readable<string>;
  readonly aliasId: Readable<string>;
  readonly effectiveId: Readable<string>;
  readonly isLoggedIn: Readable<boolean>;
  readonly attributes: Readable<UserAttributes>;
  readonly integrationAttributes: Readable<
    Partial<Record<IntegrationAttribute, string>>
  >;
  identify(userId: string, opts?: IdentityOptions): Promise<void>;
  signOut(): Promise<void>;
  setAttributes(attrs: Partial<UserAttributes>): void;
  setIntegrationAttribute(
    attr: IntegrationAttribute,
    value: string | null,
  ): void;
  setIntegrationAttributes(
    attrs: Partial<Record<IntegrationAttribute, string | null>>,
  ): void;
}

/** Per-call callbacks for `register` — fire only for this one call. */
export interface PaywallPresentationHandler {
  onPresent?(info: PaywallInfo): void;
  onDismiss?(info: PaywallInfo, result: PaywallResult): void;
  onError?(error: Error): void;
  onSkip?(reason: PaywallSkippedReason): void;
}

export interface RegisterPlacementArgs {
  placement: string;
  params?: PlacementParams;
  handler?: PaywallPresentationHandler;
  /** Runs when the user is entitled OR the resolved paywall was non-gated
   *  and skipped/dismissed without purchase. */
  feature?: () => void | Promise<void>;
  /** Per-call overrides applied before the presenter mounts the iframe.
   *  Fields are individually optional; unset ones fall back to the
   *  paywall's config. */
  overrides?: PaywallOverrides;
  /** Full presenter override for this call. Bypasses the default browser
   *  iframe presenter entirely. Highest precedence. */
  presenter?: PaywallPresenter;
  /** Render your own paywall UI instead of the default iframe. The SDK
   *  still runs the full trigger pipeline + fires identical lifecycle
   *  events; you supply UI and drive `controller.buy/restore/close`.
   *  Mirrors Android's `SuperwallCustomPaywall`. Ignored when `presenter`
   *  is also set. See `@superwall/paywalls-react`'s `SuperwallCustomPaywall`
   *  for the React wrapper. */
  paywall?: CustomPaywallRenderer;
}

export interface PaywallOverrides {
  /** Replace the paywall's `presentation_style_v3` for this call. */
  presentationStyle?: PaywallPresentationStyle;
}

export type RegisterPlacementResult =
  | { type: "presented"; info: PaywallInfo; result: PaywallResult }
  | { type: "skipped"; reason: PaywallSkippedReason }
  | { type: "error"; error: Error };

export interface PlacementsNamespace {
  getPresentationResult(
    placement: string,
    params?: PlacementParams,
  ): Promise<PresentationResult>;
  /** Returns the locally-cached `ConfirmedAssignment[]`. Pure read; no
   *  network. Useful for analytics integrations that want to observe
   *  variant rollout without forcing a confirm round-trip. */
  getAssignments(): Promise<ConfirmedAssignment[]>;
  /** POST every cached assignment to the backend (idempotent) and return
   *  the same set. Use when you want the BE's view of `confirmed_at` to
   *  catch up — analytics pipelines often gate on that. */
  confirmAllAssignments(): Promise<ConfirmedAssignment[]>;
  preloadAll(): Promise<void>;
  preloadFor(placementNames: string[]): Promise<void>;
}

export interface PurchasesNamespace {
  restore(): Promise<void>;
  refreshCustomerInfo(): Promise<never>;
  setSubscriptionStatus(s: SubscriptionStatus): void;
  /** Catalog products from the parsed config. Empty array pre-configure
   *  or when the static_config carries no products. */
  getProducts(): Promise<Product[]>;
  /** Snapshot of the current customer info signal value. Convenience for
   *  consumers that prefer Promise/method calls over signal subscription. */
  getCustomerInfo(): Promise<CustomerInfo | null>;
  /** Current Superwall-signed entitlements token (`null` if none yet). Send it
   *  to your backend and verify with `@superwall/verify`'s `verifyEntitlements`
   *  for a stateless, offline entitlement check. Refreshed from each
   *  `/entitlements` read (~hourly to track `exp`). Best-effort: `null` when
   *  the backend isn't issuing tokens. For reactive reads, see
   *  `sw.entitlementsToken`. */
  getEntitlementsToken(): string | null;
  // NOTE: `purchase(product)` is intentionally hidden for now. With the default
  // automaticPurchaseController it only resolves while a paywall is presenting
  // and the user completes Stripe checkout in parallel — standalone it does
  // nothing useful, so it's not part of the public surface yet. The
  // implementation lives on internally as `directPurchase` (the custom-paywall
  // render path needs it); re-expose here once it can initiate checkout itself.
}

export interface EntitlementsNamespace {
  readonly active: Readable<Entitlement[]>;
  readonly inactive: Readable<Entitlement[]>;
  readonly all: Readable<Entitlement[]>;
  byProductIds(ids: string[]): Entitlement[];
}

export interface Superwall {
  readonly apiKey: string;
  readonly ready: Promise<void>;
  readonly isConfigured: Readable<boolean>;
  readonly configurationStatus: Readable<ConfigurationStatus>;

  readonly user: UserNamespace;
  readonly placements: PlacementsNamespace;

  /** Evaluate a placement against current config + audience rules and, if
   *  the user matches a paywall variant, present the paywall. Top-level
   *  primary entry point — mirrors `Superwall.shared.register(...)` on
   *  iOS / Android. Skipped reasons (no audience match, holdout, already
   *  entitled, etc.) surface in the return value without throwing. */
  register(args: RegisterPlacementArgs): Promise<RegisterPlacementResult>;
  readonly purchases: PurchasesNamespace;
  readonly entitlements: EntitlementsNamespace;

  readonly subscriptionStatus: Readable<SubscriptionStatus>;
  readonly customerInfo: Readable<CustomerInfo | null>;
  /** Reactive view of the current Superwall-signed entitlements token (`null`
   *  until one is issued). Forward it to your backend and verify offline with
   *  `@superwall/verify`. See `purchases.getEntitlementsToken()` for a snapshot
   *  read. */
  readonly entitlementsToken: Readable<string | null>;
  readonly latestPaywallInfo: Readable<PaywallInfo | null>;
  readonly isPaywallPresented: Readable<boolean>;

  readonly events: SuperwallEventTarget;

  readonly logLevel: Readable<LogLevel>;
  readonly locale: Readable<string | null>;

  setLogLevel(level: LogLevel): void;
  setLocale(locale: string | null): void;
  setDelegate(delegate: SuperwallDelegate | null): void;
  /**
   * Force the SDK's reported interface style to `"light"` or `"dark"`,
   * overriding the automatic `prefers-color-scheme` detection used for the
   * `X-Device-Interface-Style` header and threaded into paywall templates.
   * Pass `null` to clear the override and revert to system.
   */
  setInterfaceStyle(style: "light" | "dark" | null): void;

  reset(): Promise<void>;
  /**
   * Force-close the active paywall. Optionally record *why* — surfaces on
   * `paywall_close` event params + `PaywallInfo.closeReason`.
   *
   * Default: `"systemLogic"` (programmatic close after some app event).
   * Use `"manualClose"` when the user dismissed via your own UI affordance.
   * `"forNextPaywall"` short-circuits the feature block because another
   * paywall is queued. `"webViewFailedToLoad"` is for iframe load errors.
   */
  dismiss(reason?: PaywallCloseReason): void;

  /** Re-fetch static config and re-run eager assignment. Re-entrancy-safe:
   *  concurrent calls share the in-flight transition. */
  refreshConfiguration(): Promise<void>;

  /** Tear down the runtime. Idempotent; the instance is unusable after. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface CreateSuperwallOptions {
  apiKey: string;
  options?: PartialSuperwallOptions;
  delegate?: SuperwallDelegate;
  storage?: StorageAdapter;
  /** Optional renderer for post-paywall surveys. Absent ⇒ the SDK skips
   *  survey presentation (the assignment key is still consumed so the
   *  user isn't pestered with the same survey twice on revisit). The
   *  browser default lives in `@superwall/paywalls-js/browser`
   *  (`createBrowserSurveyPresenter`). */
  surveyPresenter?: SurveyPresenter;
  identity?: {
    aliasId?: string;
    appUserId?: string;
    vendorId?: string;
    vendorIdProvider?: () => Promise<string> | string;
  };
  /** Test override for `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Override the default Stripe + redemption controller. Absent ⇒ SDK
   *  uses `automaticPurchaseController()` which handles the standard
   *  paywall checkout flow + ?code= redemption + web_entitlements polling. */
  purchaseController?: PurchaseController;
}

// ---------------------------------------------------------------------------
// Subscription status equality — dedupes `subscriptionStatus_didChange`
// when nothing actually changed (e.g. the 60s entitlements poll re-applies
// the same set). Compares status tag + sorted active entitlement ids.
// ---------------------------------------------------------------------------

const subscriptionStatusEqual = (
  a: import("./types.ts").SubscriptionStatus,
  b: import("./types.ts").SubscriptionStatus,
): boolean => {
  if (a.status !== b.status) return false;
  if (a.status !== "ACTIVE" || b.status !== "ACTIVE") return true;
  if (a.entitlements.length !== b.entitlements.length) return false;
  const idsA = a.entitlements.map((e) => `${e.id}:${e.isActive ? 1 : 0}`).sort();
  const idsB = b.entitlements.map((e) => `${e.id}:${e.isActive ? 1 : 0}`).sort();
  for (let i = 0; i < idsA.length; i++) {
    if (idsA[i] !== idsB[i]) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Iframe init payload builder
// ---------------------------------------------------------------------------

interface InitPayloadInput {
  info: PaywallInfo;
  placement: string;
  params: PlacementParams;
  decision: {
    kind: "paywall";
    experiment: Experiment;
  };
  application: { name?: string; iconUrl?: string } | undefined;
  bootstrap: {
    apiKey: string;
    sdkVersion: string;
    collector: string;
    apiBase: string;
    clientSurface: "web-sdk";
    hostOrigin?: string;
    cancelUrl?: string;
  };
  aliasId: string | undefined;
  appUserId: string | undefined;
  deviceId: string | undefined;
  email: string | undefined;
  userAttributes: Record<string, unknown>;
  deviceAttributes: Record<string, unknown>;
}

const randomUuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // SSR / older runtime fallback — non-cryptographic, OK for event ids.
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/** Build the `#init=` payload for the paywall iframe. Shape per
 *  `packages/web-paywalls/src/schema/controller.ts` +
 *  `apps/subscriptions-api/src/schema/CheckoutContext.ts:InitializationPropsSchema`.
 *  Many fields are optional with `?? null` / `?? ""` fallbacks because the
 *  controller's destructure is non-defensive (missing required fields
 *  crash on boot). Products are forwarded raw with `resolveVariables: true`
 *  so the server resolves per-locale `ProductVariables` instead of the SDK. */
export const buildInitPayload = (input: InitPayloadInput): Record<string, unknown> => {
  const {
    info,
    placement,
    params,
    decision,
    application,
    bootstrap,
    aliasId,
    appUserId,
    deviceId,
    email,
    userAttributes,
    deviceAttributes,
  } = input;
  const placementEventId = randomUuid();
  const presentedByEventId = randomUuid();
  const userId =
    appUserId !== undefined
      ? ({ type: "appUserId" as const, appUserId })
      : ({ type: "aliasId" as const, aliasId: aliasId ?? "" });
  const identity = {
    userId,
    deviceId: deviceId ?? "",
    ...(email && { email }),
    ...(aliasId && { aliasId }),
    ...(appUserId && { appUserId }),
  };
  const productIds = info.productIds ?? [];
  const products = info.productsV2 ?? [];
  const paywallSlice = {
    paywallId: info.identifier,
    paywallIdentifier: info.identifier,
    paywallName: info.name,
    paywallProductIds: productIds.join(","),
    paywallUrl: info.url,
  };
  const experimentSlice = {
    experimentId: decision.experiment.id,
    variantId: decision.experiment.variant.id,
  };
  const presentmentSlice = {
    // Free-trial availability defaults to false when no v2 product
    // declares `trial_days`; refined once product variables resolve.
    isFreeTrialAvailable: products.some((p) => {
      const sp = (p as { store_product?: Record<string, unknown>; storeProduct?: Record<string, unknown> })
        .store_product ?? (p as { storeProduct?: Record<string, unknown> }).storeProduct;
      return typeof sp === "object" && sp !== null && (sp as { trial_days?: unknown; trialDays?: unknown })["trial_days"] != null;
    }),
    presentationSourceType: "register" as const,
    presentedBy: "placement" as const,
    presentedByEventId,
    presentedByEventName: placement,
    presentedByEventTimestamp: new Date().toISOString(),
  };
  const placementParamsSlice = { placementParams: params };
  const collector: Record<string, unknown> = {
    // Events route through the paywall app's CORS-enabled proxy at
    // `/api/proxy/events` (paywall-next: `MainResolver.ts:75`). Absolute
    // against `apiBase` so it points at the paywall worker regardless of
    // where the iframe itself is loaded from.
    url: `${bootstrap.apiBase}/api/proxy/events`,
    headers: {
      "x-public-api-key": bootstrap.apiKey,
      "x-alias-id": aliasId ?? "",
      "x-device-id": deviceId ?? "",
      "x-platform": "web",
      "x-sdk-version": bootstrap.sdkVersion,
    },
    placementEventId,
    identity: { userId, deviceId: deviceId ?? "" },
    userAttributes,
    deviceAttributes,
    experimentSlice,
    paywallSlice,
    productSlice: {},
    presentmentSlice,
    placementParamsSlice,
  };
  const checkoutContext: Record<string, unknown> = {
    paywall: paywallSlice,
    experiment: experimentSlice,
    presentment: presentmentSlice,
    placementParams: placementParamsSlice,
    identity,
    device: {
      publicApiKey: bootstrap.apiKey,
      platform: "web",
      appVersion: (deviceAttributes["appVersion"] as string) ?? "",
      osVersion: (deviceAttributes["osVersion"] as string) ?? "",
      deviceModel: (deviceAttributes["deviceModel"] as string) ?? "",
      deviceLocale: (deviceAttributes["deviceLocale"] as string) ?? "",
      deviceLanguageCode: (deviceAttributes["deviceLanguageCode"] as string) ?? "",
      deviceCurrencyCode: (deviceAttributes["deviceCurrencyCode"] as string) ?? "",
      deviceCurrencySymbol: (deviceAttributes["deviceCurrencySymbol"] as string) ?? "",
      timezoneOffset: (deviceAttributes["timezoneOffset"] as number) ?? 0,
    },
    products: {},
  };
  return {
    placementSessionToken: bootstrap.apiKey,
    clientSurface: bootstrap.clientSurface,
    hostOrigin: bootstrap.hostOrigin ?? "",
    cancelUrl: bootstrap.cancelUrl ?? bootstrap.hostOrigin ?? "",
    apiBase: bootstrap.apiBase,
    // Server-side ProductVariables resolution. SDK ships raw products from
    // static_config + this flag instead of computing variables locally
    // (would need the schema-next decoder + per-locale price logic).
    resolveVariables: true,
    products,
    application: {
      name: application?.name ?? "",
      iconUrl: application?.iconUrl ?? "",
    },
    backgroundColorHex: {
      light: info.backgroundColorHex ?? null,
      dark: info.darkBackgroundColorHex ?? null,
    },
    variables: {
      deviceProperties: deviceAttributes,
      // Controller iterates `variables.products` via `.reduce` — array, not
      // record (despite the dev's "Record<refName, ProductVariables>" note;
      // the controller's `acceptVariables` is the source of truth and it
      // calls `.reduce`). Server fills with resolved variables via
      // `resolveVariables: true`; ship empty array as a safe seed.
      products: [],
      params,
    },
    checkoutContext,
    transactionAbandon: null,
    isFirstAssignment: false,
    integrations: [],
    collector,
  };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Browser → localStorage (persists across reloads); elsewhere → in-memory. */
const createDefaultStorage = (): StorageAdapter => {
  if (typeof localStorage !== "undefined") {
    try {
      return createBrowserStorage();
    } catch {
      // localStorage present but unusable (e.g. Safari private mode).
    }
  }
  return createMemoryStorage();
};

export const createSuperwall = (opts: CreateSuperwallOptions): Superwall => {
  const target = new SuperwallEventTarget();

  // Layer composition: storage → identity → network → eventBus
  // Capture the raw adapter too — the survey path bypasses Effect since
  // it's invoked from an async handler, not an Effect.gen scope.
  const rawStorageAdapter = opts.storage ?? createDefaultStorage();
  const storageLayer = StorageService.fromAdapter(rawStorageAdapter);
  const identityLayer = identityWithStorage(storageLayer);
  // Mutable interface-style override. Closure-read per request by the
  // network layer so `sw.setInterfaceStyle(...)` takes effect immediately.
  let interfaceStyleOverride: "light" | "dark" | null = null;
  // PartialSuperwallOptions deeply-partializes the `{ custom: ... }` shape of
  // networkEnvironment. The runtime value is always a valid NetworkEnvironment;
  // narrow at this single typed boundary rather than casting inline everywhere.
  const resolveNetworkEnvironment = (
    env: PartialSuperwallOptions["networkEnvironment"],
  ): NetworkConfig["environment"] =>
    (env ?? "release") as NetworkConfig["environment"];

  const networkConfig: NetworkConfig = {
    apiKey: opts.apiKey,
    environment: resolveNetworkEnvironment(opts.options?.networkEnvironment),
    ...(opts.options?.appVersion !== undefined && { appVersion: opts.options.appVersion }),
    ...(opts.options?.bundleId !== undefined && { bundleId: opts.options.bundleId }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    interfaceStyleOverride: () => interfaceStyleOverride,
  };
  const networkLayer = networkServiceLayer(networkConfig, identityLayer);
  const computedLayer = computedPropertiesLayer(storageLayer);
  // Build configUpstream explicitly: `networkLayer`'s declared type narrows
  // away StorageService even though it's there at runtime.
  const configUpstream = Layer.merge(networkLayer, storageLayer);
  const configLayer = configServiceLayer(opts.apiKey, configUpstream);
  const assignmentLayer = assignmentServiceLayer(storageLayer);
  const upstreamForBus = Layer.merge(networkLayer, computedLayer);
  const busLayer = eventBusLayerWithTarget(target, upstreamForBus);
  const layerWithConfig = Layer.mergeAll(
    busLayer,
    configLayer,
    assignmentLayer,
    identityLayer,
  );
  const baseLayer = loggerLayer(
    opts.options?.logging?.level ?? "warn",
    layerWithConfig,
  );
  const audienceLayer = audienceEvaluatorLayer(baseLayer);
  const fullLayer = redemptionServiceLayer(audienceLayer);
  const runtime = ManagedRuntime.make(fullLayer);

  // Public-facing signals. Driven by background subscriptions in configure().
  const idSig = createSignal<string>("");
  const aliasSig = createSignal<string>("");
  const effectiveSig = createSignal<string>("");
  const loggedInSig = createSignal<boolean>(false);
  // Empty object is a valid UserAttributes baseline (Record<string, JsonValue> with no keys).
  // UserAttributes extends Record<string,JsonValue>; empty object is always valid.
  const attrsSig = createSignal<UserAttributes>({} as UserAttributes);
  const intAttrsSig = createSignal<
    Partial<Record<IntegrationAttribute, string>>
  >({});
  const subStatusSig = createSignal<SubscriptionStatus>({ status: "UNKNOWN" });
  const customerSig = createSignal<CustomerInfo | null>(null);
  // Latest Superwall-signed entitlements JWT, refreshed from every
  // `/entitlements` read (steady-state poll, post-purchase reconcile, restore).
  // The host forwards it to their backend for offline verification via
  // `@superwall/verify`. `null` until the first read returns one — best-effort:
  // the backend omits it when signing is unavailable. We never downgrade a
  // good token to `null` on a transient refresh failure.
  const entitlementsTokenSig = createSignal<string | null>(null);
  // Config-derived `productId → entitlementIds` map. Populated on every
  // applyConfig so `entitlements.byProductIds()` can answer pre-purchase.
  const entitlementsByProductIdSig = createSignal<Map<string, string[]>>(
    new Map(),
  );
  // Persisted counters feed the deviceAttributes builder so audience CEL
  // can read time-since-install + paywall-view bucket fields.
  // firstSeenAt is written once on first configure() and survives sw.reset()
  // (mirrors install-date semantics).
  const firstSeenAtSig = createSignal<number | null>(null);
  const totalPaywallViewsSig = createSignal<number>(0);
  const lastPaywallViewAtSig = createSignal<number | null>(null);
  const latestPaywallSig = createSignal<PaywallInfo | null>(null);
  const presentedSig = createSignal<boolean>(false);
  const configuredSig = createSignal<boolean>(false);
  const statusSig = createSignal<ConfigurationStatus>("pending");
  const logLevelSig = createSignal<LogLevel>(opts.options?.logging?.level ?? "warn");
  const localeSig = createSignal<string | null>(
    opts.options?.localeIdentifier ?? null,
  );
  /** ms-since-epoch of the last successful restore. */
  const lastRestoreAtSig = createSignal<number | null>(null);

  // configure() — runs once, drives sw.ready

  const seed: IdentitySeed | undefined = opts.identity
    ? {
        ...(opts.identity.aliasId !== undefined && { aliasId: opts.identity.aliasId }),
        ...(opts.identity.appUserId !== undefined && {
          appUserId: opts.identity.appUserId,
        }),
        ...(opts.identity.vendorId !== undefined && { vendorId: opts.identity.vendorId }),
        ...(opts.identity.vendorIdProvider !== undefined && {
          vendorIdProvider: opts.identity.vendorIdProvider,
        }),
      }
    : undefined;

  const configure = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("sdk.version", SDK_VERSION);
    const bus = yield* EventBus;

    if (opts.delegate) {
      yield* bus.setDelegate(opts.delegate);
    }

    yield* IdentityService.hydrate(seed);

    // Bridge identity changes onto the public signals. forkDaemon so it
    // outlives configure() and keeps propagating across the runtime.
    const identityStream = yield* IdentityService.observe();
    yield* Effect.forkDaemon(
      identityStream.pipe(
        Stream.runForEach((snap: IdentitySnapshot | null) =>
          Effect.sync(() => {
            if (snap === null) return;
            idSig.set(snap.appUserId);
            aliasSig.set(snap.aliasId);
            effectiveSig.set(snap.appUserId === "" ? snap.aliasId : snap.appUserId);
            loggedInSig.set(snap.appUserId !== "");
          }),
        ),
      ),
    );

    // Delegate bridges: signal changes → typed delegate callbacks. We track
    // previous values to skip the sync-on-attach fire so consumers only see
    // real transitions.

    let prevAttrs = attrsSig.value;
    attrsSig.subscribe((next) => {
      if (next === prevAttrs) return;
      const changed = next;
      prevAttrs = next;
      runFireAndForget(
        "superwallCore",
        "userAttributes bridge effect failed",
        bus.withDelegate(
          (d) => d.onUserAttributesChange?.(changed),
          (cause) =>
            logViaRuntime(
              "superwallCore",
              "delegate.onUserAttributesChange threw",
              cause,
            ),
        ),
      );
    });

    // Bridge presenter-emitted URL/deep-link events to the typed delegate.
    target.addEventListener("paywallWillOpenURL", (e) => {
      runFireAndForget(
        "paywallEvents",
        "paywallWillOpenURL bridge effect failed",
        bus.withDelegate(
          (d) => d.onPaywallWillOpenURL?.(e.detail.url),
          (cause) =>
            logViaRuntime(
              "paywallEvents",
              "delegate.onPaywallWillOpenURL threw",
              cause,
            ),
        ),
      );
    });
    target.addEventListener("paywallWillOpenDeepLink", (e) => {
      runFireAndForget(
        "paywallEvents",
        "paywallWillOpenDeepLink bridge effect failed",
        bus.withDelegate(
          (d) => d.onPaywallWillOpenDeepLink?.(e.detail.url),
          (cause) =>
            logViaRuntime(
              "paywallEvents",
              "delegate.onPaywallWillOpenDeepLink threw",
              cause,
            ),
        ),
      );
    });

    let prevCustomerInfo = customerSig.value;
    customerSig.subscribe((next) => {
      if (next === prevCustomerInfo) return;
      const from = prevCustomerInfo;
      prevCustomerInfo = next;
      if (from === null || next === null) return; // need both for from/to delegate signature
      runFireAndForget(
        "superwallCore",
        "customerInfo bridge effect failed",
        bus.withDelegate(
          (d) => d.onCustomerInfoChange?.(from, next),
          (cause) =>
            logViaRuntime(
              "superwallCore",
              "delegate.onCustomerInfoChange threw",
              cause,
            ),
        ),
      );
    });

    // Replay last-restore timestamp so consumers can read it pre-restore.
    const storage = yield* StorageService;
    const cachedRestoreAt = yield* storage.get(
      asStorageKey(STORAGE_KEYS.lastRestoreAt),
    );
    if (cachedRestoreAt !== null) {
      const ms = Number.parseInt(cachedRestoreAt, 10);
      if (!Number.isNaN(ms)) lastRestoreAtSig.set(ms);
    }

    yield* hydrateCounters();
    yield* hydrateSubscriptionStatus();

    // Auto-context for every wire-emitted event. Merged under caller params
    // so explicit keys always win. `$presentation_id` is empty between
    // register() calls — analytics consumers can filter on its presence.
    yield* bus.setContextProvider(() => {
      const ctx: Record<string, JsonValue> = {
        $client_surface: "web-sdk",
      };
      try {
        const loc = (globalThis as { location?: { origin?: string } }).location;
        if (typeof loc?.origin === "string") ctx.$host_origin = loc.origin;
      } catch {}
      if (currentPresentationId) {
        ctx.$presentation_id = currentPresentationId;
      }
      return ctx;
    });

    yield* bus.publish("first_seen", {});
    yield* bus.publish("session_start", {});
    yield* bus.publish("app_launch", {});

    // Replay cached config from storage for offline-first; subsequent
    // network fetch revalidates.
    const config = yield* ConfigService;
    const assignments = yield* AssignmentService;
    yield* config.hydrateFromStorage().pipe(
      Effect.tapError((e) => Effect.logDebug("Config hydration from storage failed", { error: String(e) })),
      Effect.catchAll(() => Effect.void),
    );
    // Eager assignment over the cached config so first register() is fast
    // and confirmAllAssignments returns a complete snapshot.
    yield* eagerAssign(config, assignments);
    yield* applyEntitlementsByProductId(config);
    yield* config.preload();
    yield* warmPaywalls(config);

    const hydrated = yield* config.current();
    const enrichmentEffect = runEnrichment(bus).pipe(
      Effect.tapError((e) => Effect.logDebug("Enrichment failed", { error: String(e) })),
      Effect.catchAll(() => Effect.void),
    );

    // Cache-hot fast path: if hydrate produced a config, flip `configured`
    // immediately and revalidate in the background. register() can fire
    // against the cached config without waiting for the network round-trip.
    // No cache → block on the network fetch (consumer needs config to
    // do anything meaningful).
    const applyFreshConfig = () =>
      Effect.gen(function* () {
        yield* eagerAssign(config, assignments);
        yield* applyEntitlementsByProductId(config);
        yield* confirmAssignments(assignments);
        yield* config.preload();
        yield* warmPaywalls(config);
      });

    // Track whether we have a usable config (cache OR fresh). Status flips
    // to "failed" if neither lands — register() against `null` config is
    // a misconfiguration we should signal clearly, not pretend to succeed.
    let haveConfig = hydrated !== null;

    if (hydrated) {
      // Fire revalidation + enrichment in the background — don't await.
      yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.all(
            [
              config.fetch().pipe(
                Effect.tapError((e) => Effect.logDebug("Background config revalidation failed", { error: String(e) })),
                Effect.catchAll(() => Effect.void),
                Effect.tap(() => applyFreshConfig()),
              ),
              enrichmentEffect,
            ],
            { concurrency: "unbounded" },
          );
        }),
      );
    } else {
      // First-ever load — must await the network so register() has data.
      yield* Effect.all(
        [
          config
            .fetch()
            .pipe(
              Effect.tap(() => Effect.sync(() => { haveConfig = true; })),
              Effect.tapError((e) => Effect.logDebug("Initial config fetch failed", { error: String(e) })),
              Effect.catchAll(() => Effect.void),
            ),
          enrichmentEffect,
        ],
        { concurrency: "unbounded" },
      );
      if (haveConfig) {
        yield* applyFreshConfig();
      }
    }

    // Drain the initial Configuration pending item — register() blocks on
    // phase=Ready until this clears.
    yield* IdentityService.endPending(IdentityPending.Configuration);
    configuredSig.set(haveConfig);
    statusSig.set(haveConfig ? "configured" : "failed");
  }).pipe(Effect.withSpan("Superwall.configure"));

  /** Hand every trigger experiment to AssignmentService.chooseAllVariants. */
  const eagerAssign = Effect.fn("Superwall.eagerAssign")(function*(
    config: ConfigServiceImpl,
    assignments: AssignmentServiceImpl,
  ) {
      const cfg = yield* config.current();
      if (!cfg) return;
      const experiments = Arr.flatMap(cfg.triggerOptions, (t) =>
        Arr.map(t.rules, (r) => r.experiment),
      );
      yield* assignments.chooseAllVariants(experiments);
    });

  /** Read persisted counters into signals; bootstrap firstSeenAt on first run. */
  const hydrateCounters = () =>
    Effect.gen(function* () {
      const storage = yield* StorageService;
      const firstSeenKey = asStorageKey(STORAGE_KEYS.firstSeenAt);
      const totalKey = asStorageKey(STORAGE_KEYS.totalPaywallViews);
      const lastViewKey = asStorageKey(STORAGE_KEYS.lastPaywallViewAt);

      const stored = yield* storage.get(firstSeenKey);
      if (stored !== null) {
        const ms = Number.parseInt(stored, 10);
        if (!Number.isNaN(ms)) firstSeenAtSig.set(ms);
      } else {
        const now = Date.now();
        firstSeenAtSig.set(now);
        yield* storage
          .set(firstSeenKey, String(now))
          .pipe(Effect.catchAll(() => Effect.void));
      }

      const total = yield* storage.get(totalKey);
      if (total !== null) {
        const n = Number.parseInt(total, 10);
        if (!Number.isNaN(n)) totalPaywallViewsSig.set(n);
      }
      const lastView = yield* storage.get(lastViewKey);
      if (lastView !== null) {
        const ms = Number.parseInt(lastView, 10);
        if (!Number.isNaN(ms)) lastPaywallViewAtSig.set(ms);
      }
    });

  /** Replay the last cached `SubscriptionStatus` so a page reopen shows it
   *  immediately instead of UNKNOWN. The `/entitlements` refresh (APC
   *  onConfigured) reconciles it shortly after. Only ACTIVE/INACTIVE are
   *  cached — UNKNOWN is the un-set placeholder, never persisted. */
  const hydrateSubscriptionStatus = () =>
    Effect.gen(function* () {
      const storage = yield* StorageService;
      const raw = yield* storage
        .get(asStorageKey(STORAGE_KEYS.subscriptionStatus))
        .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
      if (raw === null) return;
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as SubscriptionStatus,
        catch: () => null,
      }).pipe(Effect.option);
      if (Option.isSome(parsed) && parsed.value !== null) {
        const s = parsed.value;
        if (s.status === "ACTIVE" || s.status === "INACTIVE") {
          subStatusSig.set(s);
        }
      }
    });

  /** Persist the resolved subscription status so it survives reloads. Called
   *  from the single setter path. Skips UNKNOWN (the placeholder). */
  const persistSubscriptionStatus = (s: SubscriptionStatus): void => {
    if (s.status === "UNKNOWN") return;
    runFireAndForget(
      "transactions",
      "persist subscriptionStatus failed",
      Effect.gen(function* () {
        const storage = yield* StorageService;
        yield* storage.set(
          asStorageKey(STORAGE_KEYS.subscriptionStatus),
          JSON.stringify(s),
        );
      }),
    );
  };

  /** Increment paywall-view counters and persist. Called after every
   *  successful `paywall_open`. */
  const recordPaywallView = () =>
    Effect.gen(function* () {
      const storage = yield* StorageService;
      const now = Date.now();
      const next = totalPaywallViewsSig.value + 1;
      totalPaywallViewsSig.set(next);
      lastPaywallViewAtSig.set(now);
      yield* storage
        .set(asStorageKey(STORAGE_KEYS.totalPaywallViews), String(next))
        .pipe(Effect.catchAll(() => Effect.void));
      yield* storage
        .set(asStorageKey(STORAGE_KEYS.lastPaywallViewAt), String(now))
        .pipe(Effect.catchAll(() => Effect.void));
    });

  /** Sync productId→entitlementIds from config.products into the signal. */
  const applyEntitlementsByProductId = (config: ConfigServiceImpl) =>
    Effect.gen(function* () {
      const cfg = yield* config.current();
      if (!cfg) return;
      entitlementsByProductIdSig.set(
        extractEntitlementsByProductId(cfg.products),
      );
    });

  /** Best-effort POST of cached assignments — local cache is authoritative. */
  const confirmAssignments = Effect.fn("Superwall.confirmAssignments")(function* (
    assignments: AssignmentServiceImpl,
  ) {
      const all = yield* assignments.getAll();
      if (all.length === 0) return;
      const network = yield* NetworkService;
      // Flat snake_case, digit-string ids, max 100 per call (BE contract).
      yield* network
        .postConfirmAssignments({
          assignments: Arr.map(Arr.take(all, 100), (a) => ({
            experiment_id: a.experimentId,
            variant_id: a.variant.id,
          })),
        })
        .pipe(
          Effect.tapError((e) => Effect.logDebug("Assignment confirmation failed", { error: String(e) })),
          Effect.catchAll(() => Effect.void),
        );
    });

  /** Hand each cached paywall URL to the presenter's optional preload hook
   *  so the browser warms the HTTP cache before first present. Best-effort,
   *  bounded concurrency to avoid hammering on large catalogs. */
  const warmPaywalls = Effect.fn("Superwall.warmPaywalls")(function* (
    config: ConfigServiceImpl,
  ) {
      const presenter = yield* Effect.promise(() => getDefaultPresenter());
      if (!presenter?.preload) return;
      const cfg = yield* config.current();
      if (!cfg) return;
      const infos = Arr.map(
        Arr.take(Arr.filter(cfg.paywallResponses, (p) => Boolean(p.url)), 6),
        (p): PaywallInfo => ({
          identifier: p.identifier,
          name: p.name,
          url: p.url,
          productIds: [...p.productIds],
          products: [],
          ...(p.featureGatingBehavior !== undefined && {
            featureGatingBehavior: p.featureGatingBehavior,
          }),
        }));
      // Run with concurrency 2 — iOS Safari throttles hidden iframes, no
      // point queuing more than a couple at a time.
      yield* Effect.all(
        Arr.map(infos, (info) =>
          Effect.tryPromise({
            try: () => presenter.preload!(info),
            catch: () => undefined,
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        { concurrency: 2 },
      );
    });

  /** Snapshot device attributes from current identity + sub state. Called
   *  by enrichment and audience eval. */
  const snapshotDeviceAttributes = (): Record<string, JsonValue> => {
    const id = idSig.value;
    const alias = aliasSig.value;
    const customer = customerSig.value;
    const activeEntitlements =
      customer?.entitlements
        ?.filter((e) => e.isActive)
        .map((e) => ({ id: e.id, type: "SERVICE_LEVEL" })) ?? [];
    // Product ids of the customer's active subscriptions. `CustomerInfo` has
    // no `activeSubscriptions` field — derive from `subscriptions` filtered by
    // `isActive` (the prior `customer?.activeSubscriptions` always read
    // `undefined`, so `activeProducts` was always empty in enrichment).
    const activeProducts =
      customer?.subscriptions
        ?.filter((s) => s.isActive)
        .map((s) => s.productId) ?? [];
    const env = (opts.options?.networkEnvironment ?? "release") as
      | "release"
      | "developer";
    const input: DeviceAttributesInput = {
      publicApiKey: opts.apiKey,
      aliasId: alias,
      appUserId: id,
      vendorId: "",
      deviceId: "",
      bundleId: opts.options?.bundleId ?? "",
      appVersion: opts.options?.appVersion ?? "",
      isSandbox: isSandbox(env),
      // Approximation — inferred from "no prior counter increments".
      isFirstAppOpen: totalPaywallViewsSig.value === 0,
      ...(firstSeenAtSig.value != null ? { firstSeenAtMs: firstSeenAtSig.value } : {}),
      ...(lastPaywallViewAtSig.value != null ? { lastPaywallViewAtMs: lastPaywallViewAtSig.value } : {}),
      totalPaywallViews: totalPaywallViewsSig.value,
      reviewRequestCount: 0,
      subscriptionStatus: subStatusSig.value.status,
      activeEntitlements,
      activeProducts,
    };
    return buildDeviceAttributes(input);
  };

  const runEnrichment = Effect.fn("Superwall.runEnrichment")(function* (
    bus: EventBusImpl,
  ) {
      const network = yield* NetworkService;
      yield* bus.publish("enrichment_start", {});
      // vendorId / deviceId aren't mirrored to signals — pull from the service.
      const idSnap = yield* IdentityService.current().pipe(
        Effect.catchAll(() => Effect.succeed(null as IdentitySnapshot | null)),
      );
      const baseDevice = snapshotDeviceAttributes();
      const device =
        idSnap !== null
          ? {
              ...baseDevice,
              vendorId: idSnap.vendorId,
              deviceId: idSnap.deviceId,
            }
          : baseDevice;
      const result = yield* network
        .postEnrichment({
          user: attrsSig.value,
          device,
        })
        .pipe(Effect.tapError(() => bus.publish("enrichment_fail", {})));

      // Server values override client values for the user attribute merge.
      const merged: Record<string, JsonValue> = {
        ...(attrsSig.value),
      };
      for (const [k, v] of Object.entries(result.user)) {
        if (v !== null) merged[k] = v;
      }
      // UserAttributes extends Record<string, JsonValue>; merged satisfies the same shape.
      attrsSig.set(merged as UserAttributes);

      yield* bus.publish("enrichment_complete", {
        userEnrichment: result.user,
        deviceEnrichment: result.device,
      });
    });

  // Public façades

  // RuntimeServices = the union of all services the ManagedRuntime provides.
  // Typed explicitly so runPublic can accept effects that use any subset
  // without suppressing their R channel with `as never` casts.
  type RuntimeServices =
    | Logger
    | EventBus
    | NetworkService
    | ComputedProperties
    | ConfigService
    | IdentityService
    | StorageService
    | AudienceEvaluator
    | AssignmentService
    | RedemptionService;

  const runPublic = <A>(
    eff: Effect.Effect<A, unknown, RuntimeServices | never>,
  ): Promise<A> =>
    runtime
      .runPromise(eff as Effect.Effect<A, unknown, RuntimeServices>)
      .catch((cause: unknown) => {
        throw translateInternalError(cause);
      });

  /** Push a warning through the internal Logger. Used to surface failures
   *  that would otherwise be silently swallowed. Logger errors themselves
   *  are dropped — logging must not break the caller. */
  const logViaRuntime = (
    scope: LogScope,
    label: string,
    cause: unknown,
  ): void => {
    const msg = cause instanceof Error ? cause.message : String(cause);
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const logger = yield* Logger;
          yield* logger.warn(scope, label, null, msg);
        }),
      )
      .catch(() => {});
  };

  /** Fire-and-forget runner for internal effects whose failures should
   *  surface via Logger.warn (delegate `onLog`) rather than disappearing. */
  const runFireAndForget = (
    scope: LogScope,
    label: string,
    eff: Effect.Effect<unknown, unknown, RuntimeServices>,
  ): void => {
    void runtime
      .runPromise(eff)
      .catch((cause: unknown) => logViaRuntime(scope, label, cause));
  };

  const user: UserNamespace = {
    id: asReadable(idSig),
    aliasId: asReadable(aliasSig),
    effectiveId: asReadable(effectiveSig),
    isLoggedIn: asReadable(loggedInSig),
    attributes: asReadable(attrsSig),
    integrationAttributes: asReadable(intAttrsSig),

    identify: (userId, _identityOpts) =>
      runPublic(
        Effect.gen(function* () {
          // Capture the appUserId before the identity mutation so we can detect
          // whether the user actually changed (empty = anonymous).
          const prevAppUserId = idSig.value;

          // Pending bracket — register() blocks on phase=Ready until both
          // Identification and Seed clear. Closes the race where an in-flight
          // identify() lets audience eval read stale attributes.
          yield* IdentityService.beginPending(
            IdentityPending.Identification(userId),
          );
          yield* IdentityService.beginPending(IdentityPending.Seed);
          yield* IdentityService.identify(userId).pipe(
            Effect.ensuring(
              Effect.all([
                IdentityService.endPending(IdentityPending.Seed),
                IdentityService.endPending(IdentityPending.Identification(userId)),
              ], { discard: true }),
            ),
          );
          // Mirrors Android `IdentityChanged` action — emits identity_alias
          // + user_attributes after the snapshot mutation lands.
          const bus = yield* EventBus;
          yield* bus.publish("identity_alias", {});
          yield* bus.publish("user_attributes", {
            attributes: attrsSig.value,
          });
          // If the user ID changed (anonymous → identified, or account switch),
          // trigger a background /entitlements refresh so subscriptionStatus
          // reflects the new identity immediately rather than waiting for the
          // next periodic poll (~10 min).
          if (userId !== prevAppUserId && purchaseController.onConfigured) {
            purchaseController.onConfigured().catch((cause: unknown) =>
              logViaRuntime(
                "identityManager",
                "entitlements refresh on identify failed",
                cause,
              ),
            );
          }
        }),
      ),

    signOut: () =>
      runPublic(
        Effect.gen(function* () {
          yield* IdentityService.signOut();
          // Sign-out is an identity transition too — fire the same wire
          // events Android does so analytics consumers see the change.
          const bus = yield* EventBus;
          yield* bus.publish("identity_alias", {});
          yield* bus.publish("user_attributes", {
            attributes: attrsSig.value,
          });
        }),
      ),

    setAttributes: (next) => {
      attrsSig.update((prev) => ({ ...prev, ...next }) as UserAttributes);
      // Wire-emit user_attributes so analytics + paywall templates see
      // the change (Android `MergeAttributes` action).
      runFireAndForget(
        "identityManager",
        "setAttributes(): user_attributes publish failed",
        Effect.gen(function* () {
          const bus = yield* EventBus;
          yield* bus.publish("user_attributes", {
            attributes: attrsSig.value,
          });
        }),
      );
    },

    setIntegrationAttribute: (attr, value) => {
      intAttrsSig.update((prev) => {
        const next = { ...prev };
        if (value === null) {
          delete next[attr];
        } else {
          next[attr] = value;
        }
        return next;
      });
    },

    setIntegrationAttributes: (next) => {
      intAttrsSig.update((prev) => {
        const merged = { ...prev };
        for (const [k, v] of Object.entries(next) as Array<
          [IntegrationAttribute, string | null]
        >) {
          if (v === null) {
            delete merged[k];
          } else {
            merged[k] = v;
          }
        }
        return merged;
      });
    },
  };


  /** Look up a paywall by id in the loaded config + project to PaywallInfo.
   *  Returns null when (a) no config is loaded, or (b) the paywallId isn't
   *  in the config. Caller decides what to do — register() throws
   *  PaywallNotAvailableError, getPresentationResult returns a skipped
   *  result. No more silent stub fallback. */
  const buildPaywallInfo = async (
    paywallId: string,
    experiment: Experiment,
  ): Promise<PaywallInfo | null> => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        const paywall = yield* config.getPaywall(paywallId);
        const products = yield* config.getProducts();
        return { paywall, products };
      }),
    );
    if (!result.paywall) return null;
    const productMap = new Map(result.products.map((p) => [p.id, p]));
    const products: Product[] = [];
    for (const id of result.paywall.productIds) {
      const item = productMap.get(id);
      if (!item) continue;
      const ents: Entitlement[] = (item.entitlements ?? []).map((e) => ({
        id: e.id,
        type: "SERVICE_LEVEL",
        isActive: false,
        productIds: [item.id],
      }));
      const product: Product = {
        id: item.id,
        ...(item.name !== undefined && { name: item.name }),
        entitlements: ents,
        store: ((): "appStore" | "stripe" | "paddle" | "playStore" | "superwall" | "other" => {
          const s = item.store;
          return s === "appStore" || s === "stripe" || s === "paddle" ||
            s === "playStore" || s === "superwall" || s === "other"
            ? s
            : "stripe";
        })(),
      };
      products.push(product);
    }
    return {
      identifier: result.paywall.identifier,
      name: result.paywall.name,
      url: result.paywall.url,
      experiment,
      productIds: [...result.paywall.productIds],
      products,
      ...(result.paywall.featureGatingBehavior !== undefined && {
        featureGatingBehavior: result.paywall.featureGatingBehavior,
      }),
      // Forward the per-paywall slot mapping + paywalljs_event verbatim so
      // the presenter can hand them to the iframe's checkout handler.
      ...(result.paywall.products && { rawProducts: result.paywall.products }),
      ...(result.paywall.paywalljsEvent && {
        paywalljsEvent: result.paywall.paywalljsEvent,
      }),
      ...(result.paywall.webCheckoutDestination && {
        webCheckoutDestination: result.paywall.webCheckoutDestination,
      }),
      ...(result.paywall.presentationStyle && {
        presentationStyle: result.paywall.presentationStyle,
      }),
      ...(result.paywall.surveys &&
        result.paywall.surveys.length > 0 && {
          surveys: [...result.paywall.surveys],
        }),
      ...(result.paywall.urlEndpoints && {
        urlEndpoints: result.paywall.urlEndpoints,
      }),
      ...(result.paywall.backgroundColorHex && {
        backgroundColorHex: result.paywall.backgroundColorHex,
      }),
      ...(result.paywall.darkBackgroundColorHex && {
        darkBackgroundColorHex: result.paywall.darkBackgroundColorHex,
      }),
      ...(result.paywall.productsV2 && { productsV2: result.paywall.productsV2 }),
    };
  };

  // Shared placement decision pipeline — consumed by both
  // getPresentationResult and register so eval logic stays in one place.
  type PlacementDecision =
    | { kind: "placementNotFound" }
    | { kind: "noAudienceMatch" }
    | { kind: "holdout"; experiment: Experiment }
    | { kind: "paywall"; experiment: Experiment };

  const evaluatePlacement = Effect.fn("Superwall.evaluatePlacement")(function* (
    placementName: string,
    params: PlacementParams,
  ) {
      const config = yield* ConfigService;
      const trigger = yield* config.getPlacement(placementName);
      if (trigger === null) return { kind: "placementNotFound" } as const;

      const evaluator = yield* AudienceEvaluator;
      const assignments = yield* AssignmentService;
      const aliasId = aliasSig.value;
      const ctx = {
        user: attrsSig.value,
        params: params as Record<string, JsonValue>,
        device: snapshotDeviceAttributes(),
      };

      // Find the first rule whose audience expression matches the current user.
      const matchedRule = yield* Effect.findFirst(trigger.rules, (rule) =>
        evaluator.evaluate(rule.expression, ctx).pipe(Effect.map((r) => r === "match")),
      );

      if (Option.isNone(matchedRule)) return { kind: "noAudienceMatch" } as const;

      // Sticky variant pick — cached per (alias, experiment).
      const confirmed = yield* assignments.getOrAssign(
        matchedRule.value.experiment,
        aliasId,
      );
      const experiment: Experiment = {
        id: matchedRule.value.experiment.id,
        groupId: matchedRule.value.experiment.groupId,
        variant: confirmed.variant,
      };
      if (experiment.variant.type === "holdout") {
        return { kind: "holdout", experiment } as const;
      }
      return { kind: "paywall", experiment } as const;
    });

  const runFeature = async (
    feature: RegisterPlacementArgs["feature"],
  ): Promise<void> => {
    if (!feature) return;
    try {
      await feature();
    } catch {
      // feature errors stay scoped to the consumer's callback
    }
  };

  const register: Superwall["register"] = async (args) => {
      const { placement, params, handler, feature } = args;
      currentPresentationId = asPresentationId(randomUuid());
      try {
        // Block until identity is Ready — closes the race where an
        // in-flight identify/reset/configure lets audience eval read stale data.
        await runtime.runPromise(IdentityService.awaitReady());
        // Single-paywall invariant — reject before invoking the presenter.
        if (presentedSig.value) {
          const current = latestPaywallSig.value;
          if (!current) {
            // Shouldn't happen — presentedSig=true implies latestPaywallSig
            // is set. Defensive: throw a generic error so we don't fabricate
            // a fake PaywallInfo.
            throw new PaywallNotAvailableError(placement, "no_paywall_in_config");
          }
          throw new PaywallAlreadyPresentedError(placement, current);
        }

        // Active subscription → skip the paywall and run the feature
        // immediately. Mirrors Android `PaywallSkippedReason.UserIsSubscribed`.
        if (subStatusSig.value.status === "ACTIVE") {
          const reason: PaywallSkippedReason = { type: "userSubscribed" };
          try {
            handler?.onSkip?.(reason);
          } catch {}
          await runFeature(feature);
          return { type: "skipped", reason };
        }

        // Decision pipeline:
        //   placementNotFound / noAudienceMatch / holdout / userSubscribed → skipped
        //   paywall → look up real paywall info from config; present
        // No config loaded ⇒ throw — caller is responsible for awaiting
        // sw.ready before register().
        const configLoaded = await runtime.runPromise(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            return (yield* config.current()) !== null;
          }),
        );
        if (!configLoaded) {
          throw new PaywallNotAvailableError(placement, "no_config");
        }

        const decision = await runtime.runPromise(
          evaluatePlacement(placement, (params ?? {}) as PlacementParams),
        );

        if (decision.kind !== "placementNotFound") {
          const triggerResult: TriggerResult =
            decision.kind === "paywall"
              ? { type: "paywall", experiment: decision.experiment }
              : decision.kind === "holdout"
                ? { type: "holdout", experiment: decision.experiment }
                : { type: "noAudienceMatch" };
          runFireAndForget(
            "placements",
            "trigger_fire publish failed",
            Effect.gen(function* () {
              const bus = yield* EventBus;
              yield* bus.publish("trigger_fire", {
                placementName: placement,
                result: triggerResult,
              });
            }),
          );
        }

        if (
          decision.kind === "placementNotFound" ||
          decision.kind === "noAudienceMatch" ||
          decision.kind === "holdout"
        ) {
          const reason: PaywallSkippedReason =
            decision.kind === "holdout"
              ? { type: "holdout", experiment: decision.experiment }
              : decision.kind === "noAudienceMatch"
                ? { type: "noAudienceMatch" }
                : { type: "placementNotFound" };
          try {
            handler?.onSkip?.(reason);
          } catch {}
          await runFeature(feature);
          return { type: "skipped", reason };
        }

        // Resolve the presenter for THIS call:
        //   args.presenter (full override) > args.paywall (custom renderer)
        //   > default browser iframe presenter (lazy-loaded singleton).
        const presenter = await resolvePresenter(args);
        if (!presenter) {
          throw new NoPresenterRegisteredError(placement);
        }
        const variantPaywallId = decision.experiment.variant.paywallId;
        if (!variantPaywallId) {
          throw new PaywallNotAvailableError(
            placement,
            "no_paywall_id_on_variant",
          );
        }
        const infoResult = await buildPaywallInfo(
          variantPaywallId,
          decision.experiment,
        );
        if (!infoResult) {
          throw new PaywallNotAvailableError(
            placement,
            "no_paywall_in_config",
          );
        }
        let info: PaywallInfo = infoResult;

        // No URL derivation — every paywall iframes its own editor URL
        // (`paywall_responses[].url` / `url_config.endpoints`). The
        // presenter picks an endpoint, appends bootstrap query params,
        // and adds the `#init=...` hash with identity + apiBase /
        // collector / hostOrigin / cancelUrl.

        const wireOpts = undefined;

        // Try/finally so a failure here (e.g. collector outage during
        // `paywall_open`) doesn't leave presentedSig stuck true and lock
        // out every subsequent register() with PaywallAlreadyPresented.
        latestPaywallSig.set(info);
        presentedSig.set(true);
        let openSucceeded = false;
        try {
          await runtime.runPromise(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "superwall.paywall_id": info.identifier,
                "superwall.placement": placement,
                "superwall.experiment_id": decision.experiment.id,
                "superwall.variant_id": decision.experiment.variant.id,
                "superwall.variant_type": decision.experiment.variant.type,
              });
              const bus = yield* EventBus;
              yield* bus.withDelegate((d) => d.onPaywallWillPresent?.(info));
              yield* bus.publish("paywall_open", { paywall_info: info }, wireOpts);
              yield* bus.withDelegate((d) => d.onPaywallDidPresent?.(info));
              yield* recordPaywallView();
            }).pipe(Effect.withSpan("Superwall.register.open")),
          );
          openSucceeded = true;
        } finally {
          if (!openSucceeded) {
            presentedSig.set(false);
            latestPaywallSig.set(null);
          }
        }
        try {
          handler?.onPresent?.(info);
        } catch {}

        // AbortController lets `dismiss()` interrupt the in-flight presentation.
        const ac = new AbortController();
        currentAbort = ac;

        // Identity bootstrap for the iframe URL — lets the paywall SSR loader
        // mint the placement token, and `client_surface=web-sdk` flips the
        // post-checkout redirect to a postMessage.
        const { idSnap, application } = await runtime.runPromise(
          Effect.gen(function* () {
            const id = yield* IdentityService.current().pipe(
              Effect.catchAll(() => Effect.succeed(null as IdentitySnapshot | null)),
            );
            const cfg = yield* ConfigService.pipe(
              Effect.flatMap((c) => c.current()),
              Effect.catchAll(() => Effect.succeed(null)),
            );
            return {
              idSnap: id,
              application: cfg?.application ?? undefined,
            };
          }),
        );
        const userAttrs = attrsSig.value as Record<string, unknown>;
        const emailAttr = typeof userAttrs["email"] === "string"
          ? (userAttrs["email"] as string)
          : undefined;
        const loc = (globalThis as { location?: { origin?: string; href?: string } })
          .location;
        const hostOrigin =
          typeof loc?.origin === "string" ? loc.origin : undefined;
        // Cancel URL = the current merchant page; defensive default to origin.
        // Per BE contract, validated against `allowedOrigins` on /checkout/initiate.
        const cancelUrl =
          (typeof loc?.href === "string" ? loc.href : undefined) ??
          hostOrigin;
        const env = (opts.options?.networkEnvironment ?? "release") as
          import("./types.ts").NetworkEnvironment;
        const hosts = resolveHosts(env);
        // appUserId stays empty/undefined when anonymous — the iframe
        // controller uses it as the discriminator for userId.type
        // ("appUserId" vs "aliasId"). Falling back to alias here would
        // misreport every anonymous session as a logged-in user.
        // vendorId == deviceId == raw UUID.
        const appUserIdRaw =
          idSnap?.appUserId && idSnap.appUserId !== ""
            ? (idSnap.appUserId as string)
            : undefined;
        const bootstrap = {
          apiKey: opts.apiKey,
          ...(appUserIdRaw && { appUserId: appUserIdRaw }),
          ...(idSnap?.aliasId && { aliasId: idSnap.aliasId as string }),
          ...(emailAttr && { email: emailAttr }),
          ...(idSnap?.vendorId && {
            deviceId: `$SuperwallDevice:${idSnap.vendorId as string}`,
          }),
          ...(hostOrigin && { hostOrigin }),
          ...(cancelUrl && { cancelUrl }),
          // TEMPORARY: hardcoded to the PR-preview worker.
          apiBase: "https://superwall-web-paywall-app-pr-3123.superstaging.workers.dev",
          collector: `https://${hosts.collector}`,
          sdkVersion: SDK_VERSION,
          clientSurface: "web-sdk" as const,
        };

        const initPayload = buildInitPayload({
          info,
          placement,
          params: params ?? {},
          // At this point `decision.kind === "paywall"` (other kinds returned
          // above), but TS can't narrow through the closure — cast.
          decision: decision as { kind: "paywall"; experiment: Experiment },
          application,
          bootstrap,
          aliasId: idSnap?.aliasId as string | undefined,
          appUserId: appUserIdRaw,
          deviceId: idSnap?.vendorId as string | undefined,
          email: emailAttr,
          userAttributes: userAttrs,
          deviceAttributes: snapshotDeviceAttributes() as Record<string, unknown>,
        });

        const ctx: PresentationContext = {
          placement,
          params: (params ?? ({} as PlacementParams)),
          signal: ac.signal,
          emit: <K extends keyof AllSuperwallEvents>(name: K, detail: AllSuperwallEvents[K]) => {
            // Fire-and-forget — presenter shouldn't block on event delivery.
            runFireAndForget(
              "paywallEvents",
              `bus.publish(${String(name)}) failed`,
              Effect.gen(function* () {
                const bus = yield* EventBus;
                yield* bus.publish(name, detail);
              }),
            );
          },
          user: attrsSig.value as Record<string, unknown>,
          device: snapshotDeviceAttributes(),
          onPurchaseEvent: (ev) => {
            // Capture the signed entitlements JWT from the terminal success
            // message so `sw.entitlementsToken` is populated for the web-sdk
            // checkout flow (the `/entitlements` read is best-effort about it).
            if (ev.type === "postCheckout" && ev.entitlementsToken) {
              entitlementsTokenSig.set(ev.entitlementsToken);
            }
            paywallPurchaseEventHandlers.forEach((h) => {
              try { h(ev); } catch {}
            });
          },
          bootstrap,
          initPayload,
          testMode: isTestMode(),
        };

        // Per-call presentation-style override wins over the paywall config.
        if (args.overrides?.presentationStyle) {
          info = { ...info, presentationStyle: args.overrides.presentationStyle };
        }

        // Track the active presenter so sw.dismiss() can force-close it.
        activePresenter = presenter;
        let result: PaywallResult;
        try {
          result = await presenter.present(info, ctx);
        } catch (cause) {
          const err =
            cause instanceof Error
              ? new PresenterError(cause.message, cause)
              : new PresenterError(String(cause));
          presentedSig.set(false);
          const reason: PaywallCloseReason =
            pendingCloseReason ?? "webViewFailedToLoad";
          info = { ...info, closeReason: reason };
          await runtime.runPromise(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "superwall.close_reason": reason });
              const bus = yield* EventBus;
              yield* bus.withDelegate((d) => d.onPaywallWillDismiss?.(info));
              yield* bus.publish(
                "paywall_close",
                { paywall_info: info, close_reason: reason },
                wireOpts,
              );
              yield* bus.withDelegate((d) => d.onPaywallDidDismiss?.(info));
            }).pipe(Effect.withSpan("Superwall.register.close")),
          );
          try {
            handler?.onError?.(err);
          } catch {}
          return { type: "error", error: err };
        } finally {
          currentAbort = null;
          activePresenter = null;
          pendingCloseReason = null;
        }

        // Emit paywall_decline alongside paywall_close on explicit decline.
        presentedSig.set(false);
        const closeReason: PaywallCloseReason =
          pendingCloseReason ??
          (result.type === "declined" ? "manualClose" : "systemLogic");
        info = { ...info, closeReason: closeReason };
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "superwall.close_reason": closeReason,
              "superwall.result_type": result.type,
            });
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onPaywallWillDismiss?.(info));
            if (result.type === "declined") {
              yield* bus.publish("paywall_decline", { paywall_info: info }, wireOpts);
            }
            yield* bus.publish(
              "paywall_close",
              { paywall_info: info, close_reason: closeReason },
              wireOpts,
            );
            yield* bus.withDelegate((d) => d.onPaywallDidDismiss?.(info));
          }).pipe(Effect.withSpan("Superwall.register.close")),
        );
        try {
          handler?.onDismiss?.(info, result);
        } catch {}

        // Survey gate — blocks completion until the user answers / closes.
        // Skipped when there's no `surveyPresenter` wired (rather than
        // burning the assignment key for nothing).
        if (
          opts.surveyPresenter &&
          info.surveys &&
          info.surveys.length > 0 &&
          closeReasonShouldComplete(closeReason)
        ) {
          await presentSurveyIfAvailable({
            surveys: info.surveys,
            result,
            closeReason,
            storage: {
              get: (k) => rawStorageAdapter.get(k),
              set: (k, v) => rawStorageAdapter.set(k, v),
            },
            storageKey: STORAGE_KEYS.surveyAssignmentKey,
            presenter: opts.surveyPresenter,
            onResponse: (answer) => {
              runFireAndForget(
                "paywallEvents",
                "survey_response publish failed",
                Effect.gen(function* () {
                  const bus = yield* EventBus;
                  yield* bus.publish("survey_response", {
                    survey: answer.survey,
                    selected_option: answer.selectedOption,
                    custom_response: answer.customResponse,
                    paywall_info: info,
                  });
                }),
              );
            },
            onClose: (survey) => {
              runFireAndForget(
                "paywallEvents",
                "survey_close publish failed",
                Effect.gen(function* () {
                  const bus = yield* EventBus;
                  yield* bus.publish("survey_close", {
                    survey,
                    paywall_info: info,
                  });
                }),
              );
            },
          });
        }

        // Run feature on purchased/restored, or when paywall is non-gated.
        // ForNextPaywall short-circuits because another paywall is taking over.
        // Undefined featureGatingBehavior is treated as gated.
        const nonGated = info.featureGatingBehavior === "nonGated";
        if (
          closeReasonShouldComplete(closeReason) &&
          (result.type === "purchased" || result.type === "restored" || nonGated)
        ) {
          await runFeature(feature);
        }

        return { type: "presented", info, result };
      } catch (cause) {
        const err = translateInternalError(cause);
        if (err instanceof Error) {
          try {
            handler?.onError?.(err);
          } catch {}
          return { type: "error", error: err };
        }
        throw err;
      } finally {
        // Always clear so subsequent non-register events don't leak the id.
        currentPresentationId = null;
      }
    };

  const placements: PlacementsNamespace = {
    getPresentationResult: async (placement, params) => {
      try {
        const decision = await runtime.runPromise(
          evaluatePlacement(placement, (params ?? {}) as PlacementParams),
        );
        return Match.value(decision).pipe(
          Match.when({ kind: "placementNotFound" }, (): PresentationResult => ({ type: "placementNotFound" })),
          Match.when({ kind: "noAudienceMatch" }, (): PresentationResult => ({ type: "noAudienceMatch" })),
          Match.when({ kind: "holdout" }, (d): PresentationResult => ({ type: "holdout", experiment: d.experiment })),
          Match.when({ kind: "paywall" }, (d): PresentationResult => ({ type: "paywall", experiment: d.experiment })),
          Match.exhaustive,
        );
      } catch (e) {
        logViaRuntime("placements", "getPresentationResult failed", e);
        return { type: "paywallNotAvailable" };
      }
    },

    getAssignments: () =>
      runPublic(
        Effect.gen(function* () {
          const a = yield* AssignmentService;
          return yield* a.getAll();
        }),
      ),

    confirmAllAssignments: () =>
      runPublic(
        Effect.gen(function* () {
          const a = yield* AssignmentService;
          yield* confirmAssignments(a);
          return yield* a.getAll();
        }),
      ),

    preloadAll: async () => {
      // No config → nothing to preload yet.
    },

    preloadFor: async (_) => {
      // No config → nothing to preload yet.
    },
  };

  /** AbortController for the in-flight presentation. dismiss() triggers it. */
  let currentAbort: AbortController | null = null;
  /** Presenter handling the in-flight presentation — so dismiss() can
   *  force-close whichever presenter (default / custom / override) is up. */
  let activePresenter: PaywallPresenter | null = null;
  /** Lazy default browser presenter (singleton). Loaded on first use via
   *  dynamic import so the headless core never statically pulls in DOM code.
   *  Null in non-browser environments. */
  let defaultPresenterPromise: Promise<PaywallPresenter | null> | null = null;
  const getDefaultPresenter = (): Promise<PaywallPresenter | null> => {
    if (typeof document === "undefined") return Promise.resolve(null);
    if (!defaultPresenterPromise) {
      defaultPresenterPromise = import("./browser/presenter.ts")
        .then((m) => m.createBrowserPresenter() as PaywallPresenter)
        .catch((cause: unknown) => {
          logViaRuntime(
            "superwallCore",
            "default browser presenter failed to load",
            cause,
          );
          return null;
        });
    }
    return defaultPresenterPromise;
  };
  /** Per-call presenter precedence: explicit override > custom renderer >
   *  default browser presenter. */
  const resolvePresenter = (
    args: RegisterPlacementArgs,
  ): Promise<PaywallPresenter | null> => {
    if (args.presenter) return Promise.resolve(args.presenter);
    if (args.paywall) {
      return Promise.resolve(
        createCustomPaywallPresenter(args.paywall, {
          purchase: (product) => directPurchase(product),
          restore: () => runRestore(),
        }),
      );
    }
    return getDefaultPresenter();
  };
  /** `testModeBehavior` defaults to `"automatic"`. Simulated (test-mode)
   *  purchases are strictly opt-in: only `"always"` turns them on. `automatic`
   *  never simulates — real checkout runs, including in production. */
  const isTestMode = (): boolean =>
    opts.options?.testModeBehavior === "always";
  /** Restore through the active PurchaseController + fire restore lifecycle
   *  events. Returns the outcome so callers (custom paywall controller) can
   *  branch on it; `purchases.restore()` ignores the return. */
  const runRestore = async (): Promise<
    { type: "restored" } | { type: "failed"; error: Error }
  > => {
    await runtime
      .runPromise(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          yield* bus.publish("restore_start", {});
        }),
      )
      .catch(() => {});
    let result: RestorationResult;
    try {
      result = await purchaseController.restorePurchases();
    } catch (cause) {
      result = {
        type: "failed",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
    const now = Date.now();
    await runtime
      .runPromise(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          const storage = yield* StorageService;
          yield* storage.set(
            asStorageKey(STORAGE_KEYS.lastRestoreAt),
            String(now),
          );
          lastRestoreAtSig.set(now);
          if (result.type === "restored") {
            yield* bus.publish("restore_complete", {});
          } else {
            yield* bus.publish("restore_fail", { reason: result.error.message });
          }
        }),
      )
      .catch((cause: unknown) =>
        logViaRuntime("transactions", "restore() lifecycle effect failed", cause),
      );
    return result.type === "restored"
      ? { type: "restored" }
      : { type: "failed", error: result.error };
  };
  /** Reason set by `dismiss(reason)`; read by the register() finally-block
   *  to populate `PaywallInfo.closeReason` + `paywall_close` params. */
  let pendingCloseReason: PaywallCloseReason | null = null;
  /** Per-`register()` presentation id. Threaded into every event's
   *  `$presentation_id` auto-context so an analytics consumer can correlate
   *  `register → paywall_open → transaction_complete` as one session. */
  let currentPresentationId: PresentationId | null = null;

  // Internal pub-sub for paywall stripe_checkout_* postMessages. The
  // PurchaseController subscribes to these to await checkout completion.
  // NOT exposed as public events.
  const paywallPurchaseEventHandlers = new Set<
    (ev: PaywallPurchaseEvent) => void
  >();
  const subscribeToPaywallPurchaseEvents = (
    handler: (ev: PaywallPurchaseEvent) => void,
  ): (() => void) => {
    paywallPurchaseEventHandlers.add(handler);
    return () => paywallPurchaseEventHandlers.delete(handler);
  };

  // Build the PurchaseController. Default = automatic (handles standard
  // Stripe paywall flow + ?code= redemption + web_entitlements polling).
  // Consumer-provided controllers take over fully.
  const purchaseController: PurchaseController =
    opts.purchaseController ??
    createAutomaticPurchaseController({
      subscribe: subscribeToPaywallPurchaseEvents,
      redeem: async (code) => {
        runFireAndForget(
          "transactions",
          "delegate.onWillRedeemLink threw",
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onWillRedeemLink?.());
          }),
        );
        const res = await runtime
          .runPromise(
            Effect.gen(function* () {
              const r = yield* RedemptionService;
              return yield* r.redeem(RedeemType.Code(code));
            }),
          )
          .catch((cause: unknown) => {
            logViaRuntime("transactions", "redemption.redeem failed", cause);
            return null;
          });
        const emitDidRedeem = (result: RedemptionResult): void => {
          runFireAndForget(
            "transactions",
            "delegate.onDidRedeemLink threw",
            Effect.gen(function* () {
              const bus = yield* EventBus;
              yield* bus.withDelegate((d) => d.onDidRedeemLink?.(result));
            }),
          );
        };
        if (!res) {
          emitDidRedeem({
            type: "error",
            code,
            error: "redemption request failed",
          });
          return { status: "error", entitlements: [] };
        }
        const codeResult = res.codes?.find((c) => c.code === code);
        const ents: Entitlement[] = (res.customerInfo?.entitlements ?? [])
          .filter((e) => e.isActive ?? true)
          .map((e) => ({
            id: e.id,
            type: "SERVICE_LEVEL" as const,
            isActive: e.isActive ?? true,
            productIds: e.productIds ?? [],
          }));
        const status =
          codeResult?.status === "EXPIRED"
            ? ("expired" as const)
            : codeResult?.status === "ERROR" || codeResult?.status === "INVALID"
              ? ("error" as const)
              : ("success" as const);
        if (status === "success") {
          emitDidRedeem({ type: "success", code, entitlements: ents });
        } else if (status === "expired") {
          emitDidRedeem({ type: "expired", code });
        } else {
          emitDidRedeem({
            type: codeResult?.status === "INVALID" ? "invalid" : "error",
            code,
            error: codeResult?.error?.message ?? "redemption failed",
          });
        }
        return { status, entitlements: ents };
      },
      refreshEntitlements: async () => {
        const res = await runtime
          .runPromise(
            Effect.gen(function* () {
              const r = yield* RedemptionService;
              return yield* r.refreshWebEntitlements();
            }),
          )
          .catch(() => null);
        if (!res) return null;
        // Surface the signed token to the host (best-effort). Only set when the
        // read succeeded — a null `res` above leaves the prior token intact.
        if (res.entitlementsToken !== undefined) {
          entitlementsTokenSig.set(res.entitlementsToken);
        }
        // Prefer customerInfo.entitlements; the top-level array is often an
        // empty `[]` (not nullish) so `??` alone would pick it and drop the
        // real ones. BE wire uses `identifier`, tolerate `id`.
        const ci = res.customerInfo?.entitlements;
        const list = ci && ci.length > 0 ? ci : (res.entitlements ?? ci ?? []);
        return list.map((e) => {
          const ent = typeof e === "object" && e !== null
            ? (e as { id?: string; identifier?: string; isActive?: boolean; productIds?: string[] })
            : {};
          return {
            id: ent.identifier ?? ent.id ?? "",
            type: "SERVICE_LEVEL" as const,
            isActive: ent.isActive ?? true,
            productIds: ent.productIds ?? [],
          };
        });
      },
      setSubscriptionStatus: (s) => {
        // Reuse the public-facing setter so delegate / event chain fires.
        const prev = subStatusSig.value;
        if (subscriptionStatusEqual(prev, s)) return;
        subStatusSig.set(s);
        persistSubscriptionStatus(s);
        runFireAndForget(
          "transactions",
          "controller.setSubscriptionStatus delegate/publish failed",
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate(
              (d) => d.onSubscriptionStatusChange?.(prev, s),
              (cause) =>
                logViaRuntime(
                  "transactions",
                  "delegate.onSubscriptionStatusChange threw",
                  cause,
                ),
            );
            yield* bus.publish("subscriptionStatus_didChange", {});
          }),
        );
      },
      logWarn: (message, error) => {
        void runtime
          .runPromise(
            Effect.gen(function* () {
              const logger = yield* Logger;
              yield* logger.warn("transactions", message, null, error ?? null);
            }),
          )
          .catch(() => {});
      },
      resolveEntitlementsForProduct: (productId) => {
        // `productId` here is what arrived in `post_checkout_complete.product_identifier`
        // — by BE contract that's the slot reference_name (e.g. "primary"),
        // NOT the Stripe product id. Look it up against the per-paywall
        // `products_v2` map; fall back to the Stripe-id-keyed top-level
        // products in case a caller (sw.purchases.purchase) passed a real
        // product id. Synchronous Ref read — safe under runSync.
        const cfg = runtime.runSync(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            return yield* config.current();
          }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        );
        if (!cfg) return [];
        const byRef = extractEntitlementsByReferenceName(cfg.paywallResponses);
        const fromRef = byRef.get(productId);
        if (fromRef && fromRef.length > 0) return fromRef;
        return (
          extractEntitlementsByProductId(cfg.products).get(productId) ?? []
        );
      },
    });

  /** One-shot purchase through the active `PurchaseController`. Internal for
   *  now (see the note on `PurchasesNamespace`): the default controller only
   *  resolves this while a paywall is presenting, so it isn't exposed publicly.
   *  Kept alive because the custom-paywall render path (`args.paywall`) wires
   *  its purchase button through here. */
  const directPurchase = async (
    product: Product,
  ): Promise<
    { type: "purchased" } | { type: "declined" } | { type: "error"; error: Error }
  > => {
    // directPurchase runs outside a register() call so no PaywallInfo is available,
    // but the transaction events were designed with paywall_info as required. We cast
    // here to emit the events with partial detail; the paywall_info field will be
    // absent on non-register purchase paths (a known design debt, TODO: make optional).
    const emit = (
      name: "transaction_start" | "transaction_complete" | "transaction_abandon" | "transaction_fail" | "subscription_start",
      detail: Record<string, unknown>,
    ) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.publish(name as keyof AllSuperwallEvents, detail as AllSuperwallEvents[keyof AllSuperwallEvents]);
          }),
        )
        .catch((cause: unknown) =>
          logViaRuntime("transactions", `bus.publish(${name}) failed`, cause),
        );

    emit("transaction_start", { product });
    let result: PurchaseResult;
    try {
      result = await purchaseController.purchase(product);
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      logViaRuntime("transactions", "controller.purchase threw", err);
      emit("transaction_fail", { product, reason: err.message });
      return { type: "error", error: err };
    }

    if (result.type === "purchased") {
      emit("transaction_complete", {
        product,
        product_identifier: product.id,
      });
      emit("subscription_start", { product });
      return { type: "purchased" };
    }
    if (result.type === "cancelled") {
      emit("transaction_abandon", { product });
      return { type: "declined" };
    }
    if (result.type === "pending") {
      // Caller can listen for transaction_complete on the bus to know
      // when the controller eventually resolves the pending purchase.
      return { type: "declined" }; // public API doesn't have a "pending" today
    }
    // failed
    emit("transaction_fail", { product, reason: result.error.message });
    return { type: "error", error: result.error };
  };

  const purchases: PurchasesNamespace = {
    restore: async () => {
      await runRestore();
    },
    refreshCustomerInfo: () =>
      Promise.reject(new NotConfiguredError(new Error("purchases not yet wired"))),
    setSubscriptionStatus: (s) => {
      const prev = subStatusSig.value;
      if (subscriptionStatusEqual(prev, s)) return;
      subStatusSig.set(s);
      persistSubscriptionStatus(s);
      runFireAndForget(
        "superwallCore",
        "setSubscriptionStatus(): delegate/publish failed",
        Effect.gen(function* () {
          const bus = yield* EventBus;
          yield* bus.withDelegate((d) => d.onSubscriptionStatusChange?.(prev, s));
          yield* bus.publish("subscriptionStatus_didChange", {});
        }),
      );
    },
    getProducts: () =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            const items = yield* config.getProducts();
            return items.map<Product>((item) => ({
              id: item.id,
              ...(item.name !== undefined && { name: item.name }),
              entitlements: (item.entitlements ?? []).map((e) => ({
                id: e.id,
                type: "SERVICE_LEVEL",
                isActive: false,
                productIds: [item.id],
              })),
              store: ((): Product["store"] => {
                const s = item.store;
                return s === "appStore" ||
                  s === "stripe" ||
                  s === "paddle" ||
                  s === "playStore" ||
                  s === "superwall" ||
                  s === "other"
                  ? s
                  : "stripe";
              })(),
            }));
          }),
        )
        .catch((cause: unknown) => {
          logViaRuntime("productsManager", "getProducts() failed", cause);
          return [] as Product[];
        }),
    getCustomerInfo: () => Promise.resolve(customerSig.value),
    getEntitlementsToken: () => entitlementsTokenSig.value,
  };

  const entitlements: EntitlementsNamespace = (() => {
    // Derived from subscriptionStatus.
    const activeSig = createSignal<Entitlement[]>([]);
    const inactiveSig = createSignal<Entitlement[]>([]);
    const allSig = createSignal<Entitlement[]>([]);
    subStatusSig.subscribe((s) => {
      const ents = s.status === "ACTIVE" ? s.entitlements : [];
      activeSig.set(ents);
      inactiveSig.set([]); // inactive isn't tracked client-side yet
      allSig.set(ents);
    });
    return {
      active: asReadable(activeSig),
      inactive: asReadable(inactiveSig),
      all: asReadable(allSig),
      byProductIds: (ids) => {
        // Active entitlements carry full state (renewedAt, expiresAt, …).
        const active = activeSig.value.filter((e) =>
          e.productIds.some((p) => ids.includes(p)),
        );
        const seen = new Set(active.map((e) => e.id));

        // Config-derived stubs (isActive=false) — purchase events upgrade
        // them later.
        const fromConfig: Entitlement[] = [];
        const map = entitlementsByProductIdSig.value;
        for (const productId of ids) {
          for (const entId of map.get(productId) ?? []) {
            if (seen.has(entId)) continue;
            seen.add(entId);
            fromConfig.push({
              id: entId,
              type: "SERVICE_LEVEL",
              isActive: false,
              productIds: [productId],
            });
          }
        }
        return [...active, ...fromConfig];
      },
    };
  })();

  let disposed = false;

  const ready: Promise<void> = runtime
    .runPromise(configure)
    .then(() => {
      // Fire controller.onConfigured() AFTER configure completes so the
      // controller can detect a returning ?code=… redirect, redeem it,
      // and start web_entitlements polling. Best-effort.
      if (purchaseController.onConfigured) {
        purchaseController.onConfigured().catch((cause: unknown) =>
          logViaRuntime(
            "transactions",
            "purchaseController.onConfigured failed",
            cause,
          ),
        );
      }
    })
    .catch((cause: unknown) => {
      if (disposed) return;
      statusSig.set("failed");
      throw translateInternalError(cause);
    });
  void ready.catch(() => {});

  const sw: Superwall = {
    apiKey: opts.apiKey,
    ready,
    isConfigured: asReadable(configuredSig),
    configurationStatus: asReadable(statusSig),

    user,
    placements,
    register,
    purchases,
    entitlements,

    subscriptionStatus: asReadable(subStatusSig),
    customerInfo: asReadable(customerSig),
    entitlementsToken: asReadable(entitlementsTokenSig),
    latestPaywallInfo: asReadable(latestPaywallSig),
    isPaywallPresented: asReadable(presentedSig),

    events: target,

    logLevel: asReadable(logLevelSig),
    locale: asReadable(localeSig),

    setLogLevel: (level) => {
      logLevelSig.set(level);
      runFireAndForget(
        "superwallCore",
        "setLogLevel(): logger update failed",
        Effect.gen(function* () {
          const logger = yield* Logger;
          yield* logger.setLevel(level);
        }),
      );
    },
    setLocale: (locale) => localeSig.set(locale),
    setInterfaceStyle: (style) => {
      interfaceStyleOverride = style;
    },
    setDelegate: (delegate) => {
      runFireAndForget(
        "superwallCore",
        "setDelegate(): bus.setDelegate failed",
        Effect.gen(function* () {
          const bus = yield* EventBus;
          yield* bus.setDelegate(delegate);
        }),
      );
    },

    reset: async () => {
      await runPublic(
        Effect.gen(function* () {
          yield* IdentityService.beginPending(IdentityPending.Reset);
          yield* IdentityService.reset();
          subStatusSig.set({ status: "UNKNOWN" });
          customerSig.set(null);
          entitlementsTokenSig.set(null);
          entitlementsByProductIdSig.set(new Map());
          // firstSeenAt persists across reset (install-date semantics).
          totalPaywallViewsSig.set(0);
          lastPaywallViewAtSig.set(null);
          latestPaywallSig.set(null);
          presentedSig.set(false);
          attrsSig.set({} as UserAttributes);
          intAttrsSig.set({});
          lastRestoreAtSig.set(null);
          const assignments = yield* AssignmentService;
          yield* assignments.reset();
          const storage = yield* StorageService;
          yield* storage.remove(asStorageKey(STORAGE_KEYS.lastRestoreAt));
          yield* storage.remove(
            asStorageKey(STORAGE_KEYS.totalPaywallViews),
          );
          yield* storage.remove(
            asStorageKey(STORAGE_KEYS.lastPaywallViewAt),
          );
          // Clear cached sub status so a stale ACTIVE doesn't re-hydrate on
          // the next configure() (reset just flipped it to UNKNOWN).
          yield* storage.remove(
            asStorageKey(STORAGE_KEYS.subscriptionStatus),
          );
          const computed = yield* ComputedProperties;
          yield* computed.reset();
          const bus = yield* EventBus;
          yield* bus.publish("reset", {});
          yield* IdentityService.endPending(IdentityPending.Reset);
        }),
      );
      // Identity changed → re-run the post-configure entitlements check for
      // the new (anonymous) identity. Reset left status at UNKNOWN; this
      // resolves it to INACTIVE (no entitlements) or ACTIVE (device-scoped
      // ones) instead of waiting for the next poll. Best-effort.
      if (purchaseController.onConfigured) {
        await purchaseController
          .onConfigured()
          .catch((cause: unknown) =>
            logViaRuntime(
              "transactions",
              "purchaseController.onConfigured (post-reset) failed",
              cause,
            ),
          );
      }
    },

    dismiss: (reason: PaywallCloseReason = "systemLogic") => {
      // Stash the reason so the register() finally-block can read it and
      // surface it on `paywall_close` event params + `PaywallInfo`.
      pendingCloseReason = reason;
      currentAbort?.abort();
      try {
        activePresenter?.dismiss(reason);
      } catch {}
    },

    refreshConfiguration: () =>
      runPublic(
        Effect.gen(function* () {
          const config = yield* ConfigService;
          const assignments = yield* AssignmentService;
          // ConfigService.fetch is serialized by its actor — concurrent
          // refresh calls share the in-flight transition.
          yield* config.fetch();
          yield* eagerAssign(config, assignments);
          yield* applyEntitlementsByProductId(config);
          yield* confirmAssignments(assignments);
          yield* config.preload();
          yield* warmPaywalls(config);
        }),
      ),

    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        purchaseController.dispose?.();
      } catch {}
      _clearDefault(sw);
      await runtime.dispose();
    },
  };

  _registerDefault(sw);

  return sw;
};
