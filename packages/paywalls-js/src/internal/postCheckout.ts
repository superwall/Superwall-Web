// Default handling of a completed web checkout (`post_checkout_complete`),
// used when the developer hasn't supplied `handler.onPurchase`. Only the
// entitlement half lives here — the SDK core owns the rest of the default
// (tear down the overlay, fire `onDismiss`). `redirect_url` is never followed;
// it's surfaced to the developer on the payload.
//
// The switch is `claimed`, not a behavior enum:
//   - claimed:   the server already bound the subscription to this device +
//                app user id. Apply what it told us and reconcile from
//                `/entitlements`. NEVER redeem the codes — that would spend a
//                code the buyer could use on their phone.
//   - unclaimed: the server minted codes but could not claim. Redeem them for
//                the current user. Redeeming is idempotent for the same
//                identity, so retrying a failed attempt is safe.

import type {
  CheckoutCompletion,
  Entitlement,
  SubscriptionStatus,
} from "../types.ts";
import type { RedemptionOutcome } from "./automaticPurchaseController.ts";

/** Waits between redeem attempts for one code — so 3 attempts in total. */
const REDEEM_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 1500];

export interface PostCheckoutDeps {
  /** Fire a redemption code POST. */
  redeem(code: string): Promise<RedemptionOutcome>;
  /** Refresh web entitlements. `null` = the read failed. */
  refreshEntitlements(): Promise<Entitlement[] | null>;
  /** Authoritative sub-status setter. */
  setSubscriptionStatus(s: SubscriptionStatus): void;
  /** Publish the signed entitlements JWT (`sw.entitlementsToken`). */
  setEntitlementsToken(token: string): void;
  /** Resolve a product id to its entitlement ids using the paywall config.
   *  Returns `[]` when the product isn't in the active config (legacy
   *  paywalls, test mode). */
  resolveEntitlementsForProduct(productId: string): string[];
  /** Surface log messages via the SDK's logger. */
  logWarn(message: string, error?: string): void;
  /** Test override for {@link REDEEM_RETRY_DELAYS_MS}. */
  retryDelaysMs?: ReadonlyArray<number>;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Apply a completed checkout's entitlements for the current user. Resolves
 *  once local state reflects the purchase as well as it can — the caller
 *  tears the overlay down after this. Never rejects. */
export const applyCheckoutEntitlements = async (
  checkout: CheckoutCompletion,
  deps: PostCheckoutDeps,
): Promise<void> => {
  if (checkout.entitlementsToken) {
    deps.setEntitlementsToken(checkout.entitlementsToken);
  }

  /** `/entitlements` is authoritative — apply it verbatim, last writer wins. */
  const reconcile = (): Promise<void> =>
    deps
      .refreshEntitlements()
      .then((ents) => {
        if (ents === null) return;
        const active = ents.filter((e) => e.isActive);
        deps.setSubscriptionStatus(
          active.length > 0
            ? { status: "ACTIVE", entitlements: active }
            : { status: "INACTIVE" },
        );
      })
      .catch((e: unknown) => {
        deps.logWarn("post-checkout entitlements refresh failed", errorMessage(e));
      });

  if (checkout.claimed) {
    // Optimistic ACTIVE flip from config-derived entitlement ids, falling
    // back to a single placeholder keyed by `productId`. The BE often sends
    // the slot reference name (e.g. "primary") here, not the Stripe id, AND
    // the merchant's product→entitlement mapping in dashboard may be empty —
    // both lead to `[]`. The reconcile below replaces the placeholder with
    // the authoritative set within seconds; meanwhile the consumer's UI flips
    // ACTIVE immediately instead of staying INACTIVE on a successful purchase.
    const { productId } = checkout;
    const ids = deps.resolveEntitlementsForProduct(productId);
    deps.setSubscriptionStatus({
      status: "ACTIVE",
      entitlements: (ids.length > 0 ? ids : [productId]).map(
        (id) =>
          ({
            id,
            type: "SERVICE_LEVEL",
            isActive: true,
            productIds: [productId],
          }) satisfies Entitlement,
      ),
    });
    // Background — teardown doesn't wait on the network for a claimed
    // purchase. Failures logged, never thrown.
    void reconcile();
    return;
  }

  if (checkout.redemptionCodes.length === 0) {
    deps.logWarn("post_checkout_complete was unclaimed but carried no redemption codes");
    await reconcile();
    return;
  }

  const delays = deps.retryDelaysMs ?? REDEEM_RETRY_DELAYS_MS;
  for (const code of checkout.redemptionCodes) {
    for (let attempt = 0; ; attempt++) {
      let outcome: RedemptionOutcome;
      try {
        outcome = await deps.redeem(code);
      } catch (e) {
        deps.logWarn("post-checkout redemption threw", errorMessage(e));
        outcome = { status: "error", entitlements: [] };
      }
      if (outcome.status === "success") {
        if (outcome.entitlements.length > 0) {
          deps.setSubscriptionStatus({
            status: "ACTIVE",
            entitlements: outcome.entitlements,
          });
        }
        break;
      }
      // expired / invalid are final for this code; only `error` is transient.
      const delay = delays[attempt];
      if (outcome.status !== "error" || delay === undefined) {
        deps.logWarn("post-checkout redemption failed", outcome.status);
        break;
      }
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
};
