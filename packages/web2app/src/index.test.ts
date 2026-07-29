import { it, expect, vi } from "vitest";
import {
  buildPostPurchaseHandler,
  buildSuperwallOptions,
  type Web2AppPurchaseResult,
} from "./index.ts";

const targets: Web2AppPurchaseResult = {
  redemptionUrl: "https://tenant.superwall.app/redeem?codes=redemption_abc",
  redemptionCodes: ["redemption_abc"],
  manageUrl: "https://tenant.superwall.app/manage",
  deepLinks: { ios: "acme://superwall/redeem?code=redemption_abc" },
};

it("calls onPurchaseComplete with the resolved targets and stays by default", () => {
  const cb = vi.fn();
  const handler = buildPostPurchaseHandler(cb, "stay");

  const result = handler(targets);

  expect(cb).toHaveBeenCalledWith(targets);
  // Anything but `false` means handled — no default navigation.
  expect(result).not.toBe(false);
});

it('"navigate" falls through to the SDK default navigation (returns false)', () => {
  const cb = vi.fn();
  const handler = buildPostPurchaseHandler(cb, "navigate");

  expect(handler(targets)).toBe(false);
  // Callback still ran first.
  expect(cb).toHaveBeenCalledWith(targets);
});

it("a {url} afterPurchase navigates there itself and reports handled", () => {
  const handler = buildPostPurchaseHandler(undefined, {
    url: "https://merchant.test/thanks",
  });

  expect(handler(targets)).not.toBe(false);
  expect(globalThis.location.href).toBe("https://merchant.test/thanks");
});

it("a throwing onPurchaseComplete is caught and still counts as handled", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = buildPostPurchaseHandler(() => {
    throw new Error("merchant bug");
  }, "stay");

  expect(() => handler(targets)).not.toThrow();
  expect(handler(targets)).not.toBe(false);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it('a throwing onPurchaseComplete with "navigate" still falls through', () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = buildPostPurchaseHandler(() => {
    throw new Error("merchant bug");
  }, "navigate");

  // The merchant's broken callback must not eat the configured navigation.
  expect(handler(targets)).toBe(false);
  warn.mockRestore();
});

it("buildSuperwallOptions installs the postPurchase handler and keeps passthrough options", () => {
  const cb = vi.fn();
  const opts = buildSuperwallOptions({
    apiKey: "pk_test_w2a",
    onPurchaseComplete: cb,
    superwall: {
      options: {
        bundleId: "com.acme.app",
        web2app: {},
      },
    },
  });

  expect(opts.apiKey).toBe("pk_test_w2a");
  expect(opts.options?.bundleId).toBe("com.acme.app");
  const postPurchase = opts.options?.web2app?.postPurchase;
  expect(typeof postPurchase).toBe("function");
  (postPurchase as (t: Web2AppPurchaseResult) => unknown)(targets);
  expect(cb).toHaveBeenCalledWith(targets);
});
