// The `collector` block of the `#init` payload: where the web paywall app's
// controller reports a paywall's lifecycle, as whom, and the attribution
// slices it spreads into every event (already in the collector's
// `$snake_case` shape). Built by `buildInitPayload` for paywall.js; the host
// reads the same block so both kinds of paywall report identically.

import { isRecord, recordOf, stringOf, type Slice } from "./values.ts";

export type UserId =
  | { type: "appUserId"; appUserId: string }
  | { type: "aliasId"; aliasId: string };

export type Collector = {
  url: string;
  headers: Record<string, string>;
  placementEventId: string;
  identity: { userId: UserId };
  userAttributes: Slice;
  deviceAttributes: Slice;
  experimentSlice: Slice;
  paywallSlice: Slice;
  productSlice: Record<string, Slice>;
  presentmentSlice: Slice;
  placementParamsSlice: Slice;
};

export const userIdOf = (value: unknown): UserId | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "appUserId" && typeof value.appUserId === "string") {
    return { type: "appUserId", appUserId: value.appUserId };
  }
  if (value.type === "aliasId" && typeof value.aliasId === "string") {
    return { type: "aliasId", aliasId: value.aliasId };
  }
  return undefined;
};

/** The collector to report to, or `undefined` without a URL and an
 *  identity. Slices the host enriches (device, products) are copied. */
export const collectorOf = (value: unknown): Collector | undefined => {
  if (!isRecord(value)) return undefined;
  const url = stringOf(value.url);
  const userId = userIdOf(recordOf(value.identity).userId);
  if (!url || !userId) return undefined;
  const headers = Object.fromEntries(
    Object.entries(recordOf(value.headers)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    url,
    headers,
    placementEventId: stringOf(value.placementEventId) ?? crypto.randomUUID(),
    identity: { userId },
    userAttributes: { ...recordOf(value.userAttributes) },
    deviceAttributes: { ...recordOf(value.deviceAttributes) },
    experimentSlice: recordOf(value.experimentSlice),
    paywallSlice: recordOf(value.paywallSlice),
    productSlice: { ...recordOf(value.productSlice) } as Record<string, Slice>,
    presentmentSlice: recordOf(value.presentmentSlice),
    placementParamsSlice: recordOf(value.placementParamsSlice),
  };
};
