// Public Superwall instance + factory. Per API.md §1, §2.
//
// Internals run on Effect (services + Layer + ManagedRuntime). The factory
// builds a single ManagedRuntime per instance so service state (identity,
// signals, delegate) is shared across method calls — no per-runPromise
// re-instantiation. Public methods are thin Promise-returning façades.

import { Effect, Layer, ManagedRuntime, Stream } from "effect";
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
import {
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
  const fullLayer = eventBusLayerWithTarget(target, networkLayer);

  const runtime = ManagedRuntime.make(
    fullLayer as Layer.Layer<EventBus | NetworkService | IdentityService | StorageService>,
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
  /** Cached confirmed-assignment list (offline parity). Replayed from
   *  storage on configure; rewritten on confirm + cleared on reset. */
  const assignmentsSig = createSignal<ConfirmedAssignment[]>([]);
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

    // Replay cached assignments from offline storage (per parity with
    // Android's confirmed-assignments cache). Read-only — confirmation +
    // upload to /confirm_assignments lands when the placement evaluation
    // engine ships.
    const storage = yield* StorageService;
    const cachedAssignments = yield* storage.get(
      asStorageKey(STORAGE_KEYS.assignments),
    );
    if (cachedAssignments !== null) {
      try {
        const parsed = JSON.parse(cachedAssignments) as ConfirmedAssignment[];
        if (Array.isArray(parsed)) assignmentsSig.set(parsed);
      } catch {
        // Corrupt cache — drop it. Fresh assignments will repopulate when
        // the placement engine lands.
      }
    }

    // Replay last-restore timestamp so consumers can read it pre-restore.
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

    // Enrichment — POST {user, device} → merge response into local state.
    // Best-effort: a network failure here doesn't block ready (we still
    // mark configured true; consumers operate on the un-enriched snapshot).
    // Per API.md §11.6: called on configure() and on every identify().
    yield* runEnrichment(bus).pipe(Effect.catchAll(() => Effect.void));

    configuredSig.set(true);
    statusSig.set("configured");
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

  const ready: Promise<void> = runtime
    .runPromise(configure)
    .catch((cause: unknown) => {
      statusSig.set("failed");
      throw translateInternalError(cause);
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
          yield* IdentityService.identify(userId);
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

  // Build a stub PaywallInfo for v0 alpha. Real config-driven info lands
  // when static_config processing arrives.
  const stubPaywallInfo = (placement: string): PaywallInfo => ({
    identifier: `stub_${placement}`,
    name: placement,
    url: `https://paywalls.superwall.com/stub/${placement}`,
    productIds: [],
    products: [],
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

        if (!opts.presenter) {
          throw new NoPresenterRegisteredError(placement);
        }

        const info = stubPaywallInfo(placement);

        // Lifecycle: opening
        latestPaywallSig.set(info);
        presentedSig.set(true);
        await runtime.runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onPaywallWillPresent?.(info));
            yield* bus.publish("paywall_open", { paywall_info: info });
            yield* bus.withDelegate((d) => d.onPaywallDidPresent?.(info));
          }),
        );
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
              yield* bus.publish("paywall_close", { paywall_info: info });
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

        // Lifecycle: dismissing on result
        presentedSig.set(false);
        await runtime.runPromise(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            yield* bus.withDelegate((d) => d.onPaywallWillDismiss?.(info));
            yield* bus.publish("paywall_close", { paywall_info: info });
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

    getPresentationResult: async () => ({ type: "paywallNotAvailable" }),

    confirmAllAssignments: async () => assignmentsSig.value,

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

    setLogLevel: (level) => logLevelSig.set(level),
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
          yield* IdentityService.reset();
          subStatusSig.set({ status: "UNKNOWN" });
          customerSig.set(null);
          latestPaywallSig.set(null);
          presentedSig.set(false);
          attrsSig.set({} as UserAttributes);
          intAttrsSig.set({});
          assignmentsSig.set([]);
          lastRestoreAtSig.set(null);
          const storage = yield* StorageService;
          yield* storage.remove(asStorageKey(STORAGE_KEYS.assignments));
          yield* storage.remove(asStorageKey(STORAGE_KEYS.lastRestoreAt));
          const bus = yield* EventBus;
          yield* bus.publish("reset", {});
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
