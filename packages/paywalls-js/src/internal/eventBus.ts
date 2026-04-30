// EventBusService — central fan-out for SDK-internal event emission.
//
// publish(name, detail) →
//   1. Synchronously dispatches a typed CustomEvent to the per-instance
//      SuperwallEventTarget (so `sw.events.addEventListener` listeners and
//      the React `useSuperwallEvent` hook receive it).
//   2. Calls `delegate.onEvent(name, detail)` (firehose) if a wire-bound
//      event AND a delegate is attached.
//   3. For wire-bound events (NOT in LOCAL_ONLY): forwards a v0 single-item
//      batch to NetworkService.postEvents. Batching lands when we have
//      enough event traffic to warrant it.
//
// notifyDelegate(method, ...args) → calls a typed delegate method directly.
// Used by services that want to surface a typed callback (onPaywallDidPresent,
// onSubscriptionStatusChange, etc.) without wire emission.

import { Context, Effect, Layer, Ref } from "effect";
import {
  LOCAL_ONLY,
  type AllSuperwallEvents,
  type SuperwallDelegate,
  SuperwallEventTarget,
} from "../events.ts";
import type { JsonValue } from "../types.ts";
import { ComputedProperties } from "./computed.ts";
import { NetworkService } from "./network.ts";

/** Random-but-good-enough event ID; collisions are extremely unlikely and
 *  the collector tolerates duplicates anyway. */
const newEventId = (): string => crypto.randomUUID();

export interface EventBusImpl {
  readonly target: SuperwallEventTarget;

  /** Fire a typed event. Wire-bound events also POST to the collector
   *  unless `opts.wireEmit === false` (used by the SDK when emitting a
   *  lifecycle event whose payload references stub data — e.g. a
   *  `PaywallInfo` synthesized from a placement name without real config). */
  publish<K extends keyof AllSuperwallEvents>(
    name: K,
    detail: AllSuperwallEvents[K],
    opts?: { wireEmit?: boolean },
  ): Effect.Effect<void>;

  /** Replace the active delegate (or detach with `null`). */
  setDelegate(delegate: SuperwallDelegate | null): Effect.Effect<void>;

  /**
   * Run a callback against the active delegate. Caller writes the typed
   * invocation; bus handles "no delegate set" + error-swallowing:
   *
   *   yield* bus.withDelegate(d => d.onSubscriptionStatusChange?.(from, to));
   */
  withDelegate(fn: (delegate: SuperwallDelegate) => void): Effect.Effect<void>;
}

const make = (target: SuperwallEventTarget) =>
  Effect.gen(function* () {
    const network = yield* NetworkService;
    const computed = yield* ComputedProperties;
    const delegateRef = yield* Ref.make<SuperwallDelegate | null>(null);

    const publish = <K extends keyof AllSuperwallEvents>(
      name: K,
      detail: AllSuperwallEvents[K],
      opts?: { wireEmit?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // (1) typed EventTarget dispatch — synchronous
        target.dispatchEvent(new CustomEvent(name, { detail }));

        const wireBound = !LOCAL_ONLY.has(name);
        if (!wireBound) return;

        // (2) record into computed-properties history. Wire-bound only —
        // local events are SDK-internal and don't drive audience rules.
        // Best-effort: storage failures don't block delivery.
        yield* computed
          .record(name)
          .pipe(Effect.catchAll(() => Effect.void));

        // (3) delegate firehose (wire-bound only — local events aren't
        //     in `SuperwallEventMap` so they don't fit the typed signature)
        const delegate = yield* Ref.get(delegateRef);
        if (delegate?.onEvent) {
          try {
            (delegate.onEvent as (n: string, d: unknown) => void)(name, detail);
          } catch {
            /* swallow — delegate errors stay scoped */
          }
        }

        // (4) wire emission. Caller can opt out for stub-data lifecycle
        // events that shouldn't pollute the collector (e.g. v0 alpha's
        // synthesized `paywall_open` from a stub `PaywallInfo`).
        if (opts?.wireEmit === false) return;

        const envelope = {
          event_id: newEventId(),
          event_name: name,
          parameters: detail as unknown as Record<string, JsonValue>,
          created_at: new Date().toISOString(),
        };
        yield* network
          .postEvents([envelope])
          .pipe(Effect.catchAll(() => Effect.void));
      }).pipe(Effect.withSpan("EventBus.publish", { attributes: { name } }));

    const setDelegate = (
      delegate: SuperwallDelegate | null,
    ): Effect.Effect<void> =>
      Ref.set(delegateRef, delegate).pipe(
        Effect.withSpan("EventBus.setDelegate"),
      );

    const withDelegate = (
      fn: (delegate: SuperwallDelegate) => void,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const delegate = yield* Ref.get(delegateRef);
        if (!delegate) return;
        try {
          fn(delegate);
        } catch {
          /* swallow — delegate errors stay scoped */
        }
      }).pipe(Effect.withSpan("EventBus.withDelegate"));

    return {
      target,
      publish,
      setDelegate,
      withDelegate,
    } satisfies EventBusImpl;
  });

export class EventBus extends Context.Tag("@superwall/EventBus")<
  EventBus,
  EventBusImpl
>() {}

/** Build an EventBus Layer over a fresh SuperwallEventTarget + the upstream
 *  Layer (which must provide both `NetworkService` and `ComputedProperties`).
 *  The resulting Layer outputs `EventBus` AND re-exposes the upstream
 *  services for downstream consumers. */
export const eventBusLayer = (
  upstream: Layer.Layer<NetworkService | ComputedProperties>,
): Layer.Layer<
  EventBus | NetworkService | ComputedProperties,
  never,
  never
> =>
  Layer.provideMerge(
    Layer.effect(EventBus, make(new SuperwallEventTarget())),
    upstream,
  ) as Layer.Layer<
    EventBus | NetworkService | ComputedProperties,
    never,
    never
  >;

/** Same as `eventBusLayer` but takes a pre-built target so React's Provider
 *  can pass the same `SuperwallEventTarget` instance the consumer already
 *  reads via `sw.events`. */
export const eventBusLayerWithTarget = (
  target: SuperwallEventTarget,
  upstream: Layer.Layer<NetworkService | ComputedProperties>,
): Layer.Layer<
  EventBus | NetworkService | ComputedProperties,
  never,
  never
> =>
  Layer.provideMerge(
    Layer.effect(EventBus, make(target)),
    upstream,
  ) as Layer.Layer<
    EventBus | NetworkService | ComputedProperties,
    never,
    never
  >;
