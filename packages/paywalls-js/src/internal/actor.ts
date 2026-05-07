// SubscriptionRef paired with a single-permit semaphore. Mutating ops go
// through `dispatch(...)` and run sequentially; read-only ops skip the
// semaphore and see whatever the most-recently-completed mutation produced.

import { Effect, SubscriptionRef } from "effect";

export interface Actor<S> {
  /** Observable state. Subscribe via `.changes` (Stream). */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  /** Run `effect` under the actor's mutex. `label` is for tracing. */
  readonly dispatch: <A, E>(
    label: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

/** Build an Actor with the given initial state. */
export const makeActor = <S>(initial: S): Effect.Effect<Actor<S>> =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial);
    const mutex = yield* Effect.makeSemaphore(1);
    const dispatch: Actor<S>["dispatch"] = (label, effect) =>
      mutex.withPermits(1)(Effect.withSpan(label)(effect));
    return { stateRef, dispatch };
  });
