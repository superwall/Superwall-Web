// Re-export `@superwall/verify` so customers already on the server SDK get the
// stateless token fast-path for free:
//
//   import { verifyEntitlements } from "@superwall/server/verify"
//
// `@superwall/server`'s default `getEntitlements`/`requires` path calls
// Superwall's `/entitlements` per check (authoritative). This path verifies a
// Superwall-signed JWT offline instead — same trust, no network — for hot
// routes. Both are valid; pick per route.
export * from "@superwall/verify";
