import { test, expect, beforeEach } from "bun:test";
import { STORAGE_KEYS } from "../types.ts";
import { readCookie, writeCookie, deleteCookie } from "./cookies.ts";
import { createBrowserStorage } from "./storage.ts";

const clearAll = () => {
  // Wipe localStorage for our keys + reset cookies between tests.
  for (const key of Object.values(STORAGE_KEYS)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) deleteCookie(name);
  }
};

beforeEach(clearAll);

test("set writes to localStorage AND mirrors mirrored keys to cookies", () => {
  const adapter = createBrowserStorage();
  adapter.set(STORAGE_KEYS.aliasId, "$SuperwallAlias:abc");
  expect(localStorage.getItem(STORAGE_KEYS.aliasId)).toBe("$SuperwallAlias:abc");
  expect(readCookie("_sw_alias_id")).toBe("$SuperwallAlias:abc");
});

test("set on non-mirrored keys writes only to localStorage (no cookie)", () => {
  const adapter = createBrowserStorage();
  adapter.set(STORAGE_KEYS.firstSeenAt, "2026-01-01T00:00:00.000Z");
  expect(localStorage.getItem(STORAGE_KEYS.firstSeenAt)).toBe(
    "2026-01-01T00:00:00.000Z",
  );
  // No cookie analogue exists for firstSeenAt — none of the cookie names
  // map to it. Best-effort sanity check: the doc.cookie has no value.
  expect(readCookie("superwall.firstSeenAt")).toBeNull();
});

test("get prefers localStorage when both stores have a value", () => {
  const adapter = createBrowserStorage();
  // Seed the cookie first.
  writeCookie("_sw_alias_id", "$SuperwallAlias:from_cookie");
  // Then write a different value via the adapter.
  adapter.set(STORAGE_KEYS.aliasId, "$SuperwallAlias:from_local");
  expect(adapter.get(STORAGE_KEYS.aliasId)).toBe("$SuperwallAlias:from_local");
});

test("get falls back to cookie when localStorage is empty (SSR-hydration case)", () => {
  const adapter = createBrowserStorage();
  // Pre-existing SSR cookie, no localStorage entry.
  writeCookie("_sw_alias_id", "$SuperwallAlias:ssr_seed");
  expect(adapter.get(STORAGE_KEYS.aliasId)).toBe("$SuperwallAlias:ssr_seed");
});

test("remove deletes from both localStorage and cookie for mirrored keys", () => {
  const adapter = createBrowserStorage();
  adapter.set(STORAGE_KEYS.appUserId, "u_42");
  expect(adapter.get(STORAGE_KEYS.appUserId)).toBe("u_42");
  adapter.remove(STORAGE_KEYS.appUserId);
  expect(localStorage.getItem(STORAGE_KEYS.appUserId)).toBeNull();
  expect(readCookie("_sw_user_id")).toBeNull();
  expect(adapter.get(STORAGE_KEYS.appUserId)).toBeNull();
});

test("clear removes only Superwall keys from localStorage and all mirrored cookies", () => {
  // Host app data that must NOT be touched.
  localStorage.setItem("host_app_token", "secret");

  const adapter = createBrowserStorage();
  adapter.set(STORAGE_KEYS.aliasId, "$SuperwallAlias:a");
  adapter.set(STORAGE_KEYS.appUserId, "u");
  adapter.set(STORAGE_KEYS.vendorId, "v");
  adapter.set(STORAGE_KEYS.firstSeenAt, "ts");

  adapter.clear?.();

  expect(localStorage.getItem(STORAGE_KEYS.aliasId)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.appUserId)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.vendorId)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.firstSeenAt)).toBeNull();
  expect(readCookie("_sw_alias_id")).toBeNull();
  expect(readCookie("_sw_user_id")).toBeNull();
  expect(readCookie("_sw_vendor_id")).toBeNull();
  // Host-app key intact.
  expect(localStorage.getItem("host_app_token")).toBe("secret");
});

test("custom localStorage override is honored (e.g. encrypted wrapper)", () => {
  // Build a Map-backed Storage shim and verify the adapter writes to it.
  const m = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
  const adapter = createBrowserStorage({ localStorage: shim });
  adapter.set(STORAGE_KEYS.firstSeenAt, "ts");
  expect(m.get(STORAGE_KEYS.firstSeenAt)).toBe("ts");
});
