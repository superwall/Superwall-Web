import { it, expect } from "@effect/vitest";
import {
  applyCheckoutEntitlements,
  type PostCheckoutDeps,
} from "./postCheckout.ts";
import type {
  CheckoutCompletion,
  Entitlement,
  SubscriptionStatus,
} from "../types.ts";

const ent = (id: string, isActive = true): Entitlement => ({
  id,
  type: "SERVICE_LEVEL",
  isActive,
  productIds: ["pro_yearly"],
});

const checkout = (
  overrides: Partial<CheckoutCompletion> = {},
): CheckoutCompletion => ({
  productId: "pro_yearly",
  checkoutContextId: "ckctx_test",
  claimed: true,
  redemptionCodes: [],
  ...overrides,
});

const stubDeps = (overrides: {
  refresh?: () => Promise<Entitlement[] | null>;
  entitlementsByProduct?: Record<string, string[]>;
} = {}) => {
  const stub = {
    refreshes: 0,
    statuses: [] as SubscriptionStatus[],
    tokens: [] as string[],
    warnings: [] as string[],
    deps: null as unknown as PostCheckoutDeps,
  };
  stub.deps = {
    refreshEntitlements: async () => {
      stub.refreshes++;
      return overrides.refresh ? overrides.refresh() : null;
    },
    setSubscriptionStatus: (s) => stub.statuses.push(s),
    setEntitlementsToken: (t) => stub.tokens.push(t),
    resolveEntitlementsForProduct: (productId) =>
      overrides.entitlementsByProduct?.[productId] ?? [],
    logWarn: (msg) => stub.warnings.push(msg),
  };
  return stub;
};

const settle = () => new Promise<void>((r) => setTimeout(r, 5));

it("claimed: flips ACTIVE from config entitlement ids synchronously, applies the token, reconciles in the background", async () => {
  const stub = stubDeps({
    entitlementsByProduct: { pro_yearly: ["pro", "premium"] },
    refresh: async () => [ent("pro"), ent("premium"), ent("lapsed", false)],
  });
  applyCheckoutEntitlements(
    checkout({
      claimed: true,
      // Fresh codes the buyer can still use on their phone. There's no redeem
      // dep at all — the handler has no way to spend them.
      redemptionCodes: ["redemption_for_the_phone"],
      entitlementsToken: "jwt.token.sig",
    }),
    stub.deps,
  );
  expect(stub.tokens).toEqual(["jwt.token.sig"]);
  // Granted by the time the call returns — teardown follows it synchronously,
  // so `onDismiss` / `feature()` must already see ACTIVE. No network wait.
  expect(stub.statuses).toHaveLength(1);
  expect(stub.statuses[0]).toMatchObject({ status: "ACTIVE" });
  if (stub.statuses[0]!.status === "ACTIVE") {
    expect(stub.statuses[0]!.entitlements.map((e) => e.id)).toEqual(["pro", "premium"]);
  }
  await settle();
  expect(stub.refreshes).toBe(1);
  const last = stub.statuses.at(-1)!;
  if (last.status === "ACTIVE") {
    // Reconcile applies /entitlements verbatim: active ones only.
    expect(last.entitlements.map((e) => e.id)).toEqual(["pro", "premium"]);
  }
});

it("claimed: no config mapping for the product falls back to a placeholder entitlement", async () => {
  const stub = stubDeps();
  applyCheckoutEntitlements(checkout({ productId: "primary" }), stub.deps);
  expect(stub.statuses[0]).toEqual({
    status: "ACTIVE",
    entitlements: [
      { id: "primary", type: "SERVICE_LEVEL", isActive: true, productIds: ["primary"] },
    ],
  });
});

it("claimed: a failed reconcile is swallowed and leaves the optimistic ACTIVE in place", async () => {
  const stub = stubDeps({
    refresh: async () => {
      throw new Error("offline");
    },
  });
  applyCheckoutEntitlements(checkout(), stub.deps);
  await settle();
  expect(stub.statuses).toHaveLength(1);
  expect(stub.warnings).toContain("post-checkout entitlements refresh failed");
});

it("unclaimed: grants nothing — no status, no token, no entitlements read; the grant is the server's job", async () => {
  const stub = stubDeps({ refresh: async () => [ent("pro")] });
  applyCheckoutEntitlements(
    checkout({
      claimed: false,
      redemptionCodes: ["redemption_a", "redemption_b"],
      entitlementsToken: "jwt.token.sig",
    }),
    stub.deps,
  );
  await settle();
  expect(stub.statuses).toEqual([]);
  expect(stub.tokens).toEqual([]);
  expect(stub.refreshes).toBe(0);
  expect(stub.warnings).toEqual([]);
});
