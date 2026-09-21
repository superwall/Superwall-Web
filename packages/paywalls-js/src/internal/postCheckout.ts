// Default handling of a completed web checkout (`post_checkout_complete`),
// used when the developer hasn't supplied `handler.onPurchase`. Only the
// entitlement half lives here — the SDK core owns the rest of the default
// (tear down the overlay, fire `onDismiss`). `redirect_url` is never followed;
// it's surfaced to the developer on the payload.
//
// The switch is `claimed`, not a behavior enum:
//   - claimed:   the server already bound the subscription to this device +
//                app user id. Grant locally: apply what it told us and
//                reconcile from `/entitlements`.
//   - unclaimed: nothing to grant here. The grant is the server's job; the
//                SDK just closes the paywall.
// Either way the SDK NEVER redeems the checkout's codes itself — they're
// fresh, and spending one would take it from the buyer's phone. They reach
// the developer on the payload (`onPurchase` / `result.checkout` /
// `redemptionCodesReceived`), who can call `sw.redeem(code)` if they want to.

import type {
  CheckoutCompletion,
  Entitlement,
  SubscriptionStatus,
} from "../types.ts";

export interface PostCheckoutDeps {
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
}

/** Grant a completed checkout's entitlements for the current user — only when
 *  the server says it `claimed` the purchase for them. Synchronous: local
 *  state reflects the purchase by the time this returns, so the caller can
 *  tear the overlay down right after. The `/entitlements` reconcile runs in
 *  the background. Never throws. */
export const applyCheckoutEntitlements = (
  checkout: CheckoutCompletion,
  deps: PostCheckoutDeps,
): void => {
  if (!checkout.claimed) return;

  if (checkout.entitlementsToken) {
    deps.setEntitlementsToken(checkout.entitlementsToken);
  }

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

  // Background reconcile — `/entitlements` is authoritative, applied
  // verbatim (last writer wins). Failures logged, never thrown.
  void deps
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
      deps.logWarn(
        "post-checkout entitlements refresh failed",
        e instanceof Error ? e.message : String(e),
      );
    });
};
