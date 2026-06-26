// Key resolution: bundled public keys first (zero network), remote JWKS as a
// fallback. Goal is zero key management for customers — see SPEC §5.
//
// A customer on an up-to-date package version makes NO network calls to verify:
// the token's `kid` matches a key bundled at release time. After a key rotation
// that predates the installed package, an unknown `kid` transparently falls
// back to the remote JWKS, which `jose` caches in-memory (~30s cooldown, ~10min
// reuse), so steady-state traffic is negligible either way. No config required.

import { createRemoteJWKSet, importJWK, type JWTVerifyGetKey } from "jose";
import { BUNDLED_JWKS } from "./bundled-keys.ts";

export { BUNDLED_JWKS };

/** Stable, CDN-cached well-known URL. MUST never move — customers pin it. */
export const DEFAULT_JWKS_URL =
  "https://superwall.com/.well-known/entitlements/jwks.json";

const DEV_JWKS_URL =
  "https://superwall.dev/.well-known/entitlements/jwks.json";

export const jwksUrlForEnv = (
  env?: "prod" | "dev" | { custom: string },
): string => {
  if (typeof env === "object") return env.custom;
  if (env === "dev") return DEV_JWKS_URL;
  return DEFAULT_JWKS_URL;
};

// One resolver per JWKS URL, reused across `verifyEntitlements` calls so jose's
// in-memory JWKS cache actually persists between requests.
const resolverCache = new Map<string, JWTVerifyGetKey>();

/** Get (or lazily build) the combined bundled-then-remote key resolver for a
 *  JWKS URL. */
export function getKeyResolver(jwksUrl: string): JWTVerifyGetKey {
  let resolver = resolverCache.get(jwksUrl);
  if (!resolver) {
    resolver = createCombinedResolver(jwksUrl);
    resolverCache.set(jwksUrl, resolver);
  }
  return resolver;
}

function createCombinedResolver(jwksUrl: string): JWTVerifyGetKey {
  // Remote JWKS set is created lazily on first miss so that customers whose
  // every token resolves from the bundle never even construct it.
  let remote: JWTVerifyGetKey | undefined;
  // Imported bundled keys, memoized by `kid` so we only run `importJWK` once.
  const imported = new Map<string, ReturnType<typeof importJWK>>();

  return (header, token) => {
    const kid = header.kid;
    if (kid !== undefined) {
      // Read BUNDLED_JWKS live (not captured) so a key registered after the
      // resolver was built is still found.
      const jwk = BUNDLED_JWKS.find((k) => k.kid === kid);
      if (jwk) {
        let key = imported.get(kid);
        if (!key) {
          key = importJWK(jwk, jwk.alg ?? "ES256");
          imported.set(kid, key);
        }
        return key;
      }
    }
    if (!remote) remote = createRemoteJWKSet(new URL(jwksUrl));
    return remote(header, token);
  };
}

/** Test-only: reset the per-URL resolver cache so a fresh JWKS server can be
 *  pointed at the same URL across cases. Not exported from the package root. */
export function __resetResolverCache(): void {
  resolverCache.clear();
}
