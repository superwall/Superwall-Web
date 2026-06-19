// RedemptionService — POSTs Superwall-issued redemption codes to
// /subscriptions-api/public/v1/redeem, persists the response, polls
// /subscriptions-api/public/v1/users/{id}/entitlements
// for refresh. Used by the default automaticPurchaseController; consumers
// don't interact with this directly.

import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  SubscriptionRef,
} from "effect";
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
  return list.map((e) => {
    const ent = e as {
      id?: string;
      identifier?: string;
      isActive?: boolean;
      productIds?: string[];
    };
    return {
      // BE wire uses `identifier`; tolerate `id` too.
      id: ent.identifier ?? ent.id ?? "",
      type: "SERVICE_LEVEL" as const,
      isActive: ent.isActive ?? true,
      productIds: ent.productIds ?? [],
    };
  });
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
  // Stores the active polling fiber so it can be interrupted on reset() or
  // when startPolling is called a second time (idempotent cancel-and-restart).
  const pollFiber = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(
    null,
  );

  const storage = yield* StorageService;
  const stored = yield* storage
    .get(REDEMPTION_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
  if (stored !== null) {
    // Fix 1: bare try/catch → Effect.try + Effect.option
    const parsed = yield* Effect.try({
      try: () => JSON.parse(stored) as RedeemResponse,
      catch: (e) => e,
    }).pipe(
      Effect.tapError((e) =>
        Effect.logDebug("Redemption: failed to parse stored response", {
          error: String(e),
        }),
      ),
      Effect.option,
    );
    if (Option.isSome(parsed)) {
      yield* SubscriptionRef.set(ref, parsed.value);
    }
  }

  const persist = (res: RedeemResponse) =>
    storage
      .set(REDEMPTION_KEY, JSON.stringify(res))
      .pipe(
        Effect.tapError((e) =>
          Effect.logDebug("Redemption: failed to persist response", {
            error: String(e),
          }),
        ),
        Effect.catchAll(() => Effect.void),
      );

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
          ...(snap.appUserId !== "" && { appUserId: snap.appUserId as string }),
          aliasId: snap.aliasId as string,
          codes: allCodes,
        })
        .pipe(
          // Fix 3: pass full structured error, not just .message
          Effect.tapError((err) =>
            logger.warn("transactions", "redeem POST failed", null, String(err)),
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
        // The `/users/{id}/entitlements` path id MUST match the identity the
        // checkout was attributed to (the iframe `#init=` collector.identity
        // userId), or the BE returns the entitlement as inactive. That userId
        // is `appUserId` when logged in, else the `aliasId` — NOT the
        // deviceId. (Anonymous purchases are keyed to the alias.)
        const queryUserId =
          snap.appUserId !== ""
            ? (snap.appUserId as string)
            : (snap.aliasId as string);
        const result = yield* network
          .getWebEntitlements({
            // Vendor UUID under `deviceId` per Android wire shape.
            deviceId: snap.vendorId as string,
            ...(queryUserId && { userId: queryUserId }),
          })
          .pipe(
            // Fix 3: pass full structured error, not just .message
            Effect.tapError((err) =>
              logger.warn(
                "transactions",
                "entitlements GET failed",
                null,
                String(err),
              ),
            ),
            Effect.catchAll(() =>
              Effect.succeed(null as WebEntitlementsResponse | null),
            ),
          );
        return result;
      });

  // Fix 2: replace setInterval with Effect.runFork + Schedule.fixed.
  // refreshWebEntitlements() closes over resolved service impls (R = never),
  // so Effect.runFork can run it without an explicit runtime context.
  // The cleanup callback interrupts the fiber synchronously.
  const startPolling: RedemptionServiceImpl["startPolling"] = (intervalMs) => {
    // Cancel any prior poller — idempotent.
    const prior = Effect.runSync(Ref.get(pollFiber));
    if (prior !== null) {
      Effect.runFork(Fiber.interrupt(prior));
    }

    const pollEffect = refreshWebEntitlements().pipe(
      Effect.catchAll(() => Effect.void),
      // Run once immediately, then repeat every intervalMs.
      Effect.repeat(Schedule.fixed(Duration.millis(intervalMs))),
      // Absorb the repeat's output type (number of repetitions) → void.
      Effect.asVoid,
    );

    const fiber = Effect.runFork(pollEffect);
    Effect.runSync(Ref.set(pollFiber, fiber));

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
      Effect.runSync(Ref.set(pollFiber, null));
    };
  };

  const latest: RedemptionServiceImpl["latest"] = () => SubscriptionRef.get(ref);

  const reset: RedemptionServiceImpl["reset"] = () =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(ref, null);
      yield* storage
        .remove(REDEMPTION_KEY)
        .pipe(Effect.catchAll(() => Effect.void));
      const fiber = yield* Ref.get(pollFiber);
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber);
        yield* Ref.set(pollFiber, null);
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

/** Build a RedemptionService Layer over an upstream providing
 *  `NetworkService | IdentityService | Logger | StorageService` plus any
 *  additional services (`Extra`). `Extra` is preserved in the output so
 *  callers don't need to cast the richer upstream type away. */
export const redemptionServiceLayer = <Extra = never>(
  upstream: Layer.Layer<NetworkService | IdentityService | Logger | StorageService | Extra>,
): Layer.Layer<RedemptionService | NetworkService | IdentityService | Logger | StorageService | Extra, never, never> =>
  Layer.provideMerge(
    Layer.effect(RedemptionService, make),
    upstream,
  ) as Layer.Layer<RedemptionService | NetworkService | IdentityService | Logger | StorageService | Extra, never, never>;
