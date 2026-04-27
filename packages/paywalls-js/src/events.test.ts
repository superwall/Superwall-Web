import { test, expect } from "bun:test";
import {
  LOCAL_ONLY,
  SuperwallEventTarget,
  type SuperwallCustomEvent,
} from "./events.ts";

test("SuperwallEventTarget dispatches typed CustomEvent with detail", () => {
  const target = new SuperwallEventTarget();
  const seen: Array<{ paywall_info: { identifier: string } }> = [];
  target.addEventListener("paywall_open", (e) => seen.push(e.detail));

  target.dispatchEvent(
    new CustomEvent("paywall_open", {
      detail: {
        paywall_info: {
          identifier: "pw_1",
          name: "pw_1",
          url: "https://x",
          productIds: [],
          products: [],
        },
      },
    }),
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]!.paywall_info.identifier).toBe("pw_1");
});

test("AbortSignal removes the listener", () => {
  const target = new SuperwallEventTarget();
  const ac = new AbortController();
  let count = 0;
  target.addEventListener("first_seen", () => count++, { signal: ac.signal });

  target.dispatchEvent(new CustomEvent("first_seen", { detail: {} }));
  expect(count).toBe(1);

  ac.abort();
  target.dispatchEvent(new CustomEvent("first_seen", { detail: {} }));
  expect(count).toBe(1);
});

test("removeEventListener detaches a previously-added listener", () => {
  const target = new SuperwallEventTarget();
  let count = 0;
  const handler = (_e: SuperwallCustomEvent<"app_open">) => count++;

  target.addEventListener("app_open", handler);
  target.dispatchEvent(new CustomEvent("app_open", { detail: {} }));
  expect(count).toBe(1);

  target.removeEventListener("app_open", handler);
  target.dispatchEvent(new CustomEvent("app_open", { detail: {} }));
  expect(count).toBe(1);
});

test("LOCAL_ONLY contains identityHydrated (and only the documented local-only set)", () => {
  expect(LOCAL_ONLY.has("identityHydrated")).toBe(true);
  expect(LOCAL_ONLY.has("paywall_open")).toBe(false);
  expect(LOCAL_ONLY.size).toBe(1);
});
