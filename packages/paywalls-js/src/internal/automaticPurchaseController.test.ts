import { it, expect } from "@effect/vitest";
import {
  createAutomaticPurchaseController,
  type AutomaticPurchaseControllerDeps,
  type RedemptionOutcome,
} from "./automaticPurchaseController.ts";
import type { Entitlement, SubscriptionStatus } from "../types.ts";
import type { PaywallPurchaseEvent } from "../presenter.ts";

interface Stub {
  deps: AutomaticPurchaseControllerDeps;
  fire: (ev: PaywallPurchaseEvent) => void;
  redeems: string[];
  refreshes: number;
  setStatuses: SubscriptionStatus[];
  warnings: string[];
}

const stubDeps = (overrides: {
  redeem?: (code: string) => Promise<RedemptionOutcome>;
  refresh?: () => Promise<Entitlement[] | null>;
  location?: { search: string; href: string };
}): Stub => {
  const handlers = new Set<(ev: PaywallPurchaseEvent) => void>();
  const stub: Stub = {
    redeems: [],
    refreshes: 0,
    setStatuses: [],
    warnings: [],
    fire: (ev) => handlers.forEach((h) => h(ev)),
    deps: {
      subscribe: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      redeem: async (code) => {
        stub.redeems.push(code);
        return overrides.redeem
          ? overrides.redeem(code)
          : { status: "success", entitlements: [] };
      },
      refreshEntitlements: async () => {
        stub.refreshes++;
        return overrides.refresh ? overrides.refresh() : null;
      },
      setSubscriptionStatus: (s) => {
        stub.setStatuses.push(s);
      },
      logWarn: (msg) => {
        stub.warnings.push(msg);
      },
      ...(overrides.location && { location: overrides.location }),
    },
  };
  return stub;
};

it("purchase() resolves on post_checkout_complete and leaves entitlements to the post-checkout handler", async () => {
  const stub = stubDeps({});
  const controller = createAutomaticPurchaseController(stub.deps);
  const promise = controller.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  // stripe_checkout_complete is in-flight, NOT terminal — should not resolve.
  queueMicrotask(() => {
    stub.fire({
      type: "complete",
      productId: "pro_yearly",
      entitlements: [{ id: "pro", productIds: ["pro_yearly"] }],
    });
    // Terminal signal once the paywall's WebPaywallController finishes its
    // post-checkout server work.
    stub.fire({
      type: "postCheckout",
      productId: "pro_yearly",
      checkout: {
        productId: "pro_yearly",
        checkoutContextId: "ckctx_test",
        claimed: false,
        redemptionCodes: ["redemption_abc"],
      },
    });
  });
  const r = await promise;
  expect(r.type).toBe("purchased");
  // Status + redemption are `internal/postCheckout.ts`'s job (or the
  // developer's `onPurchase`) — the controller must not pre-empt either.
  expect(stub.setStatuses).toHaveLength(0);
  expect(stub.redeems).toHaveLength(0);
  expect(stub.refreshes).toBe(0);
});

it("purchase() resolves cancelled on stripe_checkout_abandon", async () => {
  const stub = stubDeps({});
  const controller = createAutomaticPurchaseController(stub.deps);
  const promise = controller.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  queueMicrotask(() => {
    stub.fire({ type: "abandon", productId: "pro_yearly" });
  });
  const r = await promise;
  expect(r.type).toBe("cancelled");
  expect(stub.setStatuses).toEqual([]);
});

it("purchase() ignores events for other products", async () => {
  const stub = stubDeps({});
  const controller = createAutomaticPurchaseController(stub.deps);
  const promise = controller.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  queueMicrotask(() => {
    stub.fire({
      type: "postCheckout",
      productId: "other_product",
      checkout: {
        productId: "other_product",
        checkoutContextId: "ckctx_other",
        claimed: true,
        redemptionCodes: [],
      },
    });
    stub.fire({
      type: "postCheckout",
      productId: "pro_yearly",
      checkout: {
        productId: "pro_yearly",
        checkoutContextId: "ckctx_test",
        claimed: true,
        redemptionCodes: [],
      },
    });
  });
  const r = await promise;
  expect(r.type).toBe("purchased");
});

it("restorePurchases() calls refreshEntitlements + flips sub status", async () => {
  const stub = stubDeps({
    refresh: async () => [
      {
        id: "pro",
        type: "SERVICE_LEVEL" as const,
        isActive: true,
        productIds: ["pro_yearly"],
      },
    ],
  });
  const controller = createAutomaticPurchaseController(stub.deps);
  const r = await controller.restorePurchases();
  expect(r.type).toBe("restored");
  expect(stub.refreshes).toBe(1);
  expect(stub.setStatuses[0]!.status).toBe("ACTIVE");
});

it("restorePurchases() returns restored even when refresh returns null (network blip)", async () => {
  const stub = stubDeps({ refresh: async () => null });
  const controller = createAutomaticPurchaseController(stub.deps);
  const r = await controller.restorePurchases();
  expect(r.type).toBe("restored");
  // Sub status NOT touched on null result.
  expect(stub.setStatuses).toEqual([]);
});

it("onConfigured() detects ?code=redemption_xxx in URL and redeems it", async () => {
  const replaced: string[] = [];
  const stub = stubDeps({
    redeem: async () => ({
      status: "success",
      entitlements: [
        {
          id: "pro",
          type: "SERVICE_LEVEL" as const,
          isActive: true,
          productIds: ["pro_yearly"],
        },
      ],
    }),
    location: {
      search: "?code=redemption_test_abc&utm_source=email",
      href: "https://app.test/?code=redemption_test_abc&utm_source=email",
    },
  });
  const deps: AutomaticPurchaseControllerDeps = {
    ...stub.deps,
    replaceHistory: (url) => replaced.push(url),
  };
  const controller = createAutomaticPurchaseController(deps);
  await controller.onConfigured!();
  expect(stub.redeems).toEqual(["redemption_test_abc"]);
  expect(stub.setStatuses[0]!.status).toBe("ACTIVE");
  expect(replaced[0]).toBe("https://app.test/?utm_source=email");
});

it("onConfigured() ignores ?code= values that don't match the redemption_ prefix", async () => {
  const stub = stubDeps({
    location: {
      search: "?code=other_abc",
      href: "https://app.test/?code=other_abc",
    },
  });
  const controller = createAutomaticPurchaseController(stub.deps);
  await controller.onConfigured!();
  expect(stub.redeems).toEqual([]);
});
