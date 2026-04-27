import { test, expect } from "bun:test";
import {
  createSuperwall,
  NoPresenterRegisteredError,
  NotConfiguredError,
  type StorageAdapter,
  type SubscriptionStatus,
  type Superwall,
  type SuperwallDelegate,
} from "./index.ts";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

const noopFetch = (() =>
  Promise.resolve(new Response("", { status: 204 }))) as unknown as typeof fetch;

const newAdapter = (): StorageAdapter => {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v);
    },
    remove: (k) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
  };
};

const make = (override: Partial<Parameters<typeof createSuperwall>[0]> = {}): Superwall =>
  createSuperwall({
    apiKey: "pk_test",
    fetch: noopFetch,
    storage: newAdapter(),
    ...override,
  });

// ---------------------------------------------------------------------------
// factory + ready
// ---------------------------------------------------------------------------

test("createSuperwall returns an instance synchronously", () => {
  const sw = make();
  expect(sw.apiKey).toBe("pk_test");
  expect(sw.ready).toBeInstanceOf(Promise);
  expect(sw.events).toBeDefined();
  expect(sw.user).toBeDefined();
});

test("sw.ready resolves once identity hydrates and lifecycle events fire", async () => {
  const sw = make();
  await sw.ready;
  expect(sw.isConfigured.value).toBe(true);
  expect(sw.configurationStatus.value).toBe("configured");
  await sw.dispose();
});

test("identity hydration writes alias + vendor + device into the storage adapter", async () => {
  const adapter = newAdapter();
  const sw = make({ storage: adapter });
  await sw.ready;
  expect(await adapter.get("superwall.aliasId")).toMatch(/^\$SuperwallAlias:/);
  expect(await adapter.get("superwall.vendorId")).toBeTruthy();
  expect(await adapter.get("superwall.deviceId")).toMatch(/^[0-9a-f]{16}$/);
  await sw.dispose();
});

test("seeded identity values are picked up + persisted", async () => {
  const adapter = newAdapter();
  const sw = make({
    storage: adapter,
    identity: { aliasId: "$SuperwallAlias:seeded", appUserId: "seed-user" },
  });
  await sw.ready;
  expect(sw.user.aliasId.value).toBe("$SuperwallAlias:seeded");
  expect(sw.user.id.value).toBe("seed-user");
  expect(sw.user.effectiveId.value).toBe("seed-user");
  expect(sw.user.isLoggedIn.value).toBe(true);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// user namespace
// ---------------------------------------------------------------------------

test("identify updates id / effectiveId / isLoggedIn signals", async () => {
  const sw = make();
  await sw.ready;
  expect(sw.user.id.value).toBe("");
  expect(sw.user.effectiveId.value).toBe(sw.user.aliasId.value);
  expect(sw.user.isLoggedIn.value).toBe(false);

  await sw.user.identify("user_42");
  await tick();

  expect(sw.user.id.value).toBe("user_42");
  expect(sw.user.effectiveId.value).toBe("user_42");
  expect(sw.user.isLoggedIn.value).toBe(true);
  await sw.dispose();
});

test("signOut clears the userId but keeps the alias", async () => {
  const sw = make();
  await sw.ready;
  await sw.user.identify("user_42");
  await tick();
  const aliasBefore = sw.user.aliasId.value;

  await sw.user.signOut();
  await tick();

  expect(sw.user.id.value).toBe("");
  expect(sw.user.isLoggedIn.value).toBe(false);
  expect(sw.user.effectiveId.value).toBe(aliasBefore);
  expect(sw.user.aliasId.value).toBe(aliasBefore);
  await sw.dispose();
});

test("setAttributes merges into the attributes signal", async () => {
  const sw = make();
  await sw.ready;
  sw.user.setAttributes({ email: "a@b.co" } as Partial<typeof sw.user.attributes.value>);
  expect((sw.user.attributes.value as { email?: string }).email).toBe("a@b.co");
  await sw.dispose();
});

test("setIntegrationAttribute writes + null clears", async () => {
  const sw = make();
  await sw.ready;
  sw.user.setIntegrationAttribute("mixpanelDistinctId", "abc-123");
  expect(sw.user.integrationAttributes.value.mixpanelDistinctId).toBe("abc-123");
  sw.user.setIntegrationAttribute("mixpanelDistinctId", null);
  expect(sw.user.integrationAttributes.value.mixpanelDistinctId).toBeUndefined();
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// purchases.setSubscriptionStatus + entitlements derivation
// ---------------------------------------------------------------------------

test("setSubscriptionStatus updates subscriptionStatus + entitlements + fires delegate", async () => {
  const transitions: Array<[SubscriptionStatus, SubscriptionStatus]> = [];
  const sw = make({
    delegate: {
      onSubscriptionStatusChange(from, to) {
        transitions.push([from, to]);
      },
    },
  });
  await sw.ready;

  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [
      { id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["pro_yearly"] },
    ],
  });

  // subStatusSig.value updates synchronously; entitlements is derived via a
  // subscribe() callback which fires on the next microtask (per signal §2
  // coalescing contract). Tick once to let it flush.
  expect(sw.subscriptionStatus.value.status).toBe("ACTIVE");
  await tick();
  expect(sw.entitlements.active.value).toHaveLength(1);
  expect(sw.entitlements.active.value[0]!.id).toBe("pro");
  expect(sw.entitlements.byProductIds(["pro_yearly"])).toHaveLength(1);
  expect(sw.entitlements.byProductIds(["nope"])).toHaveLength(0);

  // The delegate notification + wire emission are fire-and-forget; tick again
  // for the runtime to process.
  await tick();
  expect(transitions).toHaveLength(1);
  expect(transitions[0]![0].status).toBe("UNKNOWN");
  expect(transitions[0]![1].status).toBe("ACTIVE");
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

test("sw.events receives the lifecycle events fired during configure", async () => {
  const sw = make();
  const seen: string[] = [];
  sw.events.addEventListener("first_seen", () => seen.push("first_seen"));
  sw.events.addEventListener("session_start", () => seen.push("session_start"));
  sw.events.addEventListener("app_launch", () => seen.push("app_launch"));
  sw.events.addEventListener("identityHydrated", () => seen.push("identityHydrated"));

  // Listeners attached BEFORE ready resolves; lifecycle events are fired
  // inside `configure`, which the runtime drives synchronously enough that
  // listeners attached pre-await still see them.
  await sw.ready;

  expect(seen).toContain("identityHydrated");
  expect(seen).toContain("first_seen");
  expect(seen).toContain("session_start");
  expect(seen).toContain("app_launch");
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// setDelegate
// ---------------------------------------------------------------------------

test("setDelegate(null) detaches the active delegate", async () => {
  let count = 0;
  const delegate: SuperwallDelegate = {
    onSubscriptionStatusChange: () => count++,
  };
  const sw = make({ delegate });
  await sw.ready;

  sw.purchases.setSubscriptionStatus({ status: "INACTIVE" });
  await tick();
  expect(count).toBe(1);

  sw.setDelegate(null);
  await tick();
  sw.purchases.setSubscriptionStatus({ status: "UNKNOWN" });
  await tick();
  expect(count).toBe(1);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test("reset regenerates identity, clears subscription + paywall state", async () => {
  const sw = make();
  await sw.ready;
  await sw.user.identify("u1");
  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [
      { id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [] },
    ],
  });
  sw.user.setAttributes({ email: "x" } as never);
  await tick();

  const aliasBefore = sw.user.aliasId.value;

  await sw.reset();
  await tick();

  expect(sw.user.id.value).toBe("");
  expect(sw.user.aliasId.value).not.toBe(aliasBefore);
  expect(sw.subscriptionStatus.value.status).toBe("UNKNOWN");
  expect(sw.entitlements.active.value).toHaveLength(0);
  expect((sw.user.attributes.value as Record<string, unknown>).email).toBeUndefined();
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// placements.register — real impl (§2h-§2i)
// ---------------------------------------------------------------------------

import type {
  PaywallPresenter,
  PresentationContext,
} from "./presenter.ts";
import { PaywallAlreadyPresentedError, PresenterError } from "./errors.ts";
import type { PaywallInfo, PaywallResult } from "./types.ts";

const presenterThatResolves = (
  result: PaywallResult,
): PaywallPresenter & { presented: PaywallInfo[] } => {
  const presented: PaywallInfo[] = [];
  return {
    presented,
    present: async (info) => {
      presented.push(info);
      return result;
    },
    dismiss: () => {},
  };
};

test("register without a presenter returns { type: 'error', error: NoPresenterRegisteredError }", async () => {
  const sw = make();
  await sw.ready;
  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("error");
  if (r.type === "error") {
    expect(r.error).toBeInstanceOf(NoPresenterRegisteredError);
  }
  await sw.dispose();
});

test("register short-circuits with { type: 'entitled' } when subscription is ACTIVE; runs feature", async () => {
  const presenter = presenterThatResolves({ type: "purchased", productId: "x" });
  const sw = make({ presenter });
  await sw.ready;
  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
  });
  await tick();

  let featureRan = false;
  const r = await sw.placements.register({
    placement: "checkout",
    feature: () => {
      featureRan = true;
    },
  });
  expect(r.type).toBe("entitled");
  expect(featureRan).toBe(true);
  expect(presenter.presented).toHaveLength(0); // presenter never called
  await sw.dispose();
});

test("register presents, awaits result, fires lifecycle events + handler callbacks", async () => {
  const presenter = presenterThatResolves({ type: "purchased", productId: "p1" });
  const sw = make({ presenter });
  await sw.ready;

  const lifecycle: string[] = [];
  sw.events.addEventListener("paywall_open", () => lifecycle.push("open"));
  sw.events.addEventListener("paywall_close", () => lifecycle.push("close"));

  let onPresent: PaywallInfo | null = null;
  let onDismiss: { info: PaywallInfo; result: PaywallResult } | null = null;
  let featureRan = false;

  const r = await sw.placements.register({
    placement: "checkout",
    handler: {
      onPresent: (info) => {
        onPresent = info;
      },
      onDismiss: (info, result) => {
        onDismiss = { info, result };
      },
    },
    feature: () => {
      featureRan = true;
    },
  });

  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("stub_checkout");
    expect(r.result).toEqual({ type: "purchased", productId: "p1" });
  }
  expect(presenter.presented).toHaveLength(1);
  expect(lifecycle).toEqual(["open", "close"]);
  expect(onPresent).not.toBeNull();
  expect(onDismiss).not.toBeNull();
  expect(featureRan).toBe(true); // purchased → feature runs
  expect(sw.isPaywallPresented.value).toBe(false);
  await sw.dispose();
});

test("register: declined result on a (default-gated) paywall does NOT run feature", async () => {
  const presenter = presenterThatResolves({ type: "declined" });
  const sw = make({ presenter });
  await sw.ready;

  let featureRan = false;
  const r = await sw.placements.register({
    placement: "checkout",
    feature: () => {
      featureRan = true;
    },
  });

  expect(r.type).toBe("presented");
  expect(featureRan).toBe(false);
  await sw.dispose();
});

test("register enforces the single-paywall invariant — second call → PaywallAlreadyPresentedError", async () => {
  // Externally-controlled present() with a "started" signal so the test can
  // wait until the presenter has actually been invoked before triggering
  // the second register call (otherwise we race the runtime).
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  let resolveFirst!: (r: PaywallResult) => void;
  const slowPresenter: PaywallPresenter = {
    present: () => {
      resolveStarted();
      return new Promise<PaywallResult>((res) => {
        resolveFirst = res;
      });
    },
    dismiss: () => {},
  };
  const sw = make({ presenter: slowPresenter });
  await sw.ready;

  const first = sw.placements.register({ placement: "first" });
  await started; // presenter has been invoked → isPaywallPresented is true
  expect(sw.isPaywallPresented.value).toBe(true);

  // Second register collides.
  const second = await sw.placements.register({ placement: "second" });
  expect(second.type).toBe("error");
  if (second.type === "error") {
    expect(second.error).toBeInstanceOf(PaywallAlreadyPresentedError);
    const e = second.error as PaywallAlreadyPresentedError;
    expect(e.attemptedPlacement).toBe("second");
    expect(e.currentPaywallInfo.identifier).toBe("stub_first");
  }

  // Resolve the first to let it complete cleanly.
  resolveFirst({ type: "declined" });
  await first;
  await sw.dispose();
});

test("register: presenter throw → { type: 'error', error: PresenterError }, isPaywallPresented resets", async () => {
  const boom: PaywallPresenter = {
    present: () => {
      throw new Error("iframe gone");
    },
    dismiss: () => {},
  };
  const sw = make({ presenter: boom });
  await sw.ready;

  let onError: Error | null = null;
  const r = await sw.placements.register({
    placement: "checkout",
    handler: {
      onError: (e) => {
        onError = e;
      },
    },
  });

  expect(r.type).toBe("error");
  if (r.type === "error") {
    expect(r.error).toBeInstanceOf(PresenterError);
    expect(r.error.message).toContain("iframe gone");
  }
  expect(onError).not.toBeNull();
  expect(sw.isPaywallPresented.value).toBe(false); // cleaned up
  await sw.dispose();
});

test("register: presentation context exposes placement + params + signal + emit", async () => {
  let capturedCtx: PresentationContext | null = null;
  const presenter: PaywallPresenter = {
    present: async (_info, ctx) => {
      capturedCtx = ctx;
      return { type: "declined" };
    },
    dismiss: () => {},
  };
  const sw = make({ presenter });
  await sw.ready;

  await sw.placements.register({
    placement: "checkout",
    params: { screen: "home" } as never,
  });

  expect(capturedCtx).not.toBeNull();
  expect(capturedCtx!.placement).toBe("checkout");
  expect(capturedCtx!.params).toEqual({ screen: "home" } as never);
  expect(capturedCtx!.signal).toBeInstanceOf(AbortSignal);
  expect(typeof capturedCtx!.emit).toBe("function");
  await sw.dispose();
});

test("dismiss aborts the in-flight presentation and tells the presenter", async () => {
  let dismissCalls = 0;
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  const presenter: PaywallPresenter = {
    present: (_info, ctx) => {
      resolveStarted();
      return new Promise<PaywallResult>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    dismiss: () => {
      dismissCalls++;
    },
  };
  const sw = make({ presenter });
  await sw.ready;

  const reg = sw.placements.register({ placement: "checkout" });
  await started; // presenter invoked → currentAbort wired
  expect(sw.isPaywallPresented.value).toBe(true);

  sw.dismiss();
  const r = await reg;

  expect(dismissCalls).toBe(1);
  expect(r.type).toBe("error");
  expect(sw.isPaywallPresented.value).toBe(false);
  await sw.dispose();
});

test("getPresentationResult returns paywallNotAvailable until config processing lands", async () => {
  const sw = make();
  await sw.ready;
  const r = await sw.placements.getPresentationResult("x");
  expect(r).toEqual({ type: "paywallNotAvailable" });
  await sw.dispose();
});

test("confirmAllAssignments returns [] until experiments processing lands", async () => {
  const sw = make();
  await sw.ready;
  const r = await sw.placements.confirmAllAssignments();
  expect(r).toEqual([]);
  await sw.dispose();
});

test("preloadAll / preloadFor are no-ops without config (do not throw)", async () => {
  const sw = make();
  await sw.ready;
  await sw.placements.preloadAll();
  await sw.placements.preloadFor(["a", "b"]);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// dispose idempotence
// ---------------------------------------------------------------------------

test("dispose is idempotent + safe to call multiple times", async () => {
  const sw = make();
  await sw.ready;
  await sw.dispose();
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// enrichment (§11.6) — POST /api/v1/enrich on configure
// ---------------------------------------------------------------------------

import { STORAGE_KEYS } from "./types.ts";

const fetchRecorder = () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  let enrichmentResponder: () => Response | Promise<Response> = () =>
    new Response(
      JSON.stringify({ user: { server_field: "from_enrichment" }, device: {} }),
      { status: 200 },
    );
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body as string | undefined;
    calls.push({ url, body });
    if (url.includes("/api/v1/enrich")) return enrichmentResponder();
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch: impl,
    calls,
    setEnrichmentResponder: (r: () => Response | Promise<Response>) => {
      enrichmentResponder = r;
    },
  };
};

test("configure POSTs enrichment with current user attributes + merges response into the user signal", async () => {
  const { fetch, calls } = fetchRecorder();
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
  });
  // Set attributes BEFORE ready resolves so they're in the enrichment payload.
  sw.user.setAttributes({ email: "a@b.co" } as never);
  await sw.ready;
  await tick();

  const enrichmentCall = calls.find((c) => c.url.includes("/api/v1/enrich"));
  expect(enrichmentCall).toBeDefined();
  expect(JSON.parse(enrichmentCall!.body!)).toEqual({
    user: { email: "a@b.co" },
    device: {},
  });
  // Server-known field merged into the user attributes signal.
  expect((sw.user.attributes.value as { server_field?: string }).server_field).toBe(
    "from_enrichment",
  );
  await sw.dispose();
});

test("enrichment failure does NOT block sw.ready (emits enrichment_fail)", async () => {
  const { fetch, setEnrichmentResponder } = fetchRecorder();
  setEnrichmentResponder(() => new Response("nope", { status: 500 }));
  const sw = createSuperwall({ apiKey: "pk_test", fetch, storage: newAdapter() });

  let failCount = 0;
  sw.events.addEventListener("enrichment_fail", () => failCount++);

  // Should resolve, not reject.
  await sw.ready;
  await tick();

  expect(sw.isConfigured.value).toBe(true);
  expect(failCount).toBe(1);
  await sw.dispose();
});

test("configure emits enrichment_start + enrichment_complete around the network call", async () => {
  const { fetch } = fetchRecorder();
  const sw = createSuperwall({ apiKey: "pk_test", fetch, storage: newAdapter() });
  const order: string[] = [];
  sw.events.addEventListener("enrichment_start", () => order.push("start"));
  sw.events.addEventListener("enrichment_complete", () => order.push("complete"));
  await sw.ready;
  await tick();
  expect(order).toEqual(["start", "complete"]);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// Offline assignment cache
// ---------------------------------------------------------------------------

test("configure replays cached ConfirmedAssignment[] from storage", async () => {
  const adapter = newAdapter();
  // Seed the cache directly — simulates a return visit.
  await adapter.set(
    STORAGE_KEYS.assignments,
    JSON.stringify([
      { experimentId: "exp_1", variant: { id: "v_a", type: "treatment" } },
    ]),
  );
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  const cached = await sw.placements.confirmAllAssignments();
  expect(cached).toEqual([
    { experimentId: "exp_1", variant: { id: "v_a", type: "treatment" } },
  ]);
  await sw.dispose();
});

test("confirmAllAssignments returns [] when storage is empty (fresh install)", async () => {
  const sw = make();
  await sw.ready;
  expect(await sw.placements.confirmAllAssignments()).toEqual([]);
  await sw.dispose();
});

test("corrupt assignments cache is silently dropped (no throw)", async () => {
  const adapter = newAdapter();
  await adapter.set(STORAGE_KEYS.assignments, "{not json");
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  expect(await sw.placements.confirmAllAssignments()).toEqual([]);
  await sw.dispose();
});

test("reset() clears the assignments cache from both signal and storage", async () => {
  const adapter = newAdapter();
  await adapter.set(
    STORAGE_KEYS.assignments,
    JSON.stringify([{ experimentId: "x", variant: { id: "v", type: "holdout" } }]),
  );
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  expect((await sw.placements.confirmAllAssignments()).length).toBe(1);

  await sw.reset();
  await tick();
  expect(await sw.placements.confirmAllAssignments()).toEqual([]);
  expect(await adapter.get(STORAGE_KEYS.assignments)).toBeNull();
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// Restore state cache
// ---------------------------------------------------------------------------

test("purchases.restore() emits lifecycle events and persists lastRestoreAt", async () => {
  const adapter = newAdapter();
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;

  const order: string[] = [];
  sw.events.addEventListener("restore_start", () => order.push("start"));
  sw.events.addEventListener("restore_complete", () => order.push("complete"));

  const before = Date.now();
  await sw.purchases.restore();
  await tick();
  const after = Date.now();

  expect(order).toEqual(["start", "complete"]);

  const persisted = await adapter.get(STORAGE_KEYS.lastRestoreAt);
  expect(persisted).not.toBeNull();
  const ms = Number.parseInt(persisted!, 10);
  expect(ms).toBeGreaterThanOrEqual(before);
  expect(ms).toBeLessThanOrEqual(after);
  await sw.dispose();
});

test("configure replays lastRestoreAt from storage on a return visit", async () => {
  const adapter = newAdapter();
  await adapter.set(STORAGE_KEYS.lastRestoreAt, "1700000000000");
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  // The signal isn't on the public surface yet; verify via the next restore
  // overwriting it (proves the load path didn't crash).
  await sw.purchases.restore();
  await tick();
  const after = await adapter.get(STORAGE_KEYS.lastRestoreAt);
  expect(after).not.toBe("1700000000000");
  await sw.dispose();
});

test("reset() clears the lastRestoreAt cache from storage", async () => {
  const adapter = newAdapter();
  await adapter.set(STORAGE_KEYS.lastRestoreAt, "1700000000000");
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  await sw.reset();
  await tick();
  expect(await adapter.get(STORAGE_KEYS.lastRestoreAt)).toBeNull();
  await sw.dispose();
});
