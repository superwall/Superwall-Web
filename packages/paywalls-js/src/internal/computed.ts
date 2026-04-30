// ComputedPropertiesService — records event history + computes the
// `daysSince_<event>` / `paywallsInHour|Day|Week|Month` /
// `placementsSinceInstall` counters used by the audience-rule evaluator.
//
// v0 alpha: storage is a single JSON array under
// `STORAGE_KEYS.computedProperties`, FIFO-evicted at MAX_HISTORY entries.
// The audience-rule evaluator that consumes these values is deferred
// (MISSING.md), but landing the storage + recording side now means the
// data is already accumulating when the evaluator ships.
//
// Internal-only — not exported from the package barrel.

import { Context, Effect, Layer, Ref } from "effect";
import { STORAGE_KEYS, type ComputedPropertyRequest } from "../types.ts";
import { asStorageKey } from "./brands.ts";
import { StorageService } from "./storage.ts";

const HISTORY_KEY = asStorageKey(STORAGE_KEYS.computedProperties);

/** Cap on retained event records. Big enough for time-window counters
 *  (paywallsInMonth on a power user) without unbounded growth. */
const MAX_HISTORY = 2000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

interface EventRecord {
  /** Event name (matches the wire `event_name` from `SuperwallEventMap`). */
  readonly name: string;
  /** ms since epoch. */
  readonly ts: number;
}

export interface ComputedPropertiesImpl {
  /** Append an event to the history buffer. Persisted asynchronously. */
  readonly record: (eventName: string, now?: number) => Effect.Effect<void>;
  /** Evaluate one computed-property request against the current history.
   *  Returns `null` when the requested event has never fired (caller can
   *  treat as "very long ago" / "never" for audience-rule semantics). */
  readonly compute: (
    request: ComputedPropertyRequest,
    now?: number,
  ) => Effect.Effect<number | null>;
  /** Snapshot the current history. Useful for diagnostics + tests. */
  readonly history: () => Effect.Effect<ReadonlyArray<EventRecord>>;
  /** Wipe everything (called from `sw.reset()`). */
  readonly reset: () => Effect.Effect<void>;
}

const computeOne = (
  history: ReadonlyArray<EventRecord>,
  request: ComputedPropertyRequest,
  now: number,
): number | null => {
  switch (request.type) {
    case "minutesSince":
    case "hoursSince":
    case "daysSince":
    case "monthsSince":
    case "yearsSince": {
      // Find the most recent record matching the event name.
      let latest: number | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const rec = history[i];
        if (rec && rec.name === request.eventName) {
          latest = rec.ts;
          break;
        }
      }
      if (latest === null) return null;
      const elapsed = now - latest;
      switch (request.type) {
        case "minutesSince":
          return Math.floor(elapsed / (60 * 1000));
        case "hoursSince":
          return Math.floor(elapsed / HOUR_MS);
        case "daysSince":
          return Math.floor(elapsed / DAY_MS);
        case "monthsSince":
          return Math.floor(elapsed / MONTH_MS);
        case "yearsSince":
          return Math.floor(elapsed / (365 * DAY_MS));
      }
      return null;
    }
    case "placementsInHour":
    case "placementsInDay":
    case "placementsInWeek":
    case "placementsInMonth": {
      const window =
        request.type === "placementsInHour"
          ? HOUR_MS
          : request.type === "placementsInDay"
            ? DAY_MS
            : request.type === "placementsInWeek"
              ? WEEK_MS
              : MONTH_MS;
      const cutoff = now - window;
      let count = 0;
      // Only count placement-trigger events. Per Android `triggerFire` is
      // the canonical "a placement was evaluated" event.
      for (const rec of history) {
        if (rec.name === "trigger_fire" && rec.ts >= cutoff) count++;
      }
      return count;
    }
    case "placementsSinceInstall": {
      let count = 0;
      for (const rec of history) {
        if (rec.name === "trigger_fire") count++;
      }
      return count;
    }
  }
};

const make = Effect.gen(function* () {
  const storage = yield* StorageService;

  // Hydrate history from storage. Corrupt JSON is silently dropped (matches
  // assignment-cache behaviour in `superwall.ts`).
  const initial = yield* storage.get(HISTORY_KEY);
  let parsed: EventRecord[] = [];
  if (initial !== null) {
    try {
      const decoded = JSON.parse(initial) as unknown;
      if (Array.isArray(decoded)) {
        parsed = decoded.filter(
          (e): e is EventRecord =>
            !!e &&
            typeof e === "object" &&
            typeof (e as EventRecord).name === "string" &&
            typeof (e as EventRecord).ts === "number",
        );
      }
    } catch {
      /* drop corrupt cache */
    }
  }

  const ref = yield* Ref.make<EventRecord[]>(parsed);

  const persist = (next: EventRecord[]) =>
    storage
      .set(HISTORY_KEY, JSON.stringify(next))
      .pipe(Effect.catchAll(() => Effect.void));

  const record: ComputedPropertiesImpl["record"] = (eventName, now) =>
    Effect.gen(function* () {
      const ts = now ?? Date.now();
      const next = yield* Ref.modify(ref, (current) => {
        const appended = current.concat({ name: eventName, ts });
        // FIFO evict if over cap.
        const trimmed =
          appended.length > MAX_HISTORY
            ? appended.slice(appended.length - MAX_HISTORY)
            : appended;
        return [trimmed, trimmed];
      });
      yield* persist(next);
    });

  const compute: ComputedPropertiesImpl["compute"] = (request, now) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(ref);
      return computeOne(current, request, now ?? Date.now());
    });

  const history: ComputedPropertiesImpl["history"] = () => Ref.get(ref);

  const reset: ComputedPropertiesImpl["reset"] = () =>
    Effect.gen(function* () {
      yield* Ref.set(ref, []);
      yield* storage
        .remove(HISTORY_KEY)
        .pipe(Effect.catchAll(() => Effect.void));
    });

  return { record, compute, history, reset } satisfies ComputedPropertiesImpl;
});

export class ComputedProperties extends Context.Tag(
  "@superwall/ComputedProperties",
)<ComputedProperties, ComputedPropertiesImpl>() {}

/** Build a Layer that exposes `ComputedProperties` over the supplied
 *  `StorageService`. The result re-exposes the upstream storage Layer so
 *  consumers don't have to compose it twice. */
export const computedPropertiesLayer = (
  storageLayer: Layer.Layer<StorageService>,
): Layer.Layer<ComputedProperties | StorageService, never, never> =>
  Layer.provideMerge(
    Layer.effect(ComputedProperties, make),
    storageLayer,
  ) as Layer.Layer<ComputedProperties | StorageService, never, never>;
