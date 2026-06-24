// Bun.serve + HTML imports per the workspace CLAUDE.md.
// Bun's bundler handles `<script type="module" src="./app.ts">` automatically.
//
// No API proxy — the Superwall BE returns CORS headers for browser origins,
// so the SDK fetches the configured hosts directly (see app.ts).

import { verifyEntitlements } from "@superwall/verify";
import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

// Same public key the client uses (app.ts). verifyEntitlements binds the
// token's audience to this key.
const SUPERWALL_API_KEY =
  process.env.SUPERWALL_API_KEY ?? "pk_ZNLGF8AlO2V50YDvC1y0c";

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" }, ...init });

Bun.serve({
  routes: {
    "/": index,
    // Offline server-side verification of the signed entitlements JWT
    // (sw.entitlementsToken). Verifies the ES256 signature locally via
    // @superwall/verify — no /entitlements round-trip. The client posts the
    // token here; a real app would gate a protected resource on the result.
    "/api/verify-token": {
      async POST(req) {
        const body = (await req.json().catch(() => null)) as
          | { token?: string }
          | null;
        if (!body?.token) {
          return json({ error: "token_required" }, { status: 400 });
        }
        try {
          const result = await verifyEntitlements(body.token, {
            publicApiKey: SUPERWALL_API_KEY,
            jwksUrl: "https://superwall.dev/.well-known/entitlements/jwks.json",
          });
          return json({
            verified: true,
            entitlements: result.entitlements,
            hasPro: result.entitlements.some((e) => e.identifier === "pro"),
          });
        } catch (error) {
          return json(
            {
              verified: false,
              error: error instanceof Error ? error.name : "verify_failed",
              message: error instanceof Error ? error.message : String(error),
            },
            { status: 401 },
          );
        }
      },
    },
  },
  development: { hmr: true, console: true },
  port,
});

console.log(`Open http://localhost:${port}`);
