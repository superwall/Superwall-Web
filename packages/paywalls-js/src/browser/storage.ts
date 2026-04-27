// `createBrowserStorage` — public StorageAdapter backed by `localStorage`
// with a small set of identity keys mirrored to cookies for SSR / cross-
// origin readability. Per API.md §5 + §7.4.
//
// Mirrored keys (source → cookie):
//   superwall.aliasId   → _sw_alias_id
//   superwall.appUserId → _sw_user_id     (provisional cookie name)
//   superwall.vendorId  → _sw_vendor_id   (provisional cookie name)
//
// Other localStorage keys (firstSeenAt, totalPaywallViews, computedProperties,
// userAttributes, integrationAttributes) live in localStorage only.
//
// On read: localStorage wins; cookie is the fallback when localStorage
// is empty. This matches the SSR-hydration policy in API.md §7.4.

import { STORAGE_KEYS, type StorageAdapter } from "../types.ts";
import {
  deleteCookie,
  readCookie,
  writeCookie,
  type CookieWriteOptions,
} from "./cookies.ts";

export interface BrowserStorageOptions {
  /** Cookie domain (e.g. `.example.com`). Default: omit (current host). */
  cookieDomain?: string;
  /** `Secure` flag. Default: derived from `location.protocol`. */
  cookieSecure?: boolean;
  /** `SameSite`. Default: `Lax`. */
  cookieSameSite?: "Lax" | "Strict" | "None";
  /** `Max-Age` in seconds. Default: 2 years. */
  cookieMaxAgeSeconds?: number;
  /** Override the `localStorage` instance. Useful for tests or wrapping
   *  with a prefix / encryption layer. Default: `globalThis.localStorage`. */
  localStorage?: Storage;
}

/** Maps localStorage key → cookie name for the mirrored identity subset. */
const COOKIE_MIRROR: ReadonlyMap<string, string> = new Map<string, string>([
  [STORAGE_KEYS.aliasId, "_sw_alias_id"],
  [STORAGE_KEYS.appUserId, "_sw_user_id"],
  [STORAGE_KEYS.vendorId, "_sw_vendor_id"],
]);

const resolveLocalStorage = (override?: Storage): Storage | null => {
  if (override) return override;
  if (typeof globalThis === "undefined") return null;
  if (!("localStorage" in globalThis)) return null;
  try {
    // Touch the API — Safari private mode throws on access.
    const ls = (globalThis as { localStorage: Storage }).localStorage;
    return ls;
  } catch {
    return null;
  }
};

export const createBrowserStorage = (
  options: BrowserStorageOptions = {},
): StorageAdapter => {
  const ls = resolveLocalStorage(options.localStorage);
  const cookieOpts: CookieWriteOptions = {
    ...(options.cookieDomain !== undefined && { domain: options.cookieDomain }),
    ...(options.cookieSecure !== undefined && { secure: options.cookieSecure }),
    ...(options.cookieSameSite !== undefined && {
      sameSite: options.cookieSameSite,
    }),
    ...(options.cookieMaxAgeSeconds !== undefined && {
      maxAge: options.cookieMaxAgeSeconds,
    }),
  };

  const cookieFor = (key: string): string | undefined => COOKIE_MIRROR.get(key);

  return {
    get: (key) => {
      // localStorage authoritative; cookie is the SSR fallback.
      if (ls) {
        const v = ls.getItem(key);
        if (v !== null) return v;
      }
      const cookieName = cookieFor(key);
      if (cookieName) {
        const cookieValue = readCookie(cookieName);
        if (cookieValue !== null) return cookieValue;
      }
      return null;
    },

    set: (key, value) => {
      if (ls) {
        try {
          ls.setItem(key, value);
        } catch {
          // localStorage quota / private mode — fall through to cookie if
          // applicable so identity isn't lost entirely.
        }
      }
      const cookieName = cookieFor(key);
      if (cookieName) writeCookie(cookieName, value, cookieOpts);
    },

    remove: (key) => {
      if (ls) {
        try {
          ls.removeItem(key);
        } catch {
          /* ignore */
        }
      }
      const cookieName = cookieFor(key);
      if (cookieName) {
        deleteCookie(cookieName, {
          ...(options.cookieDomain !== undefined && { domain: options.cookieDomain }),
        });
      }
    },

    clear: () => {
      if (ls) {
        try {
          // Only remove our own keys — don't nuke the host app's localStorage.
          for (const key of Object.values(STORAGE_KEYS)) {
            ls.removeItem(key);
          }
        } catch {
          /* ignore */
        }
      }
      for (const cookieName of COOKIE_MIRROR.values()) {
        deleteCookie(cookieName, {
          ...(options.cookieDomain !== undefined && { domain: options.cookieDomain }),
        });
      }
    },
  };
};
