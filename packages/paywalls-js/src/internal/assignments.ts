// AssignmentService — variant rollout + sticky cached assignments for
// experiments.
//
// Behavior matches Android (`ConfigLogic.kt:chooseVariant`):
//   - First time we see (experimentId), pick a variant *randomly* from
//     the variants' percentage ranges (sum percentages → uniform random
//     pick in [0, sum), find the variant whose cumulative range contains
//     the threshold). Missing percentages → even split.
//   - Persist the pick. Subsequent evaluations return the cached one —
//     same user sees the same variant across calls / sessions / reloads.
//     The aliasId is NOT a hash input (Android doesn't hash; the cache
//     is what makes it sticky). Cross-device parity is achieved via
//     `POST /confirm_assignments` so the BE knows which variant is live
//     (still TODO — see MISSING.md).
//   - If a variant is deleted from config between sessions (cached id no
//     longer in `experiment.variants`), repick.
//
// `pickVariant` accepts an injectable randomiser so tests can be
// deterministic without changing the production semantics.
//
// Persistence: JSON-serialized `ConfirmedAssignment[]` under
// `STORAGE_KEYS.assignments`. Loaded on service materialization.
//
// Internal-only — not exported from the package barrel.

import { Context, Effect, Layer, Ref } from "effect";
import {
  STORAGE_KEYS,
  type ConfirmedAssignment,
  type Variant,
} from "../types.ts";
import { asStorageKey } from "./brands.ts";
import { StorageService } from "./storage.ts";

const ASSIGNMENTS_KEY = asStorageKey(STORAGE_KEYS.assignments);

interface RawExperimentRef {
  readonly id: string;
  readonly groupId: string;
  readonly variants: ReadonlyArray<{
    readonly id: string;
    readonly type: "treatment" | "holdout";
    readonly paywallId?: string;
    readonly percentage?: number;
  }>;
}

export interface AssignmentServiceImpl {
  /**
   * Sticky variant assignment. Returns the cached variant if one exists
   * for this experimentId AND the variant id is still in the current
   * experiment's variant list; otherwise picks a fresh variant via the
   * cumulative-percentage random bucket and persists it.
   */
  readonly getOrAssign: (
    experiment: RawExperimentRef,
    aliasId: string,
  ) => Effect.Effect<ConfirmedAssignment>;
  /**
   * Eagerly assign variants for every experiment referenced by the supplied
   * experiment list, populating the cache so subsequent `register()` calls
   * can short-circuit. Mirrors Android's `ApplyConfig → choosePaywallVariants`
   * (`ConfigLogic.kt:chooseAllVariants`). Existing assignments are preserved
   * (sticky); new experiments are picked + persisted in one batch.
   */
  readonly chooseAllVariants: (
    experiments: ReadonlyArray<RawExperimentRef>,
  ) => Effect.Effect<void>;
  /** Snapshot of all currently-cached assignments. */
  readonly getAll: () => Effect.Effect<ConfirmedAssignment[]>;
  /** Wipe in-memory + storage. */
  readonly reset: () => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Variant pick — pure helper, exported for test. Matches Android's
// `ConfigLogic.chooseVariant` exactly (random per call, integer percent
// math). Stickiness comes from the cache, not the algorithm.
// ---------------------------------------------------------------------------

/** Random integer in `[0, max)`. Replaceable in tests for deterministic
 *  distribution checks. Matches Android's `randomiser: (IntRange) -> Int`
 *  parameter on `ConfigLogic.chooseVariant`. */
export type Randomiser = (max: number) => number;

const defaultRandomiser: Randomiser = (max) => Math.floor(Math.random() * max);

/**
 * Random-bucket pick over a variant list. Percentages are integers
 * (0–100); missing percentages on ALL variants → equal split (random
 * index pick). Otherwise: random threshold in `[0, sum_of_percentages)`,
 * walk cumulative until threshold lands in a variant's range.
 *
 * Same algorithm as Android `ConfigLogic.chooseVariant`. Per-call random
 * — not a hash — so stickiness comes exclusively from the cache layer
 * above (`AssignmentService.getOrAssign`).
 */
export const pickVariant = (
  variants: RawExperimentRef["variants"],
  randomiser: Randomiser = defaultRandomiser,
): Variant => {
  if (variants.length === 0) {
    return { id: "default", type: "treatment" };
  }
  if (variants.length === 1) {
    const v = variants[0]!;
    return {
      id: v.id,
      type: v.type,
      ...(v.paywallId !== undefined && { paywallId: v.paywallId }),
    };
  }

  const sum = variants.reduce((s, v) => s + (v.percentage ?? 0), 0);

  if (sum === 0) {
    // No percentages declared anywhere → even split via random index.
    const idx = randomiser(variants.length);
    const v = variants[Math.min(idx, variants.length - 1)]!;
    return {
      id: v.id,
      type: v.type,
      ...(v.paywallId !== undefined && { paywallId: v.paywallId }),
    };
  }

  const threshold = randomiser(sum);
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.percentage ?? 0;
    if (threshold < cumulative) {
      return {
        id: v.id,
        type: v.type,
        ...(v.paywallId !== undefined && { paywallId: v.paywallId }),
      };
    }
  }
  // Floating-point edge — should never hit since threshold < sum, but
  // returning the last variant matches Android.
  const last = variants[variants.length - 1]!;
  return {
    id: last.id,
    type: last.type,
    ...(last.paywallId !== undefined && { paywallId: last.paywallId }),
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const storage = yield* StorageService;

  // Hydrate from storage on materialization. Corrupt JSON is silently
  // dropped (matches the broader "tolerant cache" pattern in this repo).
  const initial = yield* storage
    .get(ASSIGNMENTS_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
  let parsed: ConfirmedAssignment[] = [];
  if (initial !== null) {
    try {
      const decoded = JSON.parse(initial) as unknown;
      if (Array.isArray(decoded)) {
        parsed = decoded.filter((a): a is ConfirmedAssignment => {
          if (!a || typeof a !== "object") return false;
          const r = a as ConfirmedAssignment;
          return (
            typeof r.experimentId === "string" &&
            !!r.variant &&
            typeof r.variant.id === "string" &&
            (r.variant.type === "treatment" || r.variant.type === "holdout")
          );
        });
      }
    } catch {
      /* drop corrupt cache */
    }
  }
  const ref = yield* Ref.make<ConfirmedAssignment[]>(parsed);

  const persist = (next: ReadonlyArray<ConfirmedAssignment>) =>
    storage
      .set(ASSIGNMENTS_KEY, JSON.stringify(next))
      .pipe(Effect.catchAll(() => Effect.void));

  const getOrAssign: AssignmentServiceImpl["getOrAssign"] = (
    experiment,
    _aliasId,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(ref);
      const cached = current.find((a) => a.experimentId === experiment.id);
      if (cached) {
        // Verify the cached variant is still in the experiment's variant
        // list (config changed, variant deleted) — if not, repick.
        const stillExists = experiment.variants.some(
          (v) => v.id === cached.variant.id,
        );
        if (stillExists) return cached;
      }

      const variant = pickVariant(experiment.variants);
      const fresh: ConfirmedAssignment = {
        experimentId: experiment.id,
        variant,
      };

      // Replace any stale entry for this experimentId.
      const next = current.filter((a) => a.experimentId !== experiment.id);
      next.push(fresh);
      yield* Ref.set(ref, next);
      yield* persist(next);
      return fresh;
    });

  const chooseAllVariants: AssignmentServiceImpl["chooseAllVariants"] = (
    experiments,
  ) =>
    Effect.gen(function* () {
      if (experiments.length === 0) return;
      const current = yield* Ref.get(ref);
      // De-dup experiments by id — the same experiment can appear under
      // multiple triggers (Android `chooseAllVariants` collects unique refs).
      const seen = new Set<string>();
      const unique = experiments.filter((e) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });

      const next = [...current];
      let mutated = false;
      for (const experiment of unique) {
        const cached = next.find((a) => a.experimentId === experiment.id);
        if (cached) {
          const stillExists = experiment.variants.some(
            (v) => v.id === cached.variant.id,
          );
          if (stillExists) continue;
          // Stale variant — drop and repick below.
          const idx = next.indexOf(cached);
          next.splice(idx, 1);
        }
        next.push({
          experimentId: experiment.id,
          variant: pickVariant(experiment.variants),
        });
        mutated = true;
      }

      if (mutated) {
        yield* Ref.set(ref, next);
        yield* persist(next);
      }
    });

  const getAll: AssignmentServiceImpl["getAll"] = () =>
    Effect.gen(function* () {
      // Return a copy so callers can't mutate the internal array.
      return [...(yield* Ref.get(ref))];
    });

  const reset: AssignmentServiceImpl["reset"] = () =>
    Effect.gen(function* () {
      yield* Ref.set(ref, []);
      yield* storage
        .remove(ASSIGNMENTS_KEY)
        .pipe(Effect.catchAll(() => Effect.void));
    });

  return {
    getOrAssign,
    chooseAllVariants,
    getAll,
    reset,
  } satisfies AssignmentServiceImpl;
});

export class AssignmentService extends Context.Tag(
  "@superwall/AssignmentService",
)<AssignmentService, AssignmentServiceImpl>() {}

/** Build an AssignmentService Layer over the supplied storage Layer. */
export const assignmentServiceLayer = (
  storageLayer: Layer.Layer<StorageService>,
): Layer.Layer<AssignmentService | StorageService, never, never> =>
  Layer.provideMerge(
    Layer.effect(AssignmentService, make),
    storageLayer,
  ) as Layer.Layer<AssignmentService | StorageService, never, never>;
