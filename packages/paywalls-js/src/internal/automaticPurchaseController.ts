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
        if (ev.type === "postCheckout") {
          off();
          // Resolve the entitlement ids the purchased product grants from
          // the active paywall config. Mirrors how the mobile SDKs build
          // the post-purchase status: product → config.entitlements → set.
          // The next /entitlements poll will return the same set; both
          // sources are authoritative and agree by contract.
          const ids = deps.resolveEntitlementsForProduct(product.id);
          if (ids.length > 0) {
            deps.setSubscriptionStatus({
              status: "ACTIVE",
              entitlements: ids.map((id) => ({
                id,
                type: "SERVICE_LEVEL",
                isActive: true,
                productIds: [product.id],
              } satisfies Entitlement)),
            });
          } else {
            // No config entry (legacy / unmapped product). Fall back to a
            // refresh to learn the entitlement set; status stays whatever
            // it was until the response lands.
            void deps
              .refreshEntitlements()
              .then((ents) => {
                if (ents !== null) applyRefresh(ents);
              })
              .catch(() => {});
          }
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

  return { purchase, restorePurchases, onConfigured };
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
