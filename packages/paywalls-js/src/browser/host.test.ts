import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaywallHost, hostedProductsOf, type PaywallHostInput } from "./host.ts";

const COLLECTOR = {
  url: "https://web-api.superwall.app/api/proxy/events",
  headers: {
    "x-public-api-key": "pk_web",
    "x-alias-id": "$SuperwallAlias:a1",
    "x-device-id": "d1",
    "x-platform": "web",
  },
  placementEventId: "placement-event-1",
  identity: { userId: { type: "appUserId", appUserId: "user_1" }, deviceId: "d1" },
  userAttributes: { email: "ada@example.com" },
  deviceAttributes: { $appInstallDate: "2026-01-01T00:00:00.000Z" },
  experimentSlice: { $experiment_id: "e1", $variant_id: "v1" },
  paywallSlice: { $paywall_id: "271256", $paywall_identifier: "paywall-simple-v2" },
  productSlice: {},
  presentmentSlice: { $presented_by_event_name: "web_checkout", $presented_by: "placement" },
  placementParamsSlice: { $placement_params: { source: "result" } },
};

const PRODUCTS = [
  {
    sw_composite_product_id: "test:price_1:no-trial",
    reference_name: "primary",
    store_product: { store: "STRIPE", environment: "test", product_identifier: "price_1" },
  },
];

const INIT = {
  apiBase: "https://web-api.superwall.app",
  clientSurface: "web-sdk",
  hostOrigin: "https://merchant.test",
  products: PRODUCTS,
  checkoutContext: {
    identity: { appUserId: "user_1", aliasId: "$SuperwallAlias:a1", email: "ada@example.com" },
    experiment: { experimentId: "e1", variantId: "v1" },
    managedPayments: true,
  },
  collector: COLLECTOR,
};

const PRICED = { "stripe|test:price_1:no-trial": { price: "$49.99", period: "year" } };

type Published = { event_id: string; event_name: string; parameters: Record<string, unknown> };

let fetchMock: ReturnType<typeof vi.fn>;
let sent: Array<Record<string, unknown>>;

const answer = (url: string, init?: RequestInit): Response => {
  if (url.endsWith("/api/products/variables")) return Response.json({ products: PRICED });
  if (url.includes("/api/post-checkout-redirect")) {
    return Response.json({
      behavior: "redeem",
      redirectUrl: "https://cruisesignal.superwall.app/app-link",
      redemption: { url: "https://cruisesignal.superwall.app/redeem", codes: ["redemption_2"] },
      transactionData: { transactionId: "in_1", productIdentifier: "stripe|test:price_1:no-trial", currency: "USD", value: 49.99 },
    });
  }
  void init;
  return new Response(null, { status: 204 });
};

const host = (overrides: Partial<PaywallHostInput> = {}) =>
  createPaywallHost({
    initPayload: INIT,
    apiKey: "pk_web",
    sdkVersion: "0.3.1",
    user: { email: "ada@example.com" },
    device: { locale: "en_US" },
    params: {},
    send: (messages) => sent.push(...messages),
    ...overrides,
  })!;

const collected = (): Published[] =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === COLLECTOR.url)
    .flatMap(([, init]) => JSON.parse(String((init as RequestInit).body)).events);

const names = () => collected().map((event) => event.event_name);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sent = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hostedProductsOf", () => {
  it("names each config product the way the price lookup does", () => {
    expect(
      hostedProductsOf([
        ...PRODUCTS,
        { referenceName: "secondary", storePrefixedSuperwallCompositeProductIdentifier: "stripe|live:x" },
        { reference_name: "no-id" },
        "junk",
      ]),
    ).toEqual([
      { reference: "primary", storeIdentifier: "stripe|test:price_1:no-trial" },
      { reference: "secondary", storeIdentifier: "stripe|live:x" },
    ]);
    expect(hostedProductsOf(undefined)).toEqual([]);
  });
});

describe("createPaywallHost", () => {
  it("hosts nothing without a collector or an API base", () => {
    expect(createPaywallHost({ initPayload: {}, apiKey: "pk", send: () => {} })).toBeNull();
    expect(
      createPaywallHost({ initPayload: { collector: COLLECTOR }, apiKey: "pk", send: () => {} }),
    ).toBeNull();
  });

  it("opens like the controller: identity and experiment, priced products, then the open batch", async () => {
    const paywall = host();

    paywall.open();
    paywall.open();
    await settle();

    expect(sent[0]).toEqual({
      event_name: "experiment",
      experimentId: "e1",
      variantId: "v1",
      campaignId: "0",
    });
    expect(sent[1]).toMatchObject({
      event_name: "template_variables",
      variables: {
        user: { email: "ada@example.com", appUserId: "user_1", aliasId: "$SuperwallAlias:a1" },
        device: { locale: "en_US" },
      },
    });
    expect(sent.slice(2)).toEqual([
      {
        event_name: "products",
        products: [{ product: "primary", productId: "test:price_1:no-trial" }],
      },
      {
        event_name: "template_variables",
        variables: expect.objectContaining({
          products: [{ primary: { price: "$49.99", period: "year" } }],
        }),
      },
    ]);
    const lookup = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/products/variables"))!;
    expect((lookup[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer pk_web" });
    expect(JSON.parse(String((lookup[1] as RequestInit).body))).toEqual({
      productIdentifiers: ["stripe|test:price_1:no-trial"],
    });

    expect(names()).toEqual([
      "web_checkout",
      "trigger_fire",
      "paywall_open",
      "user_attributes",
      "device_attributes",
    ]);
    const request = fetchMock.mock.calls.find(([url]) => String(url) === COLLECTOR.url)![1] as RequestInit;
    expect(request).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(request.headers).toMatchObject({
      "x-app-user-id": "user_1",
      "x-alias-id": "user_1",
      "x-public-api-key": "pk_web",
      "x-radio-type": expect.any(String),
    });
    const [placement, triggerFire, paywallOpen] = collected();
    expect(placement).toMatchObject({ event_id: "placement-event-1", parameters: { source: "result" } });
    expect(triggerFire!.parameters).toMatchObject({
      $result: "present",
      $trigger_name: "web_checkout",
      $paywall_identifier: "paywall-simple-v2",
    });
    expect(paywallOpen!.parameters).toMatchObject({
      $paywall_id: "271256",
      $client_surface: "web-sdk",
      $host_origin: "https://merchant.test",
      $sdk_version: "0.3.1",
      $presentation_id: expect.any(String),
    });
  });

  it("prices a reopened paywall from the cache on the first frame and only resends a changed answer", async () => {
    host().open();
    await settle();
    sent = [];

    host().open();
    const firstFrame = sent.find((message) => message.event_name === "products");
    await settle();

    expect(firstFrame).toBeDefined();
    expect(sent.filter((message) => message.event_name === "products")).toHaveLength(1);
  });

  it("renders unpriced when the lookup fails, as paywall.js does", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/products/variables")
        ? new Response("down", { status: 503 })
        : new Response(null, { status: 204 }),
    );

    host({ initPayload: { ...INIT, apiBase: "https://unpriced.test" } }).open();
    await settle();

    expect(sent.map((message) => message.event_name)).toEqual(["experiment", "template_variables"]);
  });

  it("reports closes, merged attribute updates and page views", async () => {
    const paywall = host();

    paywall.observe({ event_name: "close" });
    paywall.observe({ event_name: "user_attribute_updated", attributes: [{ key: "plan", value: "annual" }, "junk"] });
    paywall.observe({
      event_name: "page_view",
      type: "forward",
      page_node_id: "p2",
      flow_position: 1,
      page_name: "Pay",
      navigation_node_id: "n1",
      previous_page_node_id: "p1",
      previous_flow_position: 0,
      time_on_previous_page_ms: 1200,
    });
    paywall.observe({ event_name: "page_view", type: "entry", page_node_id: "p1" });
    paywall.observe({ event_name: "restore" });
    await settle();

    expect(names()).toEqual(["paywall_close", "user_attributes", "paywall_page_view", "paywall_page_view"]);
    const [close, attributes, forward, entry] = collected();
    expect(close!.parameters).toMatchObject({ $paywall_id: "271256", $experiment_id: "e1" });
    expect(attributes!.parameters).toMatchObject({ email: "ada@example.com", plan: "annual" });
    expect(forward!.parameters).toMatchObject({
      $page_node_id: "p2",
      $previous_page_node_id: "p1",
      $time_on_previous_page_ms: 1200,
    });
    expect(entry!.parameters).not.toHaveProperty("$previous_page_node_id");
  });

  it("reports the Stripe steps, a transaction start only for a prefetched session, and abandons", async () => {
    const paywall = host();
    paywall.open();
    await settle();
    fetchMock.mockClear();
    const step = (event_name: string, checkout_context_id?: string, product_identifier = "primary") =>
      paywall.observe({ event_name, checkout_context_id, product_identifier });

    step("stripe_checkout_prefetch", "ctx_1");
    step("stripe_checkout_start", "ctx_1");
    step("stripe_checkout_start", "ctx_2");
    step("stripe_checkout_submit", "ctx_1");
    step("stripe_checkout_fail", "ctx_1");
    step("stripe_checkout_abandon", "ctx_1");
    step("stripe_checkout_complete", "ctx_1");
    step("stripe_checkout_prefetch", undefined, "stripe|test:price_1:no-trial");
    await settle();

    expect(names()).toEqual([
      "stripeCheckout_prefetch",
      "stripeCheckout_start",
      "transaction_start",
      "stripeCheckout_start",
      "stripeCheckout_submit",
      "stripeCheckout_fail",
      "stripeCheckout_abandon",
      "transaction_abandon",
      "stripeCheckout_complete",
      "stripeCheckout_prefetch",
    ]);
    const all = collected();
    expect(all[2]!.parameters).toMatchObject({
      $product_id: "stripe|test:price_1:no-trial",
      $store: "STRIPE",
      price: "$49.99",
      $install_date: "2026-01-01T00:00:00.000Z",
      $placement_params: { source: "result" },
      $managed_payments: true,
      $country_code: null,
    });
    expect(all[7]!.parameters).toMatchObject({ $product_id: "primary" });
    expect(all[9]!.parameters).not.toHaveProperty("$checkout_context_id");
  });

  it("stays quiet when event tracking is off, and survives an unreachable collector", async () => {
    (globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__ = true;
    host().observe({ event_name: "close" });
    await settle();
    expect(collected()).toHaveLength(0);
    delete (globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__;

    fetchMock.mockRejectedValue(new Error("offline"));
    host().observe({ event_name: "close" });
    await settle();
  });
});

describe("completeCheckout", () => {
  const swCheckoutId = (stripeCheckoutSessionId: string) =>
    `sw_checkout_${btoa(JSON.stringify({ stripeCheckoutSessionId })).replace(/\+/g, "-").replace(/\//g, "_")}`;

  const lookupUrl = () => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/post-checkout-redirect"))!;
    return decodeURIComponent(new URL(String(call[0])).searchParams.get("url") ?? "");
  };

  it("hands the SDK the controller's post_checkout_complete: claim, every code, the transaction", async () => {
    const message = await host().completeCheckout({
      event_name: "stripe_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "primary",
      claimed: true,
      redemption_codes: [{ code: "redemption_1", claimed: true }, { nope: 1 }],
      entitlements_token: "ent_1",
      post_purchase_resolution: { type: "redeem" },
    });

    expect(message).toEqual({
      event_name: "post_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "primary",
      status: "completed",
      claimed: true,
      transaction_data: {
        transaction_id: "in_1",
        product_identifier: "stripe|test:price_1:no-trial",
        currency: "USD",
        value: 49.99,
      },
      redirect_url: "https://cruisesignal.superwall.app/redeem",
      redemption_codes: [
        { code: "redemption_1", claimed: true },
        { code: "redemption_2", claimed: false },
      ],
      entitlements_token: "ent_1",
    });
    expect(lookupUrl()).toBe(
      "https://web-api.superwall.app/sw/checkout/post-checkout/stripe/test?checkout_context_id=ctx_1",
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/post-checkout-redirect"))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ resolution: { type: "redeem" } });
  });

  it("looks the checkout up by its Stripe session or subscription when the id carries one", async () => {
    await host().completeCheckout({ checkout_context_id: "ctx_1", sw_checkout_id: swCheckoutId("cs_test_abc_secret_x") });
    expect(lookupUrl()).toBe("https://web-api.superwall.app/post-checkout?_sw_checkout_session_id_stripe=cs_test_abc");

    fetchMock.mockClear();
    const subscription = swCheckoutId("sub_123");
    await host().completeCheckout({ checkout_context_id: "ctx_1", sw_checkout_id: subscription });
    expect(lookupUrl()).toBe(`https://web-api.superwall.app/post-checkout?sw_checkout_id=${subscription}`);
  });

  it("reports a failed checkout when the lookup cannot be built, fails or answers nothing usable", async () => {
    const fail = { event_name: "stripe_checkout_fail" };
    expect(await host().completeCheckout({ sw_checkout_id: "sw_checkout_!!!" })).toMatchObject(fail);

    fetchMock.mockImplementation(async () => Response.json({ behavior: "redeem" }));
    expect(await host().completeCheckout({ checkout_context_id: "ctx_1" })).toMatchObject(fail);

    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await host().completeCheckout({ checkout_context_id: "ctx_1" })).toMatchObject(fail);
  });

  it("follows a redirect behavior's URL and leaves out what the lookup did not return", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ behavior: "redirect", redirectUrl: "https://merchant.test/thanks" }),
    );

    const message = await host({ apiKey: "session_token" }).completeCheckout({ checkout_context_id: "ctx_1" });

    expect(message).toEqual({
      event_name: "post_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "stripe|test:price_1:no-trial",
      status: "completed",
      claimed: false,
      redirect_url: "https://merchant.test/thanks",
    });
    const call = fetchMock.mock.calls[0]!;
    expect((call[1] as RequestInit).headers).not.toHaveProperty("authorization");
  });
});
