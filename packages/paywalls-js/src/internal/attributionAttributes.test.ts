import { it, expect } from "@effect/vitest";
import {
  collectCurrentAttribution,
  mergeFirstTouch,
  attributionToRecord,
  type AttributionAttributes,
} from "./attributionAttributes.ts";

// ---------------------------------------------------------------------------
// collectCurrentAttribution
// ---------------------------------------------------------------------------

it("collectCurrentAttribution: returns empty object when location is unavailable (SSR)", () => {
  const origLocation = (globalThis as Record<string, unknown>).location;
  const origDocument = (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).location;
  delete (globalThis as Record<string, unknown>).document;

  const result = collectCurrentAttribution();

  (globalThis as Record<string, unknown>).location = origLocation;
  (globalThis as Record<string, unknown>).document = origDocument;

  expect(result).toEqual({});
});

it("collectCurrentAttribution: extracts UTM params from location.search", () => {
  const origLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = {
    search: "?utm_source=google&utm_medium=cpc&utm_campaign=summer_sale",
    href: "https://example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=summer_sale",
  };

  const result = collectCurrentAttribution();

  (globalThis as Record<string, unknown>).location = origLocation;

  expect(result.utm_source).toBe("google");
  expect(result.utm_medium).toBe("cpc");
  expect(result.utm_campaign).toBe("summer_sale");
  expect(result.landing_page).toBe(
    "https://example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=summer_sale",
  );
});

it("collectCurrentAttribution: extracts ad click IDs", () => {
  const origLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = {
    search: "?gclid=abc123&fbclid=xyz789&ttclid=tt_click",
    href: "https://example.com/?gclid=abc123",
  };

  const result = collectCurrentAttribution();

  (globalThis as Record<string, unknown>).location = origLocation;

  expect(result.gclid).toBe("abc123");
  expect(result.fbclid).toBe("xyz789");
  expect(result.ttclid).toBe("tt_click");
});

it("collectCurrentAttribution: includes referrer from document", () => {
  const origLocation = (globalThis as Record<string, unknown>).location;
  const origDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).location = {
    search: "",
    href: "https://example.com/",
  };
  (globalThis as Record<string, unknown>).document = {
    referrer: "https://google.com/search?q=superwall",
  };

  const result = collectCurrentAttribution();

  (globalThis as Record<string, unknown>).location = origLocation;
  (globalThis as Record<string, unknown>).document = origDocument;

  expect(result.referrer).toBe("https://google.com/search?q=superwall");
});

it("collectCurrentAttribution: ignores unrecognised query params", () => {
  const origLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = {
    search: "?ref=sidebar&utm_source=newsletter&custom_param=ignored",
    href: "https://example.com/",
  };

  const result = collectCurrentAttribution();

  (globalThis as Record<string, unknown>).location = origLocation;

  expect(result.utm_source).toBe("newsletter");
  expect((result as Record<string, unknown>).ref).toBeUndefined();
  expect((result as Record<string, unknown>).custom_param).toBeUndefined();
});

// ---------------------------------------------------------------------------
// mergeFirstTouch
// ---------------------------------------------------------------------------

it("mergeFirstTouch: stored values always win (first-touch semantics)", () => {
  const stored: AttributionAttributes = {
    utm_source: "google",
    referrer: "https://google.com",
  };
  const current: AttributionAttributes = {
    utm_source: "facebook",
    utm_medium: "cpc",
    landing_page: "https://example.com/pricing",
  };

  const merged = mergeFirstTouch(stored, current);

  expect(merged.utm_source).toBe("google");           // stored wins
  expect(merged.utm_medium).toBe("cpc");              // fills gap from current
  expect(merged.referrer).toBe("https://google.com"); // stored wins
  expect(merged.landing_page).toBe("https://example.com/pricing"); // fills gap
});

it("mergeFirstTouch: uses all current values when stored is empty", () => {
  const stored: AttributionAttributes = {};
  const current: AttributionAttributes = {
    utm_source: "twitter",
    gclid: "abc123",
    referrer: "https://t.co/xyz",
  };

  const merged = mergeFirstTouch(stored, current);

  expect(merged.utm_source).toBe("twitter");
  expect(merged.gclid).toBe("abc123");
  expect(merged.referrer).toBe("https://t.co/xyz");
});

it("mergeFirstTouch: stored keys with no current counterpart are preserved", () => {
  const stored: AttributionAttributes = {
    utm_source: "email",
    utm_campaign: "onboarding_drip",
  };
  const current: AttributionAttributes = {
    utm_source: "organic",
  };

  const merged = mergeFirstTouch(stored, current);

  expect(merged.utm_source).toBe("email");
  expect(merged.utm_campaign).toBe("onboarding_drip");
});

it("mergeFirstTouch: empty stored + empty current yields empty object", () => {
  expect(mergeFirstTouch({}, {})).toEqual({});
});

// ---------------------------------------------------------------------------
// attributionToRecord
// ---------------------------------------------------------------------------

it("attributionToRecord: converts to Record<string, JsonValue>", () => {
  const attrs: AttributionAttributes = {
    utm_source: "google",
    utm_medium: "cpc",
    referrer: "https://google.com",
    landing_page: "https://example.com/",
  };

  const record = attributionToRecord(attrs);

  expect(record).toEqual({
    utm_source: "google",
    utm_medium: "cpc",
    referrer: "https://google.com",
    landing_page: "https://example.com/",
  });
});

it("attributionToRecord: filters out undefined values", () => {
  // exactOptionalPropertyTypes: explicitly omit utm_medium rather than set to undefined.
  const attrs: AttributionAttributes = { utm_source: "google" };

  const record = attributionToRecord(attrs);

  expect(record.utm_source).toBe("google");
  expect("utm_medium" in record).toBe(false);
});

it("attributionToRecord: returns empty object for empty attrs", () => {
  expect(attributionToRecord({})).toEqual({});
});
