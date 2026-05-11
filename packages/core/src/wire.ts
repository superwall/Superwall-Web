import type { Entitlement, Entitlements } from "./types.ts";

// Wire shape returned by GET /subscriptions-api/public/v1/users/{id}/entitlements.
// All fields optional — backend may return either a `customerInfo` envelope
// or a flat `entitlements` array. Domain types tighten these up.
export interface WebEntitlementsResponse {
  readonly customerInfo?: {
    entitlements?: ReadonlyArray<WireEntitlement>;
  };
  readonly entitlements?: ReadonlyArray<WireEntitlement>;
}

export interface WireEntitlement {
  id: string;
  isActive?: boolean;
  productIds?: string[];
  type?: string;
}

const toDomain = (e: WireEntitlement): Entitlement => ({
  id: e.id,
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
  const wire = res.entitlements ?? res.customerInfo?.entitlements ?? [];
  const all = wire.map(toDomain);
  return {
    active: all.filter((e) => e.isActive),
    inactive: all.filter((e) => !e.isActive),
    all,
  };
};
