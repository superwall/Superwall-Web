import { test, expect } from "bun:test";
import {
  buildDeviceAttributes,
  SDK_VERSION,
  type DeviceAttributesInput,
} from "./deviceAttributes.ts";

const baseInput = (
  overrides: Partial<DeviceAttributesInput> = {},
): DeviceAttributesInput => ({
  publicApiKey: "pk_test",
  aliasId: "$SuperwallAlias:abc",
  appUserId: "u_42",
  vendorId: "vendor_uuid",
  deviceId: "abc1234567890def",
  isSandbox: false,
  isFirstAppOpen: true,
  totalPaywallViews: 0,
  reviewRequestCount: 0,
  subscriptionStatus: "UNKNOWN",
  activeEntitlements: [],
  activeProducts: [],
  ...overrides,
});

test("buildDeviceAttributes: emits the canonical platform header", () => {
  const out = buildDeviceAttributes(baseInput());
  expect(out.platform).toBe("Web");
  expect(out.platform_wrapper).toBe("Web");
  expect(out.publicApiKey).toBe("pk_test");
  expect(out.appUserId).toBe("u_42");
  expect(out.vendorId).toBe("vendor_uuid");
  expect(out.deviceId).toBe("abc1234567890def");
  expect(out.aliases).toEqual(["$SuperwallAlias:abc"]);
});

test("buildDeviceAttributes: padded versions are zero-padded for CEL string compare", () => {
  const out = buildDeviceAttributes(baseInput({ appVersion: "1.10.2" }));
  expect(out.appVersionPadded).toBe("0001.0010.0002");
  expect(out.sdkVersion).toBe(SDK_VERSION);
  // Padded SDK version always padded even if SDK_VERSION is "0.0.0-alpha".
  expect((out.sdkVersionPadded as string).split(".")).toHaveLength(3);
});

test("buildDeviceAttributes: subscription state + entitlements flow through", () => {
  const out = buildDeviceAttributes(
    baseInput({
      subscriptionStatus: "ACTIVE",
      activeEntitlements: [
        { id: "pro" },
        { id: "vip", type: "ONE_TIME_PURCHASE" },
      ],
      activeProducts: ["pro_yearly"],
    }),
  );
  expect(out.subscriptionStatus).toBe("ACTIVE");
  expect(out.activeEntitlements).toEqual(["pro", "vip"]);
  expect(out.activeEntitlementsObject).toEqual([
    { id: "pro", type: "SERVICE_LEVEL" },
    { id: "vip", type: "ONE_TIME_PURCHASE" },
  ]);
  expect(out.activeProducts).toEqual(["pro_yearly"]);
});

test("buildDeviceAttributes: appInstallDate ISO + days/minutes since install", () => {
  const installMs = Date.now() - 3 * 86_400_000; // 3 days ago
  const out = buildDeviceAttributes(baseInput({ firstSeenAtMs: installMs }));
  expect(out.appInstallDate).toBe(new Date(installMs).toISOString());
  expect(out.daysSinceInstall).toBe(3);
  expect(out.minutesSinceInstall).toBeGreaterThan(3 * 24 * 60 - 5);
});

test("buildDeviceAttributes: capabilities + capabilities_config are constants", () => {
  const out = buildDeviceAttributes(baseInput());
  expect(out.capabilities).toEqual([
    "paywall_event_receiver",
    "multiple_paywall_urls",
    "config_caching",
  ]);
  const cfg = out.capabilities_config as Array<{ name: string }>;
  expect(cfg.map((c) => c.name)).toEqual([
    "paywall_event_receiver",
    "multiple_paywall_urls",
    "config_caching",
  ]);
});

test("buildDeviceAttributes: cross-platform compat defaults are stable", () => {
  // CEL audience filters from iOS/Android may reference these — they
  // always serialize as documented compat defaults so filters don't break.
  const out = buildDeviceAttributes(baseInput());
  expect(out.radioType).toBe("");
  expect(out.isLowPowerModeEnabled).toBe(false);
  expect(out.isMac).toBe(false);
  expect(out.kotlinVersion).toBe("");
});

test("buildDeviceAttributes: isSandbox stringified per Android wire shape", () => {
  expect(buildDeviceAttributes(baseInput({ isSandbox: true })).isSandbox).toBe(
    "true",
  );
  expect(
    buildDeviceAttributes(baseInput({ isSandbox: false })).isSandbox,
  ).toBe("false");
});
