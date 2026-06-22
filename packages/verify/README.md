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
import { verifyEntitlements } from "@superwall/verify";

const result = await verifyEntitlements(tokenFromClient, {
  publicApiKey: process.env.SUPERWALL_PUBLIC_API_KEY!, // your pk_... value
});

if (!result.entitlements.some((e) => e.identifier === "pro")) {
  return res.status(402).end();
}
```

Convenience helpers:

```ts
import { userHasEntitlement, userHasAnyEntitlement } from "@superwall/verify";

await userHasEntitlement(token, "pro", { publicApiKey });
await userHasAnyEntitlement(token, ["pro", "team"], { publicApiKey });
```

A valid signature proves Superwall issued those exact entitlements. Errors
(`InvalidSignatureError`, `ExpiredError`, `MalformedTokenError`, …) all extend
`VerifyError`. Always gate on the **server** — client checks are bypassable
regardless of crypto.

For route gating against the live `/entitlements` endpoint instead of a token,
see [`@superwall/server`](https://www.npmjs.com/package/@superwall/server).

## License

MIT
