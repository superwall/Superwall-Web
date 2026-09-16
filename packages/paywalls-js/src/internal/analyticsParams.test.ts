import { expect, it } from "vitest";
import type { PaywallInfo } from "../types.ts";
import { encodeSlice, toWireParameters } from "./analyticsParams.ts";

const info: PaywallInfo = {
  databaseId: "76628",
  identifier: "deep-quiz-paywall",
  name: "Deep Quiz",
  url: "https://paywalls.superwall.test/deep-quiz-paywall",
  productIds: ["price_1", "price_2"],
  products: [],
  experiment: {
    id: "175410",
    groupId: "grp_1",
    variant: { id: "632200", type: "treatment", paywallId: "deep-quiz-paywall" },
  },
  presentedByPlacementWithName: "web_funnel",
  presentedBy: "placement",
  presentationSourceType: "register",
};

it("encodeSlice prefixes snake_case keys and repeats audience keys without the prefix", () => {
  expect(
    encodeSlice({ paywallId: "1", paywallUrl: "https://x", missing: undefined }, ["paywallId"]),
  ).toEqual({
    $paywall_id: "1",
    paywall_id: "1",
    $paywall_url: "https://x",
  });
});

it("trigger_fire with a paywall result maps to flat present attribution", () => {
  expect(
    toWireParameters("trigger_fire", {
      placementName: "web_funnel",
      result: { type: "paywall", experiment: info.experiment! },
    }),
  ).toEqual({
    $trigger_name: "web_funnel",
    $result: "present",
    $experiment_id: "175410",
    $variant_id: "632200",
    $paywall_identifier: "deep-quiz-paywall",
  });
});

it("trigger_fire holdout and noAudienceMatch use the native result names", () => {
  expect(
    toWireParameters("trigger_fire", {
      placementName: "web_funnel",
      result: { type: "holdout", experiment: info.experiment! },
    }),
  ).toMatchObject({ $result: "holdout", $experiment_id: "175410", $variant_id: "632200" });
  expect(
    toWireParameters("trigger_fire", {
      placementName: "web_funnel",
      result: { type: "noAudienceMatch" },
    }),
  ).toEqual({ $trigger_name: "web_funnel", $result: "no_rule_match" });
});

it("paywall events flatten paywall_info into ClickHouse attribution fields", () => {
  const params = toWireParameters("paywall_close", {
    paywall_info: info,
    close_reason: "manualClose",
  });
  expect(params).toEqual({
    close_reason: "manualClose",
    $experiment_id: "175410",
    $variant_id: "632200",
    $paywall_id: "76628",
    paywall_id: "76628",
    $paywall_identifier: "deep-quiz-paywall",
    $paywall_name: "Deep Quiz",
    paywall_name: "Deep Quiz",
    $paywall_product_ids: "price_1,price_2",
    paywall_product_ids: "price_1,price_2",
    $paywall_url: "https://paywalls.superwall.test/deep-quiz-paywall",
    $presentation_source_type: "register",
    presentation_source_type: "register",
    $presented_by: "placement",
    presented_by: "placement",
    $presented_by_event_name: "web_funnel",
  });
  expect(params).not.toHaveProperty("paywall_info");
});

it("transaction events send the product id instead of the product object", () => {
  const params = toWireParameters("transaction_abandon", {
    product: { id: "price_1", store: "stripe", entitlements: [] },
    paywall_info: info,
  });
  expect(params).toMatchObject({ $product_id: "price_1", $paywall_id: "76628" });
  expect(params).not.toHaveProperty("product");
});

it("events without paywall attribution pass through unchanged", () => {
  expect(toWireParameters("restore_fail", { reason: "nope" })).toEqual({ reason: "nope" });
});
