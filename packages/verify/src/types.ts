// Public types for `@superwall/verify`. The entitlement shape here is the
// token's projection (see SPEC §3) — a strict subset of what
// `GET /entitlements` returns, kept deliberately small to bound token size.
// It is intentionally NOT `@superwall/core`'s `Entitlement`: the token carries
// only what a stateless gate needs, under the field names the signer emits.

/** Known store identifiers carried in the token. Left open (`| (string & {})`)
 *  so a new store added on the signer side doesn't break verification. */
export type EntitlementStore =
  | "STRIPE"
  | "APP_STORE"
  | "PLAY_STORE"
  | "PROMOTIONAL"
  | (string & {});

/** A single active entitlement as asserted by the token. */
export interface Entitlement {
  /** Entitlement identifier, e.g. `"pro"`. */
  identifier: string;
  /** Epoch **milliseconds** when this entitlement expires; `null` =
   *  lifetime/non-expiring. */
  expiresAt: number | null;
  /** The product that granted it, if any. */
  productId: string | null;
  /** Originating store. */
  store: EntitlementStore;
  /** Mirrors the entitlement `state` from `/entitlements`. */
  state: string;
}

export interface VerifyOptions {
  /** Required. The app's **public API key** (`pk_...`) — the same value used to
   *  configure the Superwall SDK, and the token's `aud`. The token is rejected
   *  with {@link AudienceMismatchError} if its `aud` doesn't match.
   *
   *  This is the ONLY app identifier customers have — do NOT ask them for the
   *  internal numeric applicationId, which they don't know. */
  publicApiKey: string;
  /** Override the JWKS URL used for the remote fallback. Defaults to the
   *  production well-known URL. */
  jwksUrl?: string;
  /** Clock tolerance in seconds applied to `exp`/`iat`. Default `0`. */
  clockToleranceSec?: number;
}

/** The verified, trusted result. Returned only when the signature, issuer,
 *  audience and expiry all check out. */
export interface VerifiedEntitlements {
  /** `appUserId` if present, else `deviceId`. The identity the entitlements
   *  belong to. */
  sub: string;
  /** `= aud`. The app's public API key (`pk_...`) these entitlements are scoped
   *  to. */
  publicApiKey: string;
  /** Issued-at, epoch **seconds**. */
  issuedAt: number;
  /** Expiry, epoch **seconds**. */
  expiresAt: number;
  /** Active entitlements. An empty array is valid and means "no active
   *  entitlements." */
  entitlements: Entitlement[];
}
