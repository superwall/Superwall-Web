// Public Superwall instance + factory. Internals run on Effect (services +
// Layer + ManagedRuntime); one ManagedRuntime per instance so service state
// is shared across method calls. Public methods are thin Promise façades.

import { Effect, Layer, ManagedRuntime, Stream } from "effect";
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
  type SuperwallDelegate,
} from "./events.ts";
import type { PaywallPresenter, PresentationContext } from "./presenter.ts";
import { asReadable, createSignal, type Readable } from "./signal.ts";
import {
  STORAGE_KEYS,
  type ConfigurationStatus,
  type ConfirmedAssignment,
  type Entitlement,
  type Experiment,
  type IdentityOptions,
  type IntegrationAttribute,
  type JsonValue,
  type LogLevel,
  type LogScope,
  type PartialSuperwallOptions,
  type PaywallInfo,
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
  type UserAttributes,
  type CustomerInfo,
} from "./types.ts";
import { asStorageKey } from "./internal/brands.ts";
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
  type NetworkConfig,
} from "./internal/network.ts";
import {
  buildDeviceAttributes,
  type DeviceAttributesInput,
} from "./internal/deviceAttributes.ts";
import { createMemoryStorage, StorageService } from "./internal/storage.ts";
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
  /** Returns the locally-cached `ConfirmedAssignment[]`. */
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
  /** Drive a one-shot purchase outside a paywall (e.g. inline upsell button).
   *  Emits the same lifecycle as a presenter-driven purchase
   *  Routes through the active `PurchaseController` (default = automatic
   *  Stripe + redemption flow). `transaction_start` fires before the
   *  controller call; `transaction_complete` + `subscription_start` on
   *  success, `transaction_abandon` on cancel, `transaction_fail` on error. */
  purchase(
    product: Product,
  ): Promise<{ type: "purchased" } | { type: "declined" } | { type: "error"; error: Error }>;
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
  readonly latestPaywallInfo: Readable<PaywallInfo | null>;
  readonly isPaywallPresented: Readable<boolean>;

  readonly events: SuperwallEventTarget;

  readonly logLevel: Readable<LogLevel>;
  readonly locale: Readable<string | null>;

  setLogLevel(level: LogLevel): void;
  setLocale(locale: string | null): void;
  setDelegate(delegate: SuperwallDelegate | null): void;

  reset(): Promise<void>;
  dismiss(): void;

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
  /** Required to call `sw.register`. */
  presenter?: PaywallPresenter;
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
// Paywall host override (review-lab / PR-preview deployments)
// ---------------------------------------------------------------------------

/** Rewrite the paywall URL to point at `paywallHostOverride`. Preserves the
 *  pathname + any existing query params and adds `?domain={slug}` so the
 *  override host can route to the right tenant.
 *
 *  TEMPORARY: hardcoded to `gymscore` while we figure out why the
 *  auto-extraction from the original host fails for the PR-preview setup
 *  (the config's `paywall.url` doesn't carry the tenant subdomain in dev).
 *  Returns the input unchanged when either URL is malformed or no override
 *  is provided. */
export const applyPaywallHostOverride = (
  originalUrl: string,
  override: string | undefined,
): string => {
  if (!override) return originalUrl;
  let orig: URL;
  let target: URL;
  try {
    orig = new URL(originalUrl);
    target = new URL(override);
  } catch {
    return originalUrl;
  }
  const out = new URL(target.origin);
  out.pathname = orig.pathname;
  orig.searchParams.forEach((v, k) => out.searchParams.set(k, v));
  out.searchParams.set("domain", "gymscore");
  return out.toString();
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSuperwall = (opts: CreateSuperwallOptions): Superwall => {
  const target = new SuperwallEventTarget();

  // Layer composition: storage → identity → network → eventBus
  const storageLayer = StorageService.fromAdapter(
    opts.storage ?? createMemoryStorage(),
  );
  const identityLayer = identityWithStorage(storageLayer);
  // PartialSuperwallOptions deeply-partializes `networkEnvironment`'s
  // `{ custom: ... }` shape; trust the caller and cast back.
  const networkConfig: NetworkConfig = {
    apiKey: opts.apiKey,
    environment: (opts.options?.networkEnvironment ?? "release") as NetworkConfig["environment"],
    ...(opts.options?.appVersion !== undefined && { appVersion: opts.options.appVersion }),
    ...(opts.options?.bundleId !== undefined && { bundleId: opts.options.bundleId }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
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
  const layerWithConfig = Layer.merge(
    Layer.merge(busLayer, configLayer),
    assignmentLayer,
  );
  const baseLayer = loggerLayer(
    opts.options?.logging?.level ?? "warn",
    layerWithConfig,
  );
  // AudienceEvaluator's Logger + ComputedProperties already live in
  // baseLayer; cast for the upstream signature.
  const audienceLayer = audienceEvaluatorLayer(
    baseLayer as Layer.Layer<ComputedProperties | Logger>,
  );
  // Redemption needs Network + Identity + Logger + Storage — all already
  // satisfied by audienceLayer's transitive context.
  const fullLayer = redemptionServiceLayer(
    audienceLayer as Layer.Layer<
      NetworkService | IdentityService | Logger | StorageService
    >,
  );

  const runtime = ManagedRuntime.make(
    fullLayer as Layer.Layer<
      | Logger
      | EventBus
      | NetworkService
      | ComputedProperties
      | ConfigService
      | IdentityService
      | StorageService
      | AudienceEvaluator
      | AssignmentService
      | RedemptionService
    >,
  );

  // Public-facing signals. Driven by background subscriptions in configure().
  const idSig = createSignal<string>("");
  const aliasSig = createSignal<string>("");
  const effectiveSig = createSignal<string>("");
  const loggedInSig = createSignal<boolean>(false);
  const attrsSig = createSignal<UserAttributes>({} as UserAttributes);
  const intAttrsSig = createSignal<
    Partial<Record<IntegrationAttribute, string>>
  >({});
  const subStatusSig = createSignal<SubscriptionStatus>({ status: "UNKNOWN" });
  const customerSig = createSignal<CustomerInfo | null>(null);
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

    yield* bus.publish("first_seen", {});
    yield* bus.publish("session_start", {});
    yield* bus.publish("app_launch", {});

    // Replay cached config from storage for offline-first; subsequent
    // network fetch revalidates.
    const config = yield* ConfigService;
    const assignments = yield* AssignmentService;
    yield* config.hydrateFromStorage().pipe(Effect.catchAll(() => Effect.void));
    // Eager assignment over the cached config so first register() is fast
    // and confirmAllAssignments returns a complete snapshot.
    yield* eagerAssign(config, assignments);
    yield* applyEntitlementsByProductId(config);
    yield* config.preload();
    yield* warmPaywalls(config);

    const hydrated = yield* config.current();
    const enrichmentEffect = runEnrichment(bus).pipe(
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

    if (hydrated) {
      // Fire revalidation + enrichment in the background — don't await.
      yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.all(
            [
              config.fetch().pipe(
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
          config.fetch().pipe(Effect.catchAll(() => Effect.void)),
          enrichmentEffect,
        ],
        { concurrency: "unbounded" },
      );
      yield* applyFreshConfig();
    }

    // Drain the initial Configuration pending item — register() blocks on
    // phase=Ready until this clears.
    yield* IdentityService.endPending(IdentityPending.Configuration);
    configuredSig.set(true);
    statusSig.set("configured");
  });

  /** Hand every trigger experiment to AssignmentService.chooseAllVariants. */
  const eagerAssign = (
    config: ConfigServiceImpl,
    assignments: AssignmentServiceImpl,
  ) =>
    Effect.gen(function* () {
      const cfg = yield* config.current();
      if (!cfg) return;
      const experiments = cfg.triggerOptions.flatMap((t) =>
        t.rules.map((r) => r.experiment),
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
  const confirmAssignments = (assignments: AssignmentServiceImpl) =>
    Effect.gen(function* () {
      const all = yield* assignments.getAll();
      if (all.length === 0) return;
      const network = yield* NetworkService;
      yield* network
        .postConfirmAssignments({
          assignments: all.map((a) => ({
            experimentId: a.experimentId,
            variant: { id: a.variant.id, type: a.variant.type },
          })),
        })
        .pipe(Effect.catchAll(() => Effect.void));
    });

  /** Hand each cached paywall URL to the presenter's optional preload hook
   *  so the browser warms the HTTP cache before first present. Best-effort,
   *  bounded concurrency to avoid hammering on large catalogs. */
  const warmPaywalls = (config: ConfigServiceImpl) =>
    Effect.gen(function* () {
      if (!opts.presenter?.preload) return;
      const cfg = yield* config.current();
      if (!cfg) return;
      const infos = cfg.paywallResponses
        .filter((p) => p.url)
        .slice(0, 6) // arbitrary cap so we don't spawn an iframe for every paywall
        .map((p): PaywallInfo => ({
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
        infos.map((info) =>
          Effect.tryPromise({
            try: () => opts.presenter!.preload!(info),
            catch: () => undefined,
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
        { concurrency: 2 },
      );
    });

  /** Snapshot device attributes from current identity + sub state. Called
   *  by enrichment and audience eval. */
  const snapshotDeviceAttributes = (): Record<string, JsonValue> => {
    const id = idSig.value as string;
    const alias = aliasSig.value as string;
    const customer = customerSig.value;
    const activeEntitlements =
      customer?.entitlements
        ?.filter((e) => e.isActive)
        .map((e) => ({ id: e.id, type: "SERVICE_LEVEL" })) ?? [];
    const activeProducts = customer?.activeSubscriptions ?? [];
    const env = (opts.options?.networkEnvironment ?? "release") as
      | "release"
      | "developer";
    const input: DeviceAttributesInput = {
      publicApiKey: opts.apiKey,
      aliasId: alias,
      appUserId: id,
      vendorId: "",
      deviceId: "",
      bundleId: opts.options?.bundleId,
      appVersion: opts.options?.appVersion,
      isSandbox: isSandbox(env),
      // Approximation — inferred from "no prior counter increments".
      isFirstAppOpen: totalPaywallViewsSig.value === 0,
      firstSeenAtMs: firstSeenAtSig.value ?? undefined,
      lastPaywallViewAtMs: lastPaywallViewAtSig.value ?? undefined,
      totalPaywallViews: totalPaywallViewsSig.value,
      reviewRequestCount: 0,
      subscriptionStatus: subStatusSig.value.status,
      activeEntitlements,
      activeProducts,
    };
    return buildDeviceAttributes(input);
  };

  const runEnrichment = (bus: EventBusImpl) =>
    Effect.gen(function* () {
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
              vendorId: idSnap.vendorId as string,
              deviceId: idSnap.deviceId as string,
            }
          : baseDevice;
      const result = yield* network
        .postEnrichment({
          user: attrsSig.value as Record<string, JsonValue>,
          device,
        })
        .pipe(Effect.tapError(() => bus.publish("enrichment_fail", {})));

      // Server values override client values for the user attribute merge.
      const merged: Record<string, JsonValue> = {
        ...(attrsSig.value as Record<string, JsonValue>),
      };
      for (const [k, v] of Object.entries(result.user)) {
        if (v !== null) merged[k] = v;
      }
      attrsSig.set(merged as UserAttributes);

      yield* bus.publish("enrichment_complete", {
        userEnrichment: result.user,
        deviceEnrichment: result.device,
      });
    });

  // Public façades

  const runPublic = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
    runtime
      .runPromise(eff as Effect.Effect<A, unknown, never>)
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
    eff: Effect.Effect<unknown, unknown, never>,
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
          // Pending bracket — register() blocks on phase=Ready until both
          // Identification and Seed clear. Closes the race where an in-flight
          // identify() lets audience eval read stale attributes.
          yield* IdentityService.beginPending(
            IdentityPending.Identification(userId),
          );
          yield* IdentityService.beginPending(IdentityPending.Seed);
          try {
            yield* IdentityService.identify(userId);
          } finally {
            yield* IdentityService.endPending(IdentityPending.Seed);
            yield* IdentityService.endPending(
              IdentityPending.Identification(userId),
            );
          }
          // Mirrors Android `IdentityChanged` action — emits identity_alias
          // + user_attributes after the snapshot mutation lands.
          const bus = yield* EventBus;
          yield* bus.publish("identity_alias", {});
          yield* bus.publish("user_attributes", {
            attributes: attrsSig.value as Partial<UserAttributes>,
          });
        }) as Effect.Effect<void, unknown, never>,
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
            attributes: attrsSig.value as Partial<UserAttributes>,
          });
        }) as Effect.Effect<void, unknown, never>,
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
            attributes: attrsSig.value as Partial<UserAttributes>,
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

  /** Compute the external Superwall-hosted paywall URL for a placement, or
   *  null when the paywall isn't configured for external mode (or web2app
   *  config is missing). External mode ⇒ register() navigates the browser
   *  to `https://{web2app-host}/{placement}` instead of presenting iframe.
   *  Mirrors the dashboard's "Web Checkout Destination" choice. */
  const deriveExternalPaywallUrl = (
    info: PaywallInfo,
    cfg: import("./internal/config.ts").RawConfig,
    placement: string,
  ): string | null => {
    const dest = info.webCheckoutDestination;
    // Anything other than null / "EMBEDDED" / "embedded" → external.
    const isExternal =
      dest !== undefined &&
      dest !== null &&
      dest.toUpperCase() !== "EMBEDDED";
    if (!isExternal) return null;
    // Host precedence: explicit `paywallHostOverride` (review-lab / self-
    // hosted checkout controller) > `restore_access_url` from config > null.
    // When the override is set, inject `?domain=gymscore` (TEMPORARY hardcode
    // — see `applyPaywallHostOverride` JSDoc) so the override host can route
    // to the correct tenant.
    const override = opts.options?.paywallHostOverride;
    if (override) {
      try {
        const u = new URL(override);
        const out = new URL(`${u.origin}/${encodeURIComponent(placement)}`);
        out.searchParams.set("domain", "gymscore");
        return out.toString();
      } catch {
        // Bad override falls through to restore_access_url.
      }
    }
    const restoreUrl = cfg.web2appConfig?.restoreAccessUrl;
    if (!restoreUrl) return null;
    try {
      const u = new URL(restoreUrl);
      return `${u.origin}/${encodeURIComponent(placement)}`;
    } catch {
      return null;
    }
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
      url: applyPaywallHostOverride(
        result.paywall.url,
        opts.options?.paywallHostOverride,
      ),
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
    };
  };

  // Shared placement decision pipeline — consumed by both
  // getPresentationResult and register so eval logic stays in one place.
  type PlacementDecision =
    | { kind: "placementNotFound" }
    | { kind: "noAudienceMatch" }
    | { kind: "holdout"; experiment: Experiment }
    | { kind: "paywall"; experiment: Experiment };

  const evaluatePlacement = (
    placementName: string,
    params: PlacementParams,
  ): Effect.Effect<
    PlacementDecision,
    never,
    ConfigService | AudienceEvaluator | AssignmentService
  > =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const trigger = yield* config.getPlacement(placementName);
      if (trigger === null) return { kind: "placementNotFound" } as const;

      const evaluator = yield* AudienceEvaluator;
      const assignments = yield* AssignmentService;
      const aliasId = aliasSig.value;
      const ctx = {
        user: attrsSig.value as Partial<UserAttributes>,
        params: params as Record<string, JsonValue>,
        device: snapshotDeviceAttributes(),
      };

      for (const rule of trigger.rules) {
        const result = yield* evaluator.evaluate(rule.expression, ctx);
        if (result === "match") {
          // Sticky variant pick — cached per (alias, experiment).
          const confirmed = yield* assignments.getOrAssign(
            rule.experiment,
            aliasId,
          );
          const experiment: Experiment = {
            id: rule.experiment.id,
            groupId: rule.experiment.groupId,
            variant: confirmed.variant,
          };
          if (experiment.variant.type === "holdout") {
            return { kind: "holdout", experiment } as const;
          }
          return { kind: "paywall", experiment } as const;
        }
      }
      return { kind: "noAudienceMatch" } as const;
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

        if (!opts.presenter) {
          throw new NoPresenterRegisteredError(placement);
        }
        const variantPaywallId = decision.experiment.variant.paywallId;
        if (!variantPaywallId) {
          throw new PaywallNotAvailableError(
            placement,
            "no_paywall_id_on_variant",
          );
        }
        const info = await buildPaywallInfo(
          variantPaywallId,
          decision.experiment,
        );
        if (!info) {
          throw new PaywallNotAvailableError(
            placement,
            "no_paywall_in_config",
          );
        }

        // Web Project routing — when the paywall (or default mode) says
        // "external", iframe the Superwall-hosted paywall URL instead of
        // the editor URL. The hosted page handles its own checkout (Stripe
        // Embedded inside that iframe) and deep-links back via `?code=`
        // on completion. The Superwall Web Project has no X-Frame-Options
        // so iframing is permitted.
        const externalUrl = await runtime.runPromise(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            const cfg = yield* config.current();
            return cfg ? deriveExternalPaywallUrl(info, cfg, placement) : null;
          }),
        );
        if (externalUrl) {
          // Mutate the info so the presenter loads the hosted URL into the
          // iframe instead of the editor URL.
          (info as { url: string }).url = externalUrl;
        }

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
              const bus = yield* EventBus;
              yield* bus.withDelegate((d) => d.onPaywallWillPresent?.(info));
              yield* bus.publish("paywall_open", { paywall_info: info }, wireOpts);
              yield* bus.withDelegate((d) => d.onPaywallDidPresent?.(info));
              yield* recordPaywallView();
            }),
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
        const idSnap = await runtime.runPromise(
          IdentityService.current().pipe(
            Effect.catchAll(() => Effect.succeed(null as IdentitySnapshot | null)),
          ),
        );
        const userAttrs = attrsSig.value as Record<string, unknown>;
        const emailAttr = typeof userAttrs["email"] === "string"
          ? (userAttrs["email"] as string)
          : undefined;
        const hostOrigin =
          typeof globalThis !== "undefined" &&
          typeof (globalThis as { location?: { origin?: string } }).location
            ?.origin === "string"
            ? (globalThis as { location: { origin: string } }).location.origin
            : undefined;
        const bootstrap = {
          apiKey: opts.apiKey,
          ...(idSnap?.appUserId && idSnap.appUserId !== "" && {
            appUserId: idSnap.appUserId as string,
          }),
          ...(idSnap?.aliasId && { aliasId: idSnap.aliasId as string }),
          ...(emailAttr && { email: emailAttr }),
          ...(idSnap?.vendorId && { deviceId: idSnap.vendorId as string }),
          ...(hostOrigin && { hostOrigin }),
          sdkVersion: SDK_VERSION,
          clientSurface: "web-sdk" as const,
        };

        const ctx: PresentationContext = {
          placement,
          params: (params ?? ({} as PlacementParams)),
          signal: ac.signal,
          emit: (name, detail) => {
            // Fire-and-forget — presenter shouldn't block on event delivery.
            runFireAndForget(
              "paywallEvents",
              `bus.publish(${String(name)}) failed`,
              Effect.gen(function* () {
                const bus = yield* EventBus;
                yield* bus.publish(name as never, detail as never);
              }),
            );
          },
          user: attrsSig.value as Record<string, unknown>,
          device: snapshotDeviceAttributes(),
          onPurchaseEvent: (ev) => {
            paywallPurchaseEventHandlers.forEach((h) => {
              try { h(ev); } catch {}
            });
          },
          bootstrap,
        };

        let result: PaywallResult;
        try {
          result = await opts.presenter.present(info, ctx);
        } catch (cause) {
          const err =
            cause instanceof Error
              ? new PresenterError(cause.message, cause)
              : new PresenterError(String(cause));
          presentedSig.set(false);
          await runtime.runPromise(
            Effect.gen(function* () {
              const bus = yield* EventBus;
              yield* bus.withDelegate((d) => d.onPaywallWillDismiss?.(info));
              yield* bus.publish("paywall_close", { paywall_info: info }, wireOpts);
              yield* bus.withDelegate((d) => d.onPaywallDidDismiss?.(info));
            }),
          );
          try {
            handler?.onError?.(err);
          } catch {}
          return { type: "error", error: err };
        } finally {
          currentAbort = null;
        }

        // Emit paywall_decline alongside paywall_close on explicit decline.
        presentedSig.set(false);
        await runtime.runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onPaywallWillDismiss?.(info));
            if (result.type === "declined") {
              yield* bus.publish("paywall_decline", { paywall_info: info }, wireOpts);
            }
            yield* bus.publish("paywall_close", { paywall_info: info }, wireOpts);
            yield* bus.withDelegate((d) => d.onPaywallDidDismiss?.(info));
          }),
        );
        try {
          handler?.onDismiss?.(info, result);
        } catch {}

        // Run feature on purchased/restored, or when paywall is non-gated.
        // Undefined featureGatingBehavior is treated as gated.
        const nonGated = info.featureGatingBehavior === "nonGated";
        if (result.type === "purchased" || result.type === "restored" || nonGated) {
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
      }
    };

  const placements: PlacementsNamespace = {
    getPresentationResult: async (placement, params) => {
      try {
        const decision = await runtime.runPromise(
          evaluatePlacement(placement, (params ?? {}) as PlacementParams),
        );
        switch (decision.kind) {
          case "placementNotFound":
            return { type: "placementNotFound" };
          case "noAudienceMatch":
            return { type: "noAudienceMatch" };
          case "holdout":
            return { type: "holdout", experiment: decision.experiment };
          case "paywall":
            return { type: "paywall", experiment: decision.experiment };
        }
      } catch {
        return { type: "paywallNotAvailable" };
      }
    },

    confirmAllAssignments: () =>
      runPublic(
        Effect.gen(function* () {
          const a = yield* AssignmentService;
          return yield* a.getAll();
        }) as unknown as Effect.Effect<ConfirmedAssignment[], unknown, never>,
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
        if (!res) {
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
        const list = res.customerInfo?.entitlements ?? res.entitlements ?? [];
        return list.map((e) => ({
          id: e.id,
          type: "SERVICE_LEVEL" as const,
          isActive: e.isActive ?? true,
          productIds: e.productIds ?? [],
        }));
      },
      setSubscriptionStatus: (s) => {
        // Reuse the public-facing setter so delegate / event chain fires.
        const prev = subStatusSig.value;
        subStatusSig.set(s);
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
        // Synchronous read of the cached config — `current()` is a Ref get,
        // safe under runSync. Returns [] when config hasn't loaded yet.
        const cfg = runtime.runSync(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            return yield* config.current();
          }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        );
        if (!cfg) return [];
        return (
          extractEntitlementsByProductId(cfg.products).get(productId) ?? []
        );
      },
    });

  const purchases: PurchasesNamespace = {
    restore: async () => {
      // Fire lifecycle events + delegate to controller. Controller is
      // responsible for the actual restore work (web_entitlements fetch
      // for default; consumer's API for custom).
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
              yield* bus.publish("restore_fail", {
                reason: result.error.message,
              });
            }
          }),
        )
        .catch((cause: unknown) =>
          logViaRuntime(
            "transactions",
            "restore() lifecycle effect failed",
            cause,
          ),
        );
    },
    refreshCustomerInfo: () =>
      Promise.reject(new NotConfiguredError(new Error("purchases not yet wired"))),
    setSubscriptionStatus: (s) => {
      const prev = subStatusSig.value;
      subStatusSig.set(s);
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
    purchase: async (product) => {
      // Routes through the active PurchaseController. Default implementation
      // awaits the next stripe_checkout_complete from a presenting paywall.
      // Custom controllers do their own thing.
      const emit = (
        name: "transaction_start" | "transaction_complete" | "transaction_abandon" | "transaction_fail" | "subscription_start",
        detail: Record<string, unknown>,
      ) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const bus = yield* EventBus;
              yield* bus.publish(name as never, detail as never);
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
    },
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

    reset: () =>
      runPublic(
        Effect.gen(function* () {
          yield* IdentityService.beginPending(IdentityPending.Reset);
          yield* IdentityService.reset();
          subStatusSig.set({ status: "UNKNOWN" });
          customerSig.set(null);
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
          const computed = yield* ComputedProperties;
          yield* computed.reset();
          const config = yield* ConfigService;
          yield* config.reset();
          const bus = yield* EventBus;
          yield* bus.publish("reset", {});
          yield* IdentityService.endPending(IdentityPending.Reset);
        }) as Effect.Effect<void, unknown, never>,
      ),

    dismiss: () => {
      // Both: abort the presenter signal, and call dismiss() directly. The
      // in-flight register() call's finally-block clears state.
      currentAbort?.abort();
      try {
        opts.presenter?.dismiss();
      } catch {}
    },

    refreshConfiguration: () =>
      runPublic(
        Effect.gen(function* () {
          const config = yield* ConfigService;
          const assignments = yield* AssignmentService;
          // ConfigService.fetch is serialized by its actor — concurrent
          // refresh calls share the in-flight transition.
          yield* config.fetch().pipe(Effect.catchAll(() => Effect.void));
          yield* eagerAssign(config, assignments);
          yield* applyEntitlementsByProductId(config);
          yield* confirmAssignments(assignments);
          yield* config.preload();
          yield* warmPaywalls(config);
        }) as Effect.Effect<void, unknown, never>,
      ),

    dispose: async () => {
      if (disposed) return;
      disposed = true;
      _clearDefault(sw);
      await runtime.dispose();
    },
  };

  _registerDefault(sw);

  return sw;
};
