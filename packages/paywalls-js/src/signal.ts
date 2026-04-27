// Public reactive-read primitive. Per API.md §2:
//
//   interface Readable<T> {
//     readonly value: T;
//     subscribe(run: (value: T) => void): () => void;
//   }
//
// Normative implementation contract (also §2):
//   - `value` MUST return a `===`-equal reference between change notifications.
//   - `subscribe(run)` MUST fire `run(currentValue)` synchronously once on attach.
//   - Notifications MUST be coalesced — a single mutation that touches multiple
//     signals MUST NOT fire any listener twice in the same microtask.
//
// Internals run on Effect's `SubscriptionRef`, so future Effect-side
// consumers can `Stream.fromSubscriptionRef(...)` over the same source of
// truth. The vanilla façade in this file owns listener notification +
// microtask coalescing for the public Readable<T> surface.

import { Effect, SubscriptionRef } from "effect";

export interface Readable<T> {
  readonly value: T;
  subscribe(run: (value: T) => void): () => void;
}

export interface Writable<T> extends Readable<T> {
  set(next: T): void;
  update(fn: (prev: T) => T): void;
}

/**
 * Create a writable signal. Internal services hold the `Writable<T>`;
 * the public surface gets the `Readable<T>` view via {@link asReadable}.
 *
 * Backed by an Effect `SubscriptionRef`. The ref is also returned so
 * Effect-side code can compose with `Stream.fromSubscriptionRef(ref)`
 * — both the public listeners and any Effect Stream consumers see the
 * same writes.
 */
export const createSignal = <T>(
  initial: T,
): Writable<T> & {
  /** Internal escape hatch for Effect-side composition. Not part of the
   *  public Readable<T> surface — never re-export to consumers. */
  readonly __ref: SubscriptionRef.SubscriptionRef<T>;
} => {
  const ref = Effect.runSync(SubscriptionRef.make(initial));

  let current = initial;
  let pending = initial;
  let pendingDirty = false;
  let flushScheduled = false;
  const listeners = new Set<(value: T) => void>();

  const flush = () => {
    flushScheduled = false;
    if (!pendingDirty) return;
    pendingDirty = false;
    const value = pending;
    // Snapshot listeners — handlers that mutate the set during iteration
    // (e.g. unsubscribe inside their own callback) shouldn't crash us.
    for (const listener of [...listeners]) listener(value);
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  };

  const write = (next: T): void => {
    if (Object.is(next, current)) return;
    current = next;
    pending = next;
    pendingDirty = true;
    // Mirror into the SubscriptionRef so Effect-side consumers see the
    // same value. SubscriptionRef.set is `Effect<void, never, never>`.
    Effect.runSync(SubscriptionRef.set(ref, next));
    scheduleFlush();
  };

  return {
    get value() {
      return current;
    },
    subscribe(run) {
      // Sync-on-attach: fire once with the current value before returning.
      run(current);
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    set: write,
    update(fn) {
      write(fn(current));
    },
    __ref: ref,
  };
};

/** Erase the writable + Effect-side surface, returning the read-only view. */
export const asReadable = <T>(signal: Writable<T>): Readable<T> => ({
  get value() {
    return signal.value;
  },
  subscribe: signal.subscribe.bind(signal),
});
