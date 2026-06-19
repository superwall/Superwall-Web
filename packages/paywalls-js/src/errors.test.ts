import { it, expect } from "@effect/vitest";
import {
  SuperwallError,
  NotConfiguredError,
  NoPresenterRegisteredError,
  PaywallAlreadyPresentedError,
  NoDefaultSuperwallError,
  NetworkError,
  ConfigurationFetchError,
  PresenterError,
  StorageError,
} from "./errors.ts";
import type { PaywallInfo } from "./types.ts";

const stubPaywall = (id: string): PaywallInfo => ({
  identifier: id,
  name: id,
  url: `https://paywalls.superwall.com/${id}`,
  productIds: [],
  products: [],
});

it("every error extends SuperwallError and Error, carries a stable code", () => {
  const cases: Array<[SuperwallError, string]> = [
    [new NotConfiguredError(), "NOT_CONFIGURED"],
    [new NoPresenterRegisteredError("upgrade"), "NO_PRESENTER"],
    [
      new PaywallAlreadyPresentedError("upgrade", stubPaywall("p_1")),
      "PAYWALL_ALREADY_PRESENTED",
    ],
    [new NoDefaultSuperwallError(), "NO_DEFAULT_INSTANCE"],
    [new NetworkError("boom"), "NETWORK"],
    [new ConfigurationFetchError(new Error("dns"), 3), "CONFIG_FETCH"],
    [new PresenterError("iframe gone"), "PRESENTER"],
    [new StorageError("quota"), "STORAGE"],
  ];

  for (const [err, code] of cases) {
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SuperwallError);
    expect(err.code).toBe(code as SuperwallError["code"]);
    expect(err.name).not.toBe("Error");
    expect(err.name).not.toBe("SuperwallError");
    expect(err.message.length).toBeGreaterThan(0);
  }
});

it("PaywallAlreadyPresentedError surfaces conflicting paywall info", () => {
  const current = stubPaywall("p_current");
  const err = new PaywallAlreadyPresentedError("p_attempted", current);
  expect(err.attemptedPlacement).toBe("p_attempted");
  expect(err.currentPaywallInfo).toBe(current);
  expect(err.message).toContain("p_current");
  expect(err.message).toContain("p_attempted");
});

it("NoPresenterRegisteredError surfaces the attempted placement", () => {
  const err = new NoPresenterRegisteredError("checkout");
  expect(err.placement).toBe("checkout");
  expect(err.message).toContain("checkout");
});

it("ConfigurationFetchError surfaces attempt + cause", () => {
  const cause = new Error("ENETUNREACH");
  const err = new ConfigurationFetchError(cause, 6);
  expect(err.attempt).toBe(6);
  expect(err.cause).toBe(cause);
  expect(err.message).toContain("attempt 6");
});

it("NetworkError defaults status/cause to undefined when omitted", () => {
  const err = new NetworkError("offline");
  expect(err.status).toBeUndefined();
  expect(err.cause).toBeUndefined();
});

it("NetworkError surfaces status + cause when provided", () => {
  const cause = new Error("ECONNRESET");
  const err = new NetworkError("upstream 502", 502, cause);
  expect(err.status).toBe(502);
  expect(err.cause).toBe(cause);
});
