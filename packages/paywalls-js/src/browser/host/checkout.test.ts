import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeCheckout, decodeStripeCheckoutId, postCheckoutUrl, redemptionCodesOf } from "./checkout.ts";

const API = "https://web-api.superwall.app";
const PRODUCTS = [{ reference: "primary", storeIdentifier: "stripe|test:price_1:no-trial" }];

const swCheckoutId = (stripeCheckoutSessionId: unknown) =>
  `sw_checkout_${btoa(JSON.stringify({ stripeCheckoutSessionId })).replace(/\+/g, "-").replace(/\//g, "_")}`;

const LOOKUP = {
  behavior: "redeem",
  redirectUrl: "https://cruisesignal.superwall.app/app-link",
  redemption: {
    url: "https://cruisesignal.superwall.app/redeem",
    codes: ["redemption_1", "redemption_2"],
    deepLinks: { ios: "cruisesignal://redeem" },
  },
  transactionData: {
    transactionId: "in_1",
    productIdentifier: "stripe|test:price_1:no-trial",
    currency: "USD",
    value: 49.99,
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json(LOOKUP));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeStripeCheckoutId", () => {
  it("reads the Stripe id out of an sw_checkout id", () => {
    expect(decodeStripeCheckoutId(swCheckoutId("cs_test_1"))).toBe("cs_test_1");
  });

  it("is null for anything else", () => {
    expect(decodeStripeCheckoutId(undefined)).toBeNull();
    expect(decodeStripeCheckoutId("cs_test_1")).toBeNull();
    expect(decodeStripeCheckoutId("sw_checkout_!!!")).toBeNull();
    expect(decodeStripeCheckoutId(swCheckoutId(7))).toBeNull();
  });
});

describe("postCheckoutUrl", () => {
  it("looks up by the Stripe session, the subscription, else the checkout context", () => {
    expect(postCheckoutUrl(API, PRODUCTS, { swCheckoutId: swCheckoutId("cs_live_abc_secret_x"), productIdentifier: "primary" })).toBe(
      `${API}/post-checkout?_sw_checkout_session_id_stripe=cs_live_abc`,
    );
    const subscription = swCheckoutId("sub_123");
    expect(postCheckoutUrl(API, PRODUCTS, { swCheckoutId: subscription, productIdentifier: "primary" })).toBe(
      `${API}/post-checkout?sw_checkout_id=${encodeURIComponent(subscription)}`,
    );
    expect(postCheckoutUrl(API, PRODUCTS, { checkoutContextId: "ctx_1", productIdentifier: "primary" })).toBe(
      `${API}/sw/checkout/post-checkout/stripe/test?checkout_context_id=ctx_1`,
    );
    expect(postCheckoutUrl(API, PRODUCTS, { checkoutContextId: "ctx_1", productIdentifier: "price_live" })).toBe(
      `${API}/sw/checkout/post-checkout/stripe/live?checkout_context_id=ctx_1`,
    );
    expect(
      postCheckoutUrl(API, PRODUCTS, { swCheckoutId: swCheckoutId("pi_1"), checkoutContextId: "ctx_1", productIdentifier: "primary" }),
    ).toContain("checkout_context_id=ctx_1");
  });

  it("is null with nothing to look the checkout up by", () => {
    expect(postCheckoutUrl(API, PRODUCTS, { productIdentifier: "primary" })).toBeNull();
  });
});

describe("redemptionCodesOf", () => {
  it("reads codes with their claim, dropping anything else", () => {
    expect(redemptionCodesOf([{ code: "a", claimed: true }, { code: "b" }, { nope: 1 }, "c"])).toEqual([
      { code: "a", claimed: true },
      { code: "b", claimed: false },
    ]);
    expect(redemptionCodesOf(undefined)).toEqual([]);
  });
});

describe("completeCheckout", () => {
  it("hands the SDK the controller's post_checkout_complete: the claim, every code, the transaction", async () => {
    const message = await completeCheckout(API, "pk_web", PRODUCTS, {
      event_name: "stripe_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "primary",
      claimed: true,
      redemption_codes: [{ code: "redemption_1", claimed: true }],
      entitlements_token: "ent_1",
      post_purchase_resolution: { type: "redeem" },
    });

    expect(message).toEqual({
      event_name: "post_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "primary",
      status: "completed",
      claimed: true,
      transaction_data: { transaction_id: "in_1", product_identifier: "stripe|test:price_1:no-trial", currency: "USD", value: 49.99 },
      redirect_url: "https://cruisesignal.superwall.app/redeem",
      redemption_codes: [
        { code: "redemption_1", claimed: true },
        { code: "redemption_2", claimed: false },
      ],
      deep_links: { ios: "cruisesignal://redeem" },
      entitlements_token: "ent_1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(decodeURIComponent(new URL(String(url)).searchParams.get("url") ?? "")).toBe(
      `${API}/sw/checkout/post-checkout/stripe/test?checkout_context_id=ctx_1`,
    );
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer pk_web" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ resolution: { type: "redeem" } });
  });

  it("follows a redirect behavior, leaves out what the lookup did not return, and sends no key but a public one", async () => {
    fetchMock.mockResolvedValue(Response.json({ behavior: "redirect", redirectUrl: "https://merchant.test/thanks" }));

    const message = await completeCheckout(API, "session_token", PRODUCTS, { checkout_context_id: "ctx_1" });

    expect(message).toEqual({
      event_name: "post_checkout_complete",
      checkout_context_id: "ctx_1",
      product_identifier: "stripe|test:price_1:no-trial",
      status: "completed",
      claimed: false,
      redirect_url: "https://merchant.test/thanks",
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(String(init.body))).toEqual({ resolution: { type: "default" } });
  });

  it("sends no redemption page without codes, and looks up by the Stripe session when the id carries one", async () => {
    fetchMock.mockResolvedValue(Response.json({ behavior: "redeem", redirectUrl: "https://x.test/app-link", redemption: { url: "https://x.test/redeem" } }));

    const message = await completeCheckout(API, "pk_web", [], { sw_checkout_id: swCheckoutId("cs_test_1") });

    expect(message).not.toHaveProperty("redirect_url");
    expect(message).toMatchObject({ product_identifier: "", checkout_context_id: "" });
    expect(decodeURIComponent(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("url") ?? "")).toContain(
      "_sw_checkout_session_id_stripe=cs_test_1",
    );
  });

  it("reports a failed checkout when the lookup cannot be built, fails, or answers nothing usable", async () => {
    const fail = { event_name: "stripe_checkout_fail", checkout_context_id: "", product_identifier: "stripe|test:price_1:no-trial" };
    expect(await completeCheckout(API, "pk", PRODUCTS, {})).toEqual(fail);

    fetchMock.mockResolvedValue(Response.json({ behavior: "redeem" }));
    expect(await completeCheckout(API, "pk", PRODUCTS, { checkout_context_id: "ctx_1" })).toMatchObject({ event_name: "stripe_checkout_fail" });

    fetchMock.mockResolvedValue(Response.json(LOOKUP, { status: 500 }));
    expect(await completeCheckout(API, "pk", PRODUCTS, { checkout_context_id: "ctx_1" })).toMatchObject({ event_name: "stripe_checkout_fail" });

    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await completeCheckout(API, "pk", PRODUCTS, { checkout_context_id: "ctx_1" })).toMatchObject({ event_name: "stripe_checkout_fail" });
  });
});
