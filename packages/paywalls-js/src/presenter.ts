// Public PaywallPresenter contract. Core calls into a presenter to display a
// paywall; the default browser presenter renders an iframe overlay, but
// consumers can supply any implementation.

import type {
  PaywallInfo,
  PaywallResult,
  PlacementParams,
  Product,
} from "./types.ts";
import type { SuperwallEventMap } from "./events.ts";
import type { Readable } from "./signal.ts";

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
  /** Pre-built payload for the iframe's `#init=<base64>` hash. SDK builds
   *  it in `register()` (where decision + identity + user/device attrs +
   *  placement context are all known); presenter is responsible only for
   *  base64-encoding and appending. When absent, presenter falls back to
   *  building a minimal shape from `bootstrap` (legacy path / tests). */
  readonly initPayload?: Record<string, unknown>;
  /** Whether the SDK is in test mode for this presentation (derived from
   *  `options.testModeBehavior`). The browser presenter uses it to set
   *  `debug=true` on the iframe URL and to intercept purchase clicks with
   *  the test-purchase shim instead of real checkout. */
  readonly testMode?: boolean;
}

// ---------------------------------------------------------------------------
// Custom (developer-rendered) paywall contract
// ---------------------------------------------------------------------------
//
// `register({ paywall })` hands the SDK a renderer instead of using the
// default iframe presenter. The SDK still runs the full trigger pipeline
// (rules / holdout / assignment / gating / analytics) and fires identical
// lifecycle events; the developer only supplies UI + drives a controller.
// The renderer is environment-agnostic — it receives plain data + callbacks,
// so it works from vanilla JS, a framework wrapper (see
// `@superwall/paywalls-react`'s `SuperwallCustomPaywall`), or even a
// server-side log. Mirrors the Android `SuperwallCustomPaywall` composable.

/** Transaction phase surfaced to a custom paywall renderer. */
export type CustomPaywallTransactionPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "purchasing"; readonly product: Product }
  | { readonly phase: "failed"; readonly error: Error; readonly product?: Product };

/** Restoration phase surfaced to a custom paywall renderer. */
export type CustomPaywallRestorationPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "restoring" }
  | { readonly phase: "failed"; readonly error: Error };

/** Reactive state a custom paywall renderer reads. */
export interface CustomPaywallState {
  /** Resolved products for this paywall, from config. */
  readonly products: ReadonlyArray<Product>;
  readonly transaction: CustomPaywallTransactionPhase;
  readonly restoration: CustomPaywallRestorationPhase;
  readonly paywallInfo: PaywallInfo;
}

/** Imperative handle a custom paywall renderer drives. All three converge on
 *  the SDK's single guarded dismiss, so lifecycle events fire exactly once. */
export interface CustomPaywallController {
  /** Start a purchase with full Superwall attribution. Routes through the
   *  active `PurchaseController`. On web there is no native billing, so the
   *  controller must actually initiate checkout (the default iframe flow, or
   *  a consumer-supplied `PurchaseController`); with the default automatic
   *  controller and no iframe, `buy` resolves only once a checkout completes
   *  elsewhere. */
  buy(product: Product): Promise<void>;
  /** Start a restore. Routes through the active `PurchaseController`. */
  restore(): Promise<void>;
  /** Dismiss the paywall. Resolves the in-flight `register()` with the last
   *  result, or `declined` if the user never purchased. */
  close(reason?: string): void;
}

/** What the SDK hands a custom paywall renderer when it decides to present.
 *  `state` is a `Readable` so framework wrappers can subscribe + re-render. */
export interface CustomPaywallMount {
  readonly state: Readable<CustomPaywallState>;
  readonly controller: CustomPaywallController;
}

/** Developer-supplied renderer. Invoked once when the SDK presents; may
 *  return a teardown callback run on dismiss (unmount DOM / React root). */
export type CustomPaywallRenderer = (
  mount: CustomPaywallMount,
) => void | (() => void);

/** Identity + host context passed via iframe URL params to the paywall SSR
 *  loader. `clientSurface=web-sdk` is the switch the paywall server uses to
 *  route us to the new "post_checkout_complete via postMessage" branch
 *  instead of the legacy `window.location.href` redirect. */
export interface PaywallBootstrap {
  readonly apiKey: string;
  /** Defaults to `aliasId` when the user is anonymous so the BE always has a
   *  stable identifier. */
  readonly appUserId?: string;
  readonly aliasId?: string;
  readonly email?: string;
  /** Raw vendor UUID. The BE's `deviceId` field expects the unhashed value. */
  readonly deviceId?: string;
  readonly hostOrigin?: string;
  /** Where the user goes if they bail. Defaults to `window.location.href`.
   *  Validated server-side against the per-app `allowedOrigins` artifact. */
  readonly cancelUrl?: string;
  /** Full origin (scheme + host) of the Superwall API. Threaded into the
   *  iframe's `#init=` hash so the in-iframe controller knows where to POST
   *  `/api/checkout/initiate`. Tracks `networkEnvironment`. */
  readonly apiBase: string;
  /** Full origin of the events collector. Threaded into the same hash. */
  readonly collector: string;
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
      /** Signed entitlements JWT for offline server-side verification
       *  (`@superwall/verify`). Best-effort — absent when the BE didn't sign. */
      entitlementsToken?: string;
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

// Re-export for consumers building custom survey UIs.
export type {
  SurveyAnswer,
  SurveyPresenter,
  SurveyPresenterOutcome,
} from "./internal/survey.ts";
