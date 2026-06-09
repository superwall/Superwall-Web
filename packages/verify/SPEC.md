# `@superwall/verify` — Signed Entitlement Token Verification

> **Status:** Spec. This package (`@superwall/verify`) is not yet implemented — someone implements it from this doc. **The `paywall-next` backend it depends on IS implemented and merged:** signed tokens ship on the `/entitlements` and `/checkout/session/complete-webapp` responses, the JWKS endpoint is live, and the browser SDK relays the token. So this is purely the client-verification helper now.
> **Relationship:** This is the "JWT entitlement proofs" that [`SERVER_SDK.md`](../../SERVER_SDK.md) lists as a deferred non-goal ("Ship later"). `@superwall/server` is the gate that reads truth from Superwall's `/entitlements` endpoint server-to-server. This package is the **stateless fast-path** for that same gate: verify a Superwall-signed JWT offline instead of making a network call per request.
> **Counterpart work:** The token is produced by `paywall-next` (`apps/subscriptions-api`). This package only **consumes/verifies** it. The token contract in §3 is the integration boundary and matches what's deployed.
>
> **⚠️ aud = public key, not applicationId.** The token's `aud` is the app's **public API key** (`pk_...`) — the value customers already configure the SDK with. Customers do **not** know the internal numeric applicationId, so `verifyEntitlements` takes `publicApiKey`. (Earlier drafts of this spec said `applicationId`; that was wrong and is corrected below.)

---

## TL;DR

Superwall signs a short-lived JWT (ES256) asserting a user's active entitlements. The browser SDK obtains it and forwards it to the customer's backend. The customer's backend verifies it with **one function call** against Superwall's public key — no per-request call to Superwall, no shared secret, no key management.

```ts
import { verifyEntitlements } from "@superwall/verify"

// In the customer's route/middleware (server-side). publicApiKey = the `pk_...`
// they configured the SDK with (the only app id they have).
const result = await verifyEntitlements(tokenFromClient, { publicApiKey: "pk_abc123" })
// result.entitlements -> [{ identifier, expiresAt, productId, store, state }]
if (!result.entitlements.some((e) => e.identifier === "pro")) {
  return res.status(402).end()
}
```

---

## Why this exists

`@superwall/server`'s default path (`getEntitlements(userId)` → server-to-server call to `/entitlements`) is correct and authoritative, but costs a network round-trip per check. For high-throughput / edge customers that's a latency and cost problem. A Superwall-signed token lets the gate run **statelessly** (no I/O) while remaining tamper-proof.

This does **not** replace the server SDK's network path — it's an optional optimization. Both are valid; the token path is for hot routes.

## Security model (must read before implementing)

- **Verification is a real cryptographic guarantee anywhere it runs** (browser or server). A valid signature proves Superwall issued these exact entitlements and nobody tampered with them. Forgery requires Superwall's private key.
- **But the gate must verify the token on the *server*.** The browser is the user's turf; anything gated purely client-side is bypassable at the UI layer regardless of crypto (see `SERVER_SDK.md` threat model). This package is therefore **primarily a server-side library**. It may run in the browser for cosmetic/optimistic UI, but that is never the access gate.
- **The token is a bearer credential.** Within its 1h life, a leaked token = leaked entitlements (same as any session JWT). Mitigations: short expiry (1h), `aud` binding, HTTPS-only transport, don't log it.
- **No impersonation protection in v1, by design.** Minting a token requires `(appUserId, deviceId)`; `deviceId` is a high-entropy Superwall-generated value tied to the user's device, so it's effectively unguessable. Document: "treat `deviceId` as a secret." Mutual customer-signed identity auth is a possible future hardening, out of scope here.

---

## 3. Token contract (integration boundary with `paywall-next`)

The token is a compact JWS (JWT), `ES256`, with a `kid` header for key rotation.

**Header**
```json
{ "alg": "ES256", "kid": "<key id>", "typ": "JWT" }
```

**Claims**
| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Always `"superwall"`. |
| `sub` | string | `appUserId` if present, else `deviceId`. The identity the entitlements belong to. |
| `aud` | string | The app's **public API key** (`pk_...`) — the identifier the customer already configures the SDK with. Verifier MUST check this matches the expected key. Prevents replay across apps. (NOT the internal numeric applicationId — customers don't know that.) |
| `iat` | number | Issued-at (epoch seconds). |
| `exp` | number | Expiry. **1 hour** after `iat`. |
| `jti` | string | Unique token id (uuid). Not denylisted in v1; reserved. |
| `entitlements` | array | Active entitlements (below). |

**`entitlements[]` item**
```ts
{
  identifier: string      // e.g. "pro"
  expiresAt: number | null // epoch ms; null = lifetime/non-expiring
  productId: string | null
  store: "STRIPE" | "APP_STORE" | "PLAY_STORE" | "PROMOTIONAL" | string
  state: string           // mirrors the entitlement state from /entitlements
}
```
> Keep this shape a strict subset of what `GET /entitlements` already returns so the two paths agree. If the upstream entitlement model adds fields, decide explicitly whether they belong in the token (token size vs. usefulness).

Only **active** entitlements are included. An empty array is a valid token meaning "no active entitlements."

---

## 4. Package surface

Package name: `@superwall/verify` (new workspace package, mirrors `@superwall/core`/`@superwall/server` conventions: `type: module`, ESM, `exports` map, `bun test`, no-op build for v0).

Dependency: `jose` (already used across the org). No other runtime deps.

### `verifyEntitlements(token, options?) => Promise<VerifiedEntitlements>`

```ts
interface VerifyOptions {
  /**
   * The app's public API key (`pk_...`) — the same value used to configure the
   * SDK. Token is rejected if its `aud` doesn't match. This is the ONLY app
   * identifier customers have; do NOT ask them for the internal applicationId.
   */
  publicApiKey: string
  /** Override the JWKS URL. Defaults to the production well-known URL. */
  jwksUrl?: string
  /** Clock tolerance in seconds for exp/iat. Default 0 (or small, e.g. 5). */
  clockToleranceSec?: number
}

interface VerifiedEntitlements {
  sub: string             // the user (appUserId or deviceId)
  publicApiKey: string    // = aud
  issuedAt: number
  expiresAt: number
  entitlements: Entitlement[]
}
```

Behavior:
1. Verify signature against the resolved public key (see §5), `alg: ["ES256"]` only (reject `none`/`alg` confusion).
2. Verify `iss === "superwall"`, `aud === options.publicApiKey`, `exp`/`iat` within tolerance.
3. Return parsed claims. **Throw a typed error** on any failure — never return a partial/"maybe valid" result. Distinguish at least: `InvalidSignature`, `Expired`, `AudienceMismatch`, `Malformed`, `KeyUnavailable`.

### Convenience helpers (thin wrappers, optional but recommended)
```ts
userHasEntitlement(token, identifier, options): Promise<boolean>
userHasAnyEntitlement(token, identifiers[], options): Promise<boolean>
```
Mirror `@superwall/server`'s `userHas` ergonomics so the two packages feel identical.

---

## 5. Key resolution (bundled public key + JWKS fallback)

Goal: **zero key management for customers.**

1. **Bundle the current public JWK(s) in the package** as a constant, keyed by `kid`. If the token's `kid` matches a bundled key, verify offline with no network at all.
2. **Fallback to remote JWKS** (`jose.createRemoteJWKSet(new URL(jwksUrl))`) only when the `kid` is unknown to the bundle (i.e. after a rotation that predates the installed package version). `jose` caches the JWKS in-memory (≈30s cooldown, ~10min reuse), so this is near-zero traffic.
3. Default `jwksUrl`: **`https://superwall.com/.well-known/entitlements/jwks.json`** (stable, CDN-cached, never moves — see §7).

This means: a customer on an up-to-date package version makes **no network calls** to verify. A customer on an older version after a rotation transparently falls back to JWKS. Either way, no config.

> Implementation note: ship a script to regenerate the bundled-keys constant from the live JWKS, so package releases stay in sync with rotations.

---

## 6. How the token reaches the customer's backend (browser SDK plumbing)

Implemented in `paywall-next`. Documented here because it defines what the customer receives.

- **At purchase (DONE):** the `complete-webapp` response returns `entitlementsToken`; the paywall relays it as an `entitlements_token` field on the **`post_checkout_complete`** message the host SDK receives. (No new message type — it rides the existing `stripe_checkout_complete` → `post_checkout_complete` flow.)
- **Steady state (DONE on the backend):** `GET /entitlements` returns `entitlementsToken` alongside `customerInfo`. **TODO for whoever owns the web SDK:** surface that token to the host (a getter / include it on the customerInfo read) so a page that didn't just purchase can still obtain a fresh token, refreshed at least hourly to track `exp`.
- The customer's page forwards the token to their backend (auth header or cookie) where `verifyEntitlements` runs.

Note: `entitlementsToken` is **best-effort** on both responses — it's omitted if signing is unavailable (e.g. no key configured in that environment). Treat its absence gracefully; fall back to the `@superwall/server` network path.

Customer-facing contract: "After a purchase you receive `entitlements_token` on `post_checkout_complete`; you can also read the current token from the SDK. Send it to your server and call `verifyEntitlements(token, { publicApiKey })`."

---

## 7. JWKS hosting (ops, `paywall-next` / infra side)

- URL: `https://superwall.com/.well-known/entitlements/jwks.json` (DONE — Next.js rewrite in `apps/web` proxies to subscriptions-api). **The URL never moves** — customers pin it; use it as the default `jwksUrl`.
- Content: `{ "keys": [ <all current public JWKs, each with kid> ] }`. Serves **all** non-retired keys so tokens signed just before a rotation still verify.
- Cache: endpoint sends `Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`. (Cloudflare edge caching of JSON still needs a Cache Rule — infra follow-up.)
- Source of truth: the signer's key set (`ENTITLEMENTS_SIGNING_KEYS` env in subscriptions-api), generated via `apps/subscriptions-api/script/generate-entitlements-signing-key.ts`.

---

## 8. Open items for the implementer
1. **Package vs. fold-in:** ship as standalone `@superwall/verify`, or export the same functions from `@superwall/server`? Spec assumes standalone; re-export from `@superwall/server` is encouraged so customers already on the server SDK get it for free.
2. **Token size:** if an app has many entitlements, the token grows. Decide a sane cap / whether to include `productId`/`store` per entitlement or trim.
3. **Bundled-key refresh process:** automate regenerating the bundled public-key constant on each rotation + release.
4. **Error types:** finalize the typed-error taxonomy and whether helpers throw or return booleans on verification failure (recommend: low-level `verifyEntitlements` throws; `userHas*` returns `false` only for "valid token, no entitlement", and re-throws for invalid tokens).

## Cross-repo status
- `paywall-next` (**DONE, merged**): `EntitlementsTokenSigner` + signing-key provider, `entitlementsToken` on `/entitlements` and `/checkout/session/complete-webapp` responses (`aud` = public API key), JWKS endpoint, superwall.com rewrite, pjs message plumbing. Remaining ops: generate the keypair and set `ENTITLEMENTS_SIGNING_KEYS` in Doppler (stg + prd).
- `Superwall-Web` (**TODO**): build this package from the spec; surface the steady-state token from the web SDK to the host (§6); optional `@superwall/server` re-export.
