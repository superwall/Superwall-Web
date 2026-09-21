// Wire types for postMessages exchanged with the Superwall paywall iframe.
//
// Mirrors the schemas in `@superwall/schema-next/paywall-js/messages/{incoming,outgoing}`.
// We don't depend on that package — types are duplicated here. Keep field
// names verbatim with the wire (snake_case for `event_name`, the rest mixed
// per the existing protocol). When the paywall team revs a message, update
// the matching interface here.

/** Outgoing = paywall iframe → host (this SDK). */

export type PaywallOutgoingMessage =
  | PingMessage
  | TemplateParamsRequestMessage
  | CloseMessage
  | RestoreMessage
  | RestoreFailedMessage
  | PurchaseMessage
  | StripeCheckoutStartMessage
  | StripeCheckoutSubmitMessage
  | StripeCheckoutCompleteMessage
  | StripeCheckoutFailMessage
  | StripeCheckoutAbandonMessage
  | PostCheckoutCompleteMessage
  | DiscountRedemptionResultMessage
  | OpenUrlMessage
  | OpenUrlExternalMessage
  | OpenDeepLinkMessage
  | CustomPlacementMessage;

export interface PingMessage {
  event_name: "ping";
}

export interface TemplateParamsRequestMessage {
  event_name: "template_params_and_user_attributes";
}

export interface CloseMessage {
  event_name: "close";
}

export interface RestoreMessage {
  event_name: "restore";
}

export interface RestoreFailedMessage {
  event_name: "restore_failed";
  reason?: string;
}

export interface PurchaseMessage {
  event_name: "purchase";
  product_identifier?: string;
  product?: string;
  should_dismiss?: boolean;
}

export interface StripeCheckoutStartMessage {
  event_name: "stripe_checkout_start";
  product_identifier?: string;
  product?: string;
}

export interface StripeCheckoutSubmitMessage {
  event_name: "stripe_checkout_submit";
  product_identifier?: string;
  product?: string;
}

export interface StripeCheckoutCompleteMessage {
  event_name: "stripe_checkout_complete";
  product_identifier?: string;
  product?: string;
  session_id?: string;
  checkout_session_id?: string;
  entitlements?: ReadonlyArray<{ id: string; productIds?: string[] }>;
}

export interface StripeCheckoutFailMessage {
  event_name: "stripe_checkout_fail";
  product_identifier?: string;
  product?: string;
  error?: string;
  message?: string;
}

export interface StripeCheckoutAbandonMessage {
  event_name: "stripe_checkout_abandon";
  product_identifier?: string;
  product?: string;
}

/** Terminal "checkout completed AND post-checkout server work is done" message
 *  emitted by the paywall's WebPaywallController when `client_surface=web-sdk`.
 *  The one message that ends a checkout: the paywall posts it and then does
 *  nothing else — no `close`, no navigation. The SDK owns tearing down the
 *  overlay and everything after (see `internal/postCheckout.ts`); it never
 *  navigates to `redirect_url`, only surfaces it. The paywall
 *  has already called the complete-webapp endpoint itself before posting.
 *
 *  - `claimed` is the switch: `true` = the server already bound the
 *    subscription to this device + app user id; `false` = it minted codes but
 *    could not claim.
 *  - `transaction_data` is enrichment; it can be absent on success (e.g. one-
 *    time prices). The SDK resolves the in-flight purchase promise from the
 *    product passed to `purchase()`, not from this field.
 *  - `redirect_url` is the purchase button's redirect, else the app-level
 *    redirect, else the redemption page when the button asked for it. It
 *    carries `redemption_code=` and the checkout context as query params.
 */
export interface PostCheckoutCompleteMessage {
  event_name: "post_checkout_complete";
  checkout_context_id: string;
  product_identifier: string;
  status: "completed";
  claimed: boolean;
  transaction_data?: {
    transaction_id: string;
    product_identifier: string;
    currency?: string;
    value?: number;
  };
  /** Prefixed (`redemption_…`) codes, fresh and unclaimed. */
  redemption_codes?: string[];
  redirect_url?: string;
  /** Deep links for the buy-on-web, redeem-in-app case. */
  deep_links?: { ios?: string; android?: string };
  /** Short-lived Superwall-signed entitlements JWT for offline server-side
   *  verification (`@superwall/verify`). Best-effort — absent when signing is
   *  unavailable. The steady-state `/entitlements` read also carries it, so a
   *  page that didn't just purchase can still obtain a fresh one. */
  entitlements_token?: string;
}

/** Result of a `redeem_discount` command, posted by the paywall's discount
 *  controller after it validates the code against the checkout backend and
 *  re-prices its Stripe products. Also fires for in-paywall "Redeem Discount"
 *  button redemptions the SDK didn't initiate — treat those as informational.
 *  `reason` is present only when `valid` is false; `appliedProductCount` only
 *  when `valid` is true. The clear path (empty `redeem_discount` code) sends NO
 *  result. */
export interface DiscountRedemptionResultMessage {
  event_name: "discount_redemption_result";
  code: string;
  valid: boolean;
  /** One of: code_not_found | code_invalid | no_valid_products |
   *  no_applicable_products | error. */
  reason?: string;
  appliedProductCount?: number;
}

export interface OpenUrlMessage {
  event_name: "open_url";
  url: string;
  browser_type?: "payment_sheet" | string;
}

export interface OpenUrlExternalMessage {
  event_name: "open_url_external";
  url: string;
}

export interface OpenDeepLinkMessage {
  event_name: "open_deep_link";
  link: string;
}

export interface CustomPlacementMessage {
  event_name: "custom_placement";
  name: string;
  params?: Record<string, unknown>;
}

/** Incoming = host (this SDK) → paywall iframe. Wrapped in a v1 envelope and
 *  base64url-encoded into `paywall.accept64`. See API.md §7.2. */

/** Apply/clear a Stripe promotion code on the presented paywall. Carried as an
 *  event inside a `paywall.accept64` array (same channel as `template_variables`).
 *  The paywall trims the code, validates it against the checkout backend, and
 *  re-prices its Stripe products, then replies with a
 *  `discount_redemption_result`. An empty/whitespace-only `code` clears a
 *  previously applied discount (restores prices, re-enables Apple Pay) and is
 *  NOT acknowledged with a result. */
export interface RedeemDiscountMessage {
  event_name: "redeem_discount";
  code: string;
}

export interface V1Envelope<T = unknown> {
  version: 1;
  payload: T;
}

export interface PaywallEventEnvelope {
  version: 1;
  payload: { events: ReadonlyArray<PaywallOutgoingMessage> };
}

export interface Accept64Envelope {
  version: 1;
  channel: "paywall.accept64";
  payload: string;
}
