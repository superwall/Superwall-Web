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
/** After a successful purchase we optimistically flip sub status to ACTIVE.
 *  Background entitlements polling can race ahead of the BE's writer side
 *  and report INACTIVE for a few seconds; suppress that downgrade until the
 *  purchased entitlement set has propagated. Mirrors the Android SDK's
 *  "recent purchase" behavior. */
const RECENT_PURCHASE_GRACE_MS = 30_000;

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
  let recentPurchaseUntil = 0;
  const now = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  /** Apply a refreshed entitlement set, but don't downgrade ACTIVE → INACTIVE
   *  during the post-purchase grace window. Prevents the optimistic ACTIVE
   *  flip from flickering back to INACTIVE while the BE is still writing
   *  the new entitlement row. */
  const applyRefresh = (ents: Entitlement[]): void => {
    const active = ents.filter((e) => e.isActive);
    if (active.length > 0) {
      deps.setSubscriptionStatus({ status: "ACTIVE", entitlements: active });
      return;
    }
    if (now() < recentPurchaseUntil) {
      // Suppress INACTIVE during grace window.
      return;
    }
    deps.setSubscriptionStatus({ status: "INACTIVE" });
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
          // Optimistic sub-status flip; the entitlements polling loop will
          // confirm/refine. Without a server-confirmed entitlement set in
          // the event we can only assert "active" against the purchased
          // product id.
          deps.setSubscriptionStatus({
            status: "ACTIVE",
            entitlements: [
              {
                id: product.id,
                type: "SERVICE_LEVEL",
                isActive: true,
                productIds: [product.id],
              } satisfies Entitlement,
            ],
          });
          // Open the grace window so a stale INACTIVE refresh response
          // can't immediately undo the optimistic flip.
          recentPurchaseUntil = now() + RECENT_PURCHASE_GRACE_MS;
          // Kick a fresh entitlements fetch so the authoritative set lands
          // shortly after the paywall closes.
          void deps
            .refreshEntitlements()
            .then((ents) => {
              if (ents !== null) applyRefresh(ents);
            })
            .catch(() => {});
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
