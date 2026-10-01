import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaywallHost, type PaywallHostInput } from "./index.ts";

const COLLECTOR = {
  url: "https://web-api.superwall.app/api/proxy/events",
  headers: { "x-public-api-key": "pk_web" },
  placementEventId: "placement-event-1",
  identity: { userId: { type: "appUserId", appUserId: "user_1" } },
  userAttributes: { email: "ada@example.com" },
  deviceAttributes: {},
  experimentSlice: { $experiment_id: "e1" },
  paywallSlice: { $paywall_id: "271256", $paywall_identifier: "paywall-simple-v2" },
  productSlice: {},
  presentmentSlice: { $presented_by_event_name: "web_checkout" },
  placementParamsSlice: {},
};

const INIT = {
  apiBase: "https://web-api.superwall.app",
  clientSurface: "web-sdk",
  hostOrigin: "https://merchant.test",
  products: [
    {
      sw_composite_product_id: "test:price_1:no-trial",
      reference_name: "primary",
      store_product: { store: "STRIPE" },
    },
  ],
  checkoutContext: {
    identity: { appUserId: "user_1", aliasId: "$SuperwallAlias:a1", email: "ada@example.com" },
    experiment: { experimentId: "e1", variantId: "v1", campaignId: "c1" },
    managedPayments: true,
  },
  collector: COLLECTOR,
};

const PRICED = { "stripe|test:price_1:no-trial": { price: "$49.99" } };

let fetchMock: ReturnType<typeof vi.fn>;
let sent: Array<Record<string, unknown>>;
let apiBaseCounter = 0;

const host = (overrides: Partial<PaywallHostInput> = {}) =>
  createPaywallHost({
    initPayload: { ...INIT, apiBase: `https://api-${++apiBaseCounter}.test` },
    apiKey: "pk_web",
    sdkVersion: "0.3.1",
    user: { plan: "none" },
    device: { locale: "en_US" },
    params: { source: "result" },
    send: (messages) => sent.push(...messages),
    ...overrides,
  })!;

const eventNames = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === COLLECTOR.url)
    .flatMap(([, init]) => JSON.parse(String((init as RequestInit).body)).events)
    .map((event: { event_name: string }) => event.event_name);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sent = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/products/variables")) return Response.json({ products: PRICED });
    if (url.includes("/api/post-checkout-redirect")) {
      return Response.json({ behavior: "redeem", redirectUrl: "https://x.test/app-link" });
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPaywallHost", () => {
  it("hosts nothing without a collector or an API base", () => {
    const send = () => undefined;
    expect(createPaywallHost({ initPayload: {}, apiKey: "pk", send })).toBeNull();
    expect(createPaywallHost({ initPayload: { collector: COLLECTOR }, apiKey: "pk", send })).toBeNull();
  });

  it("opens once, like the controller: experiment and identity, priced products, the open batch", async () => {
    const paywall = host();

    paywall.open();
    paywall.open();
    await settle();

    expect(sent[0]).toEqual({ event_name: "experiment", experimentId: "e1", variantId: "v1", campaignId: "c1" });
    expect(sent[1]).toEqual({
      event_name: "template_variables",
      variables: {
        user: { plan: "none", appUserId: "user_1", aliasId: "$SuperwallAlias:a1", email: "ada@example.com" },
        device: { locale: "en_US" },
        params: { source: "result" },
      },
    });
    expect(sent.slice(2)).toEqual([
      { event_name: "products", products: [{ product: "primary", productId: "test:price_1:no-trial" }] },
      {
        event_name: "template_variables",
        variables: expect.objectContaining({ products: [{ primary: { price: "$49.99" } }] }),
      },
    ]);
    expect(eventNames()).toEqual(["web_checkout", "trigger_fire", "paywall_open", "user_attributes", "device_attributes"]);
  });

  it("opens with defaults when the payload carries no identity, experiment or products", async () => {
    const paywall = createPaywallHost({
      initPayload: { apiBase: "https://bare.test", collector: COLLECTOR },
      apiKey: "pk",
      send: (messages) => sent.push(...messages),
    })!;

    paywall.open();
    await settle();

    expect(sent).toEqual([
      { event_name: "experiment", experimentId: "0", variantId: "0", campaignId: "0" },
      { event_name: "template_variables", variables: { user: {}, device: {}, params: {} } },
    ]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/products/variables"))).toBe(false);
  });

  it("sends no products when none could be priced", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/products/variables")
        ? Response.json({ products: { "stripe|other": { price: "$1" } } })
        : new Response(null, { status: 204 }),
    );

    host().open();
    await settle();

    expect(sent.map((message) => message.event_name)).toEqual(["experiment", "template_variables"]);
  });

  it("routes each lifecycle message to its event, with transaction_start only for a prefetched session", async () => {
    const paywall = host();
    const step = (event_name: string, checkout_context_id?: string) =>
      paywall.observe({ event_name, checkout_context_id, product_identifier: "primary" });

    paywall.observe({ event_name: "close" });
    paywall.observe({ event_name: "page_view", type: "entry", page_node_id: "p1" });
    paywall.observe({ event_name: "user_attribute_updated", attributes: [{ key: "plan", value: "annual" }, "junk"] });
    paywall.observe({ event_name: "user_attribute_updated" });
    step("stripe_checkout_prefetch", "ctx_1");
    step("stripe_checkout_start", "ctx_1");
    step("stripe_checkout_start", "ctx_2");
    step("stripe_checkout_prefetch");
    step("stripe_checkout_start");
    step("stripe_checkout_submit", "ctx_1");
    step("stripe_checkout_fail", "ctx_1");
    step("stripe_checkout_abandon", "ctx_1");
    step("stripe_checkout_complete", "ctx_1");
    paywall.observe({ event_name: "stripe_checkout_submit" });
    paywall.observe({ event_name: "restore" });
    paywall.observe({});
    await settle();

    expect(eventNames()).toEqual([
      "paywall_close",
      "paywall_page_view",
      "user_attributes",
      "user_attributes",
      "stripeCheckout_prefetch",
      "stripeCheckout_start",
      "transaction_start",
      "stripeCheckout_start",
      "stripeCheckout_prefetch",
      "stripeCheckout_start",
      "stripeCheckout_submit",
      "stripeCheckout_fail",
      "stripeCheckout_abandon",
      "transaction_abandon",
      "stripeCheckout_complete",
      "stripeCheckout_submit",
    ]);
  });

  it("resolves a finished checkout through the post-checkout lookup", async () => {
    const message = await host().completeCheckout({
      event_name: "stripe_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "primary",
      claimed: true,
    });

    expect(message).toMatchObject({ event_name: "post_checkout_complete", checkout_context_id: "ctx_1", claimed: true });
  });
});
