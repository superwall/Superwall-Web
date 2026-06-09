// Typed errors for token verification. Mirrors the plain-class style of
// `@superwall/core`'s errors (a `code` discriminant + named subclasses) so the
// two packages feel identical to catch against.
//
// `verifyEntitlements` NEVER returns a partial/"maybe valid" result — every
// failure path throws one of these. Callers can switch on `err.code` or
// `instanceof` the specific subclass.

export type VerifyErrorCode =
  | "INVALID_SIGNATURE"
  | "EXPIRED"
  | "AUDIENCE_MISMATCH"
  | "MALFORMED"
  | "KEY_UNAVAILABLE";

export class VerifyError extends Error {
  override readonly name: string = "VerifyError";
  readonly code: VerifyErrorCode;
  override readonly cause?: unknown;

  constructor(message: string, code: VerifyErrorCode, cause?: unknown) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Signature did not verify against the resolved key, or an `alg` other than
 *  ES256 was presented (alg-confusion / `none` attempts land here). The token
 *  was not issued by Superwall, or it was tampered with. */
export class InvalidSignatureError extends VerifyError {
  override readonly name = "InvalidSignatureError";
  constructor(message = "Token signature is invalid.", cause?: unknown) {
    super(message, "INVALID_SIGNATURE", cause);
  }
}

/** `exp` is in the past (beyond clock tolerance). Tokens live 1h; fetch a fresh
 *  one from the browser SDK. */
export class ExpiredError extends VerifyError {
  override readonly name = "ExpiredError";
  constructor(message = "Token has expired.", cause?: unknown) {
    super(message, "EXPIRED", cause);
  }
}

/** `aud` did not match the expected `publicApiKey`. Prevents replaying a token
 *  minted for one app against another. */
export class AudienceMismatchError extends VerifyError {
  override readonly name = "AudienceMismatchError";
  constructor(
    message = "Token audience does not match the expected publicApiKey.",
    cause?: unknown,
  ) {
    super(message, "AUDIENCE_MISMATCH", cause);
  }
}

/** The token is structurally invalid: not a JWT, wrong issuer, missing/garbled
 *  claims, or an entitlements payload that doesn't match the contract. */
export class MalformedTokenError extends VerifyError {
  override readonly name = "MalformedTokenError";
  constructor(message = "Token is malformed.", cause?: unknown) {
    super(message, "MALFORMED", cause);
  }
}

/** The signing key could not be resolved: the token's `kid` is unknown to the
 *  bundled keys AND the remote JWKS could not be fetched (network failure, no
 *  matching key, timeout). This is an availability problem, not proof the token
 *  is bad — callers may choose to retry. */
export class KeyUnavailableError extends VerifyError {
  override readonly name = "KeyUnavailableError";
  constructor(
    message = "Could not resolve a signing key for this token.",
    cause?: unknown,
  ) {
    super(message, "KEY_UNAVAILABLE", cause);
  }
}
