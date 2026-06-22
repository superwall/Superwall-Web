# @superwall/server

Server-side entitlement enforcement for the Superwall web SDK. The browser's
subscription status is editable from devtools — this package gates real routes
server-to-server against Superwall's `/entitlements` endpoint, with caching.

Works on any runtime with `fetch` (Node 18+, Bun, Deno, Workers).

```sh
bun add @superwall/server   # or npm / pnpm / yarn
```

## Setup

```ts
import { Superwall } from "@superwall/server";

const sw = Superwall({
  apiKey: process.env.SUPERWALL_API_KEY!,        // required
  userId: (req) => req.session?.userId ?? null,  // how to read the user per request
  // environment: "release",
  // cache: { ttlMs: 60_000, maxEntries: 10_000 },
  // timeoutMs: 5_000,
});
```

## Gate a route (Express-style middleware)

```ts
app.get("/api/export", sw.requires("pro"), exportHandler);
// 403 if the user lacks the "pro" entitlement; calls next() if they have it.
```

`requires(entitlement, options?)` returns `(req, res, next)`. Pass a per-call
`userId` extractor in `options` to override the default.

## Check imperatively

```ts
if (await sw.userHas(userId, "pro")) {
  // grant access
}
```

## Offline verification

For per-request checks without a network round-trip, verify the signed
entitlements token the client holds (`sw.entitlementsToken` on the browser
SDK) with [`@superwall/verify`](https://www.npmjs.com/package/@superwall/verify).

## License

MIT
