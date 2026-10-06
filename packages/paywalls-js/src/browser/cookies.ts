// Tiny cookie helpers. All functions are no-ops when `document` is undefined
// (SSR) or when `document.cookie` is unusable.

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

// Reading or writing `document.cookie` throws a `SecurityError` in a document
// with an opaque origin — e.g. an iframe sandboxed without
// `allow-same-origin`. There, cookies simply aren't available: reads see
// none and writes are dropped, rather than failing the SDK.
const readDocumentCookie = (): string | null => {
  if (typeof document === "undefined") return null;
  try {
    return typeof document.cookie === "string" ? document.cookie : null;
  } catch {
    return null;
  }
};

const writeDocumentCookie = (cookie: string): void => {
  if (typeof document === "undefined") return;
  try {
    document.cookie = cookie;
  } catch {}
};

export const readCookie = (name: string): string | null => {
  const cookies = readDocumentCookie();
  if (cookies === null) return null;
  const prefix = `${name}=`;
  for (const part of cookies.split(";")) {
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
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`Max-Age=${options.maxAge ?? TWO_YEARS_SECONDS}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  const secure =
    options.secure ??
    (typeof location !== "undefined" && location.protocol === "https:");
  if (secure) parts.push("Secure");
  writeDocumentCookie(parts.join("; "));
};

export const deleteCookie = (
  name: string,
  options: Pick<
    CookieWriteOptions,
    "domain" | "path" | "secure" | "sameSite"
  > = {},
): void => {
  // Browsers require `Secure` + `SameSite` to MATCH the original Set-Cookie
  // for deletion to take effect (especially `SameSite=None` on Safari/Chrome).
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
  writeDocumentCookie(parts.join("; "));
};
