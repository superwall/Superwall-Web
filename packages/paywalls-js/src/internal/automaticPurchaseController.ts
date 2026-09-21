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
import {
  Effect,
  Fiber,
  Schedule,
  Duration,
} from "effect";

const REDEMPTION_PARAM = "code";
const REDEMPTION_PREFIX = "redemption_";
// Background entitlements poll cadence. Loose (10 min) because checkout +
// restore + reset already refresh eagerly; this just catches out-of-band
// changes (cancellation, cross-device). The interval is paused while the tab
// is hidden and a fresh read fires on re-focus (see onConfigured), so the
// effective rate is "every 10 min of foreground time + once on each refocus".
const POLL_INTERVAL_MS = 10 * 60_000;

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
  let pollFiber: Fiber.RuntimeFiber<unknown, never> | null = null;
  let stopVisibility: (() => void) | null = null;

  /** Apply a refreshed entitlement set verbatim. The post-checkout handler
   *  (`internal/postCheckout.ts`) and the periodic /entitlements poll are both
   *  authoritative; they agree by contract (the BE has committed before
   *  either signal fires), so we never need to mediate between them — last
   *  writer wins. */
  const applyRefresh = (ents: Entitlement[]): void => {
    const active = ents.filter((e) => e.isActive);
    deps.setSubscriptionStatus(
      active.length > 0
        ? { status: "ACTIVE", entitlements: active }
        : { status: "INACTIVE" },
    );
  };

  /** Effect that performs one entitlements refresh. Never fails — errors
   *  are logged and swallowed so the polling Schedule continues. */
  const refreshEffect: Effect.Effect<void> = Effect.tryPromise({
    try: () => deps.refreshEntitlements(),
    catch: (e) => e,
  }).pipe(
    Effect.tap((ents) => Effect.sync(() => {
      if (ents !== null) applyRefresh(ents);
    })),
    Effect.tapError((e) => Effect.sync(() => {
      deps.logWarn(
        "refreshEntitlements poll failed",
        e instanceof Error ? e.message : String(e),
      );
    })),
    Effect.catchAll(() => Effect.void),
  );

  const startPolling = (): void => {
    // Interrupt any running poll fiber before starting a new one.
    if (pollFiber !== null) {
      void Effect.runFork(Fiber.interrupt(pollFiber));
      pollFiber = null;
    }
    // Immediate one-shot refresh (Promise chain preserves original timing
    // for callers that await a microtask after onConfigured()).
    void deps
      .refreshEntitlements()
      .then((ents) => { if (ents !== null) applyRefresh(ents); })
      .catch((e: unknown) => {
        deps.logWarn(
          "refreshEntitlements poll failed",
          e instanceof Error ? e.message : String(e),
        );
      });
    // Subsequent repeats managed by Effect's scheduler — no raw setInterval.
    pollFiber = Effect.runFork(
      Effect.repeat(refreshEffect, Schedule.fixed(Duration.millis(POLL_INTERVAL_MS))),
    );
  };

  const stopPolling = (): void => {
    if (pollFiber !== null) {
      void Effect.runFork(Fiber.interrupt(pollFiber));
      pollFiber = null;
    }
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
        // Note: entitlements / redemption for the completed checkout are
        // the SDK core's job (`internal/postCheckout.ts`, or the developer's
        // `handler.onPurchase`). This handler only resolves the promise.
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
        // start / submit / complete: in-flight signals, not terminal.
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
          } catch (e: unknown) {
            deps.logWarn(
              "replaceHistory failed after redemption",
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      }
    }

    // Start Effect-managed polling: immediate refresh + repeat on schedule.
    startPolling();

    // Pause the poll while the tab is hidden (no point hammering /entitlements
    // in the background — and browsers throttle background timers anyway).
    // On re-focus, refresh once immediately + restart the interval so the
    // user always sees fresh state when they come back.
    if (
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function"
    ) {
      stopVisibility?.();
      const onVisibility = () => {
        if (document.visibilityState === "hidden") {
          stopPolling();
        } else {
          startPolling();
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      stopVisibility = () =>
        document.removeEventListener("visibilitychange", onVisibility);
    }
  };

  const dispose = (): void => {
    // Interrupt the polling fiber and remove the visibility listener so
    // neither outlives the instance.
    stopPolling();
    stopVisibility?.();
    stopVisibility = null;
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
