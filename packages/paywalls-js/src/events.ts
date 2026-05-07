// Public event surface — wire-bound + local-only event maps, the typed
// EventTarget, and the global delegate interface.

import type {
  ConfirmedAssignment,
  CustomerInfo,
  IntegrationAttribute,
  JsonValue,
  PaywallInfo,
  PaywallPresentationRequestStatusReason,
  PaywallPresentationRequestStatusType,
  PaywallResult,
  Product,
  RestoreType,
  StoreTransaction,
  SubscriptionStatus,
  TransactionProduct,
  TriggerResult,
  UserAttributes,
} from "./types.ts";

// Wire-bound events — POSTed to the collector.
export interface SuperwallEventMap {
  // lifecycle
  first_seen: {};
  app_open: {};
  app_close: {};
  app_launch: {};
  app_install: {};
  session_start: {};
  reset: {};
  config_refresh: {};
  config_fail: {};
  config_attributes: {};
  confirm_all_assignments: { assignments?: ConfirmedAssignment[] };
  device_attributes: { attributes: Record<string, JsonValue> };
  user_attributes: { attributes: Partial<UserAttributes> };
  integration_attributes: {
    audienceFilterParams: Partial<Record<IntegrationAttribute, string>>;
  };
  identity_alias: {};
  deepLink_open: { uri: string };

  // subscription / customer
  subscriptionStatus_didChange: {};
  customerInfo_didChange: { from: CustomerInfo; to: CustomerInfo };

  // placements
  trigger_fire: { placementName: string; result: TriggerResult };
  paywallPresentationRequest: {
    status: PaywallPresentationRequestStatusType;
    reason?: PaywallPresentationRequestStatusReason;
  };

  // paywall lifecycle
  paywall_open: { paywall_info: PaywallInfo };
  paywall_page_view: { paywallInfo: PaywallInfo };
  paywall_close: { paywall_info: PaywallInfo };
  paywall_decline: { paywall_info: PaywallInfo };
  paywallPreload_start: { paywallCount: number };
  paywallPreload_complete: { paywallCount: number };
  paywallResponseLoad_start: { triggeredPlacementName?: string };
  paywallResponseLoad_notFound: { triggeredPlacementName?: string };
  paywallResponseLoad_complete: {
    triggeredPlacementName?: string;
    paywall_info: PaywallInfo;
  };
  paywallResponseLoad_fail: { triggeredPlacementName?: string };
  paywallWebviewLoad_start: { paywall_info: PaywallInfo };
  paywallWebviewLoad_complete: { paywall_info: PaywallInfo };
  paywallWebviewLoad_fail: { paywall_info: PaywallInfo; errorMessage?: string };
  paywallWebviewLoad_timeout: { paywall_info: PaywallInfo };
  paywallProductsLoad_start: {
    triggeredPlacementName?: string;
    paywall_info: PaywallInfo;
  };
  paywallProductsLoad_complete: {
    triggeredPlacementName?: string;
    paywall_info: PaywallInfo;
  };
  paywallProductsLoad_fail: {
    errorMessage?: string;
    triggeredPlacementName?: string;
    paywall_info: PaywallInfo;
  };
  paywallResourceLoad_fail: { url: string; error: string };
  shimmerView_start: {};
  shimmerView_complete: { duration: number };

  // transactions
  transaction_start: { product: Product; paywall_info: PaywallInfo };
  transaction_complete: {
    transaction?: StoreTransaction;
    product: Product;
    paywall_info: PaywallInfo;
    product_identifier: string;
    /** Stripe transaction id (from the paywall's post_checkout_complete
     *  payload). Web-specific — the StoreKit-shaped `transaction` field
     *  doesn't carry it. Absent on test-mode paywalls and any flow that
     *  doesn't produce a Stripe Checkout Session. */
    transaction_id?: string;
    /** ISO 4217 currency code (e.g. "USD"). Web-specific revenue data. */
    currency?: string;
    /** Transaction value in `currency` units. Web-specific revenue data. */
    value?: number;
  };
  transaction_fail: { error: string; paywall_info: PaywallInfo };
  transaction_abandon: { product: Product; paywall_info: PaywallInfo };
  transaction_timeout: { paywall_info: PaywallInfo };
  transaction_restore: { restoreType: RestoreType; paywall_info: PaywallInfo };
  restore_start: {};
  restore_complete: {};
  restore_fail: { reason: string };
  /** First-time non-trial activation. Emitted alongside `transaction_complete`
   *  for recurring subscriptions without a free-trial offer (free trials
   *  emit `freeTrial_start` instead). */
  subscription_start: { product: Product; paywall_info: PaywallInfo };
  freeTrial_start: {
    product: Product;
    paywall_info: PaywallInfo;
    trial_end_date: string;
  };
  nonRecurringProduct_purchase: {
    product: TransactionProduct;
    paywall_info: PaywallInfo;
  };

  // enrichment
  enrichment_start: {};
  enrichment_complete: {
    userEnrichment: Record<string, JsonValue | null>;
    deviceEnrichment: Record<string, JsonValue | null>;
  };
  enrichment_fail: {};

  // custom
  custom_placement: {
    placementName: string;
    paywall_info: PaywallInfo;
    params: Record<string, JsonValue>;
  };

  // misc
  review_requested: { count: number };
  permission_requested: { permissionName: string; paywallIdentifier: string };
  permission_granted: { permissionName: string; paywallIdentifier: string };
  permission_denied: { permissionName: string; paywallIdentifier: string };
}

// Local-only events — never POSTed to the collector.
export interface LocalSuperwallEventMap {
  /** Paywall asked to navigate to an in-app URL. Bridged to
   *  `SuperwallDelegate.onPaywallWillOpenURL`. */
  paywallWillOpenURL: {
    url: string;
    /** Paywall meant the URL to open in a payment sheet rather than a
     *  generic in-app browser. */
    browserType?: "payment_sheet";
  };
  /** Paywall asked to follow a deep link. Bridged to
   *  `SuperwallDelegate.onPaywallWillOpenDeepLink`. */
  paywallWillOpenDeepLink: { url: string };
}

export type AllSuperwallEvents = SuperwallEventMap & LocalSuperwallEventMap;

export type SuperwallCustomEvent<K extends keyof AllSuperwallEvents> =
  CustomEvent<AllSuperwallEvents[K]>;

/**
 * `EventTarget` subclass with typed `addEventListener` / `removeEventListener`
 * over the union of wire-bound and local-only events. Listener cleanup uses
 * the standard `AbortSignal` option.
 */
export class SuperwallEventTarget extends EventTarget {
  override addEventListener<K extends keyof AllSuperwallEvents>(
    type: K,
    listener: (event: SuperwallCustomEvent<K>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  override addEventListener(
    type: string,
    callback:
      | EventListenerOrEventListenerObject
      | ((event: SuperwallCustomEvent<keyof AllSuperwallEvents>) => void)
      | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (callback === null) return;
    // happy-dom (and older runtimes) silently ignore `{ signal }`, so we
    // wire abort-driven removal manually for cross-runtime parity.
    const handler = callback as EventListener;
    if (typeof options === "object" && options !== null && options.signal) {
      const signal = options.signal;
      if (signal.aborted) return;
      const stripped: AddEventListenerOptions = {
        ...(options.capture !== undefined && { capture: options.capture }),
        ...(options.once !== undefined && { once: options.once }),
        ...(options.passive !== undefined && { passive: options.passive }),
      };
      super.addEventListener(type, handler, stripped);
      const onAbort = () => super.removeEventListener(type, handler, stripped);
      signal.addEventListener("abort", onAbort, { once: true });
      return;
    }
    super.addEventListener(type, handler, options);
  }

  override removeEventListener<K extends keyof AllSuperwallEvents>(
    type: K,
    listener: (event: SuperwallCustomEvent<K>) => void,
    options?: EventListenerOptions | boolean,
  ): void;
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void;
  override removeEventListener(
    type: string,
    callback:
      | EventListenerOrEventListenerObject
      | ((event: SuperwallCustomEvent<keyof AllSuperwallEvents>) => void)
      | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback as EventListener | null, options);
  }
}

// Global delegate — sibling to per-listener and per-placement callbacks.
export interface SuperwallDelegate {
  // subscription / customer
  onSubscriptionStatusChange?(
    from: SubscriptionStatus,
    to: SubscriptionStatus,
  ): void;
  onCustomerInfoChange?(from: CustomerInfo, to: CustomerInfo): void;
  onUserAttributesChange?(newAttributes: Partial<UserAttributes>): void;

  // paywall lifecycle (typed convenience around the wire events)
  onPaywallWillPresent?(info: PaywallInfo): void;
  onPaywallDidPresent?(info: PaywallInfo): void;
  onPaywallWillDismiss?(info: PaywallInfo): void;
  onPaywallDidDismiss?(info: PaywallInfo): void;
  onPaywallWillOpenURL?(url: string): void;
  /** Consumer is responsible for routing the URL into the host app
   *  (e.g. `next/navigation` push, React Router navigate). */
  onPaywallWillOpenDeepLink?(url: string): void;

  // legacy `custom` postMessage
  onCustomPaywallAction?(name: string): void;

  // logging
  onLog?(
    level: "debug" | "info" | "warn" | "error" | "none",
    scope: string,
    message: string | null,
    info: Record<string, JsonValue> | null,
    error: string | null,
  ): void;

  /** Catch-all that receives every dispatched event in EventTarget order.
   *  Useful for analytics / logging forwarders. */
  onEvent?<K extends keyof SuperwallEventMap>(
    name: K,
    detail: SuperwallEventMap[K],
  ): void;
}

/** Event names the wire emitter MUST NOT POST to the collector. */
export const LOCAL_ONLY: ReadonlySet<string> = new Set<keyof LocalSuperwallEventMap>([
  "paywallWillOpenURL",
  "paywallWillOpenDeepLink",
]);
