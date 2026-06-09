#!/usr/bin/env bun
// Regenerate src/bundled-keys.ts from the live JWKS so a package release ships
// the current public keys and verifies the newest tokens with no network call.
// Run on each key rotation, before publishing:  bun run sync-keys
//
// Usage:
//   bun run sync-keys                 # pull from the default well-known URL
//   bun run sync-keys <jwks-url>      # pull from an override (e.g. staging)

import { DEFAULT_JWKS_URL } from "../src/keys.ts";

interface JsonWebKeySet {
  keys: Array<Record<string, unknown>>;
}

const url = process.argv[2] ?? DEFAULT_JWKS_URL;

const res = await fetch(url);
if (!res.ok) {
  console.error(`sync-keys: ${url} returned ${res.status} ${res.statusText}`);
  process.exit(1);
}

const body = (await res.json()) as JsonWebKeySet;
if (!body || !Array.isArray(body.keys)) {
  console.error(`sync-keys: ${url} did not return a { keys: [...] } JWKS.`);
  process.exit(1);
}

// Keep only public-key material — never bundle a private component, even if the
// upstream endpoint mistakenly serves one.
const PRIVATE_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k"];
const keys = body.keys.map((jwk) => {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(jwk)) {
    if (!PRIVATE_FIELDS.includes(k)) clean[k] = v;
  }
  if (!clean.kid) {
    console.error("sync-keys: refusing to bundle a key without a `kid`.");
    process.exit(1);
  }
  return clean;
});

const file = new URL("../src/bundled-keys.ts", import.meta.url);
const contents = `// GENERATED FILE — do not edit by hand.
//
// Public signing keys bundled at release time, keyed by \`kid\`. Regenerated from
// the live JWKS on each rotation: \`bun run sync-keys\` (see scripts/sync-keys.ts).
//
// Source: ${url}

import type { JWK } from "jose";

export const BUNDLED_JWKS: JWK[] = ${JSON.stringify(keys, null, 2)};
`;

await Bun.write(file, contents);
console.log(
  `sync-keys: wrote ${keys.length} key(s) [${keys
    .map((k) => k.kid)
    .join(", ")}] to src/bundled-keys.ts`,
);
