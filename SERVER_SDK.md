# Server SDK + Hardened Security Model

> **Status:** Design doc. Captures decisions from the security-audit discussion. Not yet implemented.
> **Scope:** the next major addition to the Superwall web product — splitting the client SDK's responsibilities and adding `@superwall/server` so customers can do real server-side entitlement enforcement with one line of code per route.

---

## TL;DR

Today, the browser SDK is the *de facto* gate for premium features: developers wrap their feature in `register({ feature: () => ... })` and the SDK decides whether to invoke it based on local subscription state. That state is trivially writable by anyone with DevTools open. This document defines the path to a model where:

- The browser SDK is honestly a **presentation layer** (paywalls, local UX belief, events). It is never the gate.
- A new **`@superwall/server`** package is the gate. One line per route. Reads truth from Superwall's existing `/entitlements` endpoint.
- Superwall remains the **single source of truth** for entitlement state. The developer does not maintain a parallel subscription database, parallel webhook handlers, or parallel renewal logic. The single line they write is delegation, not duplication.
- Documentation reframes `register({ feature })` from "the feature runs here" to "the paywall flow has resolved here." For non-sensitive UX gating, this is fine. For real access control, the route middleware is the gate.

The change is small in code (one new package + a docs rewrite + a few SDK surface tweaks) and large in product positioning. We go from "presentation framework with a security footgun" to "complete subscription backend with a one-line integration."

---

## Goals

1. Eliminate trivial client-side paywall bypass for any developer who follows the documented integration pattern.
2. Keep Superwall as the source of truth for entitlements. Developers do not build subscription backends.
3. Keep the developer-side integration surface tiny: **one line per gated route**.
4. Don't rip up the existing browser SDK. The change is mostly framing + a few API surface tweaks; the engine stays.
5. Make the secure pattern the obvious default in docs, examples, and the starter app.

## Non-goals

- **Tamper-proof browser SDK.** Not achievable on a runtime the user controls. Obfuscation, anti-debug, DevTools detection — all bypassable, all hostile to legitimate users and engineers. Out of scope.
- **Replacing the developer's product backend.** Where premium data, compute, files, API keys live — that's the developer's domain. We replace the *subscription* backend, not the whole app.
- **JWT entitlement proofs on day one.** A real performance optimization for high-throughput / edge customers, but the middleware path covers 90% of integrations. Ship later.
- **Hosted feature delivery / Superwall-as-serverless-platform.** Plausible long-term product direction, separate workstream, not part of this scope.

---

## Threat model

The browser SDK's local subscription state is writable by anyone with DevTools open. This is structural — the runtime is on the user's machine. The defense is to ensure that tampering with client state cannot grant access to server-side resources.

The following bypass attempts have all been validated against the current code. Each one fools the SDK; none fool a correctly-integrated backend.

| # | Attack | Mechanism | Bypasses access? |
|---|---|---|---|
| 1 | `superwall.purchases.setSubscriptionStatus({ status: "ACTIVE", ... })` | Public API on the SDK (`superwall.ts:1510`). Flips local belief. | **No** — backend middleware queries Superwall server-to-server with the user's session-derived id; gets the truth. |
| 2 | Patch `subStatusSig` directly via reflection or proxy on the public surface | Signal is exposed as `Readable<T>` on the public interface; current types allow mutation paths via casting. | **No** — same as above. |
| 3 | MITM / service worker / DevTools Local Overrides on the SDK's `/entitlements` poll | SDK trusts the response without signature validation (`network.ts:395`). | **No** — backend → Superwall traffic is server-to-server, doesn't traverse the user's machine. |
| 4 | `superwall.identify("victim_user_id")` | Public method; SDK doesn't verify the caller has any claim to that id. | **No** — backend middleware extracts userId from its own session (cookie, JWT), not from anything the client said. |
| 5 | Call the `feature` callback directly | If premium code lives in the closure, it's just JS the user can re-invoke. | **Yes — this is the footgun.** Mitigated by the new pattern: `feature` callbacks call the backend, which gates. |

The model we are shipping says: the SDK's local state is *cosmetic*, the backend is *authoritative*, and the bridge is the developer's own `appUserId`. As long as the developer extracts userId from their authenticated session (the documented default), the only practical bypass is one the developer enables themselves by putting premium logic directly in the client.

### What the threat model deliberately does not protect against

- **The user reading their own data.** If a user can already see premium content rendered in their browser, they can scrape it. Pure-client features are inherently inspectable.
- **Determined attackers patching the SDK.** Anyone willing to reverse-engineer the bundle and patch verification routines can break any client-side check. We do not attempt to stop them.
- **The developer choosing not to gate server-side.** If they put `feature: () => unlockTheThing()` in `register()` and the unlock is purely client-side, that's a misuse pattern documented as such.

---

## Architecture

### Two distinct concepts, currently conflated

The current SDK treats "is the user subscribed?" as one concept. The new model separates two:

1. **Client belief** — what the SDK thinks for the purposes of UI. Used to decide whether to show a paywall, whether to display "Manage Subscription" vs "Upgrade", etc. Lives in the browser, writable by the user, **cosmetic only**.
2. **Server truth** — what Superwall's backend knows about the user's entitlements. Used to gate access to real resources. Lives on Superwall's servers, written only by purchase events, **authoritative**.

Both exist in every healthy integration. They're allowed to diverge briefly (optimistic update post-purchase before truth syncs; tampered client showing fake state). Access decisions consult truth, never belief.

### The userId bridge

The two halves of the system don't need a shared session, a shared cookie, a passed token, or any new transport. They just need to refer to the same user by the same identifier:

```
┌─────────────────┐                          ┌──────────────────┐
│  Browser        │                          │  Developer's     │
│  paywalls-js    │                          │  backend         │
│                 │                          │                  │
│  identify(X)    │                          │  sw.requires(    │
│       │         │                          │    "pro",        │
│       ▼         │   appUserId = X          │    userId: X     │
│  Local belief   │   (same string)          │  )               │
│  (UX state)     │                          │       │          │
└────────┬────────┘                          └───────┼──────────┘
         │                                          │
         │                                          │
         │  ┌────────────────────────────────────┐  │
         │  │      Superwall backend             │  │
         └─►│      /entitlements/{X}              │◄─┘
            │                                    │
            │  Authoritative entitlement state   │
            │  Keyed on appUserId                │
            └────────────────────────────────────┘
```

The developer's auth system is the source of `appUserId` on both sides. The browser passes it via `identify()` so Superwall can present the right paywalls and track the right analytics. The backend passes it to `sw.requires()` from `req.session.userId` (or whatever extractor — never from a client-supplied value) so Superwall can gate the right route.

Identify-spoofing on the client doesn't propagate because the backend never asks the client who they are.

---

## Package layout

```
@superwall/core            <- shared types, schemas, host resolution, errors
@superwall/paywalls-js     <- browser SDK            (depends on core)
@superwall/server          <- server SDK             (depends on core)
@superwall/react           <- React bindings         (depends on paywalls-js)
@superwall/server-next     <- Next.js adapter        (depends on server)
@superwall/server-hono     <- Hono adapter           (depends on server)
@superwall/server-express  <- Express adapter        (depends on server)
@superwall/server-elysia   <- Elysia / Bun adapter   (depends on server)
@superwall/server-cf       <- Cloudflare Workers     (depends on server)
@superwall/server-vercel   <- Vercel Edge            (depends on server)
```

`@superwall/core` is a new package extracted from `paywalls-js/internal`. It contains:

- `Entitlement`, `EntitlementSet`, `SubscriptionStatus` types and Zod / typebox schemas
- `WebEntitlementsResponse` (the wire type for `/entitlements`)
- `resolveHosts(env)` so both SDKs hit the same endpoints with the same env logic
- Error taxonomy: `SuperwallNetworkError`, `SuperwallAuthError`, `SuperwallNotFoundError`
- HTTP envelope helpers (header building shared logic)

Extracting `@superwall/core` is a prerequisite. It's a refactor, not a feature.

---

## `@superwall/server` API surface

### Constructor

```ts
import { Superwall } from "@superwall/server"

const sw = Superwall({
  apiKey: process.env.SUPERWALL_API_KEY!,
  environment: "production",                  // "production" | "staging" | { customHost: string }
  cache: {
    ttlMs: 60_000,                            // default 60s
    maxEntries: 10_000,                       // default 10k
    storage: "memory" | RedisLike | KVLike,   // default "memory"
  },
  // Default userId extractor — override per-call if needed.
  userId: (req) => req.session?.userId ?? null,
  // Optional: hook into outbound calls for tracing
  onRequest: (info) => { /* telemetry */ },
})
```

The `userId` extractor is the safety-critical knob. It runs against the framework's request type and returns the identifier Superwall should look up. **Documented default is to read from authenticated session, never request body or query string.** Adapter packages set a sane default for each framework.

### Middleware: `requires`

The headline API. Drops onto any route handler.

```ts
// Express / Hono / Bun-native
app.get("/api/export", sw.requires("pro"), exportHandler)

// Express, multiple entitlements (AND)
app.get("/api/super-export", sw.requires(["pro", "advanced"]), handler)

// Express, ANY of entitlements (OR)
app.get("/api/either", sw.requires({ any: ["pro", "team"] }), handler)

// With per-route userId override (rare — defaults are usually right)
app.get("/api/admin/:userId/export",
  sw.requires("pro", { userId: (req) => req.params.userId }),  // ⚠️ only if route auth already verified caller can act as :userId
  handler,
)
```

Default behavior on rejection: respond with `403 { error: "entitlement_required", entitlement: "pro" }`. Configurable via `onUnauthorized`:

```ts
sw.requires("pro", {
  onUnauthorized: (req, res, ctx) => res.status(402).json({ paywall: ctx.placement }),
})
```

### Direct check: `userHas`

For cases where middleware doesn't fit (background jobs, GraphQL resolvers, non-HTTP code):

```ts
const allowed = await sw.userHas(userId, "pro")
if (!allowed) throw new ForbiddenError()
```

`userHas` is cached identically to `requires`. Calling it 1000 times within the cache window costs one Superwall API call.

### Bulk check: `getEntitlements`

When you need the full entitlement set (e.g., to return to the client for UI):

```ts
const entitlements = await sw.getEntitlements(userId)
// EntitlementSet — array of active entitlements with metadata
res.json({ user: req.user, entitlements })
```

This is what the developer's own backend would return to populate the client's UI state with truth, if they wanted to bypass the SDK's own `/entitlements` polling.

### Webhook verifier (for the Tier 4 "mirror to your DB" pattern)

```ts
app.post("/webhooks/superwall", sw.webhook(), async (event) => {
  // event is typed: { type: "subscription.created", userId, entitlements, ... }
  await db.users.update(event.userId, { entitlements: event.entitlements })
})
```

The `sw.webhook()` middleware:
- Verifies the request signature against `SUPERWALL_WEBHOOK_SECRET`
- Parses the body
- Provides a typed `event` to the handler
- Returns `400` on invalid signature, `200` on success

This is a prerequisite for customers who don't want a per-request Superwall lookup. Backed by a webhook product we either already have or need to ship alongside.

### Future: `verifyProof` (deferred — JWT path)

```ts
// Once getEntitlementProof() ships on the browser SDK:
const proof = req.headers.authorization?.replace("SwProof ", "")
const claims = await sw.verifyProof(proof)
// claims: { sub: userId, ent: ["pro"], iat, exp, jti }
```

Defer until the middleware path is in production and we have a customer asking for it.

---

## Browser SDK changes

The engine stays. The mandate narrows. Concrete changes:

### 1. Reframe the `feature` callback in docs and types

Today:

```ts
// API.md and types imply: "this runs when the user is entitled"
register({ placement: "pro_export", feature: () => exportToCsv(allData) })
```

After:

```ts
// Documented as: "this runs when the paywall flow resolves (purchase / skip / already-subscribed).
//  Use it to trigger your post-paywall flow. Server-side gating happens in the route the
//  flow calls; the SDK does not, and cannot, enforce access."
register({
  placement: "pro_export",
  feature: async () => {
    const res = await fetch("/api/export")  // server gates here
    if (res.ok) renderExport(await res.json())
  },
})
```

A future major may rename `feature` to `onPaywallResolved` or `onSatisfied`. Not breaking in v0.x.

### 2. Demote `setSubscriptionStatus` from the headline public surface

Keep the method (Mode B — developer's own subscription backend — depends on it). Move it under `superwall.purchases.localState.set(...)` or behind a `localBelief` namespace so the example app doesn't use it as a top-level "fake subscription" button. Documentation reframes it as "tell the SDK your local UI belief" rather than "set entitlement state."

The current example app's "subActive" / "subInactive" debug buttons stay for dev ergonomics — but live under a `__dev` panel that's visually marked as a debug tool, not part of the normal UX.

### 3. Add a first-class `onEntitlementsChanged` event

The event bus already emits subscription state changes. Promote to a documented public API so app code can refresh data when entitlements change:

```ts
superwall.on("entitlementsChanged", ({ entitlements }) => {
  queryClient.invalidateQueries()  // re-fetch gated data
})
```

### 4. Document `identify()` honestly

Add to API.md and the inline JSDoc:

> `identify(appUserId)` tells the SDK who Superwall should track on this device for paywall presentation, audience evaluation, and analytics. It is **not authentication**. Calling `identify()` with another user's id does not grant access to that user's entitlements — access is enforced on your backend via `sw.requires()` using your own session-derived id, not the SDK's. If you want to prevent identify-spoofing from polluting analytics or enabling enumeration, see the Identity Tokens section.

### 5. Optional (future): `getEntitlementProof()`

```ts
const proof = await superwall.getEntitlementProof()
// Short-lived JWT signed by Superwall's backend, bound to userId + deviceId + exp
fetch("/api/export", { headers: { Authorization: `SwProof ${proof}` } })
```

Backend's `sw.requires("pro", { from: "header" })` verifies the JWT against Superwall's JWKS — no per-request `/entitlements` call. Optimization path; defer until customers ask.

### 6. Optional (future): identity tokens

For customers who want to prevent client-side `identify()` spoofing (typically because they're sensitive about analytics integrity or enumeration), allow `identify()` to accept a signed token:

```ts
// Developer's backend issues at login:
const identityToken = await sign({ userId, exp }, DEVELOPER_PRIVATE_KEY)

// Client passes to identify:
await superwall.identify(userId, { identityToken })
// Superwall verifies signature against the developer's published JWKS before binding the device.
```

Defer until a customer asks. Out of v1 scope.

---

## Backend changes

These live in Superwall's existing service, not in this repo. Listing here so the SDK work isn't blocked on them.

### 1. Rate limits on the entitlements endpoint

To mitigate the identify-spoofing enumeration attack:

- Per-IP, per-key rate limit on `/entitlements` reads
- Bucket by key + deviceId combo to allow legitimate polling
- Return `429` with a `Retry-After` header

This doesn't *prevent* enumeration but raises the cost from "free" to "rate-limited and trivially detectable."

### 2. Webhooks

If we don't already ship them, this design depends on:

- `subscription.created`
- `subscription.canceled`
- `subscription.renewed`
- `entitlement.granted` (for non-renewal grants like comps, restores)
- `entitlement.revoked`

Each delivered with `Superwall-Signature: t=...,v1=...` header (Stripe-style HMAC). Verifiable with `SUPERWALL_WEBHOOK_SECRET`.

---

## Documentation strategy

### The spectrum we sell

`API.md` and the marketing site should present four integration depths so developers self-select:

| Tier | Developer writes | Use when |
|---|---|---|
| **Soft gate** | `register({ feature })` only; feature in client closure | Free trial nudges, soft UI locks, anything where bypass cost ≈ $0 |
| **One-line middleware** (recommended default) | `sw.requires("pro")` on gated routes | Any premium data/compute. 90% of customers. |
| **JWT proof** | Verify `sw.getEntitlementProof()` via JWKS | High-throughput, edge runtimes, latency-sensitive paths |
| **Webhook mirror** | Store entitlements in own DB via webhook | Customers who want zero per-request Superwall calls / already have entitlement-aware auth |

### The pitch

> "Superwall is your subscription backend. We handle billing, paywall presentation, entitlement state, renewal logic, grace periods, dunning, restore flows. Your code adds one line of middleware to your routes — `sw.requires("pro")` — and you're done. No subscription tables. No webhook plumbing. No state machines. Just call us."

### Example app

The current `example/example-browser` is client-only and uses `setSubscriptionStatus` from a debug button to fake purchases. For the secure pattern to be the default in the developer's mind, the example needs:

1. A real (mocked-Stripe is fine) purchase flow through the iframe.
2. A tiny backend served by `Bun.serve()` with a single `sw.requires("pro")` route.
3. A "secure feature" button that calls the backend route and renders the response.
4. An "insecure feature" button that runs `feature: () => alert("got in")` in the closure — labeled with a 🚨 and a doc link explaining what's wrong with it.

The contrast makes the lesson stick. The 🚨 example is the canonical thing customers will copy from if it's the only thing they see, so we show both side-by-side.

---

## Implementation order

Suggested sequencing. Each step is independently shippable.

### Phase 1 — Foundation (no customer-visible changes)

1. **Extract `@superwall/core`.** Pull shared types, schemas, host resolution, error taxonomy from `paywalls-js/internal` into a new workspace package. Update `paywalls-js` to depend on it. No behavior change.
2. **Audit and remove the documented bypass surfaces.** Move `setSubscriptionStatus` to a namespaced location, mark debug buttons as such in the example app. Update JSDoc on `identify` and `setSubscriptionStatus` with the honest framing. No types change for consumers who don't update.

### Phase 2 — Server SDK (the headline)

3. **Ship `@superwall/server`.** Core `Superwall()` constructor, `requires`, `userHas`, `getEntitlements`, in-memory cache. No framework adapters yet — generic `(req, res, next)` signature.
4. **Ship `@superwall/server-express` and `@superwall/server-hono`** as the first two adapters. Bun-native is essentially Hono.
5. **Ship `@superwall/server-next`** with both App Router and Pages Router adapters.
6. **Rewrite the API.md gating section** with the four-tier spectrum and the secure pattern as default.
7. **Rewrite the example app** with the secure-vs-insecure side-by-side.

### Phase 3 — Backend dependencies

8. **Webhook product** (if not already shipped).
9. **Rate limits on the entitlements endpoint.**

### Phase 4 — Optimization paths

10. **`sw.webhook()`** middleware in `@superwall/server` (depends on phase 3 step 8).
11. **`getEntitlementProof()` + JWKS endpoint** for the JWT path (depends on backend signing key infrastructure).
12. **`sw.verifyProof()`** in `@superwall/server`.

### Phase 5 — Long tail

13. Server adapters for Elysia, Cloudflare Workers, Vercel Edge, Fastify.
14. Server SDKs in Python, Go, Ruby, PHP — same shape, same docs.
15. Identity tokens for `identify()` if a customer asks.

Phase 1 + 2 is the minimum viable rollout. Everything else compounds value.

---

## Open questions

These need product / backend / leadership input before implementation:

- **Webhook product status.** Do we ship subscription webhooks today? If not, what's the timeline? `@superwall/server` ships without `sw.webhook()` until they exist; that's fine, but worth scoping the dependency.
- **Default cache TTL.** 60s is the proposed default; some customers will want shorter (real-time enforcement on cancellation) or longer (rate-limit reduction). Document the trade-off and the override.
- **Identity-token format.** If we ever ship signed `identify()`, do we expect customers' backends to issue JWTs against their own JWKS (so we verify against their published keys), or do we issue session tokens from Superwall after they POST a server-side login confirmation? The former is more flexible, the latter is simpler. Decision deferred until a customer asks.
- **Streaming responses.** When a `requires` middleware fronts an SSE / WebSocket / streaming endpoint, where does the entitlement check happen — at handshake or per-event? Standard pattern is handshake-only; document explicitly.
- **GraphQL resolvers.** Should we ship a `@superwall/server-graphql` with a directive (`@requires(entitlement: "pro")`) or just document the `userHas` pattern? Probably the latter for v1.

---

## Appendix A — Anti-pattern catalog

These are the things customers will try that we should detect and warn about:

```ts
// 1. Reading userId from request body
sw.requires("pro", { userId: (req) => req.body.userId })  // ⚠️ client-controlled

// 2. Reading userId from query string
sw.requires("pro", { userId: (req) => req.query.userId })  // ⚠️ client-controlled

// 3. Reading from a header that's not validated
sw.requires("pro", { userId: (req) => req.headers["x-user-id"] })  // ⚠️ client-controlled

// 4. Trusting the SDK's local belief on the server
const status = await fetch("/some-endpoint-the-client-pings")  // ⚠️ wrong direction
```

Consider runtime warnings in development for patterns 1–3 (heuristic match on `req.body.*` / `req.query.*` / `req.headers.*` in the extractor function source). Removed in production builds.

---

## Appendix B — What the developer experience looks like end-to-end

**Server (`server.ts`):**

```ts
import { Superwall } from "@superwall/server"

const sw = Superwall({ apiKey: process.env.SUPERWALL_API_KEY! })

Bun.serve({
  routes: {
    "/api/export": {
      GET: async (req) => {
        // sw.requires composes naturally with Bun's route handlers
        return await sw.requires("pro")(req, async () => {
          const data = await generateCsv(req.session.userId)
          return Response.json(data)
        })
      },
    },
  },
})
```

**Client (`app.tsx`):**

```tsx
import { useSuperwall } from "@superwall/react"

function ExportButton() {
  const sw = useSuperwall()

  const onClick = () =>
    sw.register({
      placement: "pro_export",
      feature: async () => {
        const res = await fetch("/api/export")
        if (res.status === 403) return  // user closed paywall without buying
        const data = await res.json()
        renderExport(data)
      },
    })

  return <button onClick={onClick}>Export CSV</button>
}
```

**The bypass attempt (does not work):**

```js
// In DevTools console:
await superwall.purchases.setSubscriptionStatus({ status: "ACTIVE", entitlements: [] })
// SDK now believes user is subscribed. Paywall will not show.
document.querySelector("button").click()
// → fetch("/api/export") → backend reads req.session.userId → asks Superwall
// → "userId is not entitled to pro" → 403
// → No CSV.
```

That's the property the architecture buys. Tampering with the client only changes what the client believes. The server tells the truth.
