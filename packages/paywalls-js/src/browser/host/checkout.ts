// Ending a hosted paywall's checkout the way the web paywall app's
// controller does (`stripe_checkout_complete` in web-paywalls): the paywall
// has taken the payment and called `complete-webapp` itself (as pjs does),
// then reports `stripe_checkout_complete` with the claim. The host looks the
// checkout up (`/api/post-checkout-redirect`) and turns it into the
// `post_checkout_complete` the SDK's post-checkout handling reads.

import { storePrefixedOf, type HostedProduct } from "./products.ts";
import { isRecord, stringOf } from "./values.ts";

export type HostMessage = { event_name?: string; [key: string]: unknown };

export type RedemptionCode = { code: string; claimed: boolean };

type PostCheckoutAnswer = {
  behavior?: string;
  redirectUrl?: string;
  redemption?: { url?: string; codes?: string[]; deepLinks?: unknown };
  transactionData?: {
    transactionId: string;
    productIdentifier: string;
    currency?: string;
    value?: number;
  };
};

/** The Stripe id inside an `sw_checkout_…` id (base64url JSON). */
export const decodeStripeCheckoutId = (swCheckoutId: string | undefined): string | null => {
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

/** The page `/api/post-checkout-redirect` resolves, as the controller's
 *  `getStripeCheckoutCompletePostCheckoutUrl` builds it: by the Stripe
 *  checkout session, else the subscription, else the checkout context and
 *  the product's store and environment. `null` without any of them. */
export const postCheckoutUrl = (
  apiBase: string,
  products: readonly HostedProduct[],
  message: { swCheckoutId?: string; checkoutContextId?: string; productIdentifier: string },
): string | null => {
  const stripeCheckoutId = decodeStripeCheckoutId(message.swCheckoutId);
  const sessionId = stripeCheckoutId?.split("_secret_")[0] ?? stripeCheckoutId;
  if (sessionId?.startsWith("cs_test_") || sessionId?.startsWith("cs_live_")) {
    return new URL(
      `/post-checkout?_sw_checkout_session_id_stripe=${encodeURIComponent(sessionId)}`,
      apiBase,
    ).toString();
  }
  if (stripeCheckoutId?.startsWith("sub_")) {
    return new URL(
      `/post-checkout?sw_checkout_id=${encodeURIComponent(message.swCheckoutId!)}`,
      apiBase,
    ).toString();
  }
  if (!message.checkoutContextId) return null;
  const match = storePrefixedOf(products, message.productIdentifier).match(/^([^|]+)\|([^:]+):/);
  const store = match?.[1]?.toLowerCase() || "stripe";
  const environment = match?.[2]?.toLowerCase() || "live";
  return new URL(
    `/sw/checkout/post-checkout/${encodeURIComponent(store)}/${encodeURIComponent(
      environment,
    )}?checkout_context_id=${encodeURIComponent(message.checkoutContextId)}`,
    apiBase,
  ).toString();
};

export const redemptionCodesOf = (value: unknown): RedemptionCode[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isRecord(entry) && typeof entry.code === "string"
          ? [{ code: entry.code, claimed: entry.claimed === true }]
          : [],
      )
    : [];

/** Resolves a paywall's `stripe_checkout_complete` into the
 *  `post_checkout_complete` the controller would post, or the
 *  `stripe_checkout_fail` it posts when the lookup cannot be made. */
export const completeCheckout = async (
  apiBase: string,
  apiKey: string,
  products: readonly HostedProduct[],
  message: HostMessage,
): Promise<HostMessage> => {
  const checkoutContextId = stringOf(message.checkout_context_id) ?? "";
  const productIdentifier =
    stringOf(message.product_identifier) ?? products[0]?.storeIdentifier ?? "";
  const failure: HostMessage = {
    event_name: "stripe_checkout_fail",
    checkout_context_id: checkoutContextId,
    product_identifier: productIdentifier,
  };
  const url = postCheckoutUrl(apiBase, products, {
    ...(stringOf(message.sw_checkout_id) ? { swCheckoutId: String(message.sw_checkout_id) } : {}),
    ...(checkoutContextId ? { checkoutContextId } : {}),
    productIdentifier,
  });
  if (!url) return failure;

  try {
    const response = await fetch(
      `${apiBase}/api/post-checkout-redirect?url=${encodeURIComponent(url)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey.startsWith("pk_") ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          resolution: isRecord(message.post_purchase_resolution)
            ? message.post_purchase_resolution
            : { type: "default" },
        }),
      },
    );
    const data = (await response.json()) as PostCheckoutAnswer;
    if (!response.ok || !data?.redirectUrl) return failure;

    // The button's redirect or the application's, else the redemption page
    // for these codes; /app-link and /manage never travel.
    const redirectUrl =
      data.behavior === "redirect"
        ? data.redirectUrl
        : data.redemption?.codes?.length
          ? data.redemption.url
          : undefined;
    // Every code known for this checkout: what complete-webapp returned (with
    // its claim), plus any the lookup added.
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
};
