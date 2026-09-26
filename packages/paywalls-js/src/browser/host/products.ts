// A hosted paywall's products and their variables. The web paywall app's
// controller resolves variables from `/api/products/variables` before the
// paywall boots (`maybeResolveProductVariables`); the host makes the same
// call when the paywall pings, and keeps the answer so a paywall opened
// again prices on its first frame.

import { isRecord, recordOf, stringOf, type Slice } from "./values.ts";

export type HostedProduct = { reference: string; storeIdentifier: string };

export type ProductVariables = Record<string, Slice>;

/** The paywall's products as the price lookup names them —
 *  `stripe|test:price_…:no-trial` — from the config's snake_case
 *  `products_v2`, or a store-prefixed id when one is already given. */
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

export const withoutStorePrefix = (identifier: string): string =>
  identifier.replace(/^[^|]+\|/, "");

/** A product identifier as the collector and the post-checkout lookup want
 *  it: store-prefixed, matched to the paywall's products by reference or
 *  bare id first (the controller's `resolveStorePrefixedProductIdentifier`). */
export const storePrefixedOf = (
  products: readonly HostedProduct[],
  productIdentifier: string,
): string =>
  productIdentifier.includes("|")
    ? productIdentifier
    : (products.find(
        (product) =>
          product.reference === productIdentifier ||
          product.storeIdentifier === `stripe|${productIdentifier}`,
      )?.storeIdentifier ?? `stripe|${productIdentifier}`);

/** `POST {apiBase}/api/products/variables` — every product variable, keyed
 *  by the store-prefixed id. */
export const resolveProductVariables = async (
  apiBase: string,
  apiKey: string,
  products: readonly HostedProduct[],
): Promise<ProductVariables> => {
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

const CACHE_PREFIX = "superwall.productVariables:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const memory = new Map<string, ProductVariables>();

export const variablesCacheKey = (apiBase: string, products: readonly HostedProduct[]): string =>
  `${CACHE_PREFIX}${apiBase}|${products
    .map((product) => product.storeIdentifier)
    .sort()
    .join(",")}`;

/** The last answer for these products: this page's copy first, else one
 *  stored within the last day. */
export const readCachedVariables = (key: string): ProductVariables | undefined => {
  const inMemory = memory.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { at?: unknown; variables?: unknown };
    if (typeof stored.at !== "number" || Date.now() - stored.at > CACHE_TTL_MS) return undefined;
    return isRecord(stored.variables) ? (stored.variables as ProductVariables) : undefined;
  } catch {
    return undefined;
  }
};

export const writeCachedVariables = (key: string, variables: ProductVariables): void => {
  memory.set(key, variables);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ at: Date.now(), variables }));
  } catch {
    /* storage refused — this page's copy still serves */
  }
};

/** Prices the products: hands over a cached answer at once, then the live
 *  one when it differs. A failed lookup leaves the paywall unpriced, as
 *  paywall.js does. */
export const priceProducts = (
  apiBase: string,
  apiKey: string,
  products: readonly HostedProduct[],
  onPriced: (variables: ProductVariables) => void,
): Promise<void> => {
  if (products.length === 0) return Promise.resolve();
  const key = variablesCacheKey(apiBase, products);
  const cached = readCachedVariables(key);
  if (cached) onPriced(cached);
  return resolveProductVariables(apiBase, apiKey, products)
    .then((variables) => {
      writeCachedVariables(key, variables);
      if (JSON.stringify(variables) !== JSON.stringify(cached)) onPriced(variables);
    })
    .catch(() => undefined);
};

/** `template_variables.products` in the shape the native SDKs send:
 *  `[{ <reference>: variables }]`, for the products that were priced. */
export const pricedProducts = (
  products: readonly HostedProduct[],
  variables: ProductVariables,
): Array<Record<string, Slice>> =>
  products.flatMap((product) => {
    const productVariables = variables[product.storeIdentifier];
    return productVariables ? [{ [product.reference]: productVariables }] : [];
  });
