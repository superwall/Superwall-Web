// Tests for the tree-shakeable named-export proxies (API.md §2.7).
//
// IMPORTANT: each test must dispose its instance, otherwise the
// module-level default leaks into subsequent tests.

import { test, expect, beforeEach } from "bun:test";
import {
  createSuperwall,
  entitlements,
  events,
  getDefaultSuperwall,
  NoDefaultSuperwallError,
  placements,
  purchases,
  register,
  type StorageAdapter,
  user,
} from "./index.ts";
import { _resetDefaultForTests } from "./default.ts";

// Bun runs test files in parallel in the same process, so the module-level
// `_default` can leak between suites. Reset before each test so assertions
// about the pre-createSuperwall state are deterministic.
beforeEach(() => {
  _resetDefaultForTests();
});

const tick = () => new Promise<void>((r) => queueMicrotask(r));

const noopFetch = (() =>
  Promise.resolve(new Response("", { status: 204 }))) as unknown as typeof fetch;

const newAdapter = (): StorageAdapter => {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v);
    },
    remove: (k) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
  };
};

const make = () =>
  createSuperwall({
    apiKey: "pk_test",
    fetch: noopFetch,
    storage: newAdapter(),
  });

// ---------------------------------------------------------------------------
// Default-instance lifecycle
// ---------------------------------------------------------------------------

test("getDefaultSuperwall throws NoDefaultSuperwallError before createSuperwall", () => {
  expect(() => getDefaultSuperwall()).toThrow(NoDefaultSuperwallError);
});

test("first createSuperwall registers itself as the default; dispose clears", async () => {
  const sw = make();
  expect(getDefaultSuperwall()).toBe(sw);
  await sw.dispose();
  expect(() => getDefaultSuperwall()).toThrow(NoDefaultSuperwallError);
});

test("subsequent createSuperwall calls do NOT replace the default (first-wins)", async () => {
  const a = make();
  const b = make();
  expect(getDefaultSuperwall()).toBe(a);
  // Disposing the non-default should leave the default alone.
  await b.dispose();
  expect(getDefaultSuperwall()).toBe(a);
  await a.dispose();
});

// ---------------------------------------------------------------------------
// Pre-creation: methods throw on invocation, not property access
// ---------------------------------------------------------------------------

test("destructuring a method off a namespace before createSuperwall is legal", () => {
  // Property access is safe — the bug class P2-6 in the review.
  const { identify } = user;
  expect(typeof identify).toBe("function");
});

test("invoking the destructured method before createSuperwall throws NoDefaultSuperwallError", () => {
  const { identify } = user;
  expect(() => identify("u1")).toThrow(NoDefaultSuperwallError);
});

test("readable .value access on a namespace before createSuperwall throws on read", () => {
  // Property access on `user.id` returns the lazy Readable wrapper without
  // throwing; calling `.value` triggers the default-required throw.
  const id = user.id;
  expect(typeof id).toBe("object");
  expect(() => id.value).toThrow(NoDefaultSuperwallError);
});

// ---------------------------------------------------------------------------
// Wired up after createSuperwall
// ---------------------------------------------------------------------------

test("user.* delegates to the default instance after createSuperwall", async () => {
  const sw = make();
  await sw.ready;

  expect(user.id.value).toBe("");
  expect(user.aliasId.value).toBe(sw.user.aliasId.value);
  expect(user.isLoggedIn.value).toBe(false);

  await user.identify("u_42");
  await tick();
  expect(user.id.value).toBe("u_42");
  expect(user.isLoggedIn.value).toBe(true);
  expect(user.effectiveId.value).toBe("u_42");

  await user.signOut();
  await tick();
  expect(user.id.value).toBe("");
  expect(user.isLoggedIn.value).toBe(false);

  user.setIntegrationAttribute("mixpanelDistinctId", "abc");
  expect(user.integrationAttributes.value.mixpanelDistinctId).toBe("abc");
  user.setIntegrationAttribute("mixpanelDistinctId", null);
  expect(user.integrationAttributes.value.mixpanelDistinctId).toBeUndefined();

  await sw.dispose();
});

test("register routes to the default instance", async () => {
  const sw = make();
  await sw.ready;
  // No presenter wired → returns { type: "error", error: NoPresenterRegisteredError }.
  const r = await register({ placement: "p" });
  expect(r.type).toBe("error");
  await sw.dispose();
});

test("placements.getPresentationResult / confirmAllAssignments / preload route through", async () => {
  const sw = make();
  await sw.ready;
  expect(await placements.getPresentationResult("p")).toEqual({
    type: "placementNotFound",
  });
  expect(await placements.confirmAllAssignments()).toEqual([]);
  await placements.preloadAll();
  await placements.preloadFor(["a"]);
  await sw.dispose();
});

test("purchases.setSubscriptionStatus routes through and updates entitlements", async () => {
  const sw = make();
  await sw.ready;

  purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [
      { id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["p1"] },
    ],
  });
  await tick();

  expect(entitlements.active.value).toHaveLength(1);
  expect(entitlements.byProductIds(["p1"])).toHaveLength(1);
  expect(entitlements.byProductIds(["nope"])).toHaveLength(0);
  await sw.dispose();
});

test("events.addEventListener routes to the default instance's EventTarget", async () => {
  const sw = make();
  let count = 0;
  // Attach BEFORE ready — listener should fire as the lifecycle events drain.
  events.addEventListener("first_seen", () => count++);
  events.addEventListener("session_start", () => count++);
  await sw.ready;
  expect(count).toBeGreaterThan(0);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// After dispose
// ---------------------------------------------------------------------------

test("after dispose, named exports throw NoDefaultSuperwallError again", async () => {
  const sw = make();
  await sw.ready;
  await sw.dispose();

  expect(() => user.id.value).toThrow(NoDefaultSuperwallError);
  await expect(user.identify("u")).rejects.toBeInstanceOf(NoDefaultSuperwallError);
  await expect(register({ placement: "x" })).rejects.toBeInstanceOf(
    NoDefaultSuperwallError,
  );
});

// ---------------------------------------------------------------------------
// Multi-instance scenarios — explicit instance reads still work
// ---------------------------------------------------------------------------

test("explicit instance is unaffected by named-export proxy state", async () => {
  const a = make();
  const b = make();
  await Promise.all([a.ready, b.ready]);

  // Default is `a` (first-wins). Calling user.identify routes to `a`.
  await user.identify("user_via_default");
  await tick();
  expect(a.user.id.value).toBe("user_via_default");
  expect(b.user.id.value).toBe(""); // b was untouched

  await a.dispose();
  await b.dispose();
});

// Lazy Readable subscribe still honors sync-on-attach.
test("lazy Readable subscribe fires synchronously with current value", async () => {
  const sw = make();
  await sw.ready;
  const seen: string[] = [];
  const unsub = user.aliasId.subscribe((v) => seen.push(v));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatch(/^\$SuperwallAlias:/);
  unsub();
  await sw.dispose();
});
