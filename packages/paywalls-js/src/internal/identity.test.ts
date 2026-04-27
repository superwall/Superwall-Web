import { test, expect } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { STORAGE_KEYS, type StorageAdapter } from "../types.ts";
import { asStorageKey, asUserId } from "./brands.ts";
import {
  IdentityHydrationError,
  IdentityNotHydratedError,
} from "./errors.ts";
import {
  deriveDeviceId,
  generateAlias,
  generateVendorId,
  identityWithStorage,
  IdentityService,
  type IdentitySnapshot,
} from "./identity.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

const ALIAS_KEY = asStorageKey(STORAGE_KEYS.aliasId);
const USER_KEY = asStorageKey(STORAGE_KEYS.appUserId);
const VENDOR_KEY = asStorageKey(STORAGE_KEYS.vendorId);
const DEVICE_KEY = asStorageKey(STORAGE_KEYS.deviceId);

/** Coerce a branded string back to plain `string` so `.toBe(literal)` works.
 *  Brands are internal correctness aids; tests compare against plain strings. */
const s = (b: string | null | undefined): string | null | undefined => b as string | null | undefined;

/** Fresh layer per test so suites don't bleed via the in-memory adapter. */
const freshStack = () => {
  const adapter = createMemoryStorage();
  const stack = identityWithStorage(StorageService.fromAdapter(adapter));
  return { adapter, stack };
};

const runWith = <A, E>(
  stack: Layer.Layer<IdentityService | StorageService>,
  eff: Effect.Effect<A, E, IdentityService | StorageService>,
) => Effect.runPromise(eff.pipe(Effect.provide(stack)) as Effect.Effect<A, E, never>);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("generateAlias produces $SuperwallAlias:<uuid-v4>", () => {
  const a = generateAlias();
  expect(a).toMatch(
    /^\$SuperwallAlias:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  // Non-colliding across calls.
  expect(generateAlias()).not.toBe(a);
});

test("generateVendorId produces a uuid-v4", () => {
  const v = generateVendorId();
  expect(v).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("deriveDeviceId is deterministic across calls for the same vendor", async () => {
  const v = generateVendorId();
  const a = await Effect.runPromise(deriveDeviceId(v));
  const b = await Effect.runPromise(deriveDeviceId(v));
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{16}$/);
});

test("deriveDeviceId differs across vendors", async () => {
  const a = await Effect.runPromise(deriveDeviceId(generateVendorId()));
  const b = await Effect.runPromise(deriveDeviceId(generateVendorId()));
  expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// hydrate — resolution order per §7.4
// ---------------------------------------------------------------------------

test("hydrate with empty storage + no seed: generates alias+vendor+device, no userId, persists", async () => {
  const { adapter, stack } = freshStack();
  const snap = await runWith(stack, IdentityService.hydrate());
  expect(snap.aliasId).toMatch(/^\$SuperwallAlias:/);
  expect(snap.vendorId).toMatch(/^[0-9a-f-]+$/);
  expect(snap.deviceId).toMatch(/^[0-9a-f]{16}$/);
  expect(snap.appUserId).toBe("");

  expect(await adapter.get(ALIAS_KEY)).toBe(snap.aliasId);
  expect(await adapter.get(VENDOR_KEY)).toBe(snap.vendorId);
  expect(await adapter.get(DEVICE_KEY)).toBe(snap.deviceId);
  expect(await adapter.get(USER_KEY)).toBeNull();
});

test("hydrate with stored values: reads them, no regeneration", async () => {
  const adapter = createMemoryStorage();
  await adapter.set(ALIAS_KEY, "$SuperwallAlias:stored-alias");
  await adapter.set(VENDOR_KEY, "stored-vendor");
  await adapter.set(USER_KEY, "stored-user");

  const stack = identityWithStorage(StorageService.fromAdapter(adapter));
  const snap = await runWith(stack, IdentityService.hydrate());

  expect(s(snap.aliasId)).toBe("$SuperwallAlias:stored-alias");
  expect(s(snap.vendorId)).toBe("stored-vendor");
  expect(s(snap.appUserId)).toBe("stored-user");
});

test("hydrate with seed only: uses seed values and persists them", async () => {
  const { adapter, stack } = freshStack();
  const snap = await runWith(
    stack,
    IdentityService.hydrate({
      aliasId: "$SuperwallAlias:seeded",
      appUserId: "seeded-user",
      vendorId: "seeded-vendor",
    }),
  );
  expect(s(snap.aliasId)).toBe("$SuperwallAlias:seeded");
  expect(s(snap.appUserId)).toBe("seeded-user");
  expect(s(snap.vendorId)).toBe("seeded-vendor");
  expect(await adapter.get(ALIAS_KEY)).toBe("$SuperwallAlias:seeded");
  expect(await adapter.get(USER_KEY)).toBe("seeded-user");
  expect(await adapter.get(VENDOR_KEY)).toBe("seeded-vendor");
});

test("hydrate with BOTH storage and conflicting seed: storage wins per field (§7.4)", async () => {
  const adapter = createMemoryStorage();
  await adapter.set(ALIAS_KEY, "$SuperwallAlias:storage-wins");
  // No stored vendor — seed should fill that one.
  // No stored user — seed should fill that one.
  const stack = identityWithStorage(StorageService.fromAdapter(adapter));

  const snap = await runWith(
    stack,
    IdentityService.hydrate({
      aliasId: "$SuperwallAlias:seed-loses",
      appUserId: "seed-user",
      vendorId: "seed-vendor",
    }),
  );

  expect(s(snap.aliasId)).toBe("$SuperwallAlias:storage-wins"); // storage wins
  expect(s(snap.appUserId)).toBe("seed-user"); // storage was empty → seed
  expect(s(snap.vendorId)).toBe("seed-vendor"); // storage was empty → seed
});

test("hydrate with vendorIdProvider (sync): seeded value used when storage empty", async () => {
  const { stack } = freshStack();
  const snap = await runWith(
    stack,
    IdentityService.hydrate({
      vendorIdProvider: () => "fingerprint-xyz",
    }),
  );
  expect(s(snap.vendorId)).toBe("fingerprint-xyz");
});

test("hydrate with vendorIdProvider (async): awaited value used", async () => {
  const { stack } = freshStack();
  const snap = await runWith(
    stack,
    IdentityService.hydrate({
      vendorIdProvider: async () => {
        await new Promise((r) => setTimeout(r, 0));
        return "async-fingerprint";
      },
    }),
  );
  expect(s(snap.vendorId)).toBe("async-fingerprint");
});

test("hydrate skips vendorIdProvider when storage already has a vendor", async () => {
  const adapter = createMemoryStorage();
  await adapter.set(VENDOR_KEY, "existing-vendor");
  const stack = identityWithStorage(StorageService.fromAdapter(adapter));

  let providerCalled = false;
  const snap = await runWith(
    stack,
    IdentityService.hydrate({
      vendorIdProvider: () => {
        providerCalled = true;
        return "would-overwrite";
      },
    }),
  );

  expect(s(snap.vendorId)).toBe("existing-vendor");
  expect(providerCalled).toBe(false);
});

test("vendorIdProvider that throws → IdentityHydrationError", async () => {
  const { stack } = freshStack();
  const result = await Effect.runPromiseExit(
    IdentityService.hydrate({
      vendorIdProvider: () => {
        throw new Error("fingerprint api down");
      },
    }).pipe(Effect.provide(stack)) as Effect.Effect<IdentitySnapshot, IdentityHydrationError, never>,
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(IdentityHydrationError);
    expect((err as IdentityHydrationError).message).toContain("fingerprint api down");
  }
});

// ---------------------------------------------------------------------------
// current(), identify(), signOut(), reset()
// ---------------------------------------------------------------------------

test("current() before hydrate fails with IdentityNotHydratedError", async () => {
  const { stack } = freshStack();
  const result = await Effect.runPromiseExit(
    IdentityService.current().pipe(Effect.provide(stack)) as Effect.Effect<
      IdentitySnapshot,
      IdentityNotHydratedError,
      never
    >,
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    const err = result.cause._tag === "Fail" ? result.cause.error : null;
    expect(err).toBeInstanceOf(IdentityNotHydratedError);
  }
});

test("identify() updates appUserId, persists, leaves alias/vendor/device unchanged", async () => {
  const { adapter, stack } = freshStack();
  const program = Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    const after = yield* IdentityService.identify("user_123");
    return { initial, after };
  });
  const { initial, after } = await runWith(stack, program);

  expect(after.appUserId).toBe(asUserId("user_123"));
  expect(after.aliasId).toBe(initial.aliasId);
  expect(after.vendorId).toBe(initial.vendorId);
  expect(after.deviceId).toBe(initial.deviceId);
  expect(await adapter.get(USER_KEY)).toBe("user_123");
});

test("signOut() clears appUserId and removes the storage entry; alias persists", async () => {
  const { adapter, stack } = freshStack();
  const program = Effect.gen(function* () {
    yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    return yield* IdentityService.signOut();
  });
  const after = await runWith(stack, program);

  expect(after.appUserId).toBe("");
  expect(after.aliasId).toMatch(/^\$SuperwallAlias:/);
  expect(await adapter.get(USER_KEY)).toBeNull();
  expect(await adapter.get(ALIAS_KEY)).toBe(after.aliasId);
});

test("signOut() is a no-op when not signed in", async () => {
  const { stack } = freshStack();
  const program = Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    const after = yield* IdentityService.signOut();
    return { initial, after };
  });
  const { initial, after } = await runWith(stack, program);
  expect(after).toEqual(initial);
});

test("reset() generates a fresh alias/vendor/device, clears appUserId, persists", async () => {
  const { adapter, stack } = freshStack();
  const program = Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    const after = yield* IdentityService.reset();
    return { initial, after };
  });
  const { initial, after } = await runWith(stack, program);

  expect(after.appUserId).toBe("");
  expect(after.aliasId).not.toBe(initial.aliasId);
  expect(after.vendorId).not.toBe(initial.vendorId);
  expect(after.deviceId).not.toBe(initial.deviceId);
  expect(await adapter.get(ALIAS_KEY)).toBe(after.aliasId);
  expect(await adapter.get(USER_KEY)).toBeNull();
});

// ---------------------------------------------------------------------------
// changes Stream — proves Effect-side reactivity over the same source of truth
// ---------------------------------------------------------------------------

test("observe() emits hydrate + identify + signOut transitions", async () => {
  const { stack } = freshStack();

  const program = Effect.gen(function* () {
    const stream = yield* IdentityService.observe();
    // Subscribe BEFORE hydrate so we see the null → hydrated transition.
    const collector = yield* Effect.fork(
      stream.pipe(Stream.take(4), Stream.runCollect),
    );

    yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    yield* IdentityService.signOut();

    return yield* Effect.fromFiber(collector);
  });
  const collected = await runWith(stack, program);
  const snapshots = Array.from(collected);

  // First emission is the initial null (SubscriptionRef.changes fires current
  // on subscribe). Then 3 transitions: hydrate → identify → signOut.
  expect(snapshots[0]).toBeNull();
  expect(snapshots[1]?.appUserId).toBe("");
  expect(snapshots[2]?.appUserId).toBe(asUserId("u1"));
  expect(snapshots[3]?.appUserId).toBe("");
});

// ---------------------------------------------------------------------------
// downstream storage failure surfaces as the storage tagged error
// ---------------------------------------------------------------------------

test("storage failure during hydrate persistence propagates as a tagged StorageSetError", async () => {
  let allowSets = 0;
  const flaky: StorageAdapter = {
    get: () => null,
    set: (_k, _v) => {
      if (allowSets-- > 0) return;
      throw new Error("disk full");
    },
    remove: () => {},
  };

  const stack = identityWithStorage(StorageService.fromAdapter(flaky));
  const result = await Effect.runPromiseExit(
    IdentityService.hydrate().pipe(Effect.provide(stack)) as Effect.Effect<
      IdentitySnapshot,
      Error,
      never
    >,
  );

  expect(result._tag).toBe("Failure");
});
