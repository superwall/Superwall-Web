import type { Entitlements } from "@superwall/core";
import type { EntitlementSpec } from "./types.ts";

export interface NormalizedSpec {
  readonly mode: "all" | "any";
  readonly entitlements: ReadonlyArray<string>;
}

/**
 * Normalize any accepted spec shape into `{ mode, entitlements }`.
 * Throws on empty / malformed input — fail loud at config time, not
 * at request time.
 */
export const normalizeSpec = (spec: EntitlementSpec): NormalizedSpec => {
  if (typeof spec === "string") {
    if (spec.length === 0) {
      throw new TypeError("Entitlement spec cannot be an empty string.");
    }
    return { mode: "all", entitlements: [spec] };
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      throw new TypeError("Entitlement spec array cannot be empty.");
    }
    return { mode: "all", entitlements: spec };
  }
  if (typeof spec === "object" && spec !== null) {
    if ("all" in spec) {
      if (!Array.isArray(spec.all) || spec.all.length === 0) {
        throw new TypeError("`{ all: [...] }` must be a non-empty string array.");
      }
      return { mode: "all", entitlements: spec.all };
    }
    if ("any" in spec) {
      if (!Array.isArray(spec.any) || spec.any.length === 0) {
        throw new TypeError("`{ any: [...] }` must be a non-empty string array.");
      }
      return { mode: "any", entitlements: spec.any };
    }
  }
  throw new TypeError(
    `Unrecognized entitlement spec: ${JSON.stringify(spec)}. Expected string, string[], { all: string[] }, or { any: string[] }.`,
  );
};

/**
 * Returns the entitlement IDs from `spec` that are NOT active on `ents`.
 * If `mode === "all"`, this is the set of unmet entitlements. If
 * `mode === "any"`, returns empty when at least one is met, otherwise
 * returns all listed entitlements (none satisfied).
 */
export const findMissing = (
  spec: NormalizedSpec,
  ents: Entitlements,
): ReadonlyArray<string> => {
  const activeIds = new Set(ents.active.map((e) => e.id));
  if (spec.mode === "all") {
    return spec.entitlements.filter((id) => !activeIds.has(id));
  }
  // any
  const anyMet = spec.entitlements.some((id) => activeIds.has(id));
  return anyMet ? [] : spec.entitlements;
};
