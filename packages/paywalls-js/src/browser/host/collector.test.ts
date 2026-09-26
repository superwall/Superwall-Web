import { describe, expect, it } from "vitest";
import { collectorOf, userIdOf } from "./collector.ts";

const COLLECTOR = {
  url: "https://web-api.superwall.app/api/proxy/events",
  headers: { "x-public-api-key": "pk_web", "x-dropped": 7 },
  placementEventId: "placement-event-1",
  identity: { userId: { type: "appUserId", appUserId: "user_1" } },
  userAttributes: { email: "ada@example.com" },
  deviceAttributes: { $appInstallDate: "2026-01-01" },
  experimentSlice: { $experiment_id: "e1" },
  paywallSlice: { $paywall_id: "271256" },
  productSlice: { annual: { price: "$9.99" } },
  presentmentSlice: { $presented_by_event_name: "web_checkout" },
  placementParamsSlice: { $placement_params: {} },
};

describe("userIdOf", () => {
  it("reads either shape of the collector's user id", () => {
    expect(userIdOf({ type: "appUserId", appUserId: "u1" })).toEqual({ type: "appUserId", appUserId: "u1" });
    expect(userIdOf({ type: "aliasId", aliasId: "a1" })).toEqual({ type: "aliasId", aliasId: "a1" });
  });

  it("refuses anything else", () => {
    expect(userIdOf("u1")).toBeUndefined();
    expect(userIdOf({ type: "appUserId" })).toBeUndefined();
    expect(userIdOf({ type: "aliasId", aliasId: 1 })).toBeUndefined();
    expect(userIdOf({ type: "other", appUserId: "u1" })).toBeUndefined();
  });
});

describe("collectorOf", () => {
  it("reads the collector, keeping only string headers and copying what the host enriches", () => {
    const collector = collectorOf(COLLECTOR)!;

    expect(collector).toMatchObject({
      url: COLLECTOR.url,
      headers: { "x-public-api-key": "pk_web" },
      placementEventId: "placement-event-1",
      identity: { userId: { type: "appUserId", appUserId: "user_1" } },
      paywallSlice: { $paywall_id: "271256" },
    });
    expect(collector.headers).not.toHaveProperty("x-dropped");
    collector.deviceAttributes.$radioType = "wifi";
    collector.productSlice.monthly = {};
    collector.userAttributes.plan = "annual";
    expect(COLLECTOR.deviceAttributes).not.toHaveProperty("$radioType");
    expect(COLLECTOR.productSlice).not.toHaveProperty("monthly");
    expect(COLLECTOR.userAttributes).not.toHaveProperty("plan");
  });

  it("fills the slices a minimal payload leaves out", () => {
    const collector = collectorOf({ url: COLLECTOR.url, identity: COLLECTOR.identity })!;

    expect(collector.placementEventId).toEqual(expect.any(String));
    expect(collector.headers).toEqual({});
    expect(collector.productSlice).toEqual({});
    expect(collector.presentmentSlice).toEqual({});
  });

  it("is undefined without a URL or an identity to report as", () => {
    expect(collectorOf(undefined)).toBeUndefined();
    expect(collectorOf({ ...COLLECTOR, url: "" })).toBeUndefined();
    expect(collectorOf({ ...COLLECTOR, identity: { userId: "u1" } })).toBeUndefined();
  });
});
