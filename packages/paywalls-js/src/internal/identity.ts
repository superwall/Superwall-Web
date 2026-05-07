// IdentityService — owns alias / userId / vendorId / deviceId persistence
// and the SSR hydration algorithm (API.md §7.4). Per-field resolution:
// stored value → seed value → generated locally (appUserId stays "" if
// none supplied — never fabricated). After hydrate(), all resolved values
// are written back to storage.

import { Effect, Layer, SubscriptionRef } from "effect";
import { STORAGE_KEYS } from "../types.ts";
import { makeActor } from "./actor.ts";
import {
  asAliasId,
  asDeviceId,
  asStorageKey,
  asUserId,
  asVendorId,
  type AliasId,
  type DeviceId,
  type UserId,
  type VendorId,
} from "./brands.ts";
import {
  IdentityHydrationError,
  IdentityNotHydratedError,
} from "./errors.ts";
import { StorageService } from "./storage.ts";

export interface IdentitySnapshot {
  readonly aliasId: AliasId;
  readonly appUserId: UserId | "";
  readonly vendorId: VendorId;
  readonly deviceId: DeviceId;
}

// IdentityPhase — `register()` blocks until the pending-set drains, so a
// concurrent `identify()` can't mid-resolve user attributes while a
// placement rule is being evaluated.

export type IdentityPending =
  | { readonly _tag: "Configuration" }
  | { readonly _tag: "Identification"; readonly id: string }
  | { readonly _tag: "Attributes" }
  | { readonly _tag: "Reset" }
  | { readonly _tag: "Seed" }
  | { readonly _tag: "Assignments" };

export const IdentityPending = {
  Configuration: { _tag: "Configuration" } as const satisfies IdentityPending,
  Identification: (id: string): IdentityPending => ({
    _tag: "Identification",
    id,
  }),
  Attributes: { _tag: "Attributes" } as const satisfies IdentityPending,
  Reset: { _tag: "Reset" } as const satisfies IdentityPending,
  Seed: { _tag: "Seed" } as const satisfies IdentityPending,
  Assignments: { _tag: "Assignments" } as const satisfies IdentityPending,
};

const pendingKey = (p: IdentityPending): string =>
  p._tag === "Identification" ? `Identification:${p.id}` : p._tag;

export type IdentityPhase =
  | { readonly _tag: "Pending"; readonly items: ReadonlyArray<IdentityPending> }
  | { readonly _tag: "Ready" };

export const IdentityPhase = {
  /** Initial phase — `{Configuration}` pending until the first hydrate
   *  + configure() pass completes. */
  initial: (): IdentityPhase => ({
    _tag: "Pending",
    items: [IdentityPending.Configuration],
  }),
  Ready: { _tag: "Ready" } as const satisfies IdentityPhase,
  Pending: (items: ReadonlyArray<IdentityPending>): IdentityPhase =>
    items.length === 0 ? IdentityPhase.Ready : { _tag: "Pending", items },
};

export const IdentityUpdates = {
  /** Add a pending item. No-op if already present (set semantics). */
  begin:
    (item: IdentityPending) =>
    (phase: IdentityPhase): IdentityPhase => {
      const existing = phase._tag === "Pending" ? phase.items : [];
      const key = pendingKey(item);
      if (existing.some((p) => pendingKey(p) === key)) return phase;
      return { _tag: "Pending", items: [...existing, item] };
    },
  /** Remove a pending item; flips to Ready when the set drains. */
  end:
    (item: IdentityPending) =>
    (phase: IdentityPhase): IdentityPhase => {
      if (phase._tag !== "Pending") return phase;
      const key = pendingKey(item);
      const next = phase.items.filter((p) => pendingKey(p) !== key);
      return IdentityPhase.Pending(next);
    },
};

const isReady = (phase: IdentityPhase): boolean => phase._tag === "Ready";

export interface IdentitySeed {
  readonly aliasId?: string;
  readonly appUserId?: string;
  readonly vendorId?: string;
  readonly vendorIdProvider?: () => Promise<string> | string;
}

const ALIAS_KEY = asStorageKey(STORAGE_KEYS.aliasId);
const USER_KEY = asStorageKey(STORAGE_KEYS.appUserId);
const VENDOR_KEY = asStorageKey(STORAGE_KEYS.vendorId);
const DEVICE_KEY = asStorageKey(STORAGE_KEYS.deviceId);

/** `$SuperwallAlias:<uuid-v4>` — wire format expected by the BE. */
export const generateAlias = (): AliasId =>
  asAliasId(`$SuperwallAlias:${crypto.randomUUID()}`);

export const generateVendorId = (): VendorId => asVendorId(crypto.randomUUID());

/** `sha256(vendorId)` truncated to 16 hex chars. */
export const deriveDeviceId = (
  vendorId: VendorId,
): Effect.Effect<DeviceId, IdentityHydrationError> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(vendorId);
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return asDeviceId(hex.slice(0, 16));
    },
    catch: (cause) =>
      new IdentityHydrationError({
        message: `sha256(vendorId) failed: ${describe(cause)}`,
        cause,
      }),
  });

const make = Effect.gen(function* () {
  const storage = yield* StorageService;
  // Snapshot actor — mutations serialize so concurrent identify() + reset()
  // land in arrival order without half-applied state.
  const snapshotActor = yield* makeActor<IdentitySnapshot | null>(null);
  const ref = snapshotActor.stateRef;
  const dispatch = snapshotActor.dispatch;

  // Phase ref is intentionally NOT serialized — callers bracket dispatched
  // ops with begin/end, and sharing the snapshot actor's permit would deadlock.
  const phaseRef = yield* SubscriptionRef.make<IdentityPhase>(
    IdentityPhase.initial(),
  );

  const phaseUpdate = (reducer: (p: IdentityPhase) => IdentityPhase) =>
    SubscriptionRef.update(phaseRef, reducer);

  const persist = Effect.fn("IdentityService.persist")(function* (
    snap: IdentitySnapshot,
  ) {
    yield* storage.set(ALIAS_KEY, snap.aliasId);
    yield* storage.set(VENDOR_KEY, snap.vendorId);
    yield* storage.set(DEVICE_KEY, snap.deviceId);
    if (snap.appUserId !== "") {
      yield* storage.set(USER_KEY, snap.appUserId);
    } else {
      yield* storage.remove(USER_KEY);
    }
  });

  const hydrate = (seed?: IdentitySeed) =>
    dispatch(
      "IdentityService.hydrate",
      Effect.gen(function* () {
        const [storedAlias, storedUser, storedVendor] = yield* Effect.all([
          storage.get(ALIAS_KEY),
          storage.get(USER_KEY),
          storage.get(VENDOR_KEY),
        ]);

        const aliasId =
          storedAlias != null
            ? asAliasId(storedAlias)
            : seed?.aliasId
              ? asAliasId(seed.aliasId)
              : generateAlias();

        const appUserId: UserId | "" =
          storedUser != null
            ? asUserId(storedUser)
            : seed?.appUserId
              ? asUserId(seed.appUserId)
              : "";

        let vendorId: VendorId;
        if (storedVendor != null) {
          vendorId = asVendorId(storedVendor);
        } else if (seed?.vendorId) {
          vendorId = asVendorId(seed.vendorId);
        } else {
          const provider = seed?.vendorIdProvider;
          if (provider) {
            const provided = yield* Effect.tryPromise({
              try: async () => await provider(),
              catch: (cause) =>
                new IdentityHydrationError({
                  message: `vendorIdProvider threw: ${describe(cause)}`,
                  cause,
                }),
            });
            vendorId = asVendorId(provided);
          } else {
            vendorId = generateVendorId();
          }
        }

        const deviceId = yield* deriveDeviceId(vendorId);
        const snap: IdentitySnapshot = {
          aliasId,
          appUserId,
          vendorId,
          deviceId,
        };
        yield* persist(snap);
        yield* SubscriptionRef.set(ref, snap);
        return snap;
      }),
    );

  /** Read the current snapshot. Fails if `hydrate()` hasn't run yet. */
  const current = Effect.fn("IdentityService.current")(function* () {
    const value = yield* SubscriptionRef.get(ref);
    if (value === null) {
      return yield* Effect.fail(
        new IdentityNotHydratedError({
          message: "IdentityService accessed before hydrate() resolved",
        }),
      );
    }
    return value;
  });

  const identify = (userIdInput: string) =>
    dispatch(
      "IdentityService.identify",
      Effect.gen(function* () {
        const snap = yield* current();
        const next: IdentitySnapshot = {
          ...snap,
          appUserId: asUserId(userIdInput),
        };
        yield* persist(next);
        yield* SubscriptionRef.set(ref, next);
        return next;
      }),
    );

  const signOut = () =>
    dispatch(
      "IdentityService.signOut",
      Effect.gen(function* () {
        const snap = yield* current();
        if (snap.appUserId === "") return snap;
        const next: IdentitySnapshot = { ...snap, appUserId: "" };
        yield* persist(next);
        yield* SubscriptionRef.set(ref, next);
        return next;
      }),
    );

  /** Wipe everything and regenerate alias + vendor + device. Drops appUserId. */
  const reset = () =>
    dispatch(
      "IdentityService.reset",
      Effect.gen(function* () {
        const aliasId = generateAlias();
        const vendorId = generateVendorId();
        const deviceId = yield* deriveDeviceId(vendorId);
        const next: IdentitySnapshot = {
          aliasId,
          appUserId: "",
          vendorId,
          deviceId,
        };
        yield* persist(next);
        yield* SubscriptionRef.set(ref, next);
        return next;
      }),
    );

  /** Change stream. Initial pre-hydrate value is `null`. */
  const observe = Effect.fn("IdentityService.observe")(function* () {
    return ref.changes;
  });

  /** Add a pending item to the phase set. Idempotent. */
  const beginPending = (item: IdentityPending) =>
    phaseUpdate(IdentityUpdates.begin(item));

  /** Drop a pending item; phase flips to Ready when the set drains. */
  const endPending = (item: IdentityPending) =>
    phaseUpdate(IdentityUpdates.end(item));

  const currentPhase = () => SubscriptionRef.get(phaseRef);

  /** Block until phase becomes Ready. */
  const awaitReady: () => Effect.Effect<void> = () =>
    Effect.gen(function* () {
      const phase = yield* SubscriptionRef.get(phaseRef);
      if (isReady(phase)) return;
      yield* Effect.yieldNow();
      yield* awaitReady();
    });

  return {
    hydrate,
    current,
    identify,
    signOut,
    reset,
    observe,
    phaseRef,
    beginPending,
    endPending,
    currentPhase,
    awaitReady,
  } as const;
});

export class IdentityService extends Effect.Service<IdentityService>()(
  "@superwall/IdentityService",
  {
    accessors: true,
    dependencies: [StorageService.Default],
    effect: make,
  },
) {}

/** Build a Layer that exposes both `IdentityService` and the supplied
 *  `StorageService` (re-exposed for downstream consumers/tests). */
export const identityWithStorage = (
  storage: Layer.Layer<StorageService>,
): Layer.Layer<IdentityService | StorageService> =>
  Layer.provideMerge(IdentityService.DefaultWithoutDependencies, storage);

const describe = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : JSON.stringify(cause);
