# @superwall/verify

Stateless, offline verification of Superwall-signed entitlement tokens
(ES256 JWS). Verify a user's entitlements cryptographically on your server —
no network round-trip per request.

Works on any runtime with Web Crypto (Node 18+, Bun, Deno, Workers).

```sh
bun add @superwall/verify   # or npm / pnpm / yarn
```

## Usage

The browser SDK exposes the signed token as `sw.entitlementsToken`. Send it to
your server, then:

```ts
import { userHasEntitlement } from "@superwall/verify";

const hasPro = await userHasEntitlement(tokenFromClient, "pro", {
  publicApiKey: process.env.SUPERWALL_PUBLIC_API_KEY!, // your pk_... value
});
if (!hasPro) return res.status(402).end();
```

`userHasEntitlement` / `userHasAnyEntitlement` also check each entitlement's
own `expiresAt` — the token is a snapshot at issue time with a ~1h life, so an
entitlement can lapse while the token is still valid.

For raw claims, `verifyEntitlements` returns the token's entitlements verbatim
(including possibly-lapsed ones — check `expiresAt` yourself):

```ts
import { verifyEntitlements } from "@superwall/verify";

const result = await verifyEntitlements(tokenFromClient, { publicApiKey });
const pro = result.entitlements.find((e) => e.identifier === "pro");
if (!pro || (pro.expiresAt !== null && pro.expiresAt <= Date.now())) {
  return res.status(402).end();
}
```

A valid signature proves Superwall issued those exact entitlements. Errors
(`InvalidSignatureError`, `ExpiredError`, `MalformedTokenError`, …) all extend
`VerifyError`. Always gate on the **server** — client checks are bypassable
regardless of crypto.

For route gating against the live `/entitlements` endpoint instead of a token,
see [`@superwall/server`](https://www.npmjs.com/package/@superwall/server).

## License

MIT
