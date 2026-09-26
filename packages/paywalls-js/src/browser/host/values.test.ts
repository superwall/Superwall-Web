import { describe, expect, it } from "vitest";
import { isRecord, recordOf, stringOf } from "./values.ts";

describe("values", () => {
  it("knows a plain object from an array, null and a scalar", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("reads a record or falls back to an empty one", () => {
    expect(recordOf({ a: 1 })).toEqual({ a: 1 });
    expect(recordOf(undefined)).toEqual({});
  });

  it("reads a non-empty string only", () => {
    expect(stringOf("pk")).toBe("pk");
    expect(stringOf("")).toBeUndefined();
    expect(stringOf(7)).toBeUndefined();
  });
});
