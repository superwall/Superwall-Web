// Tiny cookie helpers. Public StorageAdapter does NOT touch cookies — the
// adapter built by `createBrowserStorage` mirrors a small subset of identity
// keys to cookies for SSR / cross-origin readability per API.md §7.4.
//
// All functions are no-ops when `document` is undefined (SSR).

export interface CookieWriteOptions {
  /** Cookie domain (e.g. `.example.com`). Default: current host. */
  domain?: string;
  /** `Secure` flag. Default: derived from `location.protocol === "https:"`. */
  secure?: boolean;
  /** `SameSite` attribute. Default: `Lax`. */
  sameSite?: "Lax" | "Strict" | "None";
  /** `Path` attribute. Default: `/`. */
  path?: string;
  /** `Max-Age` in seconds. Default: 2 years. */
  maxAge?: number;
}

const TWO_YEARS_SECONDS = 60 * 60 * 24 * 365 * 2;

const hasDocument = (): boolean =>
  typeof document !== "undefined" && typeof document.cookie === "string";

export const readCookie = (name: string): string | null => {
  if (!hasDocument()) return null;
  const prefix = `${name}=`;
  // `document.cookie` is `name=value; name=value` — split + trim.
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return null;
};

export const writeCookie = (
  name: string,
  value: string,
  options: CookieWriteOptions = {},
): void => {
  if (!hasDocument()) return;
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`Max-Age=${options.maxAge ?? TWO_YEARS_SECONDS}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  const secure =
    options.secure ??
    (typeof location !== "undefined" && location.protocol === "https:");
  if (secure) parts.push("Secure");
  document.cookie = parts.join("; ");
};

export const deleteCookie = (
  name: string,
  options: Pick<
    CookieWriteOptions,
    "domain" | "path" | "secure" | "sameSite"
  > = {},
): void => {
  if (!hasDocument()) return;
  // Browsers require `Secure` + `SameSite` to MATCH the original Set-Cookie
  // for the deletion to actually take effect (especially `SameSite=None`).
  // Pass through whatever the caller wrote with so cookies set by
  // `BrowserStorage` clean up reliably on Safari + Chrome.
  const parts: string[] = [
    `${name}=`,
    `Path=${options.path ?? "/"}`,
    "Max-Age=0",
    `Expires=${new Date(0).toUTCString()}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  const secure =
    options.secure ??
    (typeof location !== "undefined" && location.protocol === "https:");
  if (secure) parts.push("Secure");
  document.cookie = parts.join("; ");
};
