// Public PaywallPresenter contract. Core calls into a presenter to display a
// paywall; the default browser presenter renders an iframe overlay, but
// consumers can supply any implementation.

import type { PaywallInfo, PaywallResult, PlacementParams } from "./types.ts";
import type { SuperwallEventMap } from "./events.ts";

/** Forward an event from inside the presenter into the SDK's event bus. */
export type SuperwallEventEmit = <K extends keyof SuperwallEventMap>(
  name: K,
  detail: SuperwallEventMap[K],
) => void;

export interface PresentationContext {
  readonly placement: string;
  readonly params: PlacementParams;
  /** Aborts when the SDK gives up on the presentation (timeout, dismiss,
   *  dispose). Presenters should clean up and reject. */
  readonly signal: AbortSignal;
  /** Forward paywall events into the public bus. */
  readonly emit: SuperwallEventEmit;
  /** User attributes snapshot at present-time. Forwarded into the paywall's
   *  `template_variables.user`. */
  readonly user?: Record<string, unknown>;
  /** Device attributes snapshot at present-time. Forwarded into
   *  `template_variables.device`. */
  readonly device?: Record<string, unknown>;
  /** Internal: forward `stripe_checkout_*` and `post_checkout_complete`
   *  postMessages from the paywall iframe to the SDK's purchase pipeline.
   *  NOT a public consumer event — the SDK routes these into the active
   *  `PurchaseController`. */
  readonly onPurchaseEvent?: (event: PaywallPurchaseEvent) => void;
  /** Bootstrap params injected into the iframe URL so the paywall's SSR
   *  loader can mint the placement token + identify the host. Forwarded
   *  verbatim by the default browser presenter; custom presenters can
   *  ignore this. */
  readonly bootstrap?: PaywallBootstrap;
}

/** Identity + host context passed via iframe URL params to the paywall SSR
 *  loader. `clientSurface=web-sdk` is the switch the paywall server uses to
 *  route us to the new "post_checkout_complete via postMessage" branch
 *  instead of the legacy `window.location.href` redirect. */
export interface PaywallBootstrap {
  readonly apiKey: string;
  readonly appUserId?: string;
  readonly aliasId?: string;
  readonly email?: string;
  readonly deviceId?: string;
  readonly hostOrigin?: string;
  readonly sdkVersion: string;
  readonly clientSurface: "web-sdk";
}

/** Purchase lifecycle messages emitted by the paywall iframe's
 *  WebCheckoutController. Routed internally to the PurchaseController; not
 *  surfaced as public SDK events. */
export type PaywallPurchaseEvent =
  | { type: "start"; productId: string }
  | { type: "submit"; productId: string }
  | {
      type: "complete";
      productId: string;
      sessionId?: string;
      entitlements?: ReadonlyArray<{ id: string; productIds?: string[] }>;
    }
  | { type: "fail"; productId: string; error?: string }
  | { type: "abandon"; productId: string }
  /** Terminal "checkout + server-side post-checkout work is done" signal.
   *  Replaces `complete` as the resolution trigger when the paywall is on
   *  the `client_surface=web-sdk` branch. The presenter resolves the
   *  active purchase promise here; `complete` is kept as an in-flight
   *  signal but is NOT terminal. */
  | {
      type: "postCheckout";
      productId: string;
      checkoutContextId: string;
      transactionData?: {
        transactionId: string;
        productIdentifier: string;
        currency?: string;
        value?: number;
      };
      redirectUrl?: string;
    };

export interface PaywallPresenter {
  /** Show the paywall; resolves when the user dismisses it. Single-paywall
   *  invariant: never called while a previous call hasn't resolved. */
  present(
    info: PaywallInfo,
    ctx: PresentationContext,
  ): Promise<PaywallResult>;

  /** Force-dismiss the active paywall; the in-flight `present` should resolve. */
  dismiss(reason?: string): void;

  /** Optional: warm a paywall before it's needed. */
  preload?(info: PaywallInfo): Promise<void>;
}
