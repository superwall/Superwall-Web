import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.superwall.com/api/v1/events");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_name).toBe("paywall_close");
    expect(body.events[0].parameters.paywall_info.identifier).toBe("pw_1");
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

// Suppress unused-import warning when the test file shrinks
void Layer;
