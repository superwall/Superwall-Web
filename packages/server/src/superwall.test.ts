import { afterEach, describe, expect, test } from "bun:test";
import { Superwall } from "./superwall.ts";
import type { FetchLike } from "./types.ts";

const realFetch = globalThis.fetch;
const setFetch = (impl: FetchLike): void => {
  (globalThis as unknown as { fetch: FetchLike }).fetch = impl;
};

const okResponse = (
  entitlements: Array<{ id: string; isActive: boolean }>,
): Response =>
  new Response(JSON.stringify({ entitlements }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  (globalThis as unknown as { fetch: typeof realFetch }).fetch = realFetch;
});

describe("Superwall() factory", () => {
  test("rejects missing apiKey", () => {
    expect(() => Superwall({ apiKey: "" })).toThrow(TypeError);
  });

  test("getEntitlements returns parsed bucket", async () => {
    setFetch(async () =>
      okResponse([
        { id: "pro", isActive: true },
        { id: "team", isActive: false },
      ]),
    );
    const sw = Superwall({ apiKey: "k" });
    const ents = await sw.getEntitlements("u1");
    expect(ents.active.map((e) => e.id)).toEqual(["pro"]);
    expect(ents.inactive.map((e) => e.id)).toEqual(["team"]);
  });

  test("userHas (string) returns true when entitlement is active", async () => {
    setFetch(async () => okResponse([{ id: "pro", isActive: true }]));
    const sw = Superwall({ apiKey: "k" });
    expect(await sw.userHas("u", "pro")).toBe(true);
  });

  test("userHas (string) returns false when entitlement is inactive", async () => {
    setFetch(async () => okResponse([{ id: "pro", isActive: false }]));
    const sw = Superwall({ apiKey: "k" });
    expect(await sw.userHas("u", "pro")).toBe(false);
  });

  test("userHas (array) requires all", async () => {
    setFetch(async () =>
      okResponse([
        { id: "pro", isActive: true },
        { id: "team", isActive: true },
      ]),
    );
    const sw = Superwall({ apiKey: "k" });
    expect(await sw.userHas("u", ["pro", "team"])).toBe(true);
    expect(await sw.userHas("u", ["pro", "missing"])).toBe(false);
  });

  test("userHas ({ any }) returns true when any active", async () => {
    setFetch(async () => okResponse([{ id: "team", isActive: true }]));
    const sw = Superwall({ apiKey: "k" });
    expect(await sw.userHas("u", { any: ["pro", "team"] })).toBe(true);
  });

  test("caches subsequent reads for the same userId", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return okResponse([{ id: "pro", isActive: true }]);
    });
    const sw = Superwall({ apiKey: "k" });
    await sw.getEntitlements("u1");
    await sw.getEntitlements("u1");
    await sw.userHas("u1", "pro");
    expect(calls).toBe(1);
  });

  test("invalidate forces a refetch", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return okResponse([{ id: "pro", isActive: true }]);
    });
    const sw = Superwall({ apiKey: "k" });
    await sw.getEntitlements("u1");
    await sw.invalidate("u1");
    await sw.getEntitlements("u1");
    expect(calls).toBe(2);
  });

  test("invalidateAll clears every entry", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return okResponse([{ id: "pro", isActive: true }]);
    });
    const sw = Superwall({ apiKey: "k" });
    await sw.getEntitlements("a");
    await sw.getEntitlements("b");
    await sw.invalidateAll();
    await sw.getEntitlements("a");
    await sw.getEntitlements("b");
    expect(calls).toBe(4);
  });

  test("TTL expiry forces a refetch", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return okResponse([{ id: "pro", isActive: true }]);
    });
    const sw = Superwall({ apiKey: "k", cache: { ttlMs: 1 } });
    await sw.getEntitlements("u1");
    await new Promise((r) => setTimeout(r, 5));
    await sw.getEntitlements("u1");
    expect(calls).toBe(2);
  });

  test("onRequest fires with cache hit info", async () => {
    const calls: Array<{ cacheHit: boolean; userId: string }> = [];
    setFetch(async () => okResponse([{ id: "pro", isActive: true }]));
    const sw = Superwall({
      apiKey: "k",
      onRequest: (info) =>
        calls.push({ cacheHit: info.cacheHit, userId: info.userId }),
    });
    await sw.getEntitlements("u1");
    await sw.getEntitlements("u1");
    expect(calls).toEqual([
      { cacheHit: false, userId: "u1" },
      { cacheHit: true, userId: "u1" },
    ]);
  });

  test("onRequest throwing does not break the request", async () => {
    setFetch(async () => okResponse([{ id: "pro", isActive: true }]));
    const sw = Superwall({
      apiKey: "k",
      onRequest: () => {
        throw new Error("boom");
      },
    });
    const ents = await sw.getEntitlements("u1");
    expect(ents.active).toHaveLength(1);
  });
});
