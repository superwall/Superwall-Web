import { it, expect } from "@effect/vitest";
import { Effect, Either } from "effect";
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

it("memory adapter: round-trips get/set/remove/clear", async () => {
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

it.effect("StorageService.Default uses an in-memory adapter", () =>
  Effect.gen(function* () {
    yield* StorageService.set(ALIAS_KEY, "$SuperwallAlias:abc");
    const got = yield* StorageService.get(ALIAS_KEY);
    expect(got).toBe("$SuperwallAlias:abc");
  }).pipe(Effect.provide(StorageService.Default)),
);

it.effect("StorageService.get returns null for missing keys", () =>
  Effect.gen(function* () {
    const out = yield* StorageService.get(asStorageKey("missing"));
    expect(out).toBeNull();
  }).pipe(Effect.provide(StorageService.Default)),
);

it.effect("StorageService.fromAdapter wraps a custom sync adapter", () => {
  const adapter = createMemoryStorage();
  return Effect.gen(function* () {
    yield* StorageService.set(ALIAS_KEY, "from-custom");
    const out = yield* StorageService.get(ALIAS_KEY);
    expect(out).toBe("from-custom");
  }).pipe(Effect.provide(StorageService.fromAdapter(adapter)));
});

it.effect("StorageService.fromAdapter wraps an async adapter", () => {
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

  return Effect.gen(function* () {
    yield* StorageService.set(ALIAS_KEY, "async-write");
    const out = yield* StorageService.get(ALIAS_KEY);
    expect(out).toBe("async-write");
  }).pipe(Effect.provide(StorageService.fromAdapter(asyncAdapter)));
});

it.effect("adapter throws → StorageService surfaces a tagged StorageGetError", () => {
  const broken: StorageAdapter = {
    get: () => {
      throw new Error("disk full");
    },
    set: () => {},
    remove: () => {},
  };

  return Effect.gen(function* () {
    const result = yield* StorageService.get(ALIAS_KEY).pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(StorageGetError);
      expect((result.left as StorageGetError).key).toBe(ALIAS_KEY);
      expect((result.left as StorageGetError).message).toContain("disk full");
    }
  });
});

it.effect("adapter rejects → tagged StorageSetError", () => {
  const broken: StorageAdapter = {
    get: () => null,
    set: async () => {
      throw new Error("quota exceeded");
    },
    remove: () => {},
  };

  return Effect.gen(function* () {
    const result = yield* StorageService.set(ALIAS_KEY, "x").pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(StorageSetError);
      expect((result.left as StorageSetError).key).toBe(ALIAS_KEY);
      expect((result.left as StorageSetError).message).toContain("quota exceeded");
    }
  });
});

it.effect("adapter throws on remove → tagged StorageRemoveError", () => {
  const broken: StorageAdapter = {
    get: () => null,
    set: () => {},
    remove: () => {
      throw new Error("permission denied");
    },
  };

  return Effect.gen(function* () {
    const result = yield* StorageService.remove(ALIAS_KEY).pipe(
      Effect.provide(StorageService.fromAdapter(broken)),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(StorageRemoveError);
    }
  });
});

it.effect("clear() on adapter without clear() fails with StorageClearError", () => {
  const noClear: StorageAdapter = {
    get: () => null,
    set: () => {},
    remove: () => {},
    // intentionally no `clear`
  };

  return Effect.gen(function* () {
    const result = yield* StorageService.clear().pipe(
      Effect.provide(StorageService.fromAdapter(noClear)),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(StorageClearError);
      expect((result.left as StorageClearError).message).toContain("does not implement clear");
    }
  });
});

it.effect("Effect.catchTag narrows on the tagged error", () => {
  const broken: StorageAdapter = {
    get: () => {
      throw new Error("boom");
    },
    set: () => {},
    remove: () => {},
  };

  return Effect.gen(function* () {
    const recovered = yield* StorageService.get(ALIAS_KEY).pipe(
      Effect.catchTag("StorageGetError", (e) =>
        Effect.succeed(`recovered: ${e.key}`),
      ),
      Effect.provide(StorageService.fromAdapter(broken)),
    );
    expect(recovered).toBe(`recovered: ${ALIAS_KEY}`);
  });
});

it("STORAGE_KEYS contract is the documented set (snapshot)", () => {
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
    attribution: "superwall.attribution",
  });
});
