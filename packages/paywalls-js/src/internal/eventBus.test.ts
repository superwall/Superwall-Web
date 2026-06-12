import { test, expect } from "bun:test";
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
  return eventBusLayerWithTarget(target, upstream);
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

test("publish dispatches a typed CustomEvent to the per-instance target", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: PaywallInfo[] = [];
  target.addEventListener("paywall_open", (e) => seen.push(e.detail.paywall_info));

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.publish("paywall_open", { paywall_info: stubPaywall("pw_1") });
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]!.identifier).toBe("pw_1");
});

// ---------------------------------------------------------------------------
// publish: wire emission
// ---------------------------------------------------------------------------

test("publish posts wire-bound events to the collector", async () => {
  const target = new SuperwallEventTarget();
  const { fetch, calls } = mockFetch();
  const stack = buildStack(fetch, target);

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.publish("paywall_close", {
        paywall_info: stubPaywall("pw_1"),
        close_reason: "manualClose",
      });
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://collector.superwall.com/api/v1/events");
  const body = JSON.parse(calls[0]!.body!);
  expect(body.events).toHaveLength(1);
  expect(body.events[0].event_name).toBe("paywall_close");
  expect(body.events[0].parameters.paywall_info.identifier).toBe("pw_1");
  expect(body.events[0].event_id).toMatch(/^[0-9a-f-]+$/);
  expect(body.events[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("publish does NOT post local-only events to the collector", async () => {
  const target = new SuperwallEventTarget();
  const { fetch, calls } = mockFetch();
  const stack = buildStack(fetch, target);

  let localCount = 0;
  target.addEventListener("paywallWillOpenURL", () => localCount++);

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.publish("paywallWillOpenURL", { url: "https://example.com" });
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  expect(localCount).toBe(1); // listener fired
  expect(calls).toHaveLength(0); // no wire emission
});

test("publish absorbs collector failures without throwing", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch(() => new Response("nope", { status: 500 }));
  const stack = buildStack(fetch, target);

  // Should resolve, not reject — wire failures are fire-and-forget.
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.publish("app_open", {});
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );
});

// ---------------------------------------------------------------------------
// delegate: setDelegate / notifyDelegate / firehose onEvent
// ---------------------------------------------------------------------------

test("withDelegate runs the callback against the active delegate", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const calls: Array<[from: SubscriptionStatus, to: SubscriptionStatus]> = [];
  const delegate: SuperwallDelegate = {
    onSubscriptionStatusChange(from, to) {
      calls.push([from, to]);
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.setDelegate(delegate);
      yield* bus.withDelegate((d) =>
        d.onSubscriptionStatusChange?.(
          { status: "INACTIVE" },
          { status: "ACTIVE", entitlements: [] },
        ),
      );
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]![0].status).toBe("INACTIVE");
  expect(calls[0]![1].status).toBe("ACTIVE");
});

test("withDelegate is a no-op when no delegate is set", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  let called = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      // Don't set a delegate; the callback should never run.
      yield* bus.withDelegate((d) => {
        called = true;
        d.onPaywallDidPresent?.(stubPaywall("pw_x"));
      });
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );
  expect(called).toBe(false);
});

test("withDelegate gracefully skips unimplemented methods (caller uses optional chaining)", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  // Delegate implements only one method — caller's optional chain handles
  // the missing one without an SDK-side check.
  const delegate: SuperwallDelegate = {
    onPaywallDidPresent: () => {},
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.setDelegate(delegate);
      yield* bus.withDelegate((d) =>
        d.onSubscriptionStatusChange?.({ status: "INACTIVE" }, { status: "INACTIVE" }),
      );
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );
});

test("withDelegate swallows delegate-thrown errors (publisher stays alive)", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const delegate: SuperwallDelegate = {
    onPaywallDidPresent: () => {
      throw new Error("delegate boom");
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.setDelegate(delegate);
      yield* bus.withDelegate((d) => d.onPaywallDidPresent?.(stubPaywall("pw_x")));
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );
});

test("publish fires delegate.onEvent firehose for wire-bound events only", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  const seen: string[] = [];
  const delegate: SuperwallDelegate = {
    onEvent: (name) => {
      seen.push(name);
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.setDelegate(delegate);
      yield* bus.publish("app_open", {});
      yield* bus.publish("paywallWillOpenURL", { url: "https://example.com" });
      yield* bus.publish("session_start", {});
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  // paywallWillOpenURL is local-only and skipped from the firehose; the rest land.
  expect(seen).toEqual(["app_open", "session_start"]);
});

test("setDelegate(null) detaches the active delegate", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  let firehoseCount = 0;
  const delegate: SuperwallDelegate = {
    onEvent: () => firehoseCount++,
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* IdentityService.hydrate();
      const bus = yield* EventBus;
      yield* bus.setDelegate(delegate);
      yield* bus.publish("app_open", {});
      yield* bus.setDelegate(null);
      yield* bus.publish("app_open", {});
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );

  expect(firehoseCount).toBe(1);
});

// ---------------------------------------------------------------------------
// target identity — proves the public `sw.events` and bus dispatch share one
// ---------------------------------------------------------------------------

test("target on the bus is the same instance the consumer added listeners to", async () => {
  const target = new SuperwallEventTarget();
  const { fetch } = mockFetch();
  const stack = buildStack(fetch, target);

  await Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      expect(bus.target).toBe(target);
    }).pipe(Effect.provide(stack)) as Effect.Effect<void, never, never>,
  );
});

// Suppress unused-import warning when the test file shrinks
void Layer;
