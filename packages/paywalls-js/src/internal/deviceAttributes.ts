// Device attributes builder (API.md §11.5). Pure — takes an explicit input
// bundle. Browser globals are read with defensive fallbacks so the same
// builder runs on an SSR boundary.

import type { JsonValue } from "../types.ts";

export const SDK_VERSION = "0.0.0-alpha";

export interface DeviceAttributesInput {
  readonly publicApiKey: string;
  readonly aliasId: string;
  readonly appUserId: string;
  readonly vendorId: string;
  readonly deviceId: string;
  readonly bundleId?: string;
  readonly appVersion?: string;
  readonly appBuild?: string;
  readonly platformWrapper?: string;
  readonly platformWrapperVersion?: string;
  readonly isSandbox: boolean;
  readonly isFirstAppOpen: boolean;
  readonly firstSeenAtMs?: number;
  readonly lastPaywallViewAtMs?: number;
  readonly totalPaywallViews: number;
  readonly reviewRequestCount: number;
  readonly subscriptionStatus: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  readonly activeEntitlements: ReadonlyArray<{ id: string; type?: string }>;
  readonly activeProducts: ReadonlyArray<string>;
}

export type DeviceAttributes = Record<string, JsonValue>;

const has = <T>(v: T | undefined | null): v is T => v != null;

/** Best-effort browser-global accessors. Each returns `undefined` on SSR. */
const safeNavigator = (): Navigator | undefined =>
  typeof navigator === "undefined" ? undefined : navigator;

const safeScreen = (): Screen | undefined =>
  typeof screen === "undefined" ? undefined : screen;

const safeWindow = (): Window | undefined =>
  typeof window === "undefined" ? undefined : window;

/** Pick the device tier from viewport width buckets. */
const deriveDeviceTier = (): "desktop" | "tablet" | "mobile" => {
  const w = safeWindow()?.innerWidth ?? 1024;
  if (w >= 1024) return "desktop";
  if (w >= 600) return "tablet";
  return "mobile";
};

const deriveInterfaceStyle = (): "Light" | "Dark" => {
  const w = safeWindow();
  if (!w || typeof w.matchMedia !== "function") return "Light";
  try {
    return w.matchMedia("(prefers-color-scheme: dark)").matches
      ? "Dark"
      : "Light";
  } catch {
    return "Light";
  }
};

const deriveDeviceLocale = (): string => safeNavigator()?.language ?? "en-US";

const derivePreferredLocale = (): string => {
  const n = safeNavigator();
  return n?.languages?.[0] ?? n?.language ?? "en-US";
};

const splitRegion = (locale: string): string => locale.split("-")[1] ?? "";
const splitLanguage = (locale: string): string => locale.split("-")[0] ?? locale;

/** `Intl.NumberFormat().resolvedOptions().currency` — fallback "USD".
 *  Some Intl backends return undefined when no currency style is requested. */
const deriveCurrencyCode = (): string => {
  try {
    const opts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD", // forces a currency to be picked even if locale doesn't have one
    }).resolvedOptions();
    // Prefer the currency derived from the user's locale when not forced.
    const native = new Intl.NumberFormat().resolvedOptions().currency;
    return (native as string | undefined) ?? opts.currency ?? "USD";
  } catch {
    return "USD";
  }
};

const deriveCurrencySymbol = (currencyCode: string): string => {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).formatToParts(0);
    const symbol = parts.find((p) => p.type === "currency")?.value;
    return symbol ?? currencyCode;
  } catch {
    return currencyCode;
  }
};

const deriveTimezoneOffsetSeconds = (): number => {
  try {
    return -new Date().getTimezoneOffset() * 60;
  } catch {
    return 0;
  }
};

const deriveBundleId = (input: DeviceAttributesInput): string => {
  if (input.bundleId) return input.bundleId;
  const w = safeWindow();
  return w?.location?.hostname ?? "";
};

/** Zero-pad each version segment to 4 digits so CEL string-compare matches
 *  semver order. `1.10.2` → `0001.0010.0002`. */
const padVersion = (v: string): string =>
  v
    .split(".")
    .map((seg) => seg.replace(/[^0-9]/g, "").padStart(4, "0"))
    .join(".");

/** `connection.effectiveType` (Chrome/Edge/Opera) — undefined on Safari/FF. */
const deriveConnectionType = (): string | null => {
  const n = safeNavigator() as
    | (Navigator & { connection?: { effectiveType?: string } })
    | undefined;
  return n?.connection?.effectiveType ?? null;
};

const ms = () => Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

const minutesBetween = (a: number, b: number) => Math.floor((b - a) / MIN);
const daysBetween = (a: number, b: number) => Math.floor((b - a) / DAY);

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (d: Date) => d.toISOString().slice(11, 19);
const isoDateTime = (d: Date) => `${isoDate(d)}T${isoTime(d)}`;

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

const CAPABILITIES = [
  "paywall_event_receiver",
  "multiple_paywall_urls",
  "config_caching",
] as const;

const CAPABILITIES_CONFIG: ReadonlyArray<JsonValue> = [
  {
    name: "paywall_event_receiver",
    event_names: [
      "transaction_start",
      "transaction_restore",
      "transaction_complete",
      "restore_start",
      "restore_fail",
      "restore_complete",
      "transaction_fail",
      "transaction_abandon",
      "transaction_timeout",
      "paywall_open",
      "paywall_close",
    ],
  },
  { name: "multiple_paywall_urls" },
  { name: "config_caching" },
];

/** Build the device-attributes map per API.md §11.5. SSR-safe. */
export const buildDeviceAttributes = (
  input: DeviceAttributesInput,
): DeviceAttributes => {
  const now = ms();
  const nowDate = new Date(now);
  const utcDate = new Date(nowDate.toISOString());

  const deviceLocale = deriveDeviceLocale();
  const preferredLocale = derivePreferredLocale();
  const currencyCode = deriveCurrencyCode();
  const currencySymbol = deriveCurrencySymbol(currencyCode);

  const n = safeNavigator() as
    | (Navigator & {
        deviceMemory?: number;
        userAgentData?: { platform?: string };
      })
    | undefined;
  const s = safeScreen();
  const w = safeWindow();

  const appVersion = input.appVersion ?? "";
  const appBuild = input.appBuild ?? "";

  const out: DeviceAttributes = {
    publicApiKey: input.publicApiKey,
    platform: "Web",
    platform_wrapper: input.platformWrapper ?? "Web",
    platform_wrapper_version: input.platformWrapperVersion ?? "",
    appUserId: input.appUserId,
    aliases: [input.aliasId],
    vendorId: input.vendorId,
    deviceId: input.deviceId,
    appVersion,
    appVersionPadded: appVersion ? padVersion(appVersion) : "",
    appBuildString: appBuild,
    appBuildStringNumber: Number.isFinite(Number(appBuild))
      ? Number(appBuild)
      : null,

    osVersion: "",
    deviceModel: "",
    deviceLocale,
    preferredLocale,
    preferredLanguageCode: splitLanguage(preferredLocale),
    deviceLanguageCode: splitLanguage(preferredLocale),
    regionCode: splitRegion(deviceLocale),
    preferredRegionCode: splitRegion(preferredLocale),

    deviceCurrencyCode: currencyCode,
    deviceCurrencySymbol: currencySymbol,
    timezoneOffset: deriveTimezoneOffsetSeconds(),

    interfaceStyle: deriveInterfaceStyle(),
    interfaceStyleMode: "automatic",

    bundleId: deriveBundleId(input),
    appInstallDate: has(input.firstSeenAtMs)
      ? new Date(input.firstSeenAtMs).toISOString()
      : "",
    isSandbox: input.isSandbox ? "true" : "false",
    isFirstAppOpen: input.isFirstAppOpen,

    sdkVersion: SDK_VERSION,
    sdkVersionPadded: padVersion(SDK_VERSION),

    daysSinceInstall: has(input.firstSeenAtMs)
      ? daysBetween(input.firstSeenAtMs, now)
      : 0,
    minutesSinceInstall: has(input.firstSeenAtMs)
      ? minutesBetween(input.firstSeenAtMs, now)
      : 0,
    daysSinceLastPaywallView: has(input.lastPaywallViewAtMs)
      ? daysBetween(input.lastPaywallViewAtMs, now)
      : null,
    minutesSinceLastPaywallView: has(input.lastPaywallViewAtMs)
      ? minutesBetween(input.lastPaywallViewAtMs, now)
      : null,
    totalPaywallViews: input.totalPaywallViews,

    utcDate: isoDate(utcDate),
    localDate: localDate(nowDate),
    utcTime: isoTime(utcDate),
    localTime: localTime(nowDate),
    utcDateTime: isoDateTime(utcDate),
    localDateTime: `${localDate(nowDate)}T${localTime(nowDate)}`,

    activeEntitlements: input.activeEntitlements.map((e) => e.id),
    activeEntitlementsObject: input.activeEntitlements.map((e) => ({
      id: e.id,
      type: e.type ?? "SERVICE_LEVEL",
    })),
    subscriptionStatus: input.subscriptionStatus,
    activeProducts: [...input.activeProducts],
    reviewRequestCount: input.reviewRequestCount,

    deviceTier: deriveDeviceTier(),
    capabilities: [...CAPABILITIES],
    capabilities_config: [...CAPABILITIES_CONFIG],

    // Web-specific
    userAgent: n?.userAgent ?? "",
    viewportWidth: w?.innerWidth ?? 0,
    viewportHeight: w?.innerHeight ?? 0,
    screenWidth: s?.width ?? 0,
    screenHeight: s?.height ?? 0,
    devicePixelRatio: w?.devicePixelRatio ?? 1,
    connectionType: deriveConnectionType(),
    hardwareConcurrency: n?.hardwareConcurrency ?? null,
    deviceMemory: n?.deviceMemory ?? null,
    cookiesEnabled: n?.cookieEnabled ?? false,

    // Cross-platform compat defaults — no web analogue but consumers'
    // CEL filters may reference them.
    radioType: "",
    isLowPowerModeEnabled: false,
    isMac: false,
    kotlinVersion: "",
  };

  return out;
};
