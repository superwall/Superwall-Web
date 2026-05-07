// EventBusService — central fan-out for SDK event emission. `publish` runs:
//   1. synchronous dispatch to the per-instance SuperwallEventTarget,
//   2. delegate `onEvent` firehose (wire-bound only),
//   3. POST to the collector (wire-bound only, opt-out via `wireEmit:false`).

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

const newEventId = (): string => crypto.randomUUID();

export interface EventBusImpl {
  readonly target: SuperwallEventTarget;

  /** Fire a typed event. Wire-bound events POST to the collector unless
   *  `opts.wireEmit === false`. */
  publish<K extends keyof AllSuperwallEvents>(
    name: K,
    detail: AllSuperwallEvents[K],
    opts?: { wireEmit?: boolean },
  ): Effect.Effect<void>;

  /** Replace the active delegate (or detach with `null`). */
  setDelegate(delegate: SuperwallDelegate | null): Effect.Effect<void>;

  /** Invoke a typed delegate method; no-op when no delegate is set; swallows
   *  thrown errors so a buggy delegate never crashes the SDK. */
  withDelegate(
    fn: (delegate: SuperwallDelegate) => void,
    onError?: (cause: unknown) => void,
  ): Effect.Effect<void>;
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
        target.dispatchEvent(new CustomEvent(name, { detail }));

        const wireBound = !LOCAL_ONLY.has(name);
        if (!wireBound) return;

        // Record into computed-properties history. Wire-bound only —
        // local events don't drive audience rules. Best-effort.
        yield* computed
          .record(name)
          .pipe(Effect.catchAll(() => Effect.void));

        const delegate = yield* Ref.get(delegateRef);
        if (delegate?.onEvent) {
          try {
            (delegate.onEvent as (n: string, d: unknown) => void)(name, detail);
          } catch {}
        }

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
      onError?: (cause: unknown) => void,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const delegate = yield* Ref.get(delegateRef);
        if (!delegate) return;
        try {
          fn(delegate);
        } catch (cause) {
          // Delegate errors must never break the SDK lifecycle; the
          // optional onError lets the caller surface them via Logger.
          onError?.(cause);
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

/** Build an EventBus Layer over a fresh SuperwallEventTarget. Upstream
 *  must provide `NetworkService` + `ComputedProperties`. */
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
 *  can share the same target the consumer reads via `sw.events`. */
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
