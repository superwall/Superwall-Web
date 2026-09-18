import { it, expect } from "@effect/vitest";
import { Effect, Layer, TestClock } from "effect";
import { computedPropertiesLayer } from "./computed.ts";
import type { PaywallInfo, SubscriptionStatus } from "../types.ts";
import {
  type SuperwallDelegate,
  SuperwallEventTarget,
} from "../events.ts";
import { EventBus, eventBusLayerWithTarget } from "./eventBus.ts";
import { IdentityService, identityWithStorage } from "./identity.ts";
import {
  networkServiceLayer,
  type NetworkConfig,
} from "./network.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

interface RecordedFetch {
  url: string;
  body: string | undefined;
}

const mockFetch = (
  responder: () => Response | Promise<Response> = () => new Response("", { status: 204 }),
): { fetch: typeof fetch; calls: RecordedFetch[] } => {
  const calls: RecordedFetch[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: init?.body as string | undefined,
    });
    return responder();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
};

const buildStack = (
  fetchImpl: typeof fetch,
  target: SuperwallEventTarget,
) => {
  const config: NetworkConfig = {
    apiKey: "pk_test",
    environment: "release",
    fetch: fetchImpl,
  };
  const storage = StorageService.fromAdapter(createMemoryStorage());
  const identity = identityWithStorage(storage);
  const network = networkServiceLayer(config, identity);
  const computed = computedPropertiesLayer(storage);
  const upstream = Layer.merge(network, computed);
  return Layer.merge(eventBusLayerWithTarget(target, upstream), identity);
};

const stubPaywall = (id: string): PaywallInfo => ({
  identifier: id,
  name: id,
  url: `https://paywalls.superwall.com/${id}`,
  productIds: [],
  products: [],
});

// ---------------------------------------------------------------------------
// publish: EventTarget dispatch
// ---------------------------------------------------------------------------

it.effect("publish dispatches a typed CustomEvent to the per-instance target", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: PaywallInfo[] = [];
  target.addEventListener("paywall_open", (e) => seen.push(e.detail.paywall_info));

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("paywall_open", { paywall_info: stubPaywall("pw_1") });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.identifier).toBe("pw_1");
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// publish: wire emission
// ---------------------------------------------------------------------------

it.effect("publish posts wire-bound events to the collector", () => {
  const target = new SuperwallEventTarget();
  const { fetch, calls } = mockFetch();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("paywall_close", {
      paywall_info: stubPaywall("pw_1"),
      close_reason: "manualClose",
    });
    yield* settle;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.superwall.com/api/v1/events");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_name).toBe("paywall_close");
    // Wire payload uses the flat analytics fields, not the public detail shape.
    expect(body.events[0].parameters.$paywall_identifier).toBe("pw_1");
    expect(body.events[0].parameters).not.toHaveProperty("paywall_info");
    expect(body.events[0].event_id).toMatch(/^[0-9a-f-]+$/);
    expect(body.events[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }).pipe(Effect.provide(stack));
});

it.effect("publish does NOT post local-only events to the collector", () => {
  const target = new SuperwallEventTarget();
  const { fetch, calls } = mockFetch();
  const stack = buildStack(fetch, target);

  let localCount = 0;
  target.addEventListener("paywallWillOpenURL", () => localCount++);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("paywallWillOpenURL", { url: "https://example.com" });
    expect(localCount).toBe(1); // listener fired
    expect(calls).toHaveLength(0); // no wire emission
  }).pipe(Effect.provide(stack));
});

it.effect("publish absorbs collector failures without throwing", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch(() => new Response("nope", { status: 500 }));
  const stack = buildStack(fetch, target);

  // Should resolve, not reject — wire failures are fire-and-forget.
  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("app_open", {});
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// delegate: setDelegate / notifyDelegate / firehose onEvent
// ---------------------------------------------------------------------------

it.effect("withDelegate runs the callback against the active delegate", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const calls: Array<[from: SubscriptionStatus, to: SubscriptionStatus]> = [];
  const delegate: SuperwallDelegate = {
    onSubscriptionStatusChange(from, to) {
      calls.push([from, to]);
    },
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.withDelegate((d) =>
      d.onSubscriptionStatusChange?.(
        { status: "INACTIVE" },
        { status: "ACTIVE", entitlements: [] },
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].status).toBe("INACTIVE");
    expect(calls[0]![1].status).toBe("ACTIVE");
  }).pipe(Effect.provide(stack));
});

it.effect("withDelegate is a no-op when no delegate is set", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  let called = false;
  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    // Don't set a delegate; the callback should never run.
    yield* bus.withDelegate((d) => {
      called = true;
      d.onPaywallDidPresent?.(stubPaywall("pw_x"));
    });
    expect(called).toBe(false);
  }).pipe(Effect.provide(stack));
});

it.effect("withDelegate gracefully skips unimplemented methods (caller uses optional chaining)", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  // Delegate implements only one method — caller's optional chain handles
  // the missing one without an SDK-side check.
  const delegate: SuperwallDelegate = {
    onPaywallDidPresent: () => {},
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.withDelegate((d) =>
      d.onSubscriptionStatusChange?.({ status: "INACTIVE" }, { status: "INACTIVE" }),
    );
  }).pipe(Effect.provide(stack));
});

it.effect("withDelegate swallows delegate-thrown errors (publisher stays alive)", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const delegate: SuperwallDelegate = {
    onPaywallDidPresent: () => {
      throw new Error("delegate boom");
    },
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.withDelegate((d) => d.onPaywallDidPresent?.(stubPaywall("pw_x")));
  }).pipe(Effect.provide(stack));
});

it.effect("publish fires delegate.onEvent firehose for wire-bound events only", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: string[] = [];
  const delegate: SuperwallDelegate = {
    onEvent: (name) => {
      seen.push(name);
    },
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.publish("app_open", {});
    yield* bus.publish("paywallWillOpenURL", { url: "https://example.com" });
    yield* bus.publish("session_start", {});
    // paywallWillOpenURL is local-only and skipped from the firehose; the rest land.
    expect(seen).toEqual(["app_open", "session_start"]);
  }).pipe(Effect.provide(stack));
});

it.effect("setDelegate(null) detaches the active delegate", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  let firehoseCount = 0;
  const delegate: SuperwallDelegate = {
    onEvent: () => firehoseCount++,
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.publish("app_open", {});
    yield* bus.setDelegate(null);
    yield* bus.publish("app_open", {});
    expect(firehoseCount).toBe(1);
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// target identity — proves the public `sw.events` and bus dispatch share one
// ---------------------------------------------------------------------------

it.effect("target on the bus is the same instance the consumer added listeners to", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    const bus = yield* EventBus;
    expect(bus.target).toBe(target);
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// publishCustom
// ---------------------------------------------------------------------------

it.effect("publishCustom dispatches CustomEvent with caller's event name as the type", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: Array<Record<string, unknown>> = [];
  (target as EventTarget).addEventListener("button_clicked", (e) =>
    seen.push((e as CustomEvent).detail),
  );

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publishCustom("button_clicked", { button: "buy_now" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ button: "buy_now" });
  }).pipe(Effect.provide(stack));
});

it.effect("publishCustom POSTs to collector with event_name = caller's event name", () => {
  const target = new SuperwallEventTarget();
  const { fetch, calls } = mockFetch();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publishCustom("purchase_intent", { product: "pro_yearly", price: 99 });
    yield* settle;
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.events[0].event_name).toBe("purchase_intent");
    expect(body.events[0].parameters.product).toBe("pro_yearly");
    expect(body.events[0].parameters.price).toBe(99);
    expect(body.events[0].event_id).toMatch(/^[0-9a-f-]+$/);
  }).pipe(Effect.provide(stack));
});

it.effect("publishCustom fires delegate.onEvent with the caller's event name", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: Array<[string, unknown]> = [];
  const delegate: SuperwallDelegate = {
    onEvent: ((name: string, detail: unknown) => {
      seen.push([name, detail]);
    }) as NonNullable<SuperwallDelegate["onEvent"]>,
  };

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.setDelegate(delegate);
    yield* bus.publishCustom("form_submit", { form: "signup" });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("form_submit");
    expect((seen[0]![1] as Record<string, unknown>).form).toBe("signup");
  }).pipe(Effect.provide(stack));
});

it.effect("publishCustom absorbs collector failures without throwing", () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch(() => new Response("nope", { status: 500 }));
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publishCustom("some_event", {});
  }).pipe(Effect.provide(stack));
});

// ---------------------------------------------------------------------------
// collector delivery queue
// ---------------------------------------------------------------------------

interface CollectorRequest {
  names: string[];
  events: Array<{ event_name: string; parameters: Record<string, unknown> }>;
  bytes: number;
  headers: Record<string, string>;
  keepalive: boolean;
  respond: (r: Response) => void;
  fail: (e: unknown) => void;
}

/** Collector whose responses the test settles by hand. */
const manualCollector = (): { fetch: typeof fetch; requests: CollectorRequest[] } => {
  const requests: CollectorRequest[] = [];
  const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((respond, fail) => {
      const body = JSON.parse(init!.body as string) as {
        events: CollectorRequest["events"];
      };
      requests.push({
        names: body.events.map((e) => e.event_name),
        events: body.events,
        bytes: new TextEncoder().encode(init!.body as string).length,
        headers: init!.headers as Record<string, string>,
        keepalive: init?.keepalive === true,
        respond,
        fail,
      });
    })) as unknown as typeof fetch;
  return { fetch: fn, requests };
};

/** Let the drainer fiber and any settled fetch promises run. */
const settle = Effect.promise(
  () => new Promise<void>((r) => setTimeout(r, 0)),
);

const ok = () => new Response("", { status: 204 });

it.effect("publish resolves without waiting for the collector response", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    // The collector never answers. Before the queue this hung forever.
    yield* bus.publish("first_seen", {});
    yield* bus.publish("session_start", {});
    yield* bus.publishCustom("form_submit", {});
    yield* settle;
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]!.names[0]).toBe("first_seen");
  }).pipe(Effect.provide(stack));
});

it.effect("events published while a request is in flight go out next, in order, as one batch", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    yield* bus.publish("session_start", {});
    yield* bus.publish("app_launch", {});
    yield* bus.publishCustom("form_submit", {});
    yield* settle;
    // One request in flight at a time keeps wire order deterministic.
    expect(requests.map((r) => r.names)).toEqual([["first_seen"]]);

    requests[0]!.respond(ok());
    yield* settle;
    expect(requests.map((r) => r.names)).toEqual([
      ["first_seen"],
      ["session_start", "app_launch", "form_submit"],
    ]);
  }).pipe(Effect.provide(stack));
});

it.effect("a queued event keeps the identity it was published under", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    // Both wait behind the in-flight request; identify() lands between them.
    yield* bus.publish("session_start", {});
    yield* IdentityService.identify("user_b");
    yield* bus.publish("app_launch", {});
    requests[0]!.respond(ok());
    yield* settle;
    requests[1]!.respond(ok());
    yield* settle;

    expect(requests.map((r) => r.names)).toEqual([
      ["first_seen"],
      ["session_start"],
      ["app_launch"],
    ]);
    expect(requests[1]!.headers["X-App-User-ID"]).toBe("");
    expect(requests[2]!.headers["X-App-User-ID"]).toBe("user_b");
  }).pipe(Effect.provide(stack));
});

it.effect("a failed collector request does not stop later events", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    yield* bus.publish("session_start", {});
    requests[0]!.fail(new TypeError("offline"));
    yield* settle;
    expect(requests.map((r) => r.names)).toEqual([
      ["first_seen"],
      ["session_start"],
    ]);
  }).pipe(Effect.provide(stack));
});

it.effect("a collector request that never settles times out and the next batch goes out", () => {
  const target = new SuperwallEventTarget();
  const signals: AbortSignal[] = [];
  const names: string[][] = [];
  const hang = ((_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!);
    names.push(
      (JSON.parse(init!.body as string).events as Array<{ event_name: string }>).map(
        (e) => e.event_name,
      ),
    );
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const stack = buildStack(hang, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    yield* bus.publish("session_start", {});
    yield* TestClock.adjust("10 seconds");
    yield* settle;
    expect(signals[0]!.aborted).toBe(true);
    expect(names).toEqual([["first_seen"], ["session_start"]]);
  }).pipe(Effect.provide(stack));
});

it.effect("pagehide flushes waiting events with keepalive", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    yield* bus.publish("paywall_decline", { paywall_info: stubPaywall("pw_1") });
    yield* settle;
    expect(requests).toHaveLength(1);

    globalThis.dispatchEvent(new Event("pagehide"));
    yield* settle;
    expect(requests).toHaveLength(2);
    expect(requests[1]!.names).toEqual(["paywall_decline"]);
    expect(requests[1]!.keepalive).toBe(true);
  }).pipe(Effect.provide(stack));
});

it.effect("a queued event is a snapshot — later caller mutation does not reach the wire", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    const props = { quiz: ["original"], nested: { answer: "a" } };
    yield* bus.publishCustom("quiz_answer", props);
    props.quiz[0] = "mutated";
    props.nested.answer = "b";
    requests[0]!.respond(ok());
    yield* settle;
    expect(requests[1]!.events[0]!.parameters.quiz).toEqual(["original"]);
    expect(requests[1]!.events[0]!.parameters.nested).toEqual({ answer: "a" });
  }).pipe(Effect.provide(stack));
});

it.effect("pagehide with a large backlog splits it and keeps keepalive within the browser quota", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    // ~115 KB waiting behind the held request; multibyte so chars != bytes.
    for (let i = 0; i < 100; i++) {
      yield* bus.publishCustom("answer", { i, pad: "答".repeat(350) });
    }
    globalThis.dispatchEvent(new Event("pagehide"));
    yield* settle;

    const flushed = requests.slice(1);
    // Every event was started in this tick, in order, none dropped.
    expect(flushed.flatMap((r) => r.events.map((e) => e.parameters.i))).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
    const keepaliveBytes = flushed
      .filter((r) => r.keepalive)
      .reduce((n, r) => n + r.bytes, 0);
    expect(keepaliveBytes).toBeGreaterThan(0);
    // The held first request is keepalive too; together they stay under 64 KiB.
    expect(keepaliveBytes + requests[0]!.bytes).toBeLessThanOrEqual(65_536);
    for (const r of flushed) {
      expect(r.events.length).toBeLessThanOrEqual(50);
      if (r.keepalive) expect(r.bytes).toBeLessThan(32_000);
    }
    // The oldest waiting events get the keepalive share.
    expect(flushed[0]!.keepalive).toBe(true);
    expect(flushed[flushed.length - 1]!.keepalive).toBe(false);
  }).pipe(Effect.provide(stack));
});

it.effect("pagehide also flushes identity groups the drainer dequeued but has not sent", () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  return Effect.gen(function* () {
    yield* IdentityService.hydrate();
    const bus = yield* EventBus;
    yield* bus.publish("first_seen", {});
    yield* settle;
    yield* bus.publishCustom("anonymous_event", {});
    yield* IdentityService.identify("user_b");
    yield* bus.publishCustom("identified_event", {});
    // The drainer dequeues both groups in one batch; the anonymous one goes
    // on the wire and the identified one waits behind it.
    requests[0]!.respond(ok());
    yield* settle;
    expect(requests.map((r) => r.names)).toEqual([["first_seen"], ["anonymous_event"]]);

    globalThis.dispatchEvent(new Event("pagehide"));
    yield* settle;
    expect(requests.map((r) => r.names)).toEqual([
      ["first_seen"],
      ["anonymous_event"],
      ["identified_event"],
    ]);
    expect(requests[2]!.keepalive).toBe(true);
    expect(requests[2]!.headers["X-App-User-ID"]).toBe("user_b");

    // The drainer must not send it a second time once it resumes.
    requests[1]!.respond(ok());
    yield* bus.publishCustom("later_event", {});
    yield* settle;
    expect(requests.slice(3).map((r) => r.names)).toEqual([["later_event"]]);
  }).pipe(Effect.provide(stack));
});

it("closing the scope flushes waiting events and detaches the pagehide listener", async () => {
  const target = new SuperwallEventTarget();
  const { fetch, requests } = manualCollector();
  const stack = buildStack(fetch, target);

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.publish("first_seen", {});
      yield* settle;
      yield* bus.publish("session_start", {});
    }).pipe(Effect.provide(stack)),
  );
  await Effect.runPromise(settle);
  expect(requests.map((r) => r.names)).toEqual([
    ["first_seen"],
    ["session_start"],
  ]);
  expect(requests[1]!.keepalive).toBe(true);

  globalThis.dispatchEvent(new Event("pagehide"));
  await Effect.runPromise(settle);
  expect(requests).toHaveLength(2);
});

// Suppress unused-import warning when the test file shrinks
void Layer;
