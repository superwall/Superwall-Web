// `PaywallHost` — the SDK standing in for the web paywall app's controller.
//
// A paywall.js paywall boots inside a web paywall app page whose
// `WebPaywallController` is its host: it feeds the paywall its templates
// (with product variables resolved from `/api/products/variables`), reports
// the lifecycle to the collector and turns a finished Stripe checkout into
// `post_checkout_complete`. The SDK stays out of all three
// (`tracksLifecycleEvents`).
//
// A framework paywall has no such page. Its iframe is the framework's own
// build, talking straight to the SDK, as it talks to the native SDKs. Its
// `ping` says `host_controlled: true`, and the presenter then creates one of
// these for the presentation: the SDK does the controller's three jobs
// itself, with the controller's payloads, so both kinds of paywall land
// identically.
//
// Mirrors `web-paywalls/src/controller` (`WebPaywallControllerEvents`,
// `maybeResolveProductVariables`, the `stripe_checkout_complete` branch).

import type { JsonValue } from "../types.ts";

type Slice = Record<string, unknown>;

type UserId =
  | { type: "appUserId"; appUserId: string }
  | { type: "aliasId"; aliasId: string };

type Collector = {
  url: string;
  headers: Record<string, string>;
  placementEventId: string;
  identity: { userId: UserId };
  userAttributes: Slice;
  deviceAttributes: Slice;
  experimentSlice: Slice;
  paywallSlice: Slice;
  productSlice: Record<string, Slice>;
  presentmentSlice: Slice;
  placementParamsSlice: Slice;
};

type HostedProduct = { reference: string; storeIdentifier: string };

export type HostMessage = { event_name?: string; [key: string]: unknown };

export interface PaywallHostInput {
  /** The `#init` payload the SDK built for this presentation. */
  readonly initPayload: Record<string, unknown>;
  /** The public key; authorizes the paywall web API calls. */
  readonly apiKey: string;
  readonly sdkVersion?: string;
  /** `template_variables.user` / `.device` / `.params` the presenter sends. */
  readonly user?: Record<string, unknown>;
  readonly device?: Record<string, unknown>;
  readonly params?: Record<string, unknown>;
  /** Pushes messages into the paywall (the accept64 channel). */
  readonly send: (messages: ReadonlyArray<Record<string, unknown>>) => void;
}

export interface PaywallHost {
  /** The paywall asked for its templates: send identity, experiment and
   *  priced products, and report the open. */
  open(): void;
  /** Report what a lifecycle message from the paywall means. */
  observe(message: HostMessage): void;
  /** Resolve a finished checkout into the `post_checkout_complete` message
   *  the controller would post (or `stripe_checkout_fail` on failure). */
  completeCheckout(message: HostMessage): Promise<HostMessage>;
}

const isRecord = (value: unknown): value is Slice =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordOf = (value: unknown): Slice => (isRecord(value) ? value : {});

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const userIdOf = (value: unknown): UserId | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "appUserId" && typeof value.appUserId === "string") {
    return { type: "appUserId", appUserId: value.appUserId };
  }
  if (value.type === "aliasId" && typeof value.aliasId === "string") {
    return { type: "aliasId", aliasId: value.aliasId };
  }
  return undefined;
};

const collectorOf = (value: unknown): Collector | undefined => {
  if (!isRecord(value)) return undefined;
  const url = stringOf(value.url);
  const userId = userIdOf(recordOf(value.identity).userId);
  if (!url || !userId) return undefined;
  const headers = Object.fromEntries(
    Object.entries(recordOf(value.headers)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    url,
    headers,
    placementEventId: stringOf(value.placementEventId) ?? crypto.randomUUID(),
    identity: { userId },
    userAttributes: { ...recordOf(value.userAttributes) },
    deviceAttributes: { ...recordOf(value.deviceAttributes) },
    experimentSlice: recordOf(value.experimentSlice),
    paywallSlice: recordOf(value.paywallSlice),
    productSlice: { ...recordOf(value.productSlice) } as Record<string, Slice>,
    presentmentSlice: recordOf(value.presentmentSlice),
    placementParamsSlice: recordOf(value.placementParamsSlice),
  };
};

/** The paywall's products as the price lookup names them:
 *  `stripe|test:price_…:no-trial` from the config's `products_v2`. */
export const hostedProductsOf = (products: unknown): HostedProduct[] => {
  if (!Array.isArray(products)) return [];
  return products.flatMap((product) => {
    if (!isRecord(product)) return [];
    const reference = stringOf(product.reference_name) ?? stringOf(product.referenceName);
    const prefixed = stringOf(product.storePrefixedSuperwallCompositeProductIdentifier);
    const composite = stringOf(product.sw_composite_product_id);
    const store = stringOf(recordOf(product.store_product).store)?.toLowerCase() ?? "stripe";
    const storeIdentifier = prefixed ?? (composite ? `${store}|${composite}` : undefined);
    return reference && storeIdentifier ? [{ reference, storeIdentifier }] : [];
  });
};

const VARIABLES_CACHE_PREFIX = "superwall.productVariables:";
const VARIABLES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const memoryVariables = new Map<string, Record<string, Slice>>();

const cacheKeyOf = (apiBase: string, products: readonly HostedProduct[]) =>
  `${VARIABLES_CACHE_PREFIX}${apiBase}|${products
    .map((product) => product.storeIdentifier)
    .sort()
    .join(",")}`;

const readCachedVariables = (key: string): Record<string, Slice> | undefined => {
  const inMemory = memoryVariables.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { at?: unknown; variables?: unknown };
    if (typeof stored.at !== "number" || Date.now() - stored.at > VARIABLES_CACHE_TTL_MS) {
      return undefined;
    }
    return isRecord(stored.variables) ? (stored.variables as Record<string, Slice>) : undefined;
  } catch {
    return undefined;
  }
};

const writeCachedVariables = (key: string, variables: Record<string, Slice>) => {
  memoryVariables.set(key, variables);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ at: Date.now(), variables }));
  } catch {
    /* storage refused — the in-memory copy still serves this page */
  }
};

/** `POST {apiBase}/api/products/variables` — the call paywall.js makes when
 *  the SDK hands it `resolveVariables: true`. Answers every product variable
 *  keyed by the store-prefixed id. */
export const resolveProductVariables = async (
  apiBase: string,
  apiKey: string,
  products: readonly HostedProduct[],
): Promise<Record<string, Slice>> => {
  const response = await fetch(`${apiBase}/api/products/variables`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      productIdentifiers: products.map((product) => product.storeIdentifier),
    }),
  });
  if (!response.ok) throw new Error(`Resolving product variables failed: ${response.status}`);
  const resolved = recordOf(((await response.json()) as { products?: unknown }).products);
  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, Slice] => isRecord(entry[1])),
  );
};

const deviceProperties = () => {
  const now = new Date();
  const localDate = now.toISOString().slice(0, 10);
  const localTime = now.toTimeString().slice(0, 8);
  let radioType = "unknown";
  try {
    radioType =
      (globalThis.navigator as Navigator & { connection?: { type?: string } } | undefined)
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

const withoutStorePrefix = (identifier: string) => identifier.replace(/^[^|]+\|/, "");

const decodeStripeCheckoutId = (swCheckoutId: string | undefined): string | null => {
  if (!swCheckoutId?.startsWith("sw_checkout_")) return null;
  try {
    const decoded = JSON.parse(
      atob(swCheckoutId.replace("sw_checkout_", "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as { stripeCheckoutSessionId?: unknown };
    return typeof decoded.stripeCheckoutSessionId === "string"
      ? decoded.stripeCheckoutSessionId
      : null;
  } catch {
    return null;
  }
};

type RedemptionCode = { code: string; claimed: boolean };

const redemptionCodesOf = (value: unknown): RedemptionCode[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.code === "string"
          ? [{ code: entry.code, claimed: entry.claimed === true }]
          : [],
      )
    : [];

export const createPaywallHost = (input: PaywallHostInput): PaywallHost | null => {
  const collector = collectorOf(input.initPayload.collector);
  const apiBase = stringOf(input.initPayload.apiBase);
  if (!collector || !apiBase) return null;

  const checkoutContext = recordOf(input.initPayload.checkoutContext);
  const identity = recordOf(checkoutContext.identity);
  const experiment = recordOf(checkoutContext.experiment);
  const products = hostedProductsOf(input.initPayload.products);
  const clientSurface = stringOf(input.initPayload.clientSurface) ?? "web-sdk";
  const hostOrigin = stringOf(input.initPayload.hostOrigin);
  const presentationId = crypto.randomUUID();
  const prefetched = new Set<string>();
  let userAttributes: Slice = { ...collector.userAttributes };
  let opened = false;

  const { "x-alias-id": _aliasId, ...baseHeaders } = collector.headers;
  const { userId } = collector.identity;
  let headers: Record<string, string> = {
    ...baseHeaders,
    "x-app-user-id": userId.type === "appUserId" ? userId.appUserId : userId.aliasId,
    ...(userId.type === "appUserId" ? { "x-alias-id": userId.appUserId } : {}),
  };

  const publish = async (events: Array<{ event_id?: string; event_name: string; parameters: Slice }>) => {
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
              $client_surface: clientSurface,
              ...(hostOrigin ? { $host_origin: hostOrigin } : {}),
              ...(input.sdkVersion ? { $sdk_version: input.sdkVersion } : {}),
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
            $managed_payments: checkoutContext.managedPayments === true,
            $paywall_managed_payments_override:
              stringOf(checkoutContext.paywallManagedPaymentsOverride) ?? null,
          }
        : {}),
    };
  };

  const storePrefixedOf = (productIdentifier: string) =>
    productIdentifier.includes("|")
      ? productIdentifier
      : (products.find(
          (product) =>
            product.reference === productIdentifier ||
            product.storeIdentifier === `stripe|${productIdentifier}`,
        )?.storeIdentifier ?? `stripe|${productIdentifier}`);

  const trackStripeCheckout = (state: string, message: HostMessage) =>
    publish([
      {
        event_name: `stripeCheckout_${state}`,
        parameters: {
          ...lifecycleSlices(),
          $store: "STRIPE",
          $product_identifier: String(message.product_identifier ?? ""),
          ...(typeof message.checkout_context_id === "string"
            ? { $checkout_context_id: message.checkout_context_id }
            : {}),
        },
      },
    ]);

  // Product variables also enrich the transaction events, keyed the way both
  // the store-prefixed and the bare product identifiers look them up.
  const applyVariables = (variables: Record<string, Slice>) => {
    for (const [storeIdentifier, productVariables] of Object.entries(variables)) {
      collector.productSlice[storeIdentifier] = productVariables;
      collector.productSlice[withoutStorePrefix(storeIdentifier)] = productVariables;
    }
    const priced = products.flatMap((product) => {
      const productVariables = variables[product.storeIdentifier];
      return productVariables ? [{ [product.reference]: productVariables }] : [];
    });
    if (priced.length === 0) return;
    input.send([
      {
        event_name: "products",
        products: products.map((product) => ({
          product: product.reference,
          productId: withoutStorePrefix(product.storeIdentifier),
        })),
      },
      {
        event_name: "template_variables",
        variables: { ...templateVariables(), products: priced },
      },
    ]);
  };

  const templateVariables = () => ({
    user: {
      ...(input.user ?? {}),
      ...(stringOf(identity.appUserId) ? { appUserId: identity.appUserId } : {}),
      ...(stringOf(identity.aliasId) ? { aliasId: identity.aliasId } : {}),
      ...(stringOf(identity.email) ? { email: identity.email } : {}),
    },
    device: input.device ?? {},
    params: input.params ?? {},
  });

  const priceProducts = () => {
    if (products.length === 0) return;
    const key = cacheKeyOf(apiBase, products);
    const cached = readCachedVariables(key);
    if (cached) applyVariables(cached);
    resolveProductVariables(apiBase, input.apiKey, products)
      .then((variables) => {
        writeCachedVariables(key, variables);
        if (JSON.stringify(variables) !== JSON.stringify(cached)) applyVariables(variables);
      })
      .catch(() => {
        /* the paywall renders its unpriced state, as paywall.js does */
      });
  };

  const trackOpen = () => {
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
      { event_name: "user_attributes", parameters: { ...userAttributes } },
      { event_name: "device_attributes", parameters: { ...collector.deviceAttributes } },
    ]);
  };

  return {
    open: () => {
      if (opened) return;
      opened = true;
      input.send([
        {
          event_name: "experiment",
          experimentId: String(experiment.experimentId ?? "0"),
          variantId: String(experiment.variantId ?? "0"),
          campaignId: String(experiment.campaignId ?? "0"),
        },
        { event_name: "template_variables", variables: templateVariables() },
      ]);
      priceProducts();
      trackOpen();
    },

    observe: (message) => {
      switch (message.event_name) {
        case "close":
          void publish([{ event_name: "paywall_close", parameters: lifecycleSlices() }]);
          return;
        case "user_attribute_updated": {
          const attributes = Array.isArray(message.attributes) ? message.attributes : [];
          for (const entry of attributes) {
            if (isRecord(entry) && typeof entry.key === "string") {
              userAttributes = { ...userAttributes, [entry.key]: entry.value as JsonValue };
            }
          }
          void publish([{ event_name: "user_attributes", parameters: { ...userAttributes } }]);
          return;
        }
        case "page_view":
          void publish([
            {
              event_name: "paywall_page_view",
              parameters: {
                ...lifecycleSlices(),
                $page_node_id: message.page_node_id,
                $flow_position: message.flow_position,
                $page_name: message.page_name,
                $navigation_node_id: message.navigation_node_id,
                $navigation_type: message.type,
                ...(message.previous_page_node_id == null
                  ? {}
                  : { $previous_page_node_id: message.previous_page_node_id }),
                ...(message.previous_flow_position == null
                  ? {}
                  : { $previous_flow_position: message.previous_flow_position }),
                ...(message.time_on_previous_page_ms == null
                  ? {}
                  : { $time_on_previous_page_ms: message.time_on_previous_page_ms }),
              },
            },
          ]);
          return;
        case "stripe_checkout_prefetch":
          if (typeof message.checkout_context_id === "string") {
            prefetched.add(message.checkout_context_id);
          }
          void trackStripeCheckout("prefetch", message);
          return;
        case "stripe_checkout_start": {
          void trackStripeCheckout("start", message);
          // A checkout the server started reports its own transaction_start.
          if (
            typeof message.checkout_context_id === "string" &&
            prefetched.delete(message.checkout_context_id)
          ) {
            const storePrefixed = storePrefixedOf(String(message.product_identifier ?? ""));
            void publish([
              {
                event_name: "transaction_start",
                parameters: transactionParameters(withoutStorePrefix(storePrefixed), {
                  storePrefixed,
                  checkoutContextFields: true,
                }),
              },
            ]);
          }
          return;
        }
        case "stripe_checkout_submit":
        case "stripe_checkout_fail":
          void trackStripeCheckout(message.event_name.replace("stripe_checkout_", ""), message);
          return;
        case "stripe_checkout_abandon":
          void trackStripeCheckout("abandon", message);
          void publish([
            {
              event_name: "transaction_abandon",
              parameters: transactionParameters(String(message.product_identifier ?? "")),
            },
          ]);
          return;
        case "stripe_checkout_complete":
          void trackStripeCheckout("complete", message);
          return;
        default:
          return;
      }
    },

    completeCheckout: async (message) => {
      const checkoutContextId = stringOf(message.checkout_context_id) ?? "";
      const productIdentifier =
        stringOf(message.product_identifier) ?? products[0]?.storeIdentifier ?? "";
      const failure: HostMessage = {
        event_name: "stripe_checkout_fail",
        checkout_context_id: checkoutContextId,
        product_identifier: productIdentifier,
      };
      const postCheckoutUrl = (() => {
        const swCheckoutId = stringOf(message.sw_checkout_id);
        const stripeCheckoutId = decodeStripeCheckoutId(swCheckoutId);
        const sessionId = stripeCheckoutId?.split("_secret_")[0] ?? stripeCheckoutId;
        if (sessionId?.startsWith("cs_test_") || sessionId?.startsWith("cs_live_")) {
          return new URL(
            `/post-checkout?_sw_checkout_session_id_stripe=${encodeURIComponent(sessionId)}`,
            apiBase,
          ).toString();
        }
        if (stripeCheckoutId?.startsWith("sub_")) {
          return new URL(
            `/post-checkout?sw_checkout_id=${encodeURIComponent(swCheckoutId!)}`,
            apiBase,
          ).toString();
        }
        if (!checkoutContextId) return null;
        const match = storePrefixedOf(productIdentifier).match(/^([^|]+)\|([^:]+):/);
        const store = match?.[1]?.toLowerCase() || "stripe";
        const environment = match?.[2]?.toLowerCase() || "live";
        return new URL(
          `/sw/checkout/post-checkout/${encodeURIComponent(store)}/${encodeURIComponent(
            environment,
          )}?checkout_context_id=${encodeURIComponent(checkoutContextId)}`,
          apiBase,
        ).toString();
      })();
      if (!postCheckoutUrl) return failure;

      const resolution = isRecord(message.post_purchase_resolution)
        ? message.post_purchase_resolution
        : { type: "default" };
      try {
        const response = await fetch(
          `${apiBase}/api/post-checkout-redirect?url=${encodeURIComponent(postCheckoutUrl)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(input.apiKey.startsWith("pk_") ? { authorization: `Bearer ${input.apiKey}` } : {}),
            },
            body: JSON.stringify({ resolution }),
          },
        );
        const data = (await response.json()) as {
          behavior?: string;
          redirectUrl?: string;
          redemption?: { url?: string; codes?: string[]; deepLinks?: JsonValue };
          transactionData?: {
            transactionId: string;
            productIdentifier: string;
            currency?: string;
            value?: number;
          };
        };
        if (!response.ok || !data?.redirectUrl) return failure;

        const redirectUrl =
          data.behavior === "redirect"
            ? data.redirectUrl
            : data.redemption?.codes?.length
              ? data.redemption.url
              : undefined;
        const fromCompletion = redemptionCodesOf(message.redemption_codes);
        const known = new Set(fromCompletion.map((entry) => entry.code));
        const redemptionCodes = [
          ...fromCompletion,
          ...(data.redemption?.codes ?? [])
            .filter((code) => !known.has(code))
            .map((code) => ({ code, claimed: false })),
        ];
        return {
          event_name: "post_checkout_complete",
          checkout_context_id: checkoutContextId,
          product_identifier: productIdentifier,
          status: "completed",
          claimed: message.claimed === true,
          ...(data.transactionData
            ? {
                transaction_data: {
                  transaction_id: data.transactionData.transactionId,
                  product_identifier: data.transactionData.productIdentifier,
                  currency: data.transactionData.currency,
                  value: data.transactionData.value,
                },
              }
            : {}),
          ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
          ...(redemptionCodes.length ? { redemption_codes: redemptionCodes } : {}),
          ...(data.redemption?.deepLinks ? { deep_links: data.redemption.deepLinks } : {}),
          ...(stringOf(message.entitlements_token)
            ? { entitlements_token: message.entitlements_token }
            : {}),
        };
      } catch {
        return failure;
      }
    },
  };
};
