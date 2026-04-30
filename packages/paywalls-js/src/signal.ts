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
// Vanilla TS implementation — no Effect dependency. The earlier prototype
// kept a parallel `SubscriptionRef` for "future Effect-side consumers,"
// but every internal service that bridges Effect → public goes one way
// (`Stream.runForEach` writing into a vanilla signal). Dropping the
// runtime hop per write makes signal updates allocation-free and avoids
// every public mutation crossing into the Effect runtime.

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
 */
export const createSignal = <T>(initial: T): Writable<T> => {
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
  };
};

/** Erase the writable surface, returning the read-only view. */
export const asReadable = <T>(signal: Writable<T>): Readable<T> => ({
  get value() {
    return signal.value;
  },
  subscribe: signal.subscribe.bind(signal),
});
