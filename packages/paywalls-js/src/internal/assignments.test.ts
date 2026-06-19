import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { STORAGE_KEYS } from "../types.ts";
import {
  AssignmentService,
  assignmentServiceLayer,
  pickVariant,
} from "./assignments.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

const stack = (storage = StorageService.fromAdapter(createMemoryStorage())) =>
  assignmentServiceLayer(storage);

const exp = (
  variants: Array<{
    id: string;
    type?: "treatment" | "holdout";
    percentage?: number;
    paywallId?: string;
  }>,
  id = "exp_test",
) => ({
  id,
  groupId: "grp_test",
  variants: variants.map((v) => ({
    id: v.id,
    type: v.type ?? ("treatment" as const),
    ...(v.percentage !== undefined && { percentage: v.percentage }),
    ...(v.paywallId !== undefined && { paywallId: v.paywallId }),
  })),
});

// ---------------------------------------------------------------------------
// pickVariant — pure helper
// ---------------------------------------------------------------------------

it("pickVariant: 0 variants → default treatment fallback", () => {
  const v = pickVariant([]);
  expect(v).toEqual({ id: "default", type: "treatment" });
});

it("pickVariant: 1 variant → returns it without randomiser", () => {
  const v = pickVariant([
    { id: "v_a", type: "treatment", paywallId: "pw_a" },
  ]);
  expect(v).toEqual({ id: "v_a", type: "treatment", paywallId: "pw_a" });
});

it("pickVariant: threshold lands in first bucket → first variant", () => {
  const variants = exp([
    { id: "v_a", percentage: 50 },
    { id: "v_b", percentage: 50 },
  ]).variants;
  // threshold 0 < cumulative 50 → v_a
  expect(pickVariant(variants, () => 0).id).toBe("v_a");
  // threshold 49 < 50 → v_a
  expect(pickVariant(variants, () => 49).id).toBe("v_a");
  // threshold 50 not < 50; lands in v_b's range (50..100)
  expect(pickVariant(variants, () => 50).id).toBe("v_b");
  expect(pickVariant(variants, () => 99).id).toBe("v_b");
});

it("pickVariant: respects explicit percentages at scale", () => {
  const variants = exp([
    { id: "v_a", percentage: 90 },
    { id: "v_b", percentage: 10 },
  ]).variants;
  const counts = { v_a: 0, v_b: 0 };
  for (let i = 0; i < 200; i++) {
    const v = pickVariant(variants);
    counts[v.id as keyof typeof counts]++;
  }
  expect(counts.v_a).toBeGreaterThan(150);
  expect(counts.v_b).toBeLessThan(50);
});

it("pickVariant: missing percentages → even split via random index", () => {
  const variants = exp([
    { id: "v_a" },
    { id: "v_b" },
    { id: "v_c" },
  ]).variants;
  // Inject randomiser that cycles 0,1,2 → all three should appear.
  let i = 0;
  const r = () => i++ % 3;
  expect(pickVariant(variants, r).id).toBe("v_a");
  expect(pickVariant(variants, r).id).toBe("v_b");
  expect(pickVariant(variants, r).id).toBe("v_c");
});

it("pickVariant: holdout variant type is preserved", () => {
  const variants = exp([
    { id: "v_treat", type: "treatment", percentage: 99, paywallId: "pw_a" },
    { id: "v_hold", type: "holdout", percentage: 1 },
  ]).variants;
  // Force threshold into the holdout slice (last 1%).
  const hold = pickVariant(variants, () => 99);
  expect(hold.id).toBe("v_hold");
  expect(hold.type).toBe("holdout");
  const treat = pickVariant(variants, () => 0);
  expect(treat.id).toBe("v_treat");
  expect(treat.type).toBe("treatment");
  expect(treat.paywallId).toBe("pw_a");
});

// ---------------------------------------------------------------------------
// AssignmentService.getOrAssign — sticky semantics
// ---------------------------------------------------------------------------

it.effect("getOrAssign: same (alias, experiment) → cached variant on subsequent calls", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const a = yield* AssignmentService;
    const e = exp([
      { id: "v_a", percentage: 50 },
      { id: "v_b", percentage: 50 },
    ]);
    const first = yield* a.getOrAssign(e, "alice");
    const second = yield* a.getOrAssign(e, "alice");
    const third = yield* a.getOrAssign(e, "alice");
    expect(first.variant.id).toBe(second.variant.id);
    expect(second.variant.id).toBe(third.variant.id);
  }).pipe(Effect.provide(layer));
});

it.effect("getOrAssign: persists across runtimes (replays from storage)", () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);
  const e = exp([{ id: "v_a", percentage: 50 }, { id: "v_b", percentage: 50 }]);

  return Effect.gen(function* () {
    // First runtime — assign + persist.
    const initial = yield* Effect.gen(function* () {
      const a = yield* AssignmentService;
      return yield* a.getOrAssign(e, "alice");
    }).pipe(Effect.provide(assignmentServiceLayer(sharedStorage)));

    // Second runtime — reads cache; same variant.
    const replayed = yield* Effect.gen(function* () {
      const a = yield* AssignmentService;
      return yield* a.getOrAssign(e, "alice");
    }).pipe(Effect.provide(assignmentServiceLayer(sharedStorage)));

    expect(replayed.variant.id).toBe(initial.variant.id);
  });
});

it.effect("getOrAssign: repicks if cached variant id no longer exists in config", () => {
  const adapter = createMemoryStorage();

  return Effect.gen(function* () {
    // Pre-seed the cache with a variant that won't be in the new config.
    yield* Effect.promise(() =>
      Promise.resolve(adapter.set(
        STORAGE_KEYS.assignments,
        JSON.stringify([
          {
            experimentId: "exp_test",
            variant: { id: "v_old", type: "treatment" },
          },
        ]),
      )),
    );

    const newE = exp([{ id: "v_new", type: "treatment" }]);
    const result = yield* Effect.gen(function* () {
      const a = yield* AssignmentService;
      return yield* a.getOrAssign(newE, "alice");
    }).pipe(
      Effect.provide(
        assignmentServiceLayer(StorageService.fromAdapter(adapter)),
      ),
    );
    // Repicked because v_old was deleted from config.
    expect(result.variant.id).toBe("v_new");
  });
});

it.effect("getAll: snapshot is a copy (caller can't mutate internal state)", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const a = yield* AssignmentService;
    yield* a.getOrAssign(exp([{ id: "v_a" }]), "alice");
    const snap = yield* a.getAll();
    snap.push({
      experimentId: "fake",
      variant: { id: "fake", type: "treatment" },
    });
    const snap2 = yield* a.getAll();
    expect(snap2.length).toBe(1);
    expect(snap2[0]!.experimentId).toBe("exp_test");
  }).pipe(Effect.provide(layer));
});

it.effect("reset: clears in-memory + storage", () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const a = yield* AssignmentService;
      yield* a.getOrAssign(exp([{ id: "v_a" }]), "alice");
      yield* a.reset();
      const all = yield* a.getAll();
      expect(all).toEqual([]);
    }).pipe(Effect.provide(assignmentServiceLayer(sharedStorage)));
    const cached = yield* Effect.promise(() => Promise.resolve(adapter.get(STORAGE_KEYS.assignments)));
    expect(cached).toBeNull();
  });
});
