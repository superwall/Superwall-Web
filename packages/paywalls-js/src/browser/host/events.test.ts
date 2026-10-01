import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectorOf } from "./collector.ts";
import { createHostEvents, deviceProperties, type HostEventsContext } from "./events.ts";

const COLLECTOR = {
  url: "https://web-api.superwall.app/api/proxy/events",
  headers: { "x-public-api-key": "pk_web", "x-alias-id": "$SuperwallAlias:a1", "x-platform": "web" },
  placementEventId: "placement-event-1",
  identity: { userId: { type: "appUserId", appUserId: "user_1" } },
  userAttributes: { email: "ada@example.com" },
  deviceAttributes: { $appInstallDate: "2026-01-01T00:00:00.000Z" },
  experimentSlice: { $experiment_id: "e1", $variant_id: "v1" },
  paywallSlice: { $paywall_id: "271256", $paywall_identifier: "paywall-simple-v2" },
  productSlice: {},
  presentmentSlice: { $presented_by_event_name: "web_checkout", $presented_by: "placement" },
  placementParamsSlice: { $placement_params: { source: "result" } },
};

type Published = {
  event_id: string;
  event_name: string;
  created_at: string;
  parameters: Record<string, unknown>;
};

let fetchMock: ReturnType<typeof vi.fn>;

const context = (overrides: Partial<HostEventsContext> = {}, collector: unknown = COLLECTOR): HostEventsContext => ({
  collector: collectorOf(collector)!,
  products: [{ reference: "primary", storeIdentifier: "stripe|test:price_1:no-trial" }],
  clientSurface: "web-sdk",
  hostOrigin: "https://merchant.test",
  sdkVersion: "0.3.1",
  managedPayments: true,
  paywallManagedPaymentsOverride: "USE_MANAGED_PAYMENTS",
  ...overrides,
});

const requests = () => fetchMock.mock.calls.map(([url, init]) => ({ url, init: init as RequestInit }));
const published = (): Published[] => requests().flatMap(({ init }) => JSON.parse(String(init.body)).events);
const names = () => published().map((event) => event.event_name);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__;
});

describe("deviceProperties", () => {
  it("reads the color scheme, the network and the local time", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("navigator", { connection: { type: "wifi" } });

    expect(deviceProperties(new Date("2026-09-25T12:34:56Z"))).toMatchObject({
      interfaceStyle: "dark",
      radioType: "wifi",
      isLowPowerModeEnabled: false,
      localDate: "2026-09-25",
      localDateTime: expect.stringMatching(/^2026-09-25T\d{2}:\d{2}:\d{2}$/),
    });
  });

  it("falls back to light and an unknown network", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("navigator", {});
    expect(deviceProperties()).toMatchObject({ interfaceStyle: "light", radioType: "unknown" });

    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("navigator", {
      get connection() {
        throw new Error("blocked");
      },
    });
    expect(deviceProperties()).toMatchObject({ interfaceStyle: "light", radioType: "unknown" });
  });
});

describe("createHostEvents", () => {
  it("reports the open batch paywall.js sends, as the identified user", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("navigator", { connection: { type: "wifi" } });

    createHostEvents(context()).trackOpen();
    await settle();

    const { url, init } = requests()[0]!;
    expect(url).toBe(COLLECTOR.url);
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(init.headers).toEqual({
      "x-public-api-key": "pk_web",
      "x-platform": "web",
      "x-app-user-id": "user_1",
      "x-alias-id": "user_1",
      "x-device-interface-style": "dark",
      "x-radio-type": "wifi",
      "x-low-power-mode": "false",
      "content-type": "application/json",
    });
    expect(names()).toEqual(["web_checkout", "trigger_fire", "paywall_open", "user_attributes", "device_attributes"]);
    const [placement, triggerFire, paywallOpen, attributes, device] = published();
    expect(placement).toMatchObject({ event_id: "placement-event-1", parameters: { source: "result" } });
    expect(triggerFire!.parameters).toMatchObject({
      $experiment_id: "e1",
      $result: "present",
      $is_standard_event: true,
      $paywall_identifier: "paywall-simple-v2",
      $trigger_name: "web_checkout",
    });
    expect(paywallOpen!.parameters).toMatchObject({
      $paywall_id: "271256",
      $presented_by_event_name: "web_checkout",
      $client_surface: "web-sdk",
      $host_origin: "https://merchant.test",
      $sdk_version: "0.3.1",
      $presentation_id: expect.any(String),
    });
    expect(attributes!.parameters).toMatchObject({ email: "ada@example.com" });
    expect(device!.parameters).toMatchObject({ $appInstallDate: "2026-01-01T00:00:00.000Z", $radioType: "wifi" });
    expect(new Set(published().map((event) => event.parameters.$presentation_id)).size).toBe(1);
    expect(published().every((event) => typeof event.created_at === "string")).toBe(true);
  });

  it("reports an anonymous user by alias, and an open with no placement or surface metadata", async () => {
    createHostEvents(
      context({ hostOrigin: undefined, sdkVersion: undefined } as unknown as Partial<HostEventsContext>, {
        ...COLLECTOR,
        identity: { userId: { type: "aliasId", aliasId: "$SuperwallAlias:a1" } },
        presentmentSlice: {},
        placementParamsSlice: {},
      }),
    ).trackOpen();
    await settle();

    const { init } = requests()[0]!;
    expect(init.headers).toMatchObject({ "x-app-user-id": "$SuperwallAlias:a1" });
    expect(init.headers).not.toHaveProperty("x-alias-id");
    expect(published()[0]).toMatchObject({ event_name: "", parameters: {} });
    expect(published()[2]!.parameters).not.toHaveProperty("$host_origin");
    expect(published()[2]!.parameters).not.toHaveProperty("$sdk_version");
  });

  it("reports closes, merged attribute updates and page views", async () => {
    const events = createHostEvents(context());

    events.trackClose();
    events.trackUserAttributes({ plan: "annual" });
    events.trackPageView({
      type: "forward",
      page_node_id: "p2",
      flow_position: 1,
      page_name: "Pay",
      navigation_node_id: "n1",
      previous_page_node_id: "p1",
      previous_flow_position: 0,
      time_on_previous_page_ms: 1200,
    });
    events.trackPageView({ type: "entry", page_node_id: "p1" });
    await settle();

    expect(names()).toEqual(["paywall_close", "user_attributes", "paywall_page_view", "paywall_page_view"]);
    const [close, attributes, forward, entry] = published();
    expect(close!.parameters).toMatchObject({ $paywall_id: "271256", $experiment_id: "e1" });
    expect(attributes!.parameters).toMatchObject({ email: "ada@example.com", plan: "annual" });
    expect(forward!.parameters).toMatchObject({
      $page_node_id: "p2",
      $navigation_type: "forward",
      $previous_page_node_id: "p1",
      $previous_flow_position: 0,
      $time_on_previous_page_ms: 1200,
    });
    expect(entry!.parameters).not.toHaveProperty("$previous_page_node_id");
    expect(entry!.parameters).not.toHaveProperty("$previous_flow_position");
    expect(entry!.parameters).not.toHaveProperty("$time_on_previous_page_ms");
  });

  it("reports the Stripe steps, with the checkout context when there is one", async () => {
    const events = createHostEvents(context());

    events.trackStripeCheckout("start", "primary", "ctx_1");
    events.trackStripeCheckout("prefetch", "primary");
    await settle();

    expect(published()[0]).toMatchObject({
      event_name: "stripeCheckout_start",
      parameters: { $store: "STRIPE", $product_identifier: "primary", $checkout_context_id: "ctx_1", $paywall_id: "271256" },
    });
    expect(published()[1]!.parameters).not.toHaveProperty("$checkout_context_id");
  });

  it("reports a transaction start with the checkout context, enriched by the resolved variables", async () => {
    const events = createHostEvents(context());
    events.applyVariables({ "stripe|test:price_1:no-trial": { price: "$49.99" } });

    events.trackTransactionStart("primary");
    events.trackTransactionAbandon("primary");
    await settle();

    expect(published()[0]).toMatchObject({
      event_name: "transaction_start",
      parameters: {
        $product_id: "stripe|test:price_1:no-trial",
        $product_identifier: "stripe|test:price_1:no-trial",
        price: "$49.99",
        $store: "STRIPE",
        $install_date: "2026-01-01T00:00:00.000Z",
        $placement_params: { source: "result" },
        $managed_payments: true,
        $paywall_managed_payments_override: "USE_MANAGED_PAYMENTS",
        $country_code: null,
        $transaction_date: expect.any(String),
      },
    });
    expect(published()[1]).toMatchObject({
      event_name: "transaction_abandon",
      parameters: { $product_id: "primary", $store: "STRIPE" },
    });
    expect(published()[1]!.parameters).not.toHaveProperty("$managed_payments");
  });

  it("dates a transaction now when the device has no install date", async () => {
    createHostEvents(context({}, { ...COLLECTOR, deviceAttributes: {} })).trackTransactionAbandon("primary");
    await settle();

    expect(published()[0]!.parameters.$install_date).toEqual(expect.any(String));
  });

  it("stays quiet when event tracking is off, and survives an unreachable collector", async () => {
    (globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__ = true;
    createHostEvents(context()).trackClose();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    delete (globalThis as { __SW_EVENTS_DISABLED__?: boolean }).__SW_EVENTS_DISABLED__;

    fetchMock.mockRejectedValue(new Error("offline"));
    createHostEvents(context()).trackClose();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
