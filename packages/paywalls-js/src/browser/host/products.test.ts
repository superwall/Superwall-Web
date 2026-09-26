import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostedProductsOf,
  priceProducts,
  pricedProducts,
  readCachedVariables,
  resolveProductVariables,
  storePrefixedOf,
  variablesCacheKey,
  withoutStorePrefix,
  writeCachedVariables,
} from "./products.ts";

const PRODUCTS = [{ reference: "primary", storeIdentifier: "stripe|test:price_1:no-trial" }];
const PRICED = { "stripe|test:price_1:no-trial": { price: "$49.99", period: "year" } };

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let apiBaseCounter = 0;
const freshApiBase = () => `https://api-${++apiBaseCounter}.test`;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ products: PRICED }));
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hostedProductsOf", () => {
  it("names each config product the way the price lookup does", () => {
    expect(
      hostedProductsOf([
        {
          sw_composite_product_id: "test:price_1:no-trial",
          reference_name: "primary",
          store_product: { store: "STRIPE" },
        },
        { reference_name: "secondary", sw_composite_product_id: "live:price_2" },
        { referenceName: "tertiary", storePrefixedSuperwallCompositeProductIdentifier: "stripe|live:x" },
        { reference_name: "no-id" },
        "junk",
      ]),
    ).toEqual([
      { reference: "primary", storeIdentifier: "stripe|test:price_1:no-trial" },
      { reference: "secondary", storeIdentifier: "stripe|live:price_2" },
      { reference: "tertiary", storeIdentifier: "stripe|live:x" },
    ]);
    expect(hostedProductsOf(undefined)).toEqual([]);
  });
});

describe("store identifiers", () => {
  it("strips the store prefix", () => {
    expect(withoutStorePrefix("stripe|test:price_1")).toBe("test:price_1");
    expect(withoutStorePrefix("test:price_1")).toBe("test:price_1");
  });

  it("prefixes an id by matching the paywall's products, else as Stripe", () => {
    expect(storePrefixedOf(PRODUCTS, "primary")).toBe("stripe|test:price_1:no-trial");
    expect(storePrefixedOf(PRODUCTS, "test:price_1:no-trial")).toBe("stripe|test:price_1:no-trial");
    expect(storePrefixedOf(PRODUCTS, "stripe|live:other")).toBe("stripe|live:other");
    expect(storePrefixedOf(PRODUCTS, "live:other")).toBe("stripe|live:other");
  });
});

describe("resolveProductVariables", () => {
  it("asks the paywall API for the products' variables with the public key", async () => {
    const variables = await resolveProductVariables("https://api.test", "pk_web", PRODUCTS);

    expect(variables).toEqual(PRICED);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/products/variables");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer pk_web" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      productIdentifiers: ["stripe|test:price_1:no-trial"],
    });
  });

  it("keeps only records and fails on an error answer", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ products: { a: { price: "$1" }, b: "junk" } }));
    expect(await resolveProductVariables("https://api.test", "pk", PRODUCTS)).toEqual({ a: { price: "$1" } });

    fetchMock.mockResolvedValueOnce(Response.json({}));
    expect(await resolveProductVariables("https://api.test", "pk", PRODUCTS)).toEqual({});

    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(resolveProductVariables("https://api.test", "pk", PRODUCTS)).rejects.toThrow("503");
  });
});

describe("the variables cache", () => {
  it("keys by API base and the sorted product ids", () => {
    expect(
      variablesCacheKey("https://api.test", [
        { reference: "b", storeIdentifier: "stripe|b" },
        { reference: "a", storeIdentifier: "stripe|a" },
      ]),
    ).toBe("superwall.productVariables:https://api.test|stripe|a,stripe|b");
  });

  it("serves this page's copy, else a stored one within a day", () => {
    const key = variablesCacheKey(freshApiBase(), PRODUCTS);
    expect(readCachedVariables(key)).toBeUndefined();

    localStorage.setItem(key, JSON.stringify({ at: Date.now(), variables: PRICED }));
    expect(readCachedVariables(key)).toEqual(PRICED);

    localStorage.setItem(key, JSON.stringify({ at: Date.now() - 25 * 60 * 60 * 1000, variables: PRICED }));
    expect(readCachedVariables(key)).toBeUndefined();

    localStorage.setItem(key, JSON.stringify({ at: "yesterday", variables: PRICED }));
    expect(readCachedVariables(key)).toBeUndefined();

    localStorage.setItem(key, JSON.stringify({ at: Date.now(), variables: "junk" }));
    expect(readCachedVariables(key)).toBeUndefined();

    localStorage.setItem(key, "not json");
    expect(readCachedVariables(key)).toBeUndefined();

    writeCachedVariables(key, PRICED);
    localStorage.clear();
    expect(readCachedVariables(key)).toEqual(PRICED);
  });

  it("keeps this page's copy when storage refuses", () => {
    const key = variablesCacheKey(freshApiBase(), PRODUCTS);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });

    writeCachedVariables(key, PRICED);

    expect(readCachedVariables(key)).toEqual(PRICED);
  });
});

describe("priceProducts", () => {
  it("prices from the lookup, then from the cache on the next open, resending only a changed answer", async () => {
    const apiBase = freshApiBase();
    const first = vi.fn();
    await priceProducts(apiBase, "pk", PRODUCTS, first);
    expect(first.mock.calls).toEqual([[PRICED]]);

    const second = vi.fn();
    const pricing = priceProducts(apiBase, "pk", PRODUCTS, second);
    expect(second.mock.calls).toEqual([[PRICED]]);
    await pricing;
    expect(second).toHaveBeenCalledTimes(1);

    const changed = { "stripe|test:price_1:no-trial": { price: "$39.99" } };
    fetchMock.mockResolvedValueOnce(Response.json({ products: changed }));
    const third = vi.fn();
    await priceProducts(apiBase, "pk", PRODUCTS, third);
    expect(third.mock.calls).toEqual([[PRICED], [changed]]);
  });

  it("leaves the paywall unpriced when the lookup fails, and asks nothing without products", async () => {
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    const onPriced = vi.fn();

    await priceProducts(freshApiBase(), "pk", PRODUCTS, onPriced);
    await priceProducts(freshApiBase(), "pk", [], onPriced);
    await settle();

    expect(onPriced).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pricedProducts", () => {
  it("shapes the priced products the way the native SDKs send them", () => {
    expect(
      pricedProducts(
        [...PRODUCTS, { reference: "secondary", storeIdentifier: "stripe|unpriced" }],
        PRICED,
      ),
    ).toEqual([{ primary: { price: "$49.99", period: "year" } }]);
  });
});
