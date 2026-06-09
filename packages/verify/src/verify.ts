// `verifyEntitlements` — the one function a customer's backend calls to turn a
// Superwall-signed token into trusted entitlements, with no per-request call to
// Superwall. A valid ES256 signature proves Superwall issued these exact
// entitlements and nobody tampered with them; forgery requires the private key.
//
// Reminder from the threat model (SPEC §"Security model"): this MUST run on the
// server. The browser is the user's turf — anything gated purely client-side is
// bypassable at the UI layer regardless of crypto.

import { jwtVerify, type JWTPayload } from "jose";
import {
  AudienceMismatchError,
  ExpiredError,
  InvalidSignatureError,
  KeyUnavailableError,
  MalformedTokenError,
  VerifyError,
} from "./errors.ts";
import { DEFAULT_JWKS_URL, getKeyResolver } from "./keys.ts";
import type {
  Entitlement,
  VerifiedEntitlements,
  VerifyOptions,
} from "./types.ts";

const ISSUER = "superwall";
const ALGORITHMS = ["ES256"] as const;

/**
 * Verify a Superwall-signed entitlements token. Resolves to the trusted claims
 * on success; **throws a typed {@link VerifyError}** on any failure — never a
 * partial result.
 *
 * ```ts
 * const result = await verifyEntitlements(tokenFromClient, {
 *   publicApiKey: process.env.SUPERWALL_PUBLIC_API_KEY!, // the `pk_...` value
 * });
 * if (!result.entitlements.some((e) => e.identifier === "pro")) {
 *   return res.status(402).end();
 * }
 * ```
 *
 * @throws {InvalidSignatureError} signature failed / non-ES256 `alg`.
 * @throws {ExpiredError} `exp` is in the past.
 * @throws {AudienceMismatchError} `aud` ≠ `publicApiKey`.
 * @throws {MalformedTokenError} not a JWT, wrong issuer, or bad payload.
 * @throws {KeyUnavailableError} signing key could not be resolved.
 */
export async function verifyEntitlements(
  token: string,
  options: VerifyOptions,
): Promise<VerifiedEntitlements> {
  if (!options || typeof options.publicApiKey !== "string" || !options.publicApiKey) {
    throw new TypeError(
      "verifyEntitlements: `options.publicApiKey` is required (the `pk_...` value).",
    );
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new MalformedTokenError("Token must be a non-empty string.");
  }

  const resolver = getKeyResolver(options.jwksUrl ?? DEFAULT_JWKS_URL);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, resolver, {
      // Pin ES256 only — rejects `none` and prevents alg-confusion attacks.
      algorithms: [...ALGORITHMS],
      issuer: ISSUER,
      // `aud` is the app's public API key (`pk_...`), the value the customer
      // configured the SDK with — NOT the internal applicationId.
      audience: options.publicApiKey,
      clockTolerance: options.clockToleranceSec ?? 0,
    }));
  } catch (err) {
    throw mapVerifyError(err);
  }

  return parsePayload(payload, options.publicApiKey);
}

/**
 * Convenience: does the token assert `identifier` for its subject? Returns
 * `false` only for a *valid* token that lacks the entitlement; re-throws every
 * verification failure (invalid signature, expired, etc.) so a broken token is
 * never silently treated as "no access" — that distinction is the caller's to
 * handle. Mirrors `@superwall/server`'s `userHas` ergonomics.
 */
export async function userHasEntitlement(
  token: string,
  identifier: string,
  options: VerifyOptions,
): Promise<boolean> {
  const result = await verifyEntitlements(token, options);
  return result.entitlements.some((e) => e.identifier === identifier);
}

/** Convenience: does the token assert *any* of `identifiers`? Same throw/return
 *  contract as {@link userHasEntitlement}. */
export async function userHasAnyEntitlement(
  token: string,
  identifiers: readonly string[],
  options: VerifyOptions,
): Promise<boolean> {
  const result = await verifyEntitlements(token, options);
  const wanted = new Set(identifiers);
  return result.entitlements.some((e) => wanted.has(e.identifier));
}

// --- internals -------------------------------------------------------------

/** Translate a jose failure into our typed taxonomy by its stable `code`. */
function mapVerifyError(err: unknown): VerifyError {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "ERR_JWT_EXPIRED":
      return new ExpiredError(undefined, err);
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return new InvalidSignatureError(undefined, err);
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const claim =
        typeof err === "object" && err !== null && "claim" in err
          ? (err as { claim?: unknown }).claim
          : undefined;
      if (claim === "aud") return new AudienceMismatchError(undefined, err);
      // Wrong issuer / nbf / iat etc. — not our token, treat as malformed.
      return new MalformedTokenError(message, err);
    }
    case "ERR_JWKS_NO_MATCHING_KEY":
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
    case "ERR_JWKS_TIMEOUT":
    case "ERR_JWKS_INVALID":
      return new KeyUnavailableError(undefined, err);
    case "ERR_JWT_INVALID":
    case "ERR_JWS_INVALID":
    case "ERR_JOSE_NOT_SUPPORTED":
    case "ERR_JWK_INVALID":
      return new MalformedTokenError(message, err);
    default:
      // No jose code: almost always the remote JWKS fetch itself failed
      // (network error / non-200). That's an availability problem, not proof
      // the token is bad.
      return new KeyUnavailableError(
        `Could not verify token: ${message}`,
        err,
      );
  }
}

/** Project verified claims into {@link VerifiedEntitlements}, validating the
 *  entitlements array against the token contract (SPEC §3). */
function parsePayload(
  payload: JWTPayload,
  publicApiKey: string,
): VerifiedEntitlements {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new MalformedTokenError("Token is missing a `sub` claim.");
  }
  // jose has already validated `exp` exists if present and is in the future,
  // but does not require it. The contract mandates both.
  if (typeof payload.iat !== "number") {
    throw new MalformedTokenError("Token is missing a numeric `iat` claim.");
  }
  if (typeof payload.exp !== "number") {
    throw new MalformedTokenError("Token is missing a numeric `exp` claim.");
  }

  const raw = (payload as { entitlements?: unknown }).entitlements;
  if (!Array.isArray(raw)) {
    throw new MalformedTokenError(
      "Token `entitlements` claim is missing or not an array.",
    );
  }

  const entitlements = raw.map(parseEntitlement);

  return {
    sub,
    publicApiKey,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    entitlements,
  };
}

function parseEntitlement(item: unknown, index: number): Entitlement {
  if (typeof item !== "object" || item === null) {
    throw new MalformedTokenError(
      `Entitlement at index ${index} is not an object.`,
    );
  }
  const e = item as Record<string, unknown>;
  if (typeof e.identifier !== "string" || e.identifier.length === 0) {
    throw new MalformedTokenError(
      `Entitlement at index ${index} is missing a string \`identifier\`.`,
    );
  }
  return {
    identifier: e.identifier,
    expiresAt: typeof e.expiresAt === "number" ? e.expiresAt : null,
    productId: typeof e.productId === "string" ? e.productId : null,
    store: typeof e.store === "string" ? e.store : "",
    state: typeof e.state === "string" ? e.state : "",
  };
}
