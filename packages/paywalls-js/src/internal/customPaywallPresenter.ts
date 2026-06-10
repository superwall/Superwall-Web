// Wraps a developer-supplied `CustomPaywallRenderer` (from
// `register({ paywall })`) into a `PaywallPresenter` so the SDK's present /
// dismiss / lifecycle path is identical to the iframe presenter. Pure — no
// DOM. The renderer decides how to draw (DOM, React via the
// `@superwall/paywalls-react` wrapper, or anything else); this module only
// owns the reactive state machine + the controller that drives buy / restore
// / close through injected SDK callbacks.

import { asReadable, createSignal } from "../signal.ts";
import type {
  CustomPaywallController,
  CustomPaywallRenderer,
  CustomPaywallState,
  PaywallPresenter,
} from "../presenter.ts";
import type { PaywallInfo, PaywallResult, Product } from "../types.ts";

/** SDK-side hooks the controller drives. Wired in `superwall.ts` to the
 *  `purchases` namespace so buy / restore reuse the exact same pipeline (and
 *  event emission) as `sw.purchases.purchase` / `.restore`. */
export interface CustomPaywallDeps {
  /** Routes through the active PurchaseController; emits transaction
   *  lifecycle. Returns the resolved outcome. */
  purchase: (
    product: Product,
  ) => Promise<
    { type: "purchased" } | { type: "declined" } | { type: "error"; error: Error }
  >;
  /** Routes through the active PurchaseController; emits restore lifecycle.
   *  Returns the outcome so the presenter can mirror Android: a successful
   *  restore dismisses regardless of whether it found active entitlements;
   *  a failure surfaces in the restore phase and keeps the paywall up. */
  restore: () => Promise<
    { type: "restored" } | { type: "failed"; error: Error }
  >;
}

export const createCustomPaywallPresenter = (
  renderer: CustomPaywallRenderer,
  deps: CustomPaywallDeps,
): PaywallPresenter => {
  // Single active presentation at a time (matches the iframe presenter's
  // invariant). `dismiss()` resolves it as declined.
  let activeFinish: ((r: PaywallResult) => void) | null = null;

  const present = (
    info: PaywallInfo,
    ctx: import("../presenter.ts").PresentationContext,
  ): Promise<PaywallResult> =>
    new Promise<PaywallResult>((resolve) => {
      const stateSig = createSignal<CustomPaywallState>({
        products: info.products,
        transaction: { phase: "idle" },
        restoration: { phase: "idle" },
        paywallInfo: info,
      });

      let settled = false;
      let teardown: void | (() => void);
      const finish = (result: PaywallResult) => {
        if (settled) return;
        settled = true;
        activeFinish = null;
        try {
          if (typeof teardown === "function") teardown();
        } catch {
          /* renderer teardown errors stay scoped */
        }
        resolve(result);
      };
      activeFinish = finish;

      const controller: CustomPaywallController = {
        buy: async (product) => {
          stateSig.update((s) => ({
            ...s,
            transaction: { phase: "purchasing", product },
          }));
          const r = await deps.purchase(product);
          if (r.type === "purchased") {
            stateSig.update((s) => ({ ...s, transaction: { phase: "idle" } }));
            finish({ type: "purchased", productId: product.id });
          } else if (r.type === "declined") {
            // Cancelled / pending — back to idle, paywall stays up.
            stateSig.update((s) => ({ ...s, transaction: { phase: "idle" } }));
          } else {
            // Failed — surface the error, paywall stays up so the UI can
            // show it.
            stateSig.update((s) => ({
              ...s,
              transaction: { phase: "failed", error: r.error, product },
            }));
          }
        },
        restore: async () => {
          stateSig.update((s) => ({
            ...s,
            restoration: { phase: "restoring" },
          }));
          let outcome: { type: "restored" } | { type: "failed"; error: Error };
          try {
            outcome = await deps.restore();
          } catch (cause) {
            outcome = {
              type: "failed",
              error: cause instanceof Error ? cause : new Error(String(cause)),
            };
          }
          if (outcome.type === "restored") {
            // Mirrors Android: a successful restore dismisses regardless of
            // whether it surfaced active entitlements.
            stateSig.update((s) => ({ ...s, restoration: { phase: "idle" } }));
            finish({ type: "restored" });
          } else {
            stateSig.update((s) => ({
              ...s,
              restoration: { phase: "failed", error: outcome.error },
            }));
          }
        },
        close: () => finish({ type: "declined" }),
      };

      // sw.dismiss / sw.dispose / timeout → resolve declined + teardown.
      ctx.signal.addEventListener(
        "abort",
        () => finish({ type: "declined" }),
        { once: true },
      );

      teardown = renderer({ state: asReadable(stateSig), controller });
    });

  const dismiss: PaywallPresenter["dismiss"] = () => {
    activeFinish?.({ type: "declined" });
  };

  return { present, dismiss };
};
