// Public Superwall instance + factory. Per API.md §1, §2.
//
// Internals run on Effect (services + Layer + ManagedRuntime). The factory
// builds a single ManagedRuntime per instance so service state (identity,
// signals, delegate) is shared across method calls — no per-runPromise
// re-instantiation. Public methods are thin Promise-returning façades.

import { Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { _clearDefault, _registerDefault } from "./default.ts";
import {
  NoPresenterRegisteredError,
  NotConfiguredError,
  PaywallAlreadyPresentedError,
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
  type PartialSuperwallOptions,
  type PaywallInfo,
  type PaywallResult,
  type PaywallSkippedReason,
  type PlacementParams,
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
  networkServiceLayer,
  NetworkService,
  type NetworkConfig,
} from "./internal/network.ts";
import { createMemoryStorage, StorageService } from "./internal/storage.ts";
import { translateInternalError } from "./internal/translate.ts";

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

/** Per-call callbacks for `register`. Sibling to the global delegate
 *  (which fires for every placement) — these only run for this one call. */
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
  /** Runs when the user is entitled OR the placement resolved to a non-gated
   *  paywall that was skipped/dismissed without purchase. */
  feature?: () => void | Promise<void>;
}

export type RegisterPlacementResult =
  | { type: "presented"; info: PaywallInfo; result: PaywallResult }
  | { type: "entitled" }
  | { type: "skipped"; reason: PaywallSkippedReason }
  | { type: "error"; error: Error };

export interface PlacementsNamespace {
  register(args: RegisterPlacementArgs): Promise<RegisterPlacementResult>;
  /** v0 alpha: returns `{ type: "paywallNotAvailable" }` until the static
   *  config processing layer lands. */
  getPresentationResult(
    placement: string,
    params?: PlacementParams,
  ): Promise<PresentationResult>;
  /** Returns the locally-cached `ConfirmedAssignment[]` (replayed from
   *  storage on configure). v0 alpha: backend `/confirm_assignments`
   *  upload deferred — see MISSING.md. */
  confirmAllAssignments(): Promise<ConfirmedAssignment[]>;
  preloadAll(): Promise<void>;
  preloadFor(placementNames: string[]): Promise<void>;
}

export interface PurchasesNamespace {
  /** v0 alpha: emits `restore_start` + `restore_complete` lifecycle events
   *  and persists the timestamp via storage; PurchaseController-driven
   *  restore lands when that path is wired (MISSING.md). */
  restore(): Promise<void>;
  refreshCustomerInfo(): Promise<never>;
  setSubscriptionStatus(s: SubscriptionStatus): void;
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

  /** Tear down the runtime. After dispose the instance is unusable.
   *  Idempotent. */
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
  /** Required to call `sw.placements.register`. The browser package's
   *  `createBrowserPresenter()` is the default for browser apps. */
  presenter?: PaywallPresenter;
  identity?: {
    aliasId?: string;
    appUserId?: string;
    vendorId?: string;
    vendorIdProvider?: () => Promise<string> | string;
  };
  /** Test override for `globalThis.fetch`. */
  fetch?: typeof fetch;
}

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
  // `PartialSuperwallOptions` deeply-partializes `networkEnvironment`'s
  // `{ custom: ... }` shape; trust caller-passed values and cast back.
  const networkConfig: NetworkConfig = {
    apiKey: opts.apiKey,
    environment: (opts.options?.networkEnvironment ?? "release") as NetworkConfig["environment"],
    ...(opts.options?.appVersion !== undefined && { appVersion: opts.options.appVersion }),
    ...(opts.options?.bundleId !== undefined && { bundleId: opts.options.bundleId }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
  };
  const networkLayer = networkServiceLayer(networkConfig, identityLayer);
  // ComputedProperties is a sibling of identity/network — both depend on
  // storage. Built directly off `storageLayer` (not networkLayer) so the
  // type signatures stay tight.
  const computedLayer = computedPropertiesLayer(storageLayer);
  // ConfigService needs NetworkService (for the static_config GET) and
  // StorageService (for the buildId-keyed cache). Build the upstream
  // explicitly since `networkLayer`'s declared type narrows away
  // StorageService even though it includes it at runtime.
  const configUpstream = Layer.merge(networkLayer, storageLayer);
  const configLayer = configServiceLayer(configUpstream);
  // AssignmentService caches sticky variant rollouts per (alias, experiment).
  const assignmentLayer = assignmentServiceLayer(storageLayer);
  // EventBus needs both NetworkService and ComputedProperties.
  const upstreamForBus = Layer.merge(networkLayer, computedLayer);
  const busLayer = eventBusLayerWithTarget(target, upstreamForBus);
  // Merge ConfigService + AssignmentService into the runtime so configure()
  // and the public façade can both reach them.
  const layerWithConfig = Layer.merge(
    Layer.merge(busLayer, configLayer),
    assignmentLayer,
  );
  const baseLayer = loggerLayer(
    opts.options?.logging?.level ?? "warn",
    layerWithConfig,
  );
  // AudienceEvaluator depends on Logger + ComputedProperties — both
  // already in `baseLayer`. Cast through `Layer<ComputedProperties | Logger>`
  // for the upstream signature; runtime materialization picks them out.
  const fullLayer = audienceEvaluatorLayer(
    baseLayer as Layer.Layer<ComputedProperties | Logger>,
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
    >,
  );

  // Public-facing signals. Internal services drive these via background
  // subscriptions started below.
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
  const latestPaywallSig = createSignal<PaywallInfo | null>(null);
  const presentedSig = createSignal<boolean>(false);
  const configuredSig = createSignal<boolean>(false);
  const statusSig = createSignal<ConfigurationStatus>("pending");
  const logLevelSig = createSignal<LogLevel>(opts.options?.logging?.level ?? "warn");
  const localeSig = createSignal<string | null>(
    opts.options?.localeIdentifier ?? null,
  );
  /** ms-since-epoch of the last successful restore. `null` until restore
   *  has been called once. Used to dedupe rapid restore retries + surfaced
   *  to the host app. */
  const lastRestoreAtSig = createSignal<number | null>(null);

  // Wire delegate from opts (if provided) onto the bus, post-runtime build.
  // We can't yield* outside an Effect, so this happens inside `configure`.

  // -------------------------------------------------------------------------
  // configure() — runs once, drives sw.ready
  // -------------------------------------------------------------------------

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

    // Attach delegate (if supplied at construction).
    if (opts.delegate) {
      yield* bus.setDelegate(opts.delegate);
    }

    // Decide hydration source for the local-only event we'll fire after.
    // For now we only know "had a seed" vs "didn't"; richer source tagging
    // (cookie vs localStorage) lands when the BrowserStorage adapter does.
    const hydrationSource: "client" | "cookie" | "generated" =
      seed?.aliasId || seed?.appUserId || seed?.vendorId ? "cookie" : "generated";

    yield* IdentityService.hydrate(seed);

    // Subscribe to identity changes — push into the public signals.
    // `Effect.forkDaemon` so the bridge outlives `configure` and continues
    // to propagate identify / signOut / reset across the runtime's lifetime.
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

    // -----------------------------------------------------------------------
    // Delegate bridges: signal changes → typed delegate callbacks. Each one
    // is a vanilla `Readable.subscribe` (not an Effect Stream) since the
    // public signals are the source of truth and notifications are already
    // microtask-coalesced. We track previous values to skip the sync-on-
    // attach fire so consumers only see real transitions.
    // -----------------------------------------------------------------------

    let prevAttrs = attrsSig.value;
    attrsSig.subscribe((next) => {
      if (next === prevAttrs) return;
      const changed = next;
      prevAttrs = next;
      void runtime
        .runPromise(
          bus.withDelegate((d) => d.onUserAttributesChange?.(changed)),
        )
        .catch(() => {
          /* swallow — delegate bridge must not break publishers */
        });
    });

    // Bridge presenter-emitted URL/deep-link events to the typed delegate.
    target.addEventListener("paywallWillOpenURL", (e) => {
      void runtime
        .runPromise(
          bus.withDelegate((d) => d.onPaywallWillOpenURL?.(e.detail.url)),
        )
        .catch(() => {
          /* swallow */
        });
    });
    target.addEventListener("paywallWillOpenDeepLink", (e) => {
      void runtime
        .runPromise(
          bus.withDelegate((d) => d.onPaywallWillOpenDeepLink?.(e.detail.url)),
        )
        .catch(() => {
          /* swallow */
        });
    });

    let prevCustomerInfo = customerSig.value;
    customerSig.subscribe((next) => {
      if (next === prevCustomerInfo) return;
      const from = prevCustomerInfo;
      prevCustomerInfo = next;
      // Skip the initial null → … transition only if we never had data.
      if (from === null && next === null) return;
      if (from === null || next === null) return; // partial transition; need both
      void runtime
        .runPromise(bus.withDelegate((d) => d.onCustomerInfoChange?.(from, next)))
        .catch(() => {
          /* swallow */
        });
    });

    // Cached confirmed assignments — `AssignmentService` hydrates from
    // storage on materialization, so we don't need to replay here.

    // Replay last-restore timestamp so consumers can read it pre-restore.
    const storage = yield* StorageService;
    const cachedRestoreAt = yield* storage.get(
      asStorageKey(STORAGE_KEYS.lastRestoreAt),
    );
    if (cachedRestoreAt !== null) {
      const ms = Number.parseInt(cachedRestoreAt, 10);
      if (!Number.isNaN(ms)) lastRestoreAtSig.set(ms);
    }

    // Local-only event — proves hydration completed.
    yield* bus.publish("identityHydrated", {
      source: hydrationSource,
      aliasChanged: false,
      userChanged: false,
    });

    // Wire-bound lifecycle events.
    yield* bus.publish("first_seen", {});
    yield* bus.publish("session_start", {});
    yield* bus.publish("app_launch", {});

    // Replay cached config from storage so offline-first works (subsequent
    // network fetch will revalidate). Cache miss / corrupt → null, and
    // we'll only have the post-fetch result.
    const config = yield* ConfigService;
    const assignments = yield* AssignmentService;
    yield* config.hydrateFromStorage().pipe(Effect.catchAll(() => Effect.void));
    // Eager assignment pass over the cached config (Android `ApplyConfig →
    // choosePaywallVariants`). Existing assignments stay sticky; new
    // experiments get picked + persisted now so first `register()` is fast
    // and `confirmAllAssignments` returns a complete snapshot.
    yield* eagerAssign(config, assignments);

    // Static config fetch + enrichment run in parallel — neither depends on
    // the other's response. Mirrors Android `ConfigState.kt:FetchConfig`
    // (`configDeferred` + `enrichmentDeferred` + `attributesDeferred` via
    // `scope.async`). Both are best-effort: failures don't block `configured`.
    //
    // Fetch deadline: when (a) a hydrated cache exists AND (b) the toggle
    // `enableConfigRefresh` is on, race the fetch against `cacheLimit`
    // (500ms on `ACTIVE` sub status, 1s otherwise — Android `ConfigState.kt:86`).
    // On timeout/error the hydrated cache stays in place. Toggle off →
    // unbounded fetch (matches Android's gating).
    const hydrated = yield* config.current();
    const refreshEnabled =
      hydrated?.toggles.find((t) => t.key === "enableConfigRefresh")?.enabled ===
      true;
    // Bounded auto-retry — single retry on fetch failure, mirroring
    // Android `ConfigState.kt:HandleFetchFailure` (`newRetries <= 1`).
    // Retry attaches to the *raw* fetch error (network / parse), not the
    // deadline-timeout wrapper below; a deadline miss means "use cache,"
    // not "config failed."
    const rawFetch = config
      .fetch()
      .pipe(Effect.retry(Schedule.recurs(1)))
      .pipe(Effect.catchAll(() => Effect.void));
    const fetchEffect =
      hydrated && refreshEnabled
        ? rawFetch.pipe(
            Effect.timeout(
              `${subStatusSig.value.status === "ACTIVE" ? 500 : 1000} millis`,
            ),
            Effect.catchAll(() => Effect.void),
          )
        : rawFetch;
    const enrichmentEffect = runEnrichment(bus).pipe(
      Effect.catchAll(() => Effect.void),
    );
    yield* Effect.all([fetchEffect, enrichmentEffect], {
      concurrency: "unbounded",
    });
    // Re-run eager assignment in case the fresh config introduced new
    // experiments or removed variants from existing ones.
    yield* eagerAssign(config, assignments);

    // Drain the initial `Configuration` pending item — `register()` blocks
    // on phase=Ready, so this is what unblocks the first registration.
    yield* IdentityService.endPending(IdentityPending.Configuration);
    configuredSig.set(true);
    statusSig.set("configured");
  });

  /** Collect every experiment ref from the current config's triggers and
   *  hand them to AssignmentService.chooseAllVariants. No-op if config
   *  hasn't loaded yet. */
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

  /** Build payload from the current user/device attribute signals,
   *  POST it to /api/v1/enrich, merge response into the user signal,
   *  and emit enrichment_start / enrichment_complete / enrichment_fail. */
  const runEnrichment = (bus: EventBusImpl) =>
    Effect.gen(function* () {
      const network = yield* NetworkService;
      yield* bus.publish("enrichment_start", {});
      const result = yield* network
        .postEnrichment({
          user: attrsSig.value as Record<string, JsonValue>,
          // device-attribute signal is deferred (MISSING.md). Send empty
          // for now; the BE still returns userEnrichment.
          device: {},
        })
        .pipe(Effect.tapError(() => bus.publish("enrichment_fail", {})));

      // Merge userEnrichment into the user attributes signal. Server values
      // override client values per Android behavior (open question for web —
      // see API.md §14 #4; v0 follows Android).
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

  // -------------------------------------------------------------------------
  // Public façades
  // -------------------------------------------------------------------------

  const runPublic = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
    runtime
      .runPromise(eff as Effect.Effect<A, unknown, never>)
      .catch((cause: unknown) => {
        throw translateInternalError(cause);
      });

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
          // Pending-set bracket — `register()` will block on phase=Ready
          // until both `Identification(id)` and `Seed` clear. Closes the
          // race where identify() in flight makes audience eval read stale
          // attributes (Android `IdentityState.Pending.Identification`).
          yield* IdentityService.beginPending(
            IdentityPending.Identification(userId),
          );
          // Seed pending lands implicitly because identify() may trigger a
          // userIdSeed resolution downstream; for v0 we just clear it after
          // identify() returns since seed-resolve isn't a separate effect yet.
          yield* IdentityService.beginPending(IdentityPending.Seed);
          try {
            yield* IdentityService.identify(userId);
          } finally {
            yield* IdentityService.endPending(IdentityPending.Seed);
            yield* IdentityService.endPending(
              IdentityPending.Identification(userId),
            );
          }
        }) as Effect.Effect<void, unknown, never>,
      ),

    signOut: () =>
      runPublic(
        Effect.gen(function* () {
          yield* IdentityService.signOut();
        }) as Effect.Effect<void, unknown, never>,
      ),

    setAttributes: (next) => {
      attrsSig.update((prev) => ({ ...prev, ...next }) as UserAttributes);
      // Synchronous — by the time this returns, attrsSig is updated and
      // any subsequent `register()` reads the new value. No Attributes
      // pending bracket needed until an async persistence/emit lands.
      // TODO: persist + emit user_attributes event when attribute service lands.
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

  // Stub PaywallInfo — used as a fallback when the placement evaluator
  // returns `paywall` but the variant's `paywallId` doesn't resolve in
  // the loaded config (transitional: until config processing always
  // includes paywall responses, or in tests without a real config).
  const stubPaywallInfo = (placement: string): PaywallInfo => ({
    identifier: `stub_${placement}`,
    name: placement,
    url: `https://paywalls.superwall.com/stub/${placement}`,
    productIds: [],
    products: [],
  });

  // Convert a parsed `RawPaywallResponse` + matched experiment into the
  // public `PaywallInfo` shape. Looks up products from the config catalog
  // and maps to `Product` (entitlements get a default `isActive: false` —
  // the actual subscription state comes from `sw.subscriptionStatus`, not
  // from a paywall info snapshot).
  const buildPaywallInfo = async (
    paywallId: string,
    experiment: Experiment,
    fallbackPlacement: string,
  ): Promise<PaywallInfo> => {
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const config = yield* ConfigService;
          const paywall = yield* config.getPaywall(paywallId);
          const products = yield* config.getProducts();
          return { paywall, products };
        }),
      );
      if (!result.paywall) return stubPaywallInfo(fallbackPlacement);
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
      const info: PaywallInfo = {
        identifier: result.paywall.identifier,
        name: result.paywall.name,
        url: result.paywall.url,
        experiment,
        productIds: [...result.paywall.productIds],
        products,
        ...(result.paywall.featureGatingBehavior !== undefined && {
          featureGatingBehavior: result.paywall.featureGatingBehavior,
        }),
      };
      return info;
    } catch {
      return stubPaywallInfo(fallbackPlacement);
    }
  };

  // Shared placement decision pipeline — runs `ConfigService.getPlacement`
  // + `AudienceEvaluator` over the rules and returns a tagged outcome.
  // `getPresentationResult` and `register` both consume this so the eval
  // logic stays in one place.
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
        device: {} as Record<string, JsonValue>,
      };

      for (const rule of trigger.rules) {
        const result = yield* evaluator.evaluate(rule.expression, ctx);
        if (result === "match") {
          // Sticky variant pick. Hashes (aliasId, experimentId) into a
          // basis-point bucket and picks the variant whose percentage range
          // contains it. Subsequent eval for the same (alias, experiment)
          // returns the cached pick from storage.
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
      /* swallow — feature errors stay scoped to the consumer's callback */
    }
  };

  const placements: PlacementsNamespace = {
    register: async (args) => {
      const { placement, params, handler, feature } = args;
      try {
        // Block until identity is Ready — closes the race where an
        // in-flight identify() / reset() / configure() makes audience
        // evaluation read stale identity / attributes. Mirrors Android
        // `IdentityState.Phase.Ready`.
        await runtime.runPromise(IdentityService.awaitReady());
        // Single-paywall invariant — reject before invoking the presenter.
        if (presentedSig.value) {
          const current = latestPaywallSig.value;
          throw new PaywallAlreadyPresentedError(
            placement,
            current ?? stubPaywallInfo("unknown"),
          );
        }

        // Entitlement short-circuit — skip the paywall entirely.
        if (subStatusSig.value.status === "ACTIVE") {
          await runFeature(feature);
          return { type: "entitled" };
        }

        // Run the placement evaluation pipeline — same one
        // `getPresentationResult` uses. Branches on the decision:
        //   placementNotFound / noAudienceMatch / holdout → skipped
        //   paywall → look up paywall info from config; present
        //
        // Back-compat: if no static config has been loaded at all (offline
        // first run, fetch failed, or v0 alpha tests without a config
        // response), fall through to the stub presentation path so
        // consumers can still test their presenter integration end-to-end
        // without a backend.
        let info: PaywallInfo;
        const configLoaded = await runtime.runPromise(
          Effect.gen(function* () {
            const config = yield* ConfigService;
            return (yield* config.current()) !== null;
          }),
        );

        if (!configLoaded) {
          // No config → stub presentation. Presenter required.
          if (!opts.presenter) {
            throw new NoPresenterRegisteredError(placement);
          }
          info = stubPaywallInfo(placement);
        } else {
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
            } catch {
              /* swallow */
            }
            // Per Android: feature runs on skip when no paywall would gate
            // the user. We don't have featureGating without a paywall, so
            // run unconditionally on skip.
            await runFeature(feature);
            return { type: "skipped", reason };
          }

          // decision.kind === "paywall" — look up the actual paywall.
          if (!opts.presenter) {
            throw new NoPresenterRegisteredError(placement);
          }
          const variantPaywallId = decision.experiment.variant.paywallId;
          info = variantPaywallId
            ? await buildPaywallInfo(
                variantPaywallId,
                decision.experiment,
                placement,
              )
            : stubPaywallInfo(placement);
        }

        // Suppress wire emission of `paywall_*` lifecycle events for stub
        // data (Code-review P0-3) — real config-driven paywalls go to the
        // collector normally.
        const isStub = info.identifier.startsWith("stub_");
        const wireOpts = isStub ? { wireEmit: false } : undefined;

        // Lifecycle: opening. Wrap in try/finally so any failure here
        // (e.g. collector outage during `paywall_open` wire emission)
        // doesn't leave the SDK stuck with `presentedSig === true` and
        // every subsequent register() rejecting `PaywallAlreadyPresented`.
        // (Code-review P0-2.)
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
        } catch {
          /* swallow */
        }

        // Build the presenter context. AbortController is used by `dismiss`
        // to interrupt the in-flight presentation.
        const ac = new AbortController();
        currentAbort = ac;
        const ctx: PresentationContext = {
          placement,
          params: (params ?? ({} as PlacementParams)),
          signal: ac.signal,
          emit: (name, detail) => {
            // Forward via runPromise — fire-and-forget; presenter
            // shouldn't block on event delivery. SuperwallEventMap is a
            // structural subset of AllSuperwallEvents (union of keys); the
            // cast is type-safe but tsc can't narrow it through publish's
            // generic constraint.
            runtime
              .runPromise(
                Effect.gen(function* () {
                  const bus = yield* EventBus;
                  yield* bus.publish(
                    name as never,
                    detail as never,
                  );
                }),
              )
              .catch(() => {
                /* swallow */
              });
          },
        };

        let result: PaywallResult;
        try {
          result = await opts.presenter.present(info, ctx);
        } catch (cause) {
          const err =
            cause instanceof Error
              ? new PresenterError(cause.message, cause)
              : new PresenterError(String(cause));
          // Lifecycle: dismissing on error
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
          } catch {
            /* swallow */
          }
          return { type: "error", error: err };
        } finally {
          currentAbort = null;
        }

        // Lifecycle: dismissing on result. Android emits `paywall_decline`
        // alongside `paywall_close` when the user explicitly declined
        // (Code-review P1).
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
        } catch {
          /* swallow */
        }

        // Run feature when entitled / purchased / non-gated. v0 default
        // PaywallInfo.featureGatingBehavior is undefined → treat as gated.
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
          } catch {
            /* swallow */
          }
          return { type: "error", error: err };
        }
        throw err;
      }
    },

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

  /** AbortController for the in-flight presentation, if any. `dismiss()`
   *  triggers it. */
  let currentAbort: AbortController | null = null;

  const purchases: PurchasesNamespace = {
    restore: async () => {
      // v0 alpha: PurchaseController-driven restore is deferred. We DO
      // fire the lifecycle events + persist the timestamp so cross-platform
      // dedup logic (and the host app's UI) can rely on it.
      await runtime
        .runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.publish("restore_start", {});
            const now = Date.now();
            const storage = yield* StorageService;
            yield* storage.set(
              asStorageKey(STORAGE_KEYS.lastRestoreAt),
              String(now),
            );
            lastRestoreAtSig.set(now);
            yield* bus.publish("restore_complete", {});
          }),
        )
        .catch(() => {
          /* swallow — restore lifecycle events / cache must not throw */
        });
    },
    refreshCustomerInfo: () =>
      Promise.reject(new NotConfiguredError(new Error("purchases not yet wired"))),
    setSubscriptionStatus: (s) => {
      const prev = subStatusSig.value;
      subStatusSig.set(s);
      // Fire delegate + wire event (best-effort — fire-and-forget).
      runtime
        .runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onSubscriptionStatusChange?.(prev, s));
            yield* bus.publish("subscriptionStatus_didChange", {});
          }),
        )
        .catch(() => {
          /* swallow */
        });
    },
  };

  const entitlements: EntitlementsNamespace = (() => {
    // Derive from subscriptionStatus.
    const activeSig = createSignal<Entitlement[]>([]);
    const inactiveSig = createSignal<Entitlement[]>([]);
    const allSig = createSignal<Entitlement[]>([]);
    subStatusSig.subscribe((s) => {
      const ents = s.status === "ACTIVE" ? s.entitlements : [];
      activeSig.set(ents);
      inactiveSig.set([]); // we don't track inactive client-side yet
      allSig.set(ents);
    });
    return {
      active: asReadable(activeSig),
      inactive: asReadable(inactiveSig),
      all: asReadable(allSig),
      byProductIds: (ids) =>
        activeSig.value.filter((e) =>
          e.productIds.some((p) => ids.includes(p)),
        ),
    };
  })();

  let disposed = false;

  const ready: Promise<void> = runtime
    .runPromise(configure)
    .catch((cause: unknown) => {
      // If the consumer disposed before configure completed, the runtime
      // interrupts the in-flight fiber. Don't surface that as a public
      // failure — disposal is the consumer's choice.
      if (disposed) return;
      statusSig.set("failed");
      throw translateInternalError(cause);
    });
  // Attach a sink for the ready rejection so consumers who don't `await
  // sw.ready` (e.g. `createSuperwall(...).dispose()` test patterns) don't
  // produce an unhandled-rejection warning. The throw above still surfaces
  // for any explicit `await sw.ready`.
  void ready.catch(() => {
    /* ready rejection observed; consumer-facing throw still works */
  });

  const sw: Superwall = {
    apiKey: opts.apiKey,
    ready,
    isConfigured: asReadable(configuredSig),
    configurationStatus: asReadable(statusSig),

    user,
    placements,
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
      // Sync the runtime Logger so internal log call sites honor the new level.
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const logger = yield* Logger;
            yield* logger.setLevel(level);
          }),
        )
        .catch(() => {
          /* swallow — log-level update failure must not throw */
        });
    },
    setLocale: (locale) => localeSig.set(locale),
    setDelegate: (delegate) => {
      runtime
        .runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.setDelegate(delegate);
          }),
        )
        .catch(() => {
          /* swallow — setDelegate must not throw publicly */
        });
    },

    reset: () =>
      runPublic(
        Effect.gen(function* () {
          yield* IdentityService.beginPending(IdentityPending.Reset);
          yield* IdentityService.reset();
          subStatusSig.set({ status: "UNKNOWN" });
          customerSig.set(null);
          latestPaywallSig.set(null);
          presentedSig.set(false);
          attrsSig.set({} as UserAttributes);
          intAttrsSig.set({});
          lastRestoreAtSig.set(null);
          const assignments = yield* AssignmentService;
          yield* assignments.reset();
          const storage = yield* StorageService;
          yield* storage.remove(asStorageKey(STORAGE_KEYS.lastRestoreAt));
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
      // Two effects: signal the presenter to abort (if it cares about
      // ctx.signal), and ask the presenter to dismiss directly. The
      // in-flight `register` call's lifecycle finally-block clears state.
      currentAbort?.abort();
      try {
        opts.presenter?.dismiss();
      } catch {
        /* swallow — dismiss must not throw */
      }
    },

    dispose: async () => {
      if (disposed) return;
      disposed = true;
      _clearDefault(sw);
      await runtime.dispose();
    },
  };

  // Tree-shakeable named exports (`user`, `placements`, …) bind to the
  // first-created instance. Subsequent createSuperwall calls don't replace
  // it — explicit instances stay accessible via the returned `Superwall`.
  _registerDefault(sw);

  return sw;
};
