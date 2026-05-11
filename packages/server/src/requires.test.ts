import { afterEach, describe, expect, test } from "bun:test";
import { Superwall } from "./superwall.ts";
import type {
  ConnectStyleNext,
  ConnectStyleResponse,
  FetchLike,
} from "./types.ts";

interface FakeRequest {
  session?: { userId?: string };
  params?: Record<string, string>;
}

interface ResponseLog {
  statusCode: number | null;
  body: unknown;
}

const realFetch = globalThis.fetch;
const setFetch = (impl: FetchLike): void => {
  (globalThis as unknown as { fetch: FetchLike }).fetch = impl;
};

afterEach(() => {
  (globalThis as unknown as { fetch: typeof realFetch }).fetch = realFetch;
});

const makeRes = (): { res: ConnectStyleResponse; log: ResponseLog } => {
  const log: ResponseLog = { statusCode: null, body: null };
  const res: ConnectStyleResponse = {
    status(code) {
      log.statusCode = code;
      return res;
    },
    json(body) {
      log.body = body;
      return res;
    },
  };
  return { res, log };
};

const makeNext = (): {
  next: ConnectStyleNext;
  calls: Array<{ err?: unknown }>;
} => {
  const calls: Array<{ err?: unknown }> = [];
  const next: ConnectStyleNext = (err) => {
    calls.push(err === undefined ? {} : { err });
  };
  return { next, calls };
};

const okResponse = (
  entitlements: Array<{ id: string; isActive: boolean }>,
): Response =>
  new Response(JSON.stringify({ entitlements }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

describe("sw.requires()", () => {
  test("calls next() when entitled", async () => {
    setFetch(async () => okResponse([{ id: "pro", isActive: true }]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: (r) => r.session?.userId ?? null,
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro")({ session: { userId: "u1" } }, res, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
    expect(log.statusCode).toBeNull();
  });

  test("default 403 when not entitled", async () => {
    setFetch(async () => okResponse([{ id: "team", isActive: true }]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: (r) => r.session?.userId ?? null,
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro")({ session: { userId: "u1" } }, res, next);
    expect(calls).toHaveLength(0);
    expect(log.statusCode).toBe(403);
    expect(log.body).toEqual({
      error: "entitlement_required",
      entitlement: "pro",
    });
  });

  test("fail-closed when no userId can be extracted", async () => {
    setFetch(async () => {
      throw new Error("should not be called — extractor returned null");
    });
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: (r) => r.session?.userId ?? null,
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro")({}, res, next);
    expect(calls).toHaveLength(0);
    expect(log.statusCode).toBe(403);
  });

  test("allowAnonymous lets the handler decide", async () => {
    setFetch(async () => okResponse([]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: (r) => r.session?.userId ?? null,
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro", { allowAnonymous: true })({}, res, next);
    expect(calls).toEqual([{}]);
    expect(log.statusCode).toBeNull();
  });

  test("onUnauthorized override", async () => {
    setFetch(async () => okResponse([]));
    const seen: Array<{ reason: string; missing: ReadonlyArray<string> }> = [];
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: (r) => r.session?.userId ?? null,
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro", {
      onUnauthorized: (_req, r, ctx) => {
        seen.push({ reason: ctx.reason, missing: ctx.missing });
        r.status(402).json({ paywall: ctx.entitlement });
      },
    })({ session: { userId: "u1" } }, res, next);
    expect(calls).toHaveLength(0);
    expect(log.statusCode).toBe(402);
    expect(log.body).toEqual({ paywall: "pro" });
    expect(seen).toEqual([{ reason: "not_entitled", missing: ["pro"] }]);
  });

  test("per-route userId override wins", async () => {
    const observed: { queriedId: string | null } = { queriedId: null };
    setFetch(async (input) => {
      const m = urlOf(input).match(/\/users\/([^/]+)\/entitlements/);
      observed.queriedId = m ? decodeURIComponent(m[1]!) : null;
      return okResponse([{ id: "pro", isActive: true }]);
    });
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: () => "default-user",
    });
    const { res } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro", {
      userId: (r) => r.params?.userId ?? null,
    })({ params: { userId: "explicit-user" } }, res, next);
    expect(calls).toEqual([{}]);
    expect(observed.queriedId).toBe("explicit-user");
  });

  test("network errors pass to next(err)", async () => {
    setFetch(async () => new Response("oops", { status: 500 }));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: () => "u1",
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires("pro")({}, res, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.err).toBeDefined();
    expect(log.statusCode).toBeNull();
  });

  test("multiple-AND spec rejects when any missing", async () => {
    setFetch(async () => okResponse([{ id: "pro", isActive: true }]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: () => "u1",
    });
    const { res, log } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires(["pro", "team"])({}, res, next);
    expect(calls).toHaveLength(0);
    expect(log.statusCode).toBe(403);
    expect((log.body as { entitlement: string }).entitlement).toBe("team");
  });

  test("ANY spec passes when one active", async () => {
    setFetch(async () => okResponse([{ id: "team", isActive: true }]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: () => "u1",
    });
    const { res } = makeRes();
    const { next, calls } = makeNext();
    await sw.requires({ any: ["pro", "team"] })({}, res, next);
    expect(calls).toEqual([{}]);
  });

  test("normalizes spec at registration time (fails loud)", () => {
    setFetch(async () => okResponse([]));
    const sw = Superwall<FakeRequest>({
      apiKey: "k",
      userId: () => "u1",
    });
    expect(() => sw.requires("")).toThrow(TypeError);
    expect(() => sw.requires([])).toThrow(TypeError);
  });
});
