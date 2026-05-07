// AssignmentService — variant rollout + sticky cached assignments for
// experiments. First evaluation picks a variant via cumulative-percentage
// random bucket (missing percentages → even split) and persists it; later
// evaluations return the cached pick unless the variant has been deleted
// from config (then repick). Stickiness comes from the cache, not a hash
// of aliasId.

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
  /** Sticky variant assignment for the supplied experiment. */
  readonly getOrAssign: (
    experiment: RawExperimentRef,
    aliasId: string,
  ) => Effect.Effect<ConfirmedAssignment>;
  /** Eagerly assign variants for every supplied experiment, preserving
   *  existing sticky picks and persisting new ones in one batch. */
  readonly chooseAllVariants: (
    experiments: ReadonlyArray<RawExperimentRef>,
  ) => Effect.Effect<void>;
  /** Snapshot of all currently-cached assignments. */
  readonly getAll: () => Effect.Effect<ConfirmedAssignment[]>;
  readonly reset: () => Effect.Effect<void>;
}

/** Random integer in `[0, max)`. Replaceable in tests for deterministic
 *  distribution checks. */
export type Randomiser = (max: number) => number;

const defaultRandomiser: Randomiser = (max) => Math.floor(Math.random() * max);

/** Random-bucket pick over a variant list. Per-call random — stickiness
 *  comes from the cache layer above. */
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
  // Floating-point edge — should never hit since threshold < sum.
  const last = variants[variants.length - 1]!;
  return {
    id: last.id,
    type: last.type,
    ...(last.paywallId !== undefined && { paywallId: last.paywallId }),
  };
};

const make = Effect.gen(function* () {
  const storage = yield* StorageService;

  // Corrupt JSON is silently dropped (tolerant-cache pattern).
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
    } catch {}
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
      // De-dup experiments by id — same experiment can appear under
      // multiple triggers.
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
      // Copy to prevent caller mutation of the internal array.
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
