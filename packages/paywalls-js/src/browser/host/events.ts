// The lifecycle events a hosted paywall reports, exactly as the web paywall
// app's controller reports them for paywall.js (`WebPaywallControllerEvents`
// in web-paywalls): same batches, parameters, headers and endpoint — the
// collector block of the `#init` payload.

import type { Collector } from "./collector.ts";
import { storePrefixedOf, withoutStorePrefix, type HostedProduct, type ProductVariables } from "./products.ts";
import { recordOf, type Slice } from "./values.ts";

export type CollectorEvent = { event_id?: string; event_name: string; parameters: Slice };

export interface HostEventsContext {
  readonly collector: Collector;
  readonly products: readonly HostedProduct[];
  readonly clientSurface: string;
  readonly hostOrigin?: string;
  readonly sdkVersion?: string;
  readonly managedPayments: boolean;
  readonly paywallManagedPaymentsOverride: string | null;
}

export type PageView = {
  [key: string]: unknown;
  type?: unknown;
  page_node_id?: unknown;
  flow_position?: unknown;
  page_name?: unknown;
  navigation_node_id?: unknown;
  previous_page_node_id?: unknown;
  previous_flow_position?: unknown;
  time_on_previous_page_ms?: unknown;
};

export type StripeCheckoutState = "prefetch" | "start" | "submit" | "fail" | "abandon" | "complete";

export interface HostEvents {
  /** `ping`: the placement, `trigger_fire`, `paywall_open`, user and device
   *  attributes, as one batch. */
  trackOpen(): void;
  trackClose(): void;
  trackUserAttributes(attributes: Slice): void;
  trackPageView(pageView: PageView): void;
  trackStripeCheckout(
    state: StripeCheckoutState,
    productIdentifier: string,
    checkoutContextId?: string,
  ): void;
  /** Only for a prefetched session: the server reports its own checkouts'. */
  trackTransactionStart(productIdentifier: string): void;
  trackTransactionAbandon(productIdentifier: string): void;
  /** Resolved product variables enrich the transaction events. */
  applyVariables(variables: ProductVariables): void;
}

/** What `extractDeviceProperties` reads when the paywall opens. */
export const deviceProperties = (now: Date = new Date()) => {
  const localDate = now.toISOString().slice(0, 10);
  const localTime = now.toTimeString().slice(0, 8);
  let radioType = "unknown";
  try {
    radioType =
      (globalThis.navigator as (Navigator & { connection?: { type?: string } }) | undefined)
        ?.connection?.type || "unknown";
  } catch {
    /* some browsers throw on `connection` */
  }
  return {
    interfaceStyle:
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    isLowPowerModeEnabled: false,
    radioType,
    localDate,
    localTime,
    localDateTime: `${localDate}T${localTime}`,
  };
};

export const createHostEvents = (context: HostEventsContext): HostEvents => {
  const { collector } = context;
  const presentationId = crypto.randomUUID();
  const { "x-alias-id": _aliasId, ...baseHeaders } = collector.headers;
  const { userId } = collector.identity;
  let headers: Record<string, string> = {
    ...baseHeaders,
    "x-app-user-id": userId.type === "appUserId" ? userId.appUserId : userId.aliasId,
    ...(userId.type === "appUserId" ? { "x-alias-id": userId.appUserId } : {}),
  };

  const publish = async (events: CollectorEvent[]): Promise<void> => {
    if ((globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__) return;
    try {
      await fetch(collector.url, {
        method: "POST",
        keepalive: true,
        credentials: "omit",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          events: events.map((event) => ({
            ...event,
            event_id: event.event_id ?? crypto.randomUUID(),
            created_at: new Date().toISOString(),
            parameters: {
              ...event.parameters,
              $presentation_id: presentationId,
              $client_surface: context.clientSurface,
              ...(context.hostOrigin ? { $host_origin: context.hostOrigin } : {}),
              ...(context.sdkVersion ? { $sdk_version: context.sdkVersion } : {}),
            },
          })),
        }),
      });
    } catch {
      /* analytics never fails the paywall */
    }
  };

  const lifecycleSlices = (): Slice => ({
    ...collector.experimentSlice,
    ...collector.paywallSlice,
    ...collector.presentmentSlice,
  });

  const transactionParameters = (
    productIdentifier: string,
    options?: { storePrefixed?: string; checkoutContextFields?: boolean },
  ): Slice => {
    const eventIdentifier = options?.storePrefixed ?? productIdentifier;
    const installDate = collector.deviceAttributes.$appInstallDate;
    return {
      ...collector.paywallSlice,
      ...collector.presentmentSlice,
      ...(options?.checkoutContextFields ? collector.placementParamsSlice : {}),
      ...collector.experimentSlice,
      ...collector.productSlice[productIdentifier],
      $store: "STRIPE",
      $install_date: typeof installDate === "string" ? installDate : new Date().toISOString(),
      $product_id: eventIdentifier,
      $product_identifier: eventIdentifier,
      ...(options?.checkoutContextFields
        ? {
            $country_code: null,
            $transaction_date: new Date().toISOString(),
            $managed_payments: context.managedPayments,
            $paywall_managed_payments_override: context.paywallManagedPaymentsOverride,
          }
        : {}),
    };
  };

  return {
    trackOpen: () => {
      const device = deviceProperties();
      headers = {
        ...headers,
        "x-device-interface-style": device.interfaceStyle,
        "x-radio-type": device.radioType,
        "x-low-power-mode": String(device.isLowPowerModeEnabled),
      };
      Object.assign(collector.deviceAttributes, {
        $interfaceStyle: device.interfaceStyle,
        $isLowPowerModeEnabled: device.isLowPowerModeEnabled,
        $radioType: device.radioType,
        $localDate: device.localDate,
        $localTime: device.localTime,
        $localDateTime: device.localDateTime,
      });
      const placement = collector.presentmentSlice.$presented_by_event_name;
      void publish([
        {
          event_id: collector.placementEventId,
          event_name: String(placement ?? ""),
          parameters: { ...recordOf(collector.placementParamsSlice.$placement_params) },
        },
        {
          event_name: "trigger_fire",
          parameters: {
            ...collector.experimentSlice,
            $result: "present",
            $is_standard_event: true,
            $paywall_identifier: collector.paywallSlice.$paywall_identifier,
            $trigger_name: placement,
          },
        },
        {
          event_name: "paywall_open",
          parameters: {
            ...collector.experimentSlice,
            ...collector.presentmentSlice,
            ...collector.paywallSlice,
          },
        },
        { event_name: "user_attributes", parameters: { ...collector.userAttributes } },
        { event_name: "device_attributes", parameters: { ...collector.deviceAttributes } },
      ]);
    },

    trackClose: () => {
      void publish([{ event_name: "paywall_close", parameters: lifecycleSlices() }]);
    },

    trackUserAttributes: (attributes) => {
      Object.assign(collector.userAttributes, attributes);
      void publish([{ event_name: "user_attributes", parameters: { ...collector.userAttributes } }]);
    },

    trackPageView: (pageView) => {
      void publish([
        {
          event_name: "paywall_page_view",
          parameters: {
            ...lifecycleSlices(),
            $page_node_id: pageView.page_node_id,
            $flow_position: pageView.flow_position,
            $page_name: pageView.page_name,
            $navigation_node_id: pageView.navigation_node_id,
            $navigation_type: pageView.type,
            ...(pageView.previous_page_node_id == null
              ? {}
              : { $previous_page_node_id: pageView.previous_page_node_id }),
            ...(pageView.previous_flow_position == null
              ? {}
              : { $previous_flow_position: pageView.previous_flow_position }),
            ...(pageView.time_on_previous_page_ms == null
              ? {}
              : { $time_on_previous_page_ms: pageView.time_on_previous_page_ms }),
          },
        },
      ]);
    },

    trackStripeCheckout: (state, productIdentifier, checkoutContextId) => {
      void publish([
        {
          event_name: `stripeCheckout_${state}`,
          parameters: {
            ...lifecycleSlices(),
            $store: "STRIPE",
            $product_identifier: productIdentifier,
            ...(checkoutContextId === undefined ? {} : { $checkout_context_id: checkoutContextId }),
          },
        },
      ]);
    },

    trackTransactionStart: (productIdentifier) => {
      const storePrefixed = storePrefixedOf(context.products, productIdentifier);
      void publish([
        {
          event_name: "transaction_start",
          parameters: transactionParameters(withoutStorePrefix(storePrefixed), {
            storePrefixed,
            checkoutContextFields: true,
          }),
        },
      ]);
    },

    trackTransactionAbandon: (productIdentifier) => {
      void publish([
        { event_name: "transaction_abandon", parameters: transactionParameters(productIdentifier) },
      ]);
    },

    applyVariables: (variables) => {
      for (const [storeIdentifier, productVariables] of Object.entries(variables)) {
        collector.productSlice[storeIdentifier] = productVariables;
        collector.productSlice[withoutStorePrefix(storeIdentifier)] = productVariables;
      }
    },
  };
};
