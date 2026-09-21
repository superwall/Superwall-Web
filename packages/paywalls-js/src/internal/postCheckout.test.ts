import { it, expect } from "@effect/vitest";
import {
  applyCheckoutEntitlements,
  type PostCheckoutDeps,
} from "./postCheckout.ts";
import type { RedemptionOutcome } from "./automaticPurchaseController.ts";
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
  redeem?: (code: string, attempt: number) => RedemptionOutcome | Promise<RedemptionOutcome>;
  refresh?: () => Promise<Entitlement[] | null>;
  entitlementsByProduct?: Record<string, string[]>;
} = {}) => {
  const stub = {
    redeems: [] as string[],
    refreshes: 0,
    statuses: [] as SubscriptionStatus[],
    tokens: [] as string[],
    warnings: [] as string[],
    deps: null as unknown as PostCheckoutDeps,
  };
  stub.deps = {
    redeem: async (code) => {
      stub.redeems.push(code);
      const attempt = stub.redeems.filter((c) => c === code).length;
      return overrides.redeem
        ? overrides.redeem(code, attempt)
        : { status: "success", entitlements: [ent("pro")] };
    },
    refreshEntitlements: async () => {
      stub.refreshes++;
      return overrides.refresh ? overrides.refresh() : null;
    },
    setSubscriptionStatus: (s) => stub.statuses.push(s),
    setEntitlementsToken: (t) => stub.tokens.push(t),
    resolveEntitlementsForProduct: (productId) =>
      overrides.entitlementsByProduct?.[productId] ?? [],
    logWarn: (msg) => stub.warnings.push(msg),
    retryDelaysMs: [0, 0],
  };
  return stub;
};

const settle = () => new Promise<void>((r) => setTimeout(r, 5));

it("claimed: flips ACTIVE from config entitlement ids, applies the token, reconciles — and NEVER redeems the codes", async () => {
  const stub = stubDeps({
    entitlementsByProduct: { pro_yearly: ["pro", "premium"] },
    refresh: async () => [ent("pro"), ent("premium"), ent("lapsed", false)],
  });
  await applyCheckoutEntitlements(
    checkout({
      claimed: true,
      // Fresh codes the buyer can still use on their phone.
      redemptionCodes: ["redemption_for_the_phone"],
      entitlementsToken: "jwt.token.sig",
    }),
    stub.deps,
  );
  expect(stub.redeems).toEqual([]);
  expect(stub.tokens).toEqual(["jwt.token.sig"]);
  // Optimistic flip is synchronous with the call — no network wait.
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
  await applyCheckoutEntitlements(checkout({ productId: "primary" }), stub.deps);
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
  await applyCheckoutEntitlements(checkout(), stub.deps);
  await settle();
  expect(stub.statuses).toHaveLength(1);
  expect(stub.warnings).toContain("post-checkout entitlements refresh failed");
});

it("unclaimed: redeems every code and flips ACTIVE from the redeem response, without an optimistic flip", async () => {
  const stub = stubDeps();
  await applyCheckoutEntitlements(
    checkout({ claimed: false, redemptionCodes: ["redemption_a", "redemption_b"] }),
    stub.deps,
  );
  expect(stub.redeems).toEqual(["redemption_a", "redemption_b"]);
  expect(stub.refreshes).toBe(0);
  expect(stub.statuses).toEqual([
    { status: "ACTIVE", entitlements: [ent("pro")] },
    { status: "ACTIVE", entitlements: [ent("pro")] },
  ]);
});

it("unclaimed: retries a transient error (redeeming is idempotent for the same identity)", async () => {
  const stub = stubDeps({
    redeem: (_code, attempt) =>
      attempt < 3
        ? { status: "error", entitlements: [] }
        : { status: "success", entitlements: [ent("pro")] },
  });
  await applyCheckoutEntitlements(
    checkout({ claimed: false, redemptionCodes: ["redemption_a"] }),
    stub.deps,
  );
  expect(stub.redeems).toEqual(["redemption_a", "redemption_a", "redemption_a"]);
  expect(stub.statuses).toEqual([{ status: "ACTIVE", entitlements: [ent("pro")] }]);
});

it("unclaimed: gives up after the retry budget, and a throwing redeem never rejects", async () => {
  const stub = stubDeps({
    redeem: () => {
      throw new Error("network down");
    },
  });
  await expect(
    applyCheckoutEntitlements(
      checkout({ claimed: false, redemptionCodes: ["redemption_a"] }),
      stub.deps,
    ),
  ).resolves.toBeUndefined();
  expect(stub.redeems).toHaveLength(3);
  expect(stub.statuses).toEqual([]);
  expect(stub.warnings).toContain("post-checkout redemption failed");
});

it("unclaimed: expired / invalid are final — no retry", async () => {
  const stub = stubDeps({ redeem: () => ({ status: "invalid", entitlements: [] }) });
  await applyCheckoutEntitlements(
    checkout({ claimed: false, redemptionCodes: ["redemption_bad"] }),
    stub.deps,
  );
  expect(stub.redeems).toEqual(["redemption_bad"]);
  expect(stub.statuses).toEqual([]);
});

it("unclaimed with no codes: nothing to redeem, so reconcile from /entitlements", async () => {
  const stub = stubDeps({ refresh: async () => [ent("pro")] });
  await applyCheckoutEntitlements(checkout({ claimed: false }), stub.deps);
  expect(stub.redeems).toEqual([]);
  expect(stub.refreshes).toBe(1);
  expect(stub.statuses).toEqual([{ status: "ACTIVE", entitlements: [ent("pro")] }]);
});
