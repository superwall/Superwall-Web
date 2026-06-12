import type { Entitlement, Entitlements } from "./types.ts";

// Wire shape returned by GET /subscriptions-api/public/v1/users/{id}/entitlements.
// All fields optional — backend may return either a `customerInfo` envelope
// or a flat `entitlements` array. Domain types tighten these up.
export interface WebEntitlementsResponse {
  readonly customerInfo?: {
    entitlements?: ReadonlyArray<WireEntitlement>;
  };
  readonly entitlements?: ReadonlyArray<WireEntitlement>;
  /** Short-lived (≈1h) Superwall-signed JWT asserting the active entitlements,
   *  for offline server-side verification via `@superwall/verify`. Best-effort:
   *  the backend omits it when signing is unavailable (e.g. no key configured
   *  in that environment), so treat its absence gracefully. */
  readonly entitlementsToken?: string;
}

export interface WireEntitlement {
  /** BE wire shape uses `identifier`; older/other shapes use `id`. */
  identifier?: string;
  id?: string;
  isActive?: boolean;
  productIds?: string[];
  type?: string;
}

const toDomain = (e: WireEntitlement): Entitlement => ({
  id: e.identifier ?? e.id ?? "",
  type: "SERVICE_LEVEL",
  isActive: e.isActive ?? false,
  productIds: e.productIds ?? [],
});

/**
 * Normalize a `WebEntitlementsResponse` into a domain `Entitlements`
 * bucket. Prefers the `entitlements` top-level array if present, falls
 * back to `customerInfo.entitlements`.
 */
export const parseEntitlements = (
  res: WebEntitlementsResponse,
): Entitlements => {
  // The BE sends `entitlements: []` (empty) at the top level and the real
  // ones under `customerInfo.entitlements`. A plain `??` would pick the
  // empty top-level array (it isn't nullish) and drop the real ones — so
  // only fall back to the top level when customerInfo has nothing.
  const wire =
    res.customerInfo?.entitlements && res.customerInfo.entitlements.length > 0
      ? res.customerInfo.entitlements
      : res.entitlements && res.entitlements.length > 0
        ? res.entitlements
        : (res.customerInfo?.entitlements ?? res.entitlements ?? []);
  const all = wire.map(toDomain);
  return {
    active: all.filter((e) => e.isActive),
    inactive: all.filter((e) => !e.isActive),
    all,
  };
};
