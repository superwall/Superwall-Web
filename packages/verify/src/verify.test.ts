import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
  SignJWT,
} from "jose";
import {
  AudienceMismatchError,
  ExpiredError,
  InvalidSignatureError,
  KeyUnavailableError,
  MalformedTokenError,
  userHasAnyEntitlement,
  userHasEntitlement,
  verifyEntitlements,
  VerifyError,
} from "./index.ts";
import { BUNDLED_JWKS, __resetResolverCache } from "./keys.ts";

const PK = "pk_test_123";

interface KeyMaterial {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

let counter = 0;
async function makeKey(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = `test-key-${counter++}`;
  publicJwk.kid = kid;
  publicJwk.alg = "ES256";
  return { privateKey, publicJwk, kid };
}

const nowSec = () => Math.floor(Date.now() / 1000);

interface TokenOpts {
  kid: string;
  privateKey: KeyLike;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  sub?: string;
  entitlements?: unknown;
  alg?: string;
}

function sign(opts: TokenOpts): Promise<string> {
  const iat = opts.iat ?? nowSec();
  const payload: Record<string, unknown> = {
    entitlements:
      opts.entitlements ??
      [
        {
          identifier: "pro",
          expiresAt: 1_900_000_000_000,
          productId: "prod_x",
          store: "STRIPE",
          state: "subscribed",
        },
      ],
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: opts.kid, typ: "JWT" })
    .setIssuer(opts.iss ?? "superwall")
    .setAudience(opts.aud ?? PK)
    .setSubject(opts.sub ?? "user_42")
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 3600)
    .sign(opts.privateKey);
}

// Each test bundles its key under a unique kid; clean up after so module-level
// BUNDLED_JWKS doesn't leak across cases.
afterEach(() => {
  BUNDLED_JWKS.length = 0;
  __resetResolverCache();
});

describe("verifyEntitlements — bundled-key offline path", () => {
  test("verifies a valid token with no network", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });

    const result = await verifyEntitlements(token, { publicApiKey: PK });

    expect(result.sub).toBe("user_42");
    expect(result.publicApiKey).toBe(PK);
    expect(typeof result.issuedAt).toBe("number");
    expect(typeof result.expiresAt).toBe("number");
    expect(result.entitlements).toEqual([
      {
        identifier: "pro",
        expiresAt: 1_900_000_000_000,
        productId: "prod_x",
        store: "STRIPE",
        state: "subscribed",
      },
    ]);
  });

  test("empty entitlements array is valid (no active entitlements)", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      entitlements: [],
    });

    const result = await verifyEntitlements(token, { publicApiKey: PK });
    expect(result.entitlements).toEqual([]);
  });

  test("normalizes missing optional entitlement fields to null/empty", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      entitlements: [{ identifier: "lifetime", expiresAt: null }],
    });

    const result = await verifyEntitlements(token, { publicApiKey: PK });
    expect(result.entitlements[0]).toEqual({
      identifier: "lifetime",
      expiresAt: null,
      productId: null,
      store: "",
      state: "",
    });
  });
});

describe("verifyEntitlements — failure taxonomy", () => {
  test("InvalidSignatureError when signed by a different key", async () => {
    const signer = await makeKey();
    const bundled = await makeKey();
    // Bundle a DIFFERENT public key under the signer's kid.
    bundled.publicJwk.kid = signer.kid;
    BUNDLED_JWKS.push(bundled.publicJwk);
    const token = await sign({ kid: signer.kid, privateKey: signer.privateKey });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidSignatureError);
    expect((err as VerifyError).code).toBe("INVALID_SIGNATURE");
  });

  test("InvalidSignatureError rejects a non-ES256 alg (alg confusion)", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    // HS256 token — alg not in the allowed list; rejected before key use.
    const hsToken = await new SignJWT({ entitlements: [] })
      .setProtectedHeader({ alg: "HS256", kid: k.kid })
      .setIssuer("superwall")
      .setAudience(PK)
      .setSubject("user_42")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new Uint8Array(32));

    const err = await verifyEntitlements(hsToken, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidSignatureError);
  });

  test("ExpiredError when exp is in the past", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const iat = nowSec() - 7200;
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      iat,
      exp: iat + 3600, // expired an hour ago
    });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExpiredError);
    expect((err as VerifyError).code).toBe("EXPIRED");
  });

  test("clockToleranceSec allows a just-expired token", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const iat = nowSec() - 3605;
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      iat,
      exp: iat + 3600, // expired 5s ago
    });

    const result = await verifyEntitlements(token, {
      publicApiKey: PK,
      clockToleranceSec: 30,
    });
    expect(result.sub).toBe("user_42");
  });

  test("AudienceMismatchError when aud != publicApiKey", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      aud: "pk_other_app",
    });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AudienceMismatchError);
    expect((err as VerifyError).code).toBe("AUDIENCE_MISMATCH");
  });

  test("MalformedTokenError when issuer is not superwall", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      iss: "evil",
    });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedTokenError);
  });

  test("MalformedTokenError for a non-JWT string", async () => {
    const err = await verifyEntitlements("not.a.jwt", {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedTokenError);
  });

  test("MalformedTokenError for an empty token", async () => {
    const err = await verifyEntitlements("", {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedTokenError);
  });

  test("MalformedTokenError when entitlements claim is missing", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    // A well-signed token that simply omits the `entitlements` claim.
    const noEnts = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: k.kid })
      .setIssuer("superwall")
      .setAudience(PK)
      .setSubject("user_42")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(k.privateKey);

    const err = await verifyEntitlements(noEnts, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedTokenError);
  });

  test("MalformedTokenError when an entitlement lacks an identifier", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      entitlements: [{ store: "STRIPE" }],
    });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedTokenError);
  });

  test("throws TypeError when publicApiKey is not provided", async () => {
    const k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });

    expect(
      verifyEntitlements(token, {} as unknown as { publicApiKey: string }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("verifyEntitlements — remote JWKS fallback", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("falls back to remote JWKS when kid is not bundled", async () => {
    const k = await makeKey();
    // NOT bundled — must come from the network.
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ keys: [k.publicJwk] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const jwksUrl = `http://localhost:${server.port}/jwks.json`;
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });

    const result = await verifyEntitlements(token, {
      publicApiKey: PK,
      env: { custom: jwksUrl },
    });
    expect(result.entitlements[0]?.identifier).toBe("pro");
  });

  test("KeyUnavailableError when the JWKS endpoint fails", async () => {
    const k = await makeKey();
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    });
    const jwksUrl = `http://localhost:${server.port}/jwks.json`;
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
      jwksUrl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect((err as VerifyError).code).toBe("KEY_UNAVAILABLE");
  });

  test("KeyUnavailableError when no key in the JWKS matches the kid", async () => {
    const signer = await makeKey();
    const other = await makeKey();
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ keys: [other.publicJwk] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const jwksUrl = `http://localhost:${server.port}/jwks.json`;
    const token = await sign({
      kid: signer.kid,
      privateKey: signer.privateKey,
    });

    const err = await verifyEntitlements(token, {
      publicApiKey: PK,
      jwksUrl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
  });
});

describe("userHasEntitlement / userHasAnyEntitlement", () => {
  let k: KeyMaterial;
  beforeEach(async () => {
    k = await makeKey();
    BUNDLED_JWKS.push(k.publicJwk);
  });

  test("userHasEntitlement returns true for an asserted entitlement", async () => {
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });
    expect(
      await userHasEntitlement(token, "pro", { publicApiKey: PK }),
    ).toBe(true);
  });

  test("userHasEntitlement returns false for a missing entitlement", async () => {
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });
    expect(
      await userHasEntitlement(token, "team", { publicApiKey: PK }),
    ).toBe(false);
  });

  test("userHasEntitlement re-throws on an invalid token", async () => {
    const token = await sign({
      kid: k.kid,
      privateKey: k.privateKey,
      aud: "pk_wrong",
    });
    expect(
      userHasEntitlement(token, "pro", { publicApiKey: PK }),
    ).rejects.toBeInstanceOf(AudienceMismatchError);
  });

  test("userHasAnyEntitlement returns true when one matches", async () => {
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });
    expect(
      await userHasAnyEntitlement(token, ["team", "pro"], {
        publicApiKey: PK,
      }),
    ).toBe(true);
  });

  test("userHasAnyEntitlement returns false when none match", async () => {
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });
    expect(
      await userHasAnyEntitlement(token, ["team", "enterprise"], {
        publicApiKey: PK,
      }),
    ).toBe(false);
  });
});
