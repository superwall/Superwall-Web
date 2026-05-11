import { describe, expect, test } from "bun:test";
import type { Entitlement, Entitlements } from "@superwall/core";
import { findMissing, normalizeSpec } from "./spec.ts";

const ent = (id: string, isActive = true): Entitlement => ({
  id,
  type: "SERVICE_LEVEL",
  isActive,
  productIds: [],
});

const ents = (...active: string[]): Entitlements => {
  const items = active.map((id) => ent(id, true));
  return { active: items, inactive: [], all: items };
};

describe("normalizeSpec", () => {
  test("string", () => {
    expect(normalizeSpec("pro")).toEqual({ mode: "all", entitlements: ["pro"] });
  });

  test("array → all", () => {
    expect(normalizeSpec(["pro", "team"])).toEqual({
      mode: "all",
      entitlements: ["pro", "team"],
    });
  });

  test("{ all }", () => {
    expect(normalizeSpec({ all: ["pro", "team"] })).toEqual({
      mode: "all",
      entitlements: ["pro", "team"],
    });
  });

  test("{ any }", () => {
    expect(normalizeSpec({ any: ["pro", "team"] })).toEqual({
      mode: "any",
      entitlements: ["pro", "team"],
    });
  });

  test("rejects empty string", () => {
    expect(() => normalizeSpec("")).toThrow(TypeError);
  });

  test("rejects empty array", () => {
    expect(() => normalizeSpec([])).toThrow(TypeError);
  });

  test("rejects empty all", () => {
    expect(() => normalizeSpec({ all: [] })).toThrow(TypeError);
  });

  test("rejects empty any", () => {
    expect(() => normalizeSpec({ any: [] })).toThrow(TypeError);
  });

  test("rejects malformed object", () => {
    expect(() =>
      normalizeSpec({ foo: ["pro"] } as unknown as Parameters<typeof normalizeSpec>[0]),
    ).toThrow(TypeError);
  });
});

describe("findMissing (mode: all)", () => {
  test("returns empty when all entitlements active", () => {
    const missing = findMissing(
      { mode: "all", entitlements: ["pro", "team"] },
      ents("pro", "team"),
    );
    expect(missing).toEqual([]);
  });

  test("returns the missing entitlement", () => {
    const missing = findMissing(
      { mode: "all", entitlements: ["pro", "team"] },
      ents("pro"),
    );
    expect(missing).toEqual(["team"]);
  });

  test("ignores extra active entitlements", () => {
    const missing = findMissing(
      { mode: "all", entitlements: ["pro"] },
      ents("pro", "extra"),
    );
    expect(missing).toEqual([]);
  });

  test("inactive entitlements are not counted", () => {
    const proInactive: Entitlements = {
      active: [],
      inactive: [ent("pro", false)],
      all: [ent("pro", false)],
    };
    const missing = findMissing(
      { mode: "all", entitlements: ["pro"] },
      proInactive,
    );
    expect(missing).toEqual(["pro"]);
  });
});

describe("findMissing (mode: any)", () => {
  test("returns empty when any one is active", () => {
    const missing = findMissing(
      { mode: "any", entitlements: ["pro", "team"] },
      ents("team"),
    );
    expect(missing).toEqual([]);
  });

  test("returns all listed when none active", () => {
    const missing = findMissing(
      { mode: "any", entitlements: ["pro", "team"] },
      ents("other"),
    );
    expect(missing).toEqual(["pro", "team"]);
  });
});
