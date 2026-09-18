// EventBusService — central fan-out for SDK event emission. `publish` runs:
//   1. synchronous dispatch to the per-instance SuperwallEventTarget,
//   2. delegate `onEvent` firehose (wire-bound only),
//   3. enqueue for the collector (wire-bound only, opt-out via `wireEmit:false`).
//
// Collector delivery is decoupled from `publish`: a background drainer POSTs
// the queue in order, one request at a time, so callers (configure, register,
// identify) never wait on analytics HTTP.

import {
  Array as Arr,
  Chunk,
  Context,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
  Runtime,
} from "effect";
import {
  LOCAL_ONLY,
  type AllSuperwallEvents,
  type SuperwallDelegate,
  SuperwallEventTarget,
} from "../events.ts";
import type { JsonValue } from "../types.ts";
import { toWireParameters } from "./analyticsParams.ts";
import { ComputedProperties } from "./computed.ts";
import {
  KEEPALIVE_MAX_BYTES,
  NetworkService,
  utf8ByteLength,
  type EventEnvelope,
  type PostEventsOptions,
} from "./network.ts";

/** Events waiting on the collector. Past this the oldest are dropped, so an
 *  unreachable collector can't grow memory without bound. */
const MAX_QUEUED_EVENTS = 1000;
/** Events per collector POST (matches the native SDKs' batch size). */
const MAX_BATCH_SIZE = 50;

interface QueuedEvent {
  /** JSON snapshot taken at publish time — the caller may mutate its params
   *  object after `track()` returns, long before delivery serializes it. */
  readonly envelope: EventEnvelope;
  /** UTF-8 size of the serialized envelope. */
  readonly bytes: number;
  /** Request headers captured at publish time. They carry the identity, so an
   *  identify() / signOut() / reset() that lands before delivery can't
   *  re-attribute the event to a different user. */
  readonly headers: Record<string, string>;
}

const IDENTITY_HEADERS = ["X-App-User-ID", "X-Alias-ID", "X-Vendor-ID"] as const;

const sameIdentity = (a: QueuedEvent, b: QueuedEvent): boolean =>
  IDENTITY_HEADERS.every((h) => a.headers[h] === b.headers[h]);

/** Split a backlog into collector batches for the exit flush: same identity,
 *  at most {@link MAX_BATCH_SIZE} events, and small enough to be eligible for
 *  keepalive. An oversized single event gets a batch of its own. */
const flushBatches = (
  events: ReadonlyArray<QueuedEvent>,
): ReadonlyArray<Arr.NonEmptyArray<QueuedEvent>> => {
  const batches: Array<Arr.NonEmptyArray<QueuedEvent>> = [];
  let bytes = 0;
  for (const event of events) {
    const current = batches[batches.length - 1];
    if (
      current &&
      sameIdentity(Arr.headNonEmpty(current), event) &&
      current.length < MAX_BATCH_SIZE &&
      bytes + event.bytes <= KEEPALIVE_MAX_BYTES
    ) {
      current.push(event);
      bytes += event.bytes;
    } else {
      batches.push([event]);
      bytes = event.bytes;
    }
  }
  return batches;
};

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

  /** Fire a custom user-defined event. Dispatches on the EventTarget with
   *  `event` as the type, calls delegate.onEvent, and POSTs to the collector
   *  with `event_name = event` so the wire sees the caller's event name
   *  directly rather than a "track" envelope. */
  publishCustom(
    event: string,
    properties: Record<string, JsonValue>,
  ): Effect.Effect<void>;

  /** Replace the active delegate (or detach with `null`). */
  setDelegate(delegate: SuperwallDelegate | null): Effect.Effect<void>;

  /** Invoke a typed delegate method; no-op when no delegate is set; swallows
   *  thrown errors so a buggy delegate never crashes the SDK. */
  withDelegate(
    fn: (delegate: SuperwallDelegate) => void,
    onError?: (cause: unknown) => void,
  ): Effect.Effect<void>;
  /** Set a function returning auto-context params (e.g. `$client_surface`,
   *  `$host_origin`, `$presentation_id`). Merged into every wire-emitted
   *  envelope's `parameters` field with caller params winning on key clash. */
  setContextProvider(
    provider: (() => Record<string, JsonValue>) | null,
  ): Effect.Effect<void>;
}

const make = (target: SuperwallEventTarget) =>
  Effect.gen(function* () {
    const network = yield* NetworkService;
    const computed = yield* ComputedProperties;
    const delegateRef = yield* Ref.make<SuperwallDelegate | null>(null);
    const contextProviderRef = yield* Ref.make<
      (() => Record<string, JsonValue>) | null
    >(null);

    const queue = yield* Queue.sliding<QueuedEvent>(MAX_QUEUED_EVENTS);

    const enqueue = Effect.fn("EventBus.enqueue")(function* (
      envelope: EventEnvelope,
    ) {
      const headers = yield* network.buildHeaders();
      const json = yield* Effect.try(() => JSON.stringify(envelope));
      yield* Queue.offer(queue, {
        envelope: JSON.parse(json) as EventEnvelope,
        bytes: utf8ByteLength(json),
        headers,
      });
    }, Effect.catchAll(() => Effect.void));

    /** One collector POST for a same-identity batch. Best-effort: a failed or
     *  timed-out request drops its events (no retries, as before the queue). */
    const post = (
      batch: Arr.NonEmptyReadonlyArray<QueuedEvent>,
      options?: PostEventsOptions,
    ) =>
      network
        .postEvents(
          Arr.map(batch, (e) => e.envelope),
          { ...options, headers: Arr.headNonEmpty(batch).headers },
        )
        .pipe(
          Effect.tapError((e) =>
            Effect.logDebug("Collector delivery failed", { error: String(e) }),
          ),
          Effect.catchAll(() => Effect.void),
        );

    // Identity groups the drainer has dequeued but not yet sent. Kept here,
    // not in the drainer's fiber, so the exit flush can still reach them.
    const dequeued = yield* Ref.make<
      ReadonlyArray<Arr.NonEmptyArray<QueuedEvent>>
    >([]);

    // Exit flush (pagehide / scope close): start every waiting batch now —
    // only requests already started can outlive the page. Keepalive goes to
    // the oldest batches until the browser quota share is spent; the rest go
    // out as plain requests, which is all a dispose on a live page needs.
    const flush = Effect.fn("EventBus.flush")(function* () {
      const waiting = [
        ...(yield* Ref.getAndSet(dequeued, [])).flat(),
        ...(yield* Queue.takeAll(queue)),
      ];
      let budget = KEEPALIVE_MAX_BYTES;
      for (const batch of flushBatches(waiting)) {
        const bytes = batch.reduce((n, e) => n + e.bytes, 0);
        const keepalive = bytes <= budget;
        if (keepalive) budget -= bytes;
        // Finalizers run uninterruptible; the collector timeout needs interruption.
        yield* Effect.forkDaemon(Effect.interruptible(post(batch, { keepalive })));
      }
    });
    // Registered before the drainer so it runs after the drainer is interrupted.
    yield* Effect.addFinalizer(() => flush());

    // Drainer: in order, one request at a time, one same-identity group per
    // request. Taking a group out of `dequeued` is what transfers ownership,
    // so the drainer and the exit flush never send the same events. The
    // request runs on a daemon fiber so a dispose interrupts the wait, not
    // the request already on the wire.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let group = yield* Ref.modify(dequeued, ([head, ...tail]) => [head, tail]);
        if (!group) {
          const batch = Chunk.toReadonlyArray(
            yield* restore(Queue.takeBetween(queue, 1, MAX_BATCH_SIZE)),
          );
          if (!Arr.isNonEmptyReadonlyArray(batch)) return;
          const [head, ...tail] = Arr.groupWith(batch, sameIdentity);
          yield* Ref.set(dequeued, tail);
          group = head;
        }
        // `restore`: a forked fiber inherits the uninterruptible region, and
        // the collector timeout works by interrupting the request.
        const fiber = yield* Effect.forkDaemon(restore(post(group)));
        yield* restore(Fiber.join(fiber));
      }),
    ).pipe(Effect.forever, Effect.forkScoped);

    if (typeof globalThis.addEventListener === "function") {
      const runFork = Runtime.runFork(yield* Effect.runtime<never>());
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onPageHide = () => void runFork(flush());
          globalThis.addEventListener("pagehide", onPageHide);
          return onPageHide;
        }),
        (onPageHide) =>
          Effect.sync(() =>
            globalThis.removeEventListener("pagehide", onPageHide),
          ),
      );
    }

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

        // Merge auto-context (`$client_surface`, `$host_origin`,
        // `$presentation_id`, …) under the caller's params so explicit
        // params always win on key collision.
        const provider = yield* Ref.get(contextProviderRef);
        let context: Record<string, JsonValue> = {};
        if (provider) {
          try {
            context = provider();
          } catch {}
        }
        const envelope = {
          event_id: newEventId(),
          event_name: name,
          parameters: {
            ...context,
            ...toWireParameters(name, detail),
          },
          created_at: new Date().toISOString(),
        };
        yield* enqueue(envelope);
      }).pipe(Effect.withSpan("EventBus.publish", { attributes: { name } }));

    const publishCustom = (
      event: string,
      properties: Record<string, JsonValue>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Dispatch with the caller's event name so sw.events listeners can
        // subscribe to specific event names directly.
        target.dispatchEvent(new CustomEvent(event, { detail: properties }));

        yield* computed
          .record(event)
          .pipe(Effect.catchAll(() => Effect.void));

        const delegate = yield* Ref.get(delegateRef);
        if (delegate?.onEvent) {
          try {
            (delegate.onEvent as (n: string, d: unknown) => void)(
              event,
              properties,
            );
          } catch {}
        }

        const provider = yield* Ref.get(contextProviderRef);
        let context: Record<string, JsonValue> = {};
        if (provider) {
          try {
            context = provider();
          } catch {}
        }
        const envelope = {
          event_id: newEventId(),
          event_name: event,
          parameters: { ...context, ...properties },
          created_at: new Date().toISOString(),
        };
        yield* enqueue(envelope);
      }).pipe(
        Effect.withSpan("EventBus.publishCustom", { attributes: { event } }),
      );

    const setDelegate = (
      delegate: SuperwallDelegate | null,
    ): Effect.Effect<void> =>
      Ref.set(delegateRef, delegate).pipe(
        Effect.withSpan("EventBus.setDelegate"),
      );

    const setContextProvider = (
      provider: (() => Record<string, JsonValue>) | null,
    ): Effect.Effect<void> =>
      Ref.set(contextProviderRef, provider).pipe(
        Effect.withSpan("EventBus.setContextProvider"),
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
      publishCustom,
      setDelegate,
      withDelegate,
      setContextProvider,
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
    Layer.scoped(EventBus, make(new SuperwallEventTarget())),
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
    Layer.scoped(EventBus, make(target)),
    upstream,
  ) as Layer.Layer<
    EventBus | NetworkService | ComputedProperties,
    never,
    never
  >;
