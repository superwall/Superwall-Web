// `createBrowserStorage` — StorageAdapter backed by `localStorage`, mirroring
// a small subset of identity keys to cookies for SSR / cross-origin readability.
// On read: localStorage wins; cookie is the fallback when localStorage is empty.

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
    // Safari private mode throws on access.
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

  // Cookie deletion needs the SAME `Secure`/`SameSite`/`Path`/`Domain` as
  // creation, otherwise Chrome/Safari treat it as a different cookie.
  const deleteCookieOpts = {
    ...(options.cookieDomain !== undefined && { domain: options.cookieDomain }),
    ...(options.cookieSecure !== undefined && { secure: options.cookieSecure }),
    ...(options.cookieSameSite !== undefined && {
      sameSite: options.cookieSameSite,
    }),
  };

  return {
    get: (key) => {
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
          // Quota / private mode — fall through to cookie so identity isn't lost.
        }
      }
      const cookieName = cookieFor(key);
      if (cookieName) writeCookie(cookieName, value, cookieOpts);
    },

    remove: (key) => {
      if (ls) {
        try {
          ls.removeItem(key);
        } catch {}
      }
      const cookieName = cookieFor(key);
      if (cookieName) deleteCookie(cookieName, deleteCookieOpts);
    },

    clear: () => {
      if (ls) {
        try {
          // Only remove our own keys — don't nuke the host app's storage.
          for (const key of Object.values(STORAGE_KEYS)) {
            ls.removeItem(key);
          }
        } catch {}
      }
      for (const cookieName of COOKIE_MIRROR.values()) {
        deleteCookie(cookieName, deleteCookieOpts);
      }
    },
  };
};
