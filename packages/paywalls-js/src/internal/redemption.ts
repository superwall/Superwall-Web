// RedemptionService — POSTs Superwall-issued redemption codes to
// /subscriptions-api/public/v1/redeem, persists the response, polls
// /subscriptions-api/public/v1/users/{id}/entitlements
// for refresh. Used by the default automaticPurchaseController; consumers
// don't interact with this directly.

import { Context, Effect, Layer, Ref, SubscriptionRef } from "effect";
import {
  STORAGE_KEYS,
  type Entitlement,
  type SubscriptionStatus,
} from "../types.ts";
import { asStorageKey } from "./brands.ts";
import { IdentityService } from "./identity.ts";
import { Logger } from "./logger.ts";
import {
  NetworkService,
  type RedeemResponse,
  type WebEntitlementsResponse,
} from "./network.ts";
import { StorageService } from "./storage.ts";

const REDEMPTION_KEY = asStorageKey(STORAGE_KEYS.latestRedemption);

export type RedeemType =
  | { _tag: "Code"; code: string }
  | { _tag: "Existing" };

export const RedeemType = {
  Code: (code: string): RedeemType => ({ _tag: "Code", code }),
  Existing: { _tag: "Existing" } as const satisfies RedeemType,
};

export interface RedemptionResultPerCode {
  readonly code: string;
  readonly status: "SUCCESS" | "ERROR" | "EXPIRED" | "INVALID";
  readonly error?: string;
}

export interface RedemptionServiceImpl {
  /** Run a redemption. New code is added to the persisted set; SDK then
   *  asks the BE to redeem the full set (mirrors Android, where the
   *  request always carries every previously-seen code). */
  readonly redeem: (
    type: RedeemType,
  ) => Effect.Effect<RedeemResponse | null>;
  /** One-shot fetch + merge of /users/{id}/entitlements. */
  readonly refreshWebEntitlements: () => Effect.Effect<WebEntitlementsResponse | null>;
  /** Start a polling loop that calls refreshWebEntitlements every `intervalMs`.
   *  Returns a cleanup callback. Idempotent — second call cancels the first. */
  readonly startPolling: (intervalMs: number) => () => void;
  /** Read the persisted redemption response. */
  readonly latest: () => Effect.Effect<RedeemResponse | null>;
  /** Wipe persisted state. Called from sw.reset(). */
  readonly reset: () => Effect.Effect<void>;
}

const entitlementsFromResponse = (
  res: RedeemResponse | WebEntitlementsResponse | null,
): Entitlement[] => {
  if (!res) return [];
  const list =
    (res as RedeemResponse).customerInfo?.entitlements ??
    (res as WebEntitlementsResponse).entitlements ??
    [];
  return list.map((e) => ({
    id: e.id,
    type: "SERVICE_LEVEL" as const,
    isActive: e.isActive ?? true,
    productIds: e.productIds ?? [],
  }));
};

/** Project a SubscriptionStatus from an entitlement set. */
export const subscriptionStatusFromEntitlements = (
  entitlements: Entitlement[],
): SubscriptionStatus => {
  const active = entitlements.filter((e) => e.isActive);
  return active.length > 0
    ? { status: "ACTIVE", entitlements: active }
    : { status: "INACTIVE" };
};

const make = Effect.gen(function* () {
  const network = yield* NetworkService;
  const identity = yield* IdentityService;
  const logger = yield* Logger;
  const ref = yield* SubscriptionRef.make<RedeemResponse | null>(null);
  const pollHandle = yield* Ref.make<ReturnType<typeof setInterval> | null>(
    null,
  );

  const storage = yield* StorageService;
  const stored = yield* storage
    .get(REDEMPTION_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as RedeemResponse;
      yield* SubscriptionRef.set(ref, parsed);
    } catch {}
  }

  const persist = (res: RedeemResponse) =>
    storage
      .set(REDEMPTION_KEY, JSON.stringify(res))
      .pipe(Effect.catchAll(() => Effect.void));

  const redeem: RedemptionServiceImpl["redeem"] = (type) =>
    Effect.gen(function* () {
      const snap = yield* identity.current().pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!snap) return null;

      const previous = yield* SubscriptionRef.get(ref);
      const allCodes = [...(previous?.allCodes ?? [])];
      if (type._tag === "Code") {
        const isFirst = !allCodes.some((c) => c.code === type.code);
        allCodes.push({ code: type.code, firstRedemption: isFirst });
      }

      const result = yield* network
        .postRedeem({
          // BE expects the raw vendor UUID under `deviceId` (Android's
          // `DeviceVendorId`). Our SDK's `snap.deviceId` is the truncated
          // sha256 hash — wrong for this endpoint.
          deviceId: snap.vendorId as string,
          appUserId: snap.appUserId === "" ? undefined : (snap.appUserId as string),
          aliasId: snap.aliasId as string,
          codes: allCodes,
        })
        .pipe(
          Effect.tapError((err) =>
            logger.warn(
              "transactions",
              "redeem POST failed",
              null,
              err.message,
            ),
          ),
          Effect.catchAll(() => Effect.succeed(null as RedeemResponse | null)),
        );

      if (result === null) return null;
      yield* SubscriptionRef.set(ref, result);
      yield* persist(result);
      return result;
    });

  const refreshWebEntitlements: RedemptionServiceImpl["refreshWebEntitlements"] =
    () =>
      Effect.gen(function* () {
        const snap = yield* identity.current().pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (!snap) return null;
        const result = yield* network
          .getWebEntitlements({
            // Vendor UUID under `deviceId` per Android wire shape.
            deviceId: snap.vendorId as string,
            ...(snap.appUserId !== "" && { userId: snap.appUserId as string }),
          })
          .pipe(
            Effect.tapError((err) =>
              logger.warn(
                "transactions",
                "entitlements GET failed",
                null,
                err.message,
              ),
            ),
            Effect.catchAll(() =>
              Effect.succeed(null as WebEntitlementsResponse | null),
            ),
          );
        return result;
      });

  const startPolling: RedemptionServiceImpl["startPolling"] = (intervalMs) => {
    if (typeof setInterval === "undefined") return () => {};
    // Cancel any prior poller — idempotent.
    Effect.runSync(
      Ref.get(pollHandle).pipe(
        Effect.flatMap((h) => {
          if (h !== null) clearInterval(h);
          return Effect.void;
        }),
      ),
    );
    const handle = setInterval(() => {
      void Effect.runPromise(
        refreshWebEntitlements().pipe(Effect.catchAll(() => Effect.void)),
      ).catch(() => {});
    }, intervalMs);
    Effect.runSync(Ref.set(pollHandle, handle));
    return () => {
      clearInterval(handle);
      Effect.runSync(Ref.set(pollHandle, null));
    };
  };

  const latest: RedemptionServiceImpl["latest"] = () => SubscriptionRef.get(ref);

  const reset: RedemptionServiceImpl["reset"] = () =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(ref, null);
      yield* storage
        .remove(REDEMPTION_KEY)
        .pipe(Effect.catchAll(() => Effect.void));
      const handle = yield* Ref.get(pollHandle);
      if (handle !== null) {
        clearInterval(handle);
        yield* Ref.set(pollHandle, null);
      }
    });

  return {
    redeem,
    refreshWebEntitlements,
    startPolling,
    latest,
    reset,
  } satisfies RedemptionServiceImpl;
});

export class RedemptionService extends Context.Tag(
  "@superwall/RedemptionService",
)<RedemptionService, RedemptionServiceImpl>() {}

export const redemptionServiceLayer = (
  upstream: Layer.Layer<NetworkService | IdentityService | Logger | StorageService>,
) =>
  Layer.provideMerge(Layer.effect(RedemptionService, make), upstream);
