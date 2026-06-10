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
 *  Replaces the controller's `window.location.href = redirectUrl` step (which
 *  would otherwise trap navigation inside the SDK's iframe).
 *
 *  - `transactionData` is enrichment; it can be absent on success (e.g. one-
 *    time prices). The SDK resolves the in-flight purchase promise from the
 *    product passed to `purchase()`, not from this field.
 *  - `redirectUrl` is only present when the merchant configured a post-purchase
 *    URL in dashboard. Internal Superwall paths (/redeem, /manage, /app-link)
 *    are filtered server-side and never appear here.
 */
export interface PostCheckoutCompleteMessage {
  event_name: "post_checkout_complete";
  checkout_context_id: string;
  product_identifier: string;
  transactionData?: {
    transactionId: string;
    productIdentifier: string;
    currency?: string;
    value?: number;
  };
  redirectUrl?: string;
  /** Short-lived Superwall-signed entitlements JWT for offline server-side
   *  verification (`@superwall/verify`). Best-effort — absent when signing is
   *  unavailable. The steady-state `/entitlements` read also carries it, so a
   *  page that didn't just purchase can still obtain a fresh one. */
  entitlements_token?: string;
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
