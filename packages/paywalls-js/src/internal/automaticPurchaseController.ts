// Default PurchaseController for the standard Superwall web flow:
// paywall-driven Stripe checkout (drawer/embedded/redirect modes), web
// redemption codes (?code=redemption_…), and periodic web_entitlements
// polling. Consumers can swap with a custom PurchaseController for full
// control over checkout + restore.

import type {
  Entitlement,
  PurchaseController,
  PurchaseResult,
  Product,
  RestorationResult,
  SubscriptionStatus,
} from "../types.ts";
import type { PaywallPurchaseEvent } from "../presenter.ts";

const REDEMPTION_PARAM = "code";
const REDEMPTION_PREFIX = "redemption_";
const POLL_INTERVAL_MS = 60_000;

export interface AutomaticPurchaseControllerDeps {
  /** Subscribe to in-flight paywall purchase events. Returns unsubscribe. */
  subscribe(handler: (ev: PaywallPurchaseEvent) => void): () => void;
  /** Fire a redemption code POST. */
  redeem(code: string): Promise<RedemptionOutcome>;
  /** Refresh web entitlements. */
  refreshEntitlements(): Promise<Entitlement[] | null>;
  /** Authoritative sub-status setter. */
  setSubscriptionStatus(s: SubscriptionStatus): void;
  /** Surface log messages via the SDK's logger. */
  logWarn(message: string, error?: string): void;
  /** Resolve a product id to its entitlement ids using the paywall config.
   *  Returns `[]` when the product isn't in the active config (legacy
   *  paywalls, test mode). The SDK uses this to materialize the active
   *  entitlement set on `post_checkout_complete` without waiting for the
   *  next /entitlements refresh — both signals are authoritative and agree. */
  resolveEntitlementsForProduct(productId: string): string[];
  /** Browser location for redemption-code URL detection. SSR-safe. */
  location?: { search: string; href: string };
  /** Replace history entry with the given URL (strips ?code= after consume). */
  replaceHistory?: (url: string) => void;
}

export interface RedemptionOutcome {
  status: "success" | "error" | "expired" | "invalid";
  entitlements: Entitlement[];
}

export const createAutomaticPurchaseController = (
  deps: AutomaticPurchaseControllerDeps,
): PurchaseController => {
  let stopPolling: (() => void) | null = null;
  /** Apply a refreshed entitlement set verbatim. Both `post_checkout_complete`
   *  and the periodic /entitlements poll are authoritative; they agree by
   *  contract (the BE has committed before either signal fires), so we
   *  never need to mediate between them — last writer wins. */
  const applyRefresh = (ents: Entitlement[]): void => {
    const active = ents.filter((e) => e.isActive);
    deps.setSubscriptionStatus(
      active.length > 0
        ? { status: "ACTIVE", entitlements: active }
        : { status: "INACTIVE" },
    );
  };

  /** Optimistic ACTIVE flip from config-derived entitlement ids + a
   *  background `/entitlements` reconcile. Idempotent — safe to invoke
   *  from both the persistent subscription (every postCheckout, even
   *  outside an in-flight purchase() promise) and the per-purchase
   *  subscription. */
  const applyPostCheckout = (productId: string): void => {
    // Try config-derived entitlement ids first; fall back to a single
    // synthesized placeholder using `productId` as the id. The BE often
    // sends the slot reference name (e.g. "primary") here, not the Stripe
    // id, AND the merchant's product→entitlement mapping in dashboard may
    // be empty — both lead to `[]` from `resolveEntitlementsForProduct`.
    // The /entitlements refresh below replaces the placeholder with the
    // authoritative set within seconds; meanwhile the consumer's UI flips
    // ACTIVE immediately instead of staying INACTIVE on a successful
    // purchase.
    const ids = deps.resolveEntitlementsForProduct(productId);
    const entitlements: Entitlement[] =
      ids.length > 0
        ? ids.map((id) => ({
            id,
            type: "SERVICE_LEVEL",
            isActive: true,
            productIds: [productId],
          } satisfies Entitlement))
        : [
            {
              id: productId,
              type: "SERVICE_LEVEL",
              isActive: true,
              productIds: [productId],
            } satisfies Entitlement,
          ];
    deps.setSubscriptionStatus({ status: "ACTIVE", entitlements });
    void deps
      .refreshEntitlements()
      .then((ents) => {
        if (ents !== null && ents.length > 0) applyRefresh(ents);
      })
      .catch(() => {});
  };

  const purchase = async (product: Product): Promise<PurchaseResult> =>
    new Promise<PurchaseResult>((resolve) => {
      const off = deps.subscribe((ev) => {
        // Filter to events for this product. Empty productId in the
        // event = "no filter" (some paywalls don't emit it).
        if (ev.productId && ev.productId !== product.id) return;
        // Terminal success: `post_checkout_complete` from the paywall's
        // WebPaywallController, fired AFTER server-side post-checkout work
        // (session/complete + redemption) succeeded. `stripe_checkout_complete`
        // is an in-flight signal — don't resolve on it; the controller
        // still has work to do and may yet fail.
        // Note: the persistent subscription in onConfigured() handles the
        // sub-status flip + refresh. This per-purchase handler only
        // resolves the promise. Same event hits both subscribers; the
        // flip is idempotent so the double-call is fine.
        if (ev.type === "postCheckout") {
          off();
          resolve({ type: "purchased" });
        } else if (ev.type === "fail") {
          off();
          resolve({
            type: "failed",
            error: new Error(ev.error ?? "stripe checkout failed"),
          });
        } else if (ev.type === "abandon") {
          off();
          resolve({ type: "cancelled" });
        }
        // start / submit / complete: in-flight signals, no-op for now.
      });
    });

  const restorePurchases = async (): Promise<RestorationResult> => {
    try {
      // Mirrors Android `RestorationResult.Restored` semantics — completion
      // without throwing IS the restore. A network blip yields null + we
      // leave sub status alone (don't downgrade ACTIVE → INACTIVE on a
      // transient failure).
      const ents = await deps.refreshEntitlements();
      if (ents !== null) applyRefresh(ents);
      return { type: "restored" };
    } catch (cause) {
      return {
        type: "failed",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
  };

  // Persistent purchase-event subscription — handles every postCheckout
  // independent of any in-flight `purchase()` promise. The typical
  // `sw.register()` flow (user clicks Stripe in the iframe, never calls
  // `sw.purchases.purchase`) needs this to flip subscriptionStatus to
  // ACTIVE on success; without it the per-purchase subscription is the
  // only listener and it doesn't exist outside a `purchase()` call.
  // Wired at controller construction so it's active from boot.
  deps.subscribe((ev) => {
    if (ev.type === "postCheckout" && ev.productId) {
      applyPostCheckout(ev.productId);
    }
  });

  const onConfigured = async (): Promise<void> => {
    // Auto-detect a returning redemption-code redirect.
    const loc = deps.location ?? readGlobalLocation();
    if (loc) {
      const params = new URLSearchParams(loc.search);
      const code = params.get(REDEMPTION_PARAM);
      if (code && code.startsWith(REDEMPTION_PREFIX)) {
        try {
          const result = await deps.redeem(code);
          if (result.status === "success" && result.entitlements.length > 0) {
            deps.setSubscriptionStatus({
              status: "ACTIVE",
              entitlements: result.entitlements,
            });
          }
        } catch (cause) {
          deps.logWarn(
            "automatic redemption failed",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        // Strip the code param so reload doesn't re-trigger.
        if (deps.replaceHistory) {
          params.delete(REDEMPTION_PARAM);
          const qs = params.toString();
          const cleanUrl =
            loc.href.split("?")[0] + (qs ? "?" + qs : "");
          try {
            deps.replaceHistory(cleanUrl);
          } catch {}
        }
      }
    }

    // Immediate one-shot fetch so subscriptionStatus flips off UNKNOWN as
    // soon as configure() settles — don't wait the full poll interval.
    void deps
      .refreshEntitlements()
      .then((ents) => {
        if (ents !== null) applyRefresh(ents);
      })
      .catch(() => {});

    // Periodic web_entitlements poll. Best-effort; failures swallowed.
    if (typeof setInterval !== "undefined") {
      stopPolling?.();
      const handle = setInterval(() => {
        void deps
          .refreshEntitlements()
          .then((ents) => {
            if (ents !== null) applyRefresh(ents);
          })
          .catch(() => {});
      }, POLL_INTERVAL_MS);
      stopPolling = () => clearInterval(handle);
    }
  };

  const dispose = (): void => {
    // Stop the entitlements-polling interval so the timer (and its fetch
    // loop) doesn't outlive the SDK instance.
    stopPolling?.();
    stopPolling = null;
  };

  return { purchase, restorePurchases, onConfigured, dispose };
};

const readGlobalLocation = ():
  | { search: string; href: string }
  | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return { search: window.location.search, href: window.location.href };
  } catch {
    return undefined;
  }
};
