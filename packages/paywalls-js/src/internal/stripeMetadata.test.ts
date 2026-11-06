import { it, expect } from "@effect/vitest";
import { InvalidStripeMetadataError } from "../errors.ts";
import { validateStripeMetadata } from "./stripeMetadata.ts";

const reasonOf = (input: unknown): string | undefined => {
  try {
    validateStripeMetadata(input);
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidStripeMetadataError);
    expect((e as InvalidStripeMetadataError).code).toBe("INVALID_STRIPE_METADATA");
    return (e as InvalidStripeMetadataError).reason;
  }
};

it("returns undefined for missing or empty metadata", () => {
  expect(validateStripeMetadata(undefined)).toBeUndefined();
  expect(validateStripeMetadata(null)).toBeUndefined();
  expect(validateStripeMetadata({})).toBeUndefined();
});

it("returns a copy of valid metadata", () => {
  const input = { campaign: "spring", ref: "" };
  const out = validateStripeMetadata(input);
  expect(out).toEqual({ campaign: "spring", ref: "" });
  expect(out).not.toBe(input);
});

it("accepts the limits exactly", () => {
  const ten = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`k${i}`.padEnd(40, "x"), "v".repeat(500)]),
  );
  expect(validateStripeMetadata(ten)).toEqual(ten);
});

it("rejects non-objects", () => {
  expect(reasonOf("a=b")).toBe("not_an_object");
  expect(reasonOf(["a"])).toBe("not_an_object");
  expect(reasonOf(new Map([["a", "b"]]))).toBe("not_an_object");
});

it("rejects more than 10 keys", () => {
  const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  expect(reasonOf(eleven)).toBe("too_many_keys");
});

it("rejects empty and over-long keys", () => {
  expect(reasonOf({ "": "v" })).toBe("invalid_key");
  expect(reasonOf({ ["k".repeat(41)]: "v" })).toBe("invalid_key");
});

it("rejects reserved _sw_ keys", () => {
  expect(reasonOf({ _sw_user_id: "x" })).toBe("reserved_key");
});

it("rejects non-string and over-long values", () => {
  expect(reasonOf({ n: 1 })).toBe("invalid_value");
  expect(reasonOf({ b: true })).toBe("invalid_value");
  expect(reasonOf({ o: { nested: "x" } })).toBe("invalid_value");
  expect(reasonOf({ long: "v".repeat(501) })).toBe("invalid_value");
});

it("names the offending key", () => {
  try {
    validateStripeMetadata({ ok: "x", bad: 2 });
  } catch (e) {
    expect((e as InvalidStripeMetadataError).key).toBe("bad");
  }
});
