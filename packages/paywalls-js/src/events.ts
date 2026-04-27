// Public event surface. Matches API.md §8.1 (wire-bound) + §8.2 (local-only).
// Wire `event_name` strings are taken verbatim from Android's
// `SuperwallEvent.kt` `rawName` properties — see API.md §11.4.

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

// ---------------------------------------------------------------------------
// 8.1 — Wire-bound event map
// ---------------------------------------------------------------------------

/** Strings copied from Android `SuperwallEvent.kt` `rawName`. Each entry's
 *  payload key set matches what Android emits. */
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
  };
  transaction_fail: { error: string; paywall_info: PaywallInfo };
  transaction_abandon: { product: Product; paywall_info: PaywallInfo };
  transaction_timeout: { paywall_info: PaywallInfo };
  transaction_restore: { restoreType: RestoreType; paywall_info: PaywallInfo };
  restore_start: {};
  restore_complete: {};
  restore_fail: { reason: string };
  /** First-time non-trial activation. Emitted alongside `transaction_complete`
   *  when the purchased product is a recurring subscription with no
   *  free-trial offer. (Free trials emit `freeTrial_start` instead.) */
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

// ---------------------------------------------------------------------------
// 8.2 — Local-only event map (never POSTed to collector)
// ---------------------------------------------------------------------------

export interface LocalSuperwallEventMap {
  /** Fires once after SSR hydration completes. See API.md §7.4. */
  identityHydrated: {
    source: "client" | "cookie" | "generated";
    aliasChanged: boolean;
    userChanged: boolean;
  };
}

export type AllSuperwallEvents = SuperwallEventMap & LocalSuperwallEventMap;

export type SuperwallCustomEvent<K extends keyof AllSuperwallEvents> =
  CustomEvent<AllSuperwallEvents[K]>;

// ---------------------------------------------------------------------------
// Typed EventTarget
// ---------------------------------------------------------------------------

/**
 * `EventTarget` subclass with typed `addEventListener` / `removeEventListener`
 * over the union of wire-bound and local-only events. Per spec §2.5.
 *
 * Listener cleanup uses the standard `AbortSignal` option:
 *
 *   const ac = new AbortController();
 *   sw.events.addEventListener("paywall_open", fn, { signal: ac.signal });
 *   ac.abort();
 */
export class SuperwallEventTarget extends EventTarget {
  // Typed overload — preferred call shape (`type` constrained to known events).
  override addEventListener<K extends keyof AllSuperwallEvents>(
    type: K,
    listener: (event: SuperwallCustomEvent<K>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  // Catch-all overload that mirrors `EventTarget.addEventListener` so the
  // override is variance-compatible with the parent.
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
    // Defensive AbortSignal handling — modern browsers + Bun honor
    // `{ signal }` natively, but happy-dom (and older runtimes) silently
    // ignore it. We strip the signal from the options we pass to the
    // underlying EventTarget and wire removal manually so the contract
    // holds everywhere.
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

// ---------------------------------------------------------------------------
// 2.6 — Global delegate (sibling to per-listener and per-placement callbacks)
// ---------------------------------------------------------------------------

export interface SuperwallDelegate {
  // subscription / customer
  onSubscriptionStatusChange?(
    from: SubscriptionStatus,
    to: SubscriptionStatus,
  ): void;
  onCustomerInfoChange?(from: CustomerInfo, to: CustomerInfo): void;
  onUserAttributesChange?(newAttributes: Partial<UserAttributes>): void;

  // paywall lifecycle (typed convenience around the corresponding wire events)
  onPaywallWillPresent?(info: PaywallInfo): void;
  onPaywallDidPresent?(info: PaywallInfo): void;
  onPaywallWillDismiss?(info: PaywallInfo): void;
  onPaywallDidDismiss?(info: PaywallInfo): void;
  onPaywallWillOpenURL?(url: string): void;

  // custom paywall actions (legacy `custom` postMessage)
  onCustomPaywallAction?(name: string): void;

  // logging
  onLog?(
    level: "debug" | "info" | "warn" | "error" | "none",
    scope: string,
    message: string | null,
    info: Record<string, JsonValue> | null,
    error: string | null,
  ): void;

  /** Catch-all for transient lifecycle hooks the typed methods above don't
   *  cover. Receives every dispatched event in the same order as the
   *  EventTarget. Useful for analytics / logging forwarders. */
  onEvent?<K extends keyof SuperwallEventMap>(
    name: K,
    detail: SuperwallEventMap[K],
  ): void;
}

// ---------------------------------------------------------------------------
// LOCAL_ONLY filter — wire emitter consults this to skip local-only events
// ---------------------------------------------------------------------------

/** Set of event names that MUST NOT be POSTed to the collector. Derived from
 *  `LocalSuperwallEventMap` keys; runtime check is a string-set lookup. */
export const LOCAL_ONLY: ReadonlySet<string> = new Set<keyof LocalSuperwallEventMap>([
  "identityHydrated",
]);
