import { test, expect } from "bun:test";
import { parseEntitlements, type WebEntitlementsResponse } from "./wire.ts";

test("parseEntitlements reads the BE `identifier` field (not `id`)", () => {
  // Real BE shape: customerInfo.entitlements[].identifier + isActive.
  const res: WebEntitlementsResponse = {
    entitlements: [],
    customerInfo: {
      entitlements: [
        {
          identifier: "best",
          type: "SERVICE_LEVEL",
          isActive: true,
          productIds: ["test:price_a", "test:price_b"],
        },
      ],
    },
  };
  const out = parseEntitlements(res);
  expect(out.all).toHaveLength(1);
  expect(out.all[0]!.id).toBe("best");
  expect(out.active.map((e) => e.id)).toEqual(["best"]);
  expect(out.inactive).toHaveLength(0);
});

test("parseEntitlements: isActive:false → inactive bucket, id still resolved", () => {
  const res: WebEntitlementsResponse = {
    customerInfo: {
      entitlements: [
        { identifier: "best", isActive: false, productIds: ["p"] },
      ],
    },
  };
  const out = parseEntitlements(res);
  expect(out.active).toHaveLength(0);
  expect(out.inactive[0]!.id).toBe("best");
});

test("parseEntitlements: legacy `id` field still works", () => {
  const res: WebEntitlementsResponse = {
    entitlements: [{ id: "pro", isActive: true, productIds: [] }],
  };
  const out = parseEntitlements(res);
  expect(out.all[0]!.id).toBe("pro");
});
