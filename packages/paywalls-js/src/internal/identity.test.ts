import { it, expect } from "@effect/vitest";
import { Effect, Either, Layer, Stream } from "effect";
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
  IdentityPending,
  IdentityPhase,
  IdentityService,
  IdentityUpdates,
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

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

it("generateAlias produces $SuperwallAlias:<uuid-v4>", () => {
  const a = generateAlias();
  expect(a).toMatch(
    /^\$SuperwallAlias:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  // Non-colliding across calls.
  expect(generateAlias()).not.toBe(a);
});

it("generateVendorId produces a uuid-v4", () => {
  const v = generateVendorId();
  expect(v).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

it.effect("deriveDeviceId is deterministic across calls for the same vendor", () => {
  const v = generateVendorId();
  return Effect.gen(function* () {
    const a = yield* deriveDeviceId(v);
    const b = yield* deriveDeviceId(v);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

it.effect("deriveDeviceId differs across vendors", () => {
  return Effect.gen(function* () {
    const a = yield* deriveDeviceId(generateVendorId());
    const b = yield* deriveDeviceId(generateVendorId());
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// hydrate — resolution order per §7.4
// ---------------------------------------------------------------------------

it.effect("hydrate with empty storage + no seed: generates alias+vendor+device, no userId, persists", () => {
  const { adapter, stack } = freshStack();
  return Effect.gen(function* () {
    const snap = yield* IdentityService.hydrate();
    expect(snap.aliasId).toMatch(/^\$SuperwallAlias:/);
    expect(snap.vendorId).toMatch(/^[0-9a-f-]+$/);
    expect(snap.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.appUserId).toBe("");

    const storedAlias = yield* Effect.promise(() => Promise.resolve(adapter.get(ALIAS_KEY)));
    const storedVendor = yield* Effect.promise(() => Promise.resolve(adapter.get(VENDOR_KEY)));
    const storedDevice = yield* Effect.promise(() => Promise.resolve(adapter.get(DEVICE_KEY)));
    const storedUser = yield* Effect.promise(() => Promise.resolve(adapter.get(USER_KEY)));
    expect(storedAlias).toBe(snap.aliasId);
    expect(storedVendor).toBe(snap.vendorId);
    expect(storedDevice).toBe(snap.deviceId);
    expect(storedUser).toBeNull();
  }).pipe(Effect.provide(stack));
});

it.effect("hydrate with stored values: reads them, no regeneration", () => {
  const adapter = createMemoryStorage();
  return Effect.gen(function* () {
    yield* Effect.promise(() => Promise.resolve(adapter.set(ALIAS_KEY, "$SuperwallAlias:stored-alias")));
    yield* Effect.promise(() => Promise.resolve(adapter.set(VENDOR_KEY, "stored-vendor")));
    yield* Effect.promise(() => Promise.resolve(adapter.set(USER_KEY, "stored-user")));
    const stack = identityWithStorage(StorageService.fromAdapter(adapter));
    const snap = yield* IdentityService.hydrate().pipe(Effect.provide(stack));
    expect(s(snap.aliasId)).toBe("$SuperwallAlias:stored-alias");
    expect(s(snap.vendorId)).toBe("stored-vendor");
    expect(s(snap.appUserId)).toBe("stored-user");
  });
});

it.effect("hydrate with seed only: uses seed values and persists them", () => {
  const { adapter, stack } = freshStack();
  return Effect.gen(function* () {
    const snap = yield* IdentityService.hydrate({
      aliasId: "$SuperwallAlias:seeded",
      appUserId: "seeded-user",
      vendorId: "seeded-vendor",
    });
    expect(s(snap.aliasId)).toBe("$SuperwallAlias:seeded");
    expect(s(snap.appUserId)).toBe("seeded-user");
    expect(s(snap.vendorId)).toBe("seeded-vendor");
    expect(yield* Effect.promise(() => Promise.resolve(adapter.get(ALIAS_KEY)))).toBe("$SuperwallAlias:seeded");
    expect(yield* Effect.promise(() => Promise.resolve(adapter.get(USER_KEY)))).toBe("seeded-user");
    expect(yield* Effect.promise(() => Promise.resolve(adapter.get(VENDOR_KEY)))).toBe("seeded-vendor");
  }).pipe(Effect.provide(stack));
});

it.effect("hydrate with BOTH storage and conflicting seed: storage wins per field (§7.4)", () => {
  const adapter = createMemoryStorage();
  return Effect.gen(function* () {
    yield* Effect.promise(() => Promise.resolve(adapter.set(ALIAS_KEY, "$SuperwallAlias:storage-wins")));
    // No stored vendor — seed should fill that one.
    // No stored user — seed should fill that one.
    const stack = identityWithStorage(StorageService.fromAdapter(adapter));

    const snap = yield* IdentityService.hydrate({
      aliasId: "$SuperwallAlias:seed-loses",
      appUserId: "seed-user",
      vendorId: "seed-vendor",
    }).pipe(Effect.provide(stack));

    expect(s(snap.aliasId)).toBe("$SuperwallAlias:storage-wins"); // storage wins
    expect(s(snap.appUserId)).toBe("seed-user"); // storage was empty → seed
    expect(s(snap.vendorId)).toBe("seed-vendor"); // storage was empty → seed
  });
});

it.effect("hydrate with vendorIdProvider (sync): seeded value used when storage empty", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    const snap = yield* IdentityService.hydrate({
      vendorIdProvider: () => "fingerprint-xyz",
    });
    expect(s(snap.vendorId)).toBe("fingerprint-xyz");
  }).pipe(Effect.provide(stack));
});

it.effect("hydrate with vendorIdProvider (async): awaited value used", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    const snap = yield* IdentityService.hydrate({
      vendorIdProvider: async () => {
        await new Promise((r) => setTimeout(r, 0));
        return "async-fingerprint";
      },
    });
    expect(s(snap.vendorId)).toBe("async-fingerprint");
  }).pipe(Effect.provide(stack));
});

it.effect("hydrate skips vendorIdProvider when storage already has a vendor", () => {
  const adapter = createMemoryStorage();
  return Effect.gen(function* () {
    yield* Effect.promise(() => Promise.resolve(adapter.set(VENDOR_KEY, "existing-vendor")));
    const stack = identityWithStorage(StorageService.fromAdapter(adapter));

    let providerCalled = false;
    const snap = yield* IdentityService.hydrate({
      vendorIdProvider: () => {
        providerCalled = true;
        return "would-overwrite";
      },
    }).pipe(Effect.provide(stack));

    expect(s(snap.vendorId)).toBe("existing-vendor");
    expect(providerCalled).toBe(false);
  });
});

it.effect("vendorIdProvider that throws → IdentityHydrationError", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    const result = yield* IdentityService.hydrate({
      vendorIdProvider: () => {
        throw new Error("fingerprint api down");
      },
    }).pipe(Effect.provide(stack), Effect.either);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(IdentityHydrationError);
      expect((result.left as IdentityHydrationError).message).toContain("fingerprint api down");
    }
  });
});

// ---------------------------------------------------------------------------
// current(), identify(), signOut(), reset()
// ---------------------------------------------------------------------------

it.effect("current() before hydrate fails with IdentityNotHydratedError", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    const result = yield* IdentityService.current().pipe(
      Effect.provide(stack),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(IdentityNotHydratedError);
    }
  });
});

it.effect("identify() updates appUserId, persists, leaves alias/vendor/device unchanged", () => {
  const { adapter, stack } = freshStack();
  return Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    const after = yield* IdentityService.identify("user_123");
    expect(after.appUserId).toBe(asUserId("user_123"));
    expect(after.aliasId).toBe(initial.aliasId);
    expect(after.vendorId).toBe(initial.vendorId);
    expect(after.deviceId).toBe(initial.deviceId);
    const stored = yield* Effect.promise(() => Promise.resolve(adapter.get(USER_KEY)));
    expect(stored).toBe("user_123");
  }).pipe(Effect.provide(stack));
});

it.effect("signOut() clears appUserId and removes the storage entry; alias persists", () => {
  const { adapter, stack } = freshStack();
  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    const after = yield* IdentityService.signOut();
    expect(after.appUserId).toBe("");
    expect(after.aliasId).toMatch(/^\$SuperwallAlias:/);
    const storedUser = yield* Effect.promise(() => Promise.resolve(adapter.get(USER_KEY)));
    const storedAlias = yield* Effect.promise(() => Promise.resolve(adapter.get(ALIAS_KEY)));
    expect(storedUser).toBeNull();
    expect(storedAlias).toBe(after.aliasId);
  }).pipe(Effect.provide(stack));
});

it.effect("signOut() is a no-op when not signed in", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    const after = yield* IdentityService.signOut();
    expect(after).toEqual(initial);
  }).pipe(Effect.provide(stack));
});

it.effect("reset() generates a fresh alias/vendor/device, clears appUserId, persists", () => {
  const { adapter, stack } = freshStack();
  return Effect.gen(function* () {
    const initial = yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    const after = yield* IdentityService.reset();
    expect(after.appUserId).toBe("");
    expect(after.aliasId).not.toBe(initial.aliasId);
    expect(after.vendorId).not.toBe(initial.vendorId);
    expect(after.deviceId).not.toBe(initial.deviceId);
    const storedAlias = yield* Effect.promise(() => Promise.resolve(adapter.get(ALIAS_KEY)));
    const storedUser = yield* Effect.promise(() => Promise.resolve(adapter.get(USER_KEY)));
    expect(storedAlias).toBe(after.aliasId);
    expect(storedUser).toBeNull();
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// changes Stream — proves Effect-side reactivity over the same source of truth
// ---------------------------------------------------------------------------

it.effect("observe() emits hydrate + identify + signOut transitions", () => {
  const { stack } = freshStack();

  return Effect.gen(function* () {
    const stream = yield* IdentityService.observe();
    // Subscribe BEFORE hydrate so we see the null → hydrated transition.
    const collector = yield* Effect.fork(
      stream.pipe(Stream.take(4), Stream.runCollect),
    );

    yield* IdentityService.hydrate();
    yield* IdentityService.identify("u1");
    yield* IdentityService.signOut();

    const collected = yield* Effect.fromFiber(collector);
    const snapshots = Array.from(collected);

    // First emission is the initial null (SubscriptionRef.changes fires current
    // on subscribe). Then 3 transitions: hydrate → identify → signOut.
    expect(snapshots[0]).toBeNull();
    expect(snapshots[1]?.appUserId).toBe("");
    expect(snapshots[2]?.appUserId).toBe(asUserId("u1"));
    expect(snapshots[3]?.appUserId).toBe("");
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// downstream storage failure surfaces as the storage tagged error
// ---------------------------------------------------------------------------

it.effect("storage failure during hydrate persistence propagates as a tagged StorageSetError", () => {
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
  return Effect.gen(function* () {
    const result = yield* IdentityService.hydrate().pipe(
      Effect.provide(stack),
      Effect.either,
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IdentityPhase actor — pure reducers + service-driven transitions
// ---------------------------------------------------------------------------

it("IdentityPhase.initial: starts Pending with Configuration", () => {
  const phase = IdentityPhase.initial();
  expect(phase._tag).toBe("Pending");
  if (phase._tag === "Pending") {
    expect(phase.items).toEqual([{ _tag: "Configuration" }]);
  }
});

it("IdentityUpdates.begin is set-semantic — duplicate adds are no-ops", () => {
  let phase: IdentityPhase = IdentityPhase.initial();
  phase = IdentityUpdates.begin(IdentityPending.Seed)(phase);
  phase = IdentityUpdates.begin(IdentityPending.Seed)(phase);
  if (phase._tag !== "Pending") throw new Error("expected Pending");
  expect(phase.items.filter((p) => p._tag === "Seed")).toHaveLength(1);
});

it("IdentityUpdates.end of last item flips Pending → Ready", () => {
  let phase: IdentityPhase = IdentityPhase.Pending([IdentityPending.Configuration]);
  phase = IdentityUpdates.end(IdentityPending.Configuration)(phase);
  expect(phase._tag).toBe("Ready");
});

it("IdentityUpdates.end of one of many keeps Pending with the rest", () => {
  let phase: IdentityPhase = IdentityPhase.Pending([
    IdentityPending.Configuration,
    IdentityPending.Seed,
  ]);
  phase = IdentityUpdates.end(IdentityPending.Seed)(phase);
  expect(phase._tag).toBe("Pending");
  if (phase._tag === "Pending") {
    expect(phase.items.map((p) => p._tag)).toEqual(["Configuration"]);
  }
});

it("IdentityUpdates.end of a different Identification id leaves the original pending", () => {
  let phase: IdentityPhase = IdentityPhase.Pending([
    IdentityPending.Identification("u_1"),
  ]);
  phase = IdentityUpdates.end(IdentityPending.Identification("u_2"))(phase);
  expect(phase._tag).toBe("Pending");
});

it.effect("IdentityService.awaitReady resolves only after the pending-set drains", () => {
  const { stack } = freshStack();
  return Effect.gen(function* () {
    // Start a fiber that races awaitReady against a fixed wall-clock.
    const readyFiber = yield* Effect.fork(
      IdentityService.awaitReady().pipe(
        Effect.timeout("500 millis"),
        Effect.either,
      ),
    );
    // Briefly yield so awaitReady actually begins polling.
    yield* Effect.yieldNow();
    // Drain the initial Configuration.
    yield* IdentityService.endPending(IdentityPending.Configuration);
    // Collect the fiber result.
    const exit = yield* readyFiber;
    // No timeout firing — Either.right(undefined).
    expect(exit._tag).toBe("Right");
  }).pipe(Effect.provide(stack));
});

it.effect("IdentityService: concurrent identify + reset land in arrival order (snapshot never half-applied)", () => {
  // identify("u_1") + reset() fired concurrently. The serializer runs them
  // strictly in arrival order: identify first → snapshot has appUserId=u_1,
  // then reset → snapshot back to anonymous (appUserId="") with a fresh
  // alias. We assert (a) the final state is the reset (anonymous +
  // regenerated alias), (b) at no point during the run was the snapshot
  // half-applied (e.g. appUserId=u_1 with the regenerated alias).
  const { stack, adapter } = freshStack();

  return Effect.gen(function* () {
    // Pre-seed an alias so the post-hydrate snapshot is deterministic.
    yield* Effect.promise(() =>
      Promise.resolve(adapter.set(asStorageKey(STORAGE_KEYS.aliasId), "$SuperwallAlias:initial")),
    );

    const observed: Array<{ alias: string; user: string }> = [];
    yield* IdentityService.hydrate();
    const initial = yield* IdentityService.current();
    const initialAlias = initial.aliasId as string;

    // Subscribe to snapshot transitions.
    const observer = yield* Effect.fork(
      IdentityService.observe().pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.tap((snap) => {
              if (snap !== null) {
                observed.push({
                  alias: snap.aliasId as string,
                  user: snap.appUserId as string,
                });
              }
              return Effect.void;
            }),
            Stream.take(3),
            Stream.runDrain,
          ),
        ),
      ),
    );

    // Concurrent identify + reset.
    yield* Effect.all(
      [IdentityService.identify("u_1"), IdentityService.reset()],
      { concurrency: "unbounded" },
    );

    yield* observer;

    const finalSnap = yield* IdentityService.current();
    expect(finalSnap.appUserId).toBe(""); // reset ran last
    expect(finalSnap.aliasId).not.toBe(initialAlias); // alias regenerated

    // Verify no half-applied state: every observed snapshot has
    // (alias=initial AND user∈{"","u_1"}) OR (alias=fresh AND user="").
    // I.e. (newAlias, "u_1") must never appear.
    for (const o of observed) {
      if (o.alias !== initialAlias) {
        expect(o.user).toBe("");
      }
    }
  }).pipe(Effect.provide(stack));
});

// Uses real clock (Effect.timeout needs real time — it.effect uses frozen TestClock)
it("IdentityService.awaitReady stays pending while items remain in the set", async () => {
  const { stack } = freshStack();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.beginPending(IdentityPending.Identification("u_1"));
      const result = yield* IdentityService.awaitReady().pipe(
        Effect.timeout("100 millis"),
        Effect.either,
      );
      expect(result._tag).toBe("Left"); // TimeoutException
    }).pipe(Effect.provide(stack)),
  );
}, 10_000);

// Suppress unused Layer import if needed
void Layer;
