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
// itself, with the controller's payloads (see `products.ts`, `events.ts`,
// `checkout.ts`), so both kinds of paywall land identically.

import { completeCheckout, type HostMessage } from "./checkout.ts";
import { collectorOf } from "./collector.ts";
import { createHostEvents, type StripeCheckoutState } from "./events.ts";
import {
  hostedProductsOf,
  priceProducts,
  pricedProducts,
  withoutStorePrefix,
  type ProductVariables,
} from "./products.ts";
import { isRecord, recordOf, stringOf, type Slice } from "./values.ts";

export type { HostMessage } from "./checkout.ts";

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
  /** Send the paywall's attribution (`experiment`, then `paywall_open`) once.
   *  The presenter calls it before it sends the templates: a framework
   *  paywall starts prefetching checkout sessions as soon as it has its
   *  products, and each session's checkout context, which the server builds
   *  `transaction_complete` from, records the attribution the paywall had at
   *  that moment. */
  announce(): void;
  /** The paywall asked for its templates: send attribution (when `announce`
   *  hasn't yet), identity and priced products, and report the open. */
  open(): void;
  /** Report what a lifecycle message from the paywall means. */
  observe(message: HostMessage): void;
  /** Resolve a finished checkout into the `post_checkout_complete` message
   *  the controller would post (or `stripe_checkout_fail` on failure). */
  completeCheckout(message: HostMessage): Promise<HostMessage>;
}

const STRIPE_CHECKOUT_STATES: Record<string, StripeCheckoutState> = {
  stripe_checkout_prefetch: "prefetch",
  stripe_checkout_start: "start",
  stripe_checkout_submit: "submit",
  stripe_checkout_fail: "fail",
  stripe_checkout_abandon: "abandon",
  stripe_checkout_complete: "complete",
};

/** A host for one presentation, or `null` when the `#init` payload has no
 *  collector or API base to host with. */
export const createPaywallHost = (input: PaywallHostInput): PaywallHost | null => {
  const collector = collectorOf(input.initPayload.collector);
  const apiBase = stringOf(input.initPayload.apiBase);
  if (!collector || !apiBase) return null;

  const checkoutContext = recordOf(input.initPayload.checkoutContext);
  const identity = recordOf(checkoutContext.identity);
  const experiment = recordOf(checkoutContext.experiment);
  const paywall = recordOf(checkoutContext.paywall);
  const products = hostedProductsOf(input.initPayload.products);
  const hostOrigin = stringOf(input.initPayload.hostOrigin);
  const events = createHostEvents({
    collector,
    products,
    clientSurface: stringOf(input.initPayload.clientSurface) ?? "web-sdk",
    ...(hostOrigin ? { hostOrigin } : {}),
    ...(input.sdkVersion ? { sdkVersion: input.sdkVersion } : {}),
    managedPayments: checkoutContext.managedPayments === true,
    paywallManagedPaymentsOverride: stringOf(checkoutContext.paywallManagedPaymentsOverride) ?? null,
  });
  const prefetched = new Set<string>();
  let announced = false;
  let opened = false;

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

  const applyVariables = (variables: ProductVariables) => {
    events.applyVariables(variables);
    const priced = pricedProducts(products, variables);
    if (priced.length === 0) return;
    input.send([
      {
        event_name: "products",
        products: products.map((product) => ({
          product: product.reference,
          productId: withoutStorePrefix(product.storeIdentifier),
        })),
      },
      { event_name: "template_variables", variables: { ...templateVariables(), products: priced } },
    ]);
  };

  const announce = () => {
    if (announced) return;
    announced = true;
    input.send([
      {
        event_name: "experiment",
        experimentId: String(experiment.experimentId ?? "0"),
        variantId: String(experiment.variantId ?? "0"),
        campaignId: String(experiment.campaignId ?? "0"),
      },
      // What the native SDKs send a paywall on open. The framework keeps it
      // as `snapshot.paywall` and puts it in every checkout context; without
      // it the context carries paywall `0`.
      {
        event_name: "paywall_open",
        paywall_id: String(paywall.paywallId ?? "0"),
        paywall_identifier: stringOf(paywall.paywallIdentifier) ?? "",
        paywall_name: stringOf(paywall.paywallName) ?? "",
      },
    ]);
  };

  return {
    announce,

    open: () => {
      if (opened) return;
      opened = true;
      announce();
      input.send([{ event_name: "template_variables", variables: templateVariables() }]);
      void priceProducts(apiBase, input.apiKey, products, applyVariables);
      events.trackOpen();
    },

    observe: (message) => {
      const name = message.event_name ?? "";
      if (name === "close") return events.trackClose();
      if (name === "page_view") return events.trackPageView(message);
      if (name === "user_attribute_updated") {
        const attributes: Slice = {};
        for (const entry of Array.isArray(message.attributes) ? message.attributes : []) {
          if (isRecord(entry) && typeof entry.key === "string") attributes[entry.key] = entry.value;
        }
        return events.trackUserAttributes(attributes);
      }
      const state = STRIPE_CHECKOUT_STATES[name];
      if (!state) return;
      const productIdentifier = String(message.product_identifier ?? "");
      const checkoutContextId = stringOf(message.checkout_context_id);
      events.trackStripeCheckout(state, productIdentifier, checkoutContextId);
      if (state === "prefetch" && checkoutContextId) prefetched.add(checkoutContextId);
      // A checkout the server started reports its own transaction_start.
      if (state === "start" && checkoutContextId && prefetched.delete(checkoutContextId)) {
        events.trackTransactionStart(productIdentifier);
      }
      if (state === "abandon") events.trackTransactionAbandon(productIdentifier);
    },

    completeCheckout: (message) => completeCheckout(apiBase, input.apiKey, products, message),
  };
};
