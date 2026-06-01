// Type-level sanity checks. Most assertions are compile-time (tsc enforces);
// runtime expectations cover only the few cases that aren't.
//
// Module augmentation is exercised via a separate fixture file
// (./types.augmentation.test.ts) so this file stays type-only.

import { test, expect } from "bun:test";
import type {
  ConfigurationStatus,
  Entitlement,
  IntegrationAttribute,
  JsonValue,
  PartialSuperwallOptions,
  PaywallResult,
  PaywallSkippedReason,
  PresentationResult,
  RestoreType,
  SubscriptionStatus,
  SuperwallOptions,
  TriggerResult,
} from "./types.ts";

test("discriminated unions narrow on `type` (compile-time)", () => {
  const result: PaywallResult = { type: "purchased", productId: "pro_yearly" };
  if (result.type === "purchased") {
    expect(result.productId).toBe("pro_yearly");
  } else {
    throw new Error("unreachable");
  }

  const skipped: PaywallSkippedReason = { type: "noAudienceMatch" };
  if (skipped.type === "noAudienceMatch") {
    expect(true).toBe(true);
  }

  const trigger: TriggerResult = { type: "error", error: "boom" };
  if (trigger.type === "error") {
    expect(trigger.error).toBe("boom");
  }

  const presented: PresentationResult = { type: "paywallNotAvailable" };
  expect(presented.type).toBe("paywallNotAvailable");

  const restore: RestoreType = { type: "viaRestore" };
  expect(restore.type).toBe("viaRestore");
});

test("SubscriptionStatus narrows on `status`", () => {
  const s: SubscriptionStatus = { status: "ACTIVE", entitlements: [] };
  if (s.status === "ACTIVE") {
    expect(Array.isArray(s.entitlements)).toBe(true);
  }
});

test("Entitlement.type is the closed literal SERVICE_LEVEL", () => {
  const e: Entitlement = {
    id: "pro",
    type: "SERVICE_LEVEL",
    isActive: true,
    productIds: ["pro_yearly", "pro_monthly"],
  };
  expect(e.type).toBe("SERVICE_LEVEL");
});

test("PartialSuperwallOptions accepts deeply partial input", () => {
  const opts: PartialSuperwallOptions = {
    paywalls: { closeOnBackdrop: false },
    logging: { level: "debug" },
  };
  expect(opts.paywalls?.closeOnBackdrop).toBe(false);
});

test("SuperwallOptions networkEnvironment accepts custom hosts", () => {
  const opts: SuperwallOptions = {
    networkEnvironment: {
      custom: {
        base: "api.example.test",
        collector: "collector.example.test",
        enrichment: "enrich.example.test",
        subscriptions: "subs.example.test",
      },
    },
  };
  if (typeof opts.networkEnvironment === "object") {
    expect(opts.networkEnvironment.custom.base).toBe("api.example.test");
  }
});

test("ConfigurationStatus is the closed three-state union", () => {
  const states: ConfigurationStatus[] = ["pending", "configured", "failed"];
  expect(states).toEqual(["pending", "configured", "failed"]);
});

test("IntegrationAttribute is a closed union (compile-time)", () => {
  const attr: IntegrationAttribute = "mixpanelDistinctId";
  expect(attr).toBe("mixpanelDistinctId");
  // @ts-expect-error — "twitterId" is not in the closed set
  const bad: IntegrationAttribute = "twitterId";
  // The cast is the assertion: if `IntegrationAttribute` ever opened up,
  // the @ts-expect-error above would fail and tsc would catch it.
  expect(bad as string).toBe("twitterId");
});

test("JsonValue accepts nested values (compile-time)", () => {
  const v: JsonValue = { a: 1, b: [true, null, { c: "d" }] };
  expect(v).toBeTruthy();
});
