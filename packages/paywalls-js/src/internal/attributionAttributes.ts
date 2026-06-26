// First-touch attribution collection: UTM params + ad platform click IDs
// + referrer / landing page. Persisted in storage so UTM data survives
// across sessions even after query params are stripped.

import type { JsonValue } from "../types.ts";

const ATTRIBUTION_PARAMS = [
  // UTM campaign params
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  // Ad platform click IDs
  "gclid",      // Google Ads
  "fbclid",     // Meta / Facebook Ads
  "msclkid",    // Microsoft Ads
  "ttclid",     // TikTok Ads
  "twclid",     // X / Twitter Ads
  "li_fat_id",  // LinkedIn Ads
  "sccid",      // Snapchat Ads
] as const;

export type AttributionParam = (typeof ATTRIBUTION_PARAMS)[number];

export type AttributionAttributes = Partial<Record<AttributionParam, string>> & {
  referrer?: string;
  landing_page?: string;
};

/** Collect attribution from the current page. SSR-safe — all globals guarded. */
export const collectCurrentAttribution = (): AttributionAttributes => {
  const result: AttributionAttributes = {};

  try {
    const search =
      typeof location !== "undefined" ? location.search : undefined;
    if (search) {
      const params = new URLSearchParams(search);
      for (const key of ATTRIBUTION_PARAMS) {
        const val = params.get(key);
        if (val) (result as Record<string, string>)[key] = val;
      }
    }
  } catch {}

  try {
    const ref =
      typeof document !== "undefined" ? document.referrer : undefined;
    if (ref) result.referrer = ref;
  } catch {}

  try {
    const href =
      typeof location !== "undefined" ? location.href : undefined;
    if (href) result.landing_page = href;
  } catch {}

  return result;
};

/** First-touch merge: stored values always win. Current values fill gaps. */
export const mergeFirstTouch = (
  stored: AttributionAttributes,
  current: AttributionAttributes,
): AttributionAttributes => {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (v !== undefined) merged[k] = v;
  }
  for (const [k, v] of Object.entries(stored)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged as AttributionAttributes;
};

/** Flatten to `Record<string, JsonValue>` for merging into user attributes. */
export const attributionToRecord = (
  attrs: AttributionAttributes,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(attrs).filter(([, v]) => v !== undefined),
  ) as Record<string, JsonValue>;
