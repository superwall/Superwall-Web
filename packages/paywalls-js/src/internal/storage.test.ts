import { test, expect } from "bun:test";
import { Effect } from "effect";
import { STORAGE_KEYS, type StorageAdapter } from "../types.ts";
import { asStorageKey } from "./brands.ts";
import {
  StorageGetError,
  StorageSetError,
  StorageRemoveError,
  StorageClearError,
} from "./errors.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

const ALIAS_KEY = asStorageKey(STORAGE_KEYS.aliasId);

const run = <A, E>(eff: Effect.Effect<A, E, StorageService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(StorageService.Default)) as Effect.Effect<A, E, never>);

test("memory adapter: round-trips get/set/remove/clear", async () => {
  const adapter = createMemoryStorage();
  expect(await adapter.get("k")).toBeNull();
  await adapter.set("k", "v");
  expect(await adapter.get("k")).toBe("v");
  await adapter.remove("k");
  expect(await adapter.get("k")).toBeNull();

  await adapter.set("a", "1");
  await adapter.set("b", "2");
  await adapter.clear?.();
  expect(await adapter.get("a")).toBeNull();
  expect(await adapter.get("b")).toBeNull();
});

test("StorageService.Default uses an in-memory adapter", async () => {
  const out = await run(
    Effect.gen(function* () {
      yield* StorageService.set(ALIAS_KEY, "$SuperwallAlias:abc");
      const got = yield* StorageService.get(ALIAS_KEY);
      return got;
    }),
  );
  expect(out).toBe("$SuperwallAlias:abc");
});

test("StorageService.get returns null for missing keys", async () => {
  const out = await run(StorageService.get(asStorageKey("missing")));
  expect(out).toBeNull();
});

test("StorageService.fromAdapter wraps a custom sync adapter", async () => {
  const adapter = createMemoryStorage();
  const program = Effect.gen(function* () {
    yield* StorageService.set(ALIAS_KEY, "from-custom");
    return yield* StorageService.get(ALIAS_KEY);
  });
  const out = await Effect.runPromise(
    program.pipe(Effect.provide(StorageService.fromAdapter(adapter))),
  );
  expect(out).toBe("from-custom");
});

test("StorageService.fromAdapter wraps an async adapter", async () => {
  const inner = new Map<string, string>();
  const asyncAdapter: StorageAdapter = {
    get: async (k) => inner.get(k) ?? null,
    set: async (k, v) => {
      inner.set(k, v);
    },
    remove: async (k) => {
      inner.delete(k);
    },
  };

  const program = Effect.gen(function* () {
    yield* StorageService.set(ALIAS_KEY, "async-write");
    return yield* StorageService.get(ALIAS_KEY);
  });
  const out = await Effect.runPromise(
    program.pipe(Effect.provide(StorageService.fromAdapter(asyncAdapter))),
  );
  expect(out).toBe("async-write");
});

test("adapter throws → StorageService surfaces a tagged StorageGetError", async () => {
  const broken: StorageAdapter = {
    get: () => {
      throw new Error("disk full");
    },
    set: () => {},
    remove: () => {},
  };

  const result = await Effect.runPromiseExit(
    StorageService.get(ALIAS_KEY).pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
    ),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(StorageGetError);
    expect((err as StorageGetError).key).toBe(ALIAS_KEY);
    expect((err as StorageGetError).message).toContain("disk full");
  }
});

test("adapter rejects → tagged StorageSetError", async () => {
  const broken: StorageAdapter = {
    get: () => null,
    set: async () => {
      throw new Error("quota exceeded");
    },
    remove: () => {},
  };

  const result = await Effect.runPromiseExit(
    StorageService.set(ALIAS_KEY, "x").pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
    ),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(StorageSetError);
    expect((err as StorageSetError).key).toBe(ALIAS_KEY);
    expect((err as StorageSetError).message).toContain("quota exceeded");
  }
});

test("adapter throws on remove → tagged StorageRemoveError", async () => {
  const broken: StorageAdapter = {
    get: () => null,
    set: () => {},
    remove: () => {
      throw new Error("permission denied");
    },
  };

  const result = await Effect.runPromiseExit(
    StorageService.remove(ALIAS_KEY).pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
    ),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(StorageRemoveError);
  }
});

test("clear() on adapter without clear() fails with StorageClearError", async () => {
  const noClear: StorageAdapter = {
    get: () => null,
    set: () => {},
    remove: () => {},
    // intentionally no `clear`
  };

  const result = await Effect.runPromiseExit(
    StorageService.clear().pipe(
      Effect.provide(StorageService.fromAdapter(noClear)),
    ),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(StorageClearError);
    expect((err as StorageClearError).message).toContain("does not implement clear");
  }
});

test("Effect.catchTag narrows on the tagged error", async () => {
  const broken: StorageAdapter = {
    get: () => {
      throw new Error("boom");
    },
    set: () => {},
    remove: () => {},
  };

  const recovered = await Effect.runPromise(
    StorageService.get(ALIAS_KEY).pipe(
      Effect.catchTag("StorageGetError", (e) =>
        Effect.succeed(`recovered: ${e.key}`),
      ),
      Effect.provide(StorageService.fromAdapter(broken)),
    ),
  );
  expect(recovered).toBe(`recovered: ${ALIAS_KEY}`);
});

test("STORAGE_KEYS contract is the documented set (snapshot)", () => {
  expect(STORAGE_KEYS).toEqual({
    aliasId: "superwall.aliasId",
    appUserId: "superwall.appUserId",
    vendorId: "superwall.vendorId",
    deviceId: "superwall.deviceId",
    seed: "superwall.seed",
    userAttributes: "superwall.userAttributes",
    integrationAttributes: "superwall.integrationAttributes",
    firstSeenAt: "superwall.firstSeenAt",
    totalPaywallViews: "superwall.totalPaywallViews",
    lastPaywallViewAt: "superwall.lastPaywallViewAt",
    computedProperties: "superwall.computedProperties",
    assignments: "superwall.assignments",
    lastRestoreAt: "superwall.lastRestoreAt",
    config: "superwall.config",
    latestRedemption: "superwall.latestRedemption",
    subscriptionStatus: "superwall.subscriptionStatus",
    surveyAssignmentKey: "superwall.surveyAssignmentKey",
  });
});
