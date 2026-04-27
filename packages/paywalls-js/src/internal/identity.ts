// IdentityService — owns alias / userId / vendorId / deviceId persistence
// and the SSR hydration algorithm from API.md §7.4.
//
// Resolution order, per field, per §7.4:
//   1. value already in the StorageService (client localStorage)
//   2. seed value passed via createSuperwall({ identity })  (cookie / pre-seed)
//   3. generated locally  (or vendorIdProvider() for vendorId)
//   4. for appUserId only: leave as "" — never fabricate one
//
// After hydrate(), all resolved values are written back to storage so the
// adapter and the in-memory snapshot are consistent.

import { Effect, Layer, SubscriptionRef } from "effect";
import { STORAGE_KEYS } from "../types.ts";
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

/** `$SuperwallAlias:<uuid-v4>` — matches Android `IdentityLogic.generateAlias`. */
export const generateAlias = (): AliasId =>
  asAliasId(`$SuperwallAlias:${crypto.randomUUID()}`);

export const generateVendorId = (): VendorId => asVendorId(crypto.randomUUID());

/** `sha256(vendorId)` truncated to 16 hex chars (matches Android's hashed `DeviceVendorId`). */
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
    // crypto.subtle.digest can't actually fail in any realistic runtime
    // we ship to, but unwind cleanly if it ever does.
    catch: (cause) =>
      new IdentityHydrationError({
        message: `sha256(vendorId) failed: ${describe(cause)}`,
        cause,
      }),
  });

const make = Effect.gen(function* () {
  const storage = yield* StorageService;
  const ref = yield* SubscriptionRef.make<IdentitySnapshot | null>(null);

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

  const hydrate = Effect.fn("IdentityService.hydrate")(function* (
    seed?: IdentitySeed,
  ) {
    const [storedAlias, storedUser, storedVendor] = yield* Effect.all([
      storage.get(ALIAS_KEY),
      storage.get(USER_KEY),
      storage.get(VENDOR_KEY),
    ]);

    // Per §7.4: for each field, client storage wins, then seed, then fallback.
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

    const snap: IdentitySnapshot = { aliasId, appUserId, vendorId, deviceId };
    yield* persist(snap);
    yield* SubscriptionRef.set(ref, snap);
    return snap;
  });

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

  const identify = Effect.fn("IdentityService.identify")(function* (
    userIdInput: string,
  ) {
    const snap = yield* current();
    const next: IdentitySnapshot = { ...snap, appUserId: asUserId(userIdInput) };
    yield* persist(next);
    yield* SubscriptionRef.set(ref, next);
    return next;
  });

  const signOut = Effect.fn("IdentityService.signOut")(function* () {
    const snap = yield* current();
    if (snap.appUserId === "") return snap;
    const next: IdentitySnapshot = { ...snap, appUserId: "" };
    yield* persist(next);
    yield* SubscriptionRef.set(ref, next);
    return next;
  });

  /** Wipe everything and regenerate alias + vendor + device. Drops appUserId. */
  const reset = Effect.fn("IdentityService.reset")(function* () {
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
  });

  /** Effect-side change stream. Subscribers get the current value on attach
   *  (per SubscriptionRef.changes contract), then every transition. The
   *  initial pre-hydrate value is `null`; first hydrate replaces it. */
  const observe = Effect.fn("IdentityService.observe")(function* () {
    return ref.changes;
  });

  return { hydrate, current, identify, signOut, reset, observe } as const;
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
 *  `StorageService` so tests / callers can poke at storage too. */
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
