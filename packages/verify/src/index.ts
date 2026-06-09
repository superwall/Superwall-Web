// @superwall/verify — stateless, offline verification of Superwall-signed
// entitlement tokens (ES256 JWS). The fast path for `@superwall/server`'s gate:
// verify a token cryptographically instead of calling `/entitlements` per
// request.
//
// Quickstart (server-side):
//
//   import { verifyEntitlements } from "@superwall/verify"
//
//   const result = await verifyEntitlements(tokenFromClient, {
//     publicApiKey: process.env.SUPERWALL_PUBLIC_API_KEY!, // the `pk_...` value
//   })
//   if (!result.entitlements.some((e) => e.identifier === "pro")) {
//     return res.status(402).end()
//   }
//
// A valid signature proves Superwall issued these exact entitlements. But the
// gate MUST run on the server — client-side checks are bypassable regardless of
// crypto (see the package SPEC threat model).

export {
  verifyEntitlements,
  userHasEntitlement,
  userHasAnyEntitlement,
} from "./verify.ts";

export { DEFAULT_JWKS_URL } from "./keys.ts";

export type {
  VerifyOptions,
  VerifiedEntitlements,
  Entitlement,
  EntitlementStore,
} from "./types.ts";

export {
  VerifyError,
  InvalidSignatureError,
  ExpiredError,
  AudienceMismatchError,
  MalformedTokenError,
  KeyUnavailableError,
} from "./errors.ts";

export type { VerifyErrorCode } from "./errors.ts";
