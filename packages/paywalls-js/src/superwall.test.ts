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

/** Variant of `make()` that wires a fetch returning a minimal real config
 *  with a "checkout" placement → "pw_default" paywall. Used by tests that
 *  rely on register() actually presenting (formerly via the now-deleted
 *  stub fallback). */
const makeWithPaywall = (
  override: Partial<Parameters<typeof createSuperwall>[0]> = {},
): Superwall => {
  const fakeFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            build_id: "test_build",
            trigger_options: [
              {
                event_name: "checkout",
                rules: [
                  {
                    experiment_id: "exp_checkout",
                    experiment_group_id: "grp_test",
                    expression_cel: "",
                    variants: [
                      {
                        variant_id: "var_default",
                        variant_type: "TREATMENT",
                        percentage: 100,
                        paywall_identifier: "pw_default",
                      },
                    ],
                  },
                ],
              },
            ],
            paywall_responses: [
              {
                identifier: "pw_default",
                name: "Default",
                url: "https://paywalls.superwall.test/pw_default",
              },
            ],
            products: [
              {
                id: "pro_yearly",
                product_identifier: "pro_yearly",
                store: "stripe",
                entitlements: [{ id: "pro" }],
              },
            ],
            toggles: [],
            localization: { locales: [{ locale: "en-US" }] },
          }),
        ),
      );
    }
    if (url.includes("/api/v1/enrich")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user: {}, device: {} })),
      );
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;
  return createSuperwall({
    apiKey: "pk_test",
    fetch: fakeFetch,
    storage: newAdapter(),
    ...override,
  });
};

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

  // Listeners attached BEFORE ready resolves; lifecycle events are fired
  // inside `configure`, which the runtime drives synchronously enough that
  // listeners attached pre-await still see them.
  await sw.ready;

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
import type { PaywallInfo, PaywallResult, PaywallSkippedReason } from "./types.ts";

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
  const sw = makeWithPaywall();
  await sw.ready;
  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("error");
  if (r.type === "error") {
    expect(r.error).toBeInstanceOf(NoPresenterRegisteredError);
  }
  await sw.dispose();
});

test("register: ACTIVE subscription → skipped { type: 'userSubscribed' } and runs feature", async () => {
  // Mirrors Android `PaywallSkippedReason.UserIsSubscribed`: skip the
  // paywall, fire onSkip(reason), run feature.
  const presenter = presenterThatResolves({ type: "purchased", productId: "x" });
  const sw = make({ presenter });
  await sw.ready;
  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
  });
  await tick();

  let featureRan = false;
  let skipReason: PaywallSkippedReason | null = null;
  const r = await sw.placements.register({
    placement: "checkout",
    handler: { onSkip: (reason) => { skipReason = reason; } },
    feature: () => {
      featureRan = true;
    },
  });
  expect(r.type).toBe("skipped");
  if (r.type === "skipped") expect(r.reason.type).toBe("userSubscribed");
  expect(skipReason).toEqual({ type: "userSubscribed" });
  expect(featureRan).toBe(true);
  expect(presenter.presented).toHaveLength(0);
  await sw.dispose();
});

test("register presents, awaits result, fires lifecycle events + handler callbacks", async () => {
  const presenter = presenterThatResolves({ type: "purchased", productId: "p1" });
  const sw = makeWithPaywall({ presenter });
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
    expect(r.info.identifier).toBe("pw_default");
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

test("register: declined result on a config-driven nonGated paywall RUNS the feature", async () => {
  // Config carries `featureGatingBehavior: "nonGated"` on the paywall —
  // even when the user dismisses, the consumer's feature callback fires.
  // Mirrors Android `featureGatingBehavior` semantics.
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [
            {
              placementName: "checkout",
              rules: [
                {
                  expression: "",
                  experiment: {
                    id: "exp_x",
                    groupId: "grp",
                    variants: [
                      { id: "v_a", type: "treatment", paywallId: "pw_x" },
                    ],
                  },
                },
              ],
            },
          ],
          paywallResponses: [
            {
              identifier: "pw_x",
              url: "https://paywalls.superwall.test/pw_x",
              featureGatingBehavior: "nonGated",
            },
          ],
          products: [],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    if (url.includes("/api/v1/enrich"))
      return new Response(JSON.stringify({ user: {}, device: {} }));
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  let featureRan = false;
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter: {
      present: async () => ({ type: "declined" }),
      dismiss: () => {},
    },
  });
  await sw.ready;

  const r = await sw.placements.register({
    placement: "checkout",
    feature: () => {
      featureRan = true;
    },
  });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.featureGatingBehavior).toBe("nonGated");
    expect(r.result.type).toBe("declined");
  }
  expect(featureRan).toBe(true);
  await sw.dispose();
});

test("register: declined result on a config-driven gated paywall does NOT run feature", async () => {
  // Same setup as above but featureGatingBehavior: "gated" — feature must NOT fire.
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [
            {
              placementName: "checkout",
              rules: [
                {
                  expression: "",
                  experiment: {
                    id: "exp_x",
                    groupId: "grp",
                    variants: [
                      { id: "v_a", type: "treatment", paywallId: "pw_x" },
                    ],
                  },
                },
              ],
            },
          ],
          paywallResponses: [
            {
              identifier: "pw_x",
              url: "https://paywalls.superwall.test/pw_x",
              featureGatingBehavior: "gated",
            },
          ],
          products: [],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    if (url.includes("/api/v1/enrich"))
      return new Response(JSON.stringify({ user: {}, device: {} }));
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  let featureRan = false;
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter: {
      present: async () => ({ type: "declined" }),
      dismiss: () => {},
    },
  });
  await sw.ready;

  const r = await sw.placements.register({
    placement: "checkout",
    feature: () => {
      featureRan = true;
    },
  });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.featureGatingBehavior).toBe("gated");
  }
  expect(featureRan).toBe(false);
  await sw.dispose();
});

test("register: declined result on a (default-gated) paywall does NOT run feature", async () => {
  const presenter = presenterThatResolves({ type: "declined" });
  const sw = makeWithPaywall({ presenter });
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
  const sw = makeWithPaywall({ presenter: slowPresenter });
  await sw.ready;

  const first = sw.placements.register({ placement: "checkout" });
  await started; // presenter has been invoked → isPaywallPresented is true
  expect(sw.isPaywallPresented.value).toBe(true);

  // Second register collides regardless of placement.
  const second = await sw.placements.register({ placement: "checkout" });
  expect(second.type).toBe("error");
  if (second.type === "error") {
    expect(second.error).toBeInstanceOf(PaywallAlreadyPresentedError);
    const e = second.error as PaywallAlreadyPresentedError;
    expect(e.attemptedPlacement).toBe("checkout");
    expect(e.currentPaywallInfo.identifier).toBe("pw_default");
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
  const sw = makeWithPaywall({ presenter: boom });
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
  const sw = makeWithPaywall({ presenter });
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
  const sw = makeWithPaywall({ presenter });
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

test("getPresentationResult returns placementNotFound for placements not in config", async () => {
  // No real config response (noopFetch returns 204), so any placement
  // lookup misses → placementNotFound. When config processing returns a
  // matching trigger, the result will become `paywallNotAvailable` until
  // the audience-rule evaluator lands.
  const sw = make();
  await sw.ready;
  const r = await sw.placements.getPresentationResult("unknown_placement");
  expect(r).toEqual({ type: "placementNotFound" });
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
  const body = JSON.parse(enrichmentCall!.body!) as {
    user: Record<string, unknown>;
    device: Record<string, unknown>;
  };
  expect(body.user).toEqual({ email: "a@b.co" });
  // Spot-check a few canonical device-attribute fields. Full coverage of
  // every key is in `internal/deviceAttributes.test.ts`.
  expect(body.device.platform).toBe("Web");
  expect(body.device.publicApiKey).toBe("pk_test");
  expect(body.device.subscriptionStatus).toBe("UNKNOWN");
  expect(typeof body.device.timezoneOffset).toBe("number");
  expect(Array.isArray(body.device.aliases)).toBe(true);
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

// ---------------------------------------------------------------------------
// Delegate bridges — userAttributesDidChange + customerInfoDidChange
// ---------------------------------------------------------------------------

test("delegate.onUserAttributesChange fires when sw.user.setAttributes is called", async () => {
  const seen: Array<Partial<typeof sw.user.attributes.value>> = [];
  const sw = make({
    delegate: {
      onUserAttributesChange(next) {
        seen.push(next);
      },
    },
  });
  await sw.ready;
  await tick();
  // The merge from enrichment may have already fired once; clear the
  // sample window before our explicit setAttributes.
  const baseline = seen.length;

  sw.user.setAttributes({ email: "a@b.co" } as never);
  await tick();
  await tick();

  expect(seen.length).toBeGreaterThan(baseline);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// paywall_open_url + paywall_open_deep_link → delegate bridge
// ---------------------------------------------------------------------------

test("paywallWillOpenURL local event is delivered to the delegate", async () => {
  const captured: string[] = [];
  const sw = make({
    delegate: {
      onPaywallWillOpenURL(url) {
        captured.push(url);
      },
    },
  });
  await sw.ready;

  // Simulate the browser presenter forwarding `open_url`.
  sw.events.dispatchEvent(
    new CustomEvent("paywallWillOpenURL", {
      detail: { url: "https://help.example.com" },
    }),
  );
  await tick();

  expect(captured).toEqual(["https://help.example.com"]);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// Code-review fixes (regression coverage)
// ---------------------------------------------------------------------------

test("paywall_open with stub info does NOT POST to collector (P0-3)", async () => {
  const { fetch, calls } = fetchRecorder();
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "purchased", productId: "p1" }),
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;
  // Drain the configure-time enrichment call so the only "registered"
  // POSTs after register() are paywall_* events.
  const baseline = calls.length;

  await sw.placements.register({ placement: "checkout" });
  await tick();

  const newCalls = calls.slice(baseline);
  // No collector POST for paywall_* events on stub data.
  const collectorPosts = newCalls.filter((c) =>
    c.url.includes("/api/v1/events"),
  );
  // (transaction_start / transaction_complete may still post depending on
  // the presenter; we only assert paywall_open / paywall_close didn't.)
  for (const post of collectorPosts) {
    const parsed = JSON.parse(post.body!) as { events: Array<{ event_name: string }> };
    for (const e of parsed.events) {
      expect(e.event_name).not.toBe("paywall_open");
      expect(e.event_name).not.toBe("paywall_close");
      expect(e.event_name).not.toBe("paywall_decline");
    }
  }
  await sw.dispose();
});

test("paywall_decline fires on declined results (P1, parity with Android)", async () => {
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  let declineCount = 0;
  sw.events.addEventListener("paywall_decline", () => declineCount++);

  await sw.placements.register({ placement: "checkout" });
  await tick();

  expect(declineCount).toBe(1);
  await sw.dispose();
});

test("paywall_decline does NOT fire on purchased / restored results", async () => {
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "purchased", productId: "p" }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  let declineCount = 0;
  sw.events.addEventListener("paywall_decline", () => declineCount++);
  await sw.placements.register({ placement: "checkout" });
  await tick();
  expect(declineCount).toBe(0);
  await sw.dispose();
});

test("after declined dismiss, isPaywallPresented resets to false (regression for P0-2)", async () => {
  // Sanity test that the open-lifecycle try/finally + close-lifecycle path
  // both leave the SDK ready to register again. The P0-2 fix specifically
  // guards against `runtime.runPromise(open-lifecycle)` rejection — hard
  // to trigger deterministically without runtime injection — but the
  // happy path here proves the cleanup invariant the P0 fix preserves.
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  await sw.placements.register({ placement: "checkout" });
  await tick();
  expect(sw.isPaywallPresented.value).toBe(false);

  // Second register works (proves signal isn't stuck).
  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// Config-driven register pipeline (audience eval + variant lookup)
// ---------------------------------------------------------------------------

const configResponse = (overrides: Partial<{
  triggers: Array<{
    placementName: string;
    rules: Array<{ expression: string; variantType?: "treatment" | "holdout"; paywallId?: string }>;
  }>;
  paywalls: Array<{ identifier: string; name?: string; url?: string; productIds?: string[] }>;
}> = {}) => ({
  buildId: "test_build",
  triggerOptions: (overrides.triggers ?? []).map((t) => ({
    placementName: t.placementName,
    rules: t.rules.map((r, i) => ({
      expression: r.expression,
      experiment: {
        // Each rule needs its own experiment id — backend guarantees this.
        // The helper used to share `exp_<placement>` across rules; that
        // collided once eager assignment landed (one experimentId can only
        // resolve to one variant), so different rules masked each other.
        id: `exp_${t.placementName}_${i}`,
        groupId: "grp_test",
        variants: [
          {
            id: `var_${t.placementName}_${i}`,
            type: r.variantType ?? "treatment",
            paywallId: r.paywallId,
          },
        ],
      },
    })),
  })),
  paywallResponses: overrides.paywalls ?? [],
  products: [],
  toggles: [],
  localization: { locales: [{ locale: "en-US" }] },
});

const configFetchRecorder = (cfg: ReturnType<typeof configResponse>) => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/api/v1/static_config")) {
      return new Response(JSON.stringify(cfg), { status: 200 });
    }
    if (url.includes("/api/v1/enrich")) {
      return new Response(JSON.stringify({ user: {}, device: {} }), { status: 200 });
    }
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, calls };
};

test("register: empty audience matches → presents the config-driven paywall", async () => {
  const { fetch } = configFetchRecorder(
    configResponse({
      triggers: [
        {
          placementName: "checkout",
          rules: [{ expression: "", paywallId: "pw_pro" }],
        },
      ],
      paywalls: [
        {
          identifier: "pw_pro",
          name: "Pro Pricing",
          url: "https://paywalls.superwall.test/pw_pro",
          productIds: ["pro_yearly"],
        },
      ],
    }),
  );
  const presented: PaywallInfo[] = [];
  const presenter: PaywallPresenter = {
    present: async (info) => {
      presented.push(info);
      return { type: "purchased", productId: "pro_yearly" };
    },
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;

  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("pw_pro");
    expect(r.info.name).toBe("Pro Pricing");
    expect(r.info.experiment?.id).toBe("exp_checkout_0");
    expect(r.info.experiment?.variant.id).toBe("var_checkout_0");
  }
  expect(presented).toHaveLength(1);
  expect(presented[0]!.identifier).toBe("pw_pro"); // not stub_*
  await sw.dispose();
});

test("register: holdout variant → skipped { type: 'holdout', experiment }", async () => {
  const { fetch } = configFetchRecorder(
    configResponse({
      triggers: [
        {
          placementName: "checkout",
          rules: [
            {
              expression: "",
              variantType: "holdout",
              paywallId: "pw_pro",
            },
          ],
        },
      ],
    }),
  );
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;

  let onSkipCalls = 0;
  const r = await sw.placements.register({
    placement: "checkout",
    handler: { onSkip: () => onSkipCalls++ },
  });
  expect(r.type).toBe("skipped");
  if (r.type === "skipped") {
    expect(r.reason.type).toBe("holdout");
    if (r.reason.type === "holdout") {
      expect(r.reason.experiment.id).toBe("exp_checkout_0");
    }
  }
  expect(onSkipCalls).toBe(1);
  await sw.dispose();
});

test("register: placement not in config → skipped placementNotFound", async () => {
  const { fetch } = configFetchRecorder(
    configResponse({
      triggers: [{ placementName: "other", rules: [{ expression: "" }] }],
    }),
  );
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;

  let featureRan = false;
  const r = await sw.placements.register({
    placement: "checkout", // not in config
    feature: () => {
      featureRan = true;
    },
  });
  expect(r.type).toBe("skipped");
  if (r.type === "skipped") {
    expect(r.reason.type).toBe("placementNotFound");
  }
  // Skip → feature runs unconditionally (no gating paywall).
  expect(featureRan).toBe(true);
  await sw.dispose();
});

test("register: variant pick is sticky — same alias re-evaluates → same paywall", async () => {
  // Two-variant experiment with explicit 50/50; the alias-driven hash
  // bucket determines which one fires. Either way, BOTH register calls
  // should land on the same one.
  const { fetch } = configFetchRecorder({
    buildId: "test_build",
    triggerOptions: [
      {
        placementName: "checkout",
        rules: [
          {
            expression: "",
            experiment: {
              id: "exp_split",
              groupId: "grp",
              variants: [
                { id: "v_a", type: "treatment", paywallId: "pw_a", percentage: 50 },
                { id: "v_b", type: "treatment", paywallId: "pw_b", percentage: 50 },
              ],
            },
          },
        ],
      },
    ],
    paywallResponses: [
      { identifier: "pw_a", url: "https://paywalls.superwall.test/pw_a" },
      { identifier: "pw_b", url: "https://paywalls.superwall.test/pw_b" },
    ],
    products: [],
    toggles: [],
    localization: { locales: [{ locale: "en-US" }] },
  } as never);

  const presented: string[] = [];
  const presenter: PaywallPresenter = {
    present: async (info) => {
      presented.push(info.identifier);
      return { type: "declined" };
    },
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;

  await sw.placements.register({ placement: "checkout" });
  await sw.placements.register({ placement: "checkout" });
  await sw.placements.register({ placement: "checkout" });

  // All three calls hit the same paywall — sticky variant.
  expect(new Set(presented).size).toBe(1);

  // The chosen experiment is in the confirmed-assignments cache.
  const confirmed = await sw.placements.confirmAllAssignments();
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]!.experimentId).toBe("exp_split");

  await sw.dispose();
});

test("register: rule expression evaluates against user attributes via Superscript", async () => {
  const { fetch } = configFetchRecorder(
    configResponse({
      triggers: [
        {
          placementName: "checkout",
          rules: [
            {
              expression: "user.plan == 'pro'",
              paywallId: "pw_pro",
            },
            {
              expression: "user.plan == 'free'",
              paywallId: "pw_upsell",
            },
          ],
        },
      ],
      paywalls: [
        { identifier: "pw_pro", url: "https://paywalls.superwall.test/pw_pro" },
        { identifier: "pw_upsell", url: "https://paywalls.superwall.test/pw_upsell" },
      ],
    }),
  );
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter,
  });
  await sw.ready;

  // Set user attributes BEFORE register.
  sw.user.setAttributes({ plan: "free" } as never);
  await tick();

  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    // Second rule (`plan == "free"`) matched, so we present `pw_upsell`.
    expect(r.info.identifier).toBe("pw_upsell");
  }
  await sw.dispose();
});

test("paywallWillOpenDeepLink local event is delivered to the delegate", async () => {
  const captured: string[] = [];
  const sw = make({
    delegate: {
      onPaywallWillOpenDeepLink(url) {
        captured.push(url);
      },
    },
  });
  await sw.ready;

  sw.events.dispatchEvent(
    new CustomEvent("paywallWillOpenDeepLink", {
      detail: { url: "myapp://upgrade" },
    }),
  );
  await tick();

  expect(captured).toEqual(["myapp://upgrade"]);
  await sw.dispose();
});

test("configure: failing static_config fetch retries exactly once before giving up", async () => {
  // Android `ConfigState.kt:HandleFetchFailure` — single retry max.
  let configCalls = 0;
  const failingFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      configCalls++;
      return new Response("nope", { status: 500 });
    }
    if (url.includes("/api/v1/enrich")) {
      return new Response(JSON.stringify({ user: {}, device: {} }), { status: 200 });
    }
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;

  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: failingFetch,
    storage: newAdapter(),
  });
  await sw.ready;
  // Initial attempt + 1 retry == 2.
  expect(configCalls).toBe(2);
  await sw.dispose();
});

test("paywall post_checkout_complete flows through PurchaseController.purchase()", async () => {
  // Custom presenter that fires post_checkout_complete via ctx.onPurchaseEvent —
  // the terminal success signal from the paywall's WebPaywallController on the
  // `client_surface=web-sdk` branch.
  const fakePresenter: PaywallPresenter = {
    present: (_info, ctx) =>
      new Promise<PaywallResult>((resolve) => {
        queueMicrotask(() => {
          ctx.onPurchaseEvent?.({
            type: "postCheckout",
            productId: "pro_yearly",
            checkoutContextId: "ckctx_test",
          });
          setTimeout(() => resolve({ type: "purchased", productId: "pro_yearly" }), 5);
        });
      }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter: fakePresenter });
  await sw.ready;
  // Drive the controller-level purchase by calling sw.purchases.purchase()
  // and concurrently presenting a paywall that fires the complete event.
  // The controller subscribe wires both sides.
  const productPromise = sw.purchases.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  // Trigger a paywall presentation in parallel — this hooks the same
  // ctx.onPurchaseEvent the controller subscribes to.
  void sw.placements.register({ placement: "checkout" }).catch(() => {});
  const r = await productPromise;
  expect(r.type).toBe("purchased");
  expect(sw.subscriptionStatus.value.status).toBe("ACTIVE");
  await sw.dispose();
});

test("purchases.purchase: routes through PurchaseController + emits transaction lifecycle on success", async () => {
  // Custom controller that simulates a successful purchase synchronously.
  const customController = {
    purchase: async () => ({ type: "purchased" as const }),
    restorePurchases: async () => ({ type: "restored" as const }),
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: noopFetch,
    storage: newAdapter(),
    purchaseController: customController,
  });
  await sw.ready;

  const events: string[] = [];
  for (const name of [
    "transaction_start",
    "transaction_complete",
    "subscription_start",
  ]) {
    sw.events.addEventListener(name as never, () => events.push(name));
  }
  const r = await sw.purchases.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  expect(r.type).toBe("purchased");
  await tick();
  await tick();
  expect(events).toEqual([
    "transaction_start",
    "transaction_complete",
    "subscription_start",
  ]);
  await sw.dispose();
});

test("purchases.purchase: cancelled → transaction_abandon, no subscription_start", async () => {
  const customController = {
    purchase: async () => ({ type: "cancelled" as const }),
    restorePurchases: async () => ({ type: "restored" as const }),
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: noopFetch,
    storage: newAdapter(),
    purchaseController: customController,
  });
  await sw.ready;
  const events: string[] = [];
  for (const name of ["transaction_abandon", "subscription_start"]) {
    sw.events.addEventListener(name as never, () => events.push(name));
  }
  const r = await sw.purchases.purchase({
    id: "pro_yearly",
    store: "stripe",
    entitlements: [],
  });
  expect(r.type).toBe("declined");
  await tick();
  await tick();
  expect(events).toEqual(["transaction_abandon"]);
  await sw.dispose();
});

test("purchases.getProducts: returns config-derived products as Product[]", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [],
          paywallResponses: [],
          products: [
            {
              id: "pro_yearly",
              name: "Pro Yearly",
              store: "stripe",
              entitlements: [{ id: "pro" }],
            },
            { id: "no_entitlements" },
          ],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    if (url.includes("/api/v1/enrich"))
      return new Response(JSON.stringify({ user: {}, device: {} }));
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
  });
  await sw.ready;

  const products = await sw.purchases.getProducts();
  expect(products).toHaveLength(2);
  expect(products[0]!.id).toBe("pro_yearly");
  expect(products[0]!.name).toBe("Pro Yearly");
  expect(products[0]!.store).toBe("stripe");
  expect(products[0]!.entitlements).toEqual([
    { id: "pro", type: "SERVICE_LEVEL", isActive: false, productIds: ["pro_yearly"] },
  ]);
  expect(products[1]!.id).toBe("no_entitlements");
  expect(products[1]!.entitlements).toEqual([]);
  await sw.dispose();
});

test("purchases.getCustomerInfo: returns the current customerSig snapshot", async () => {
  const sw = make();
  await sw.ready;
  expect(await sw.purchases.getCustomerInfo()).toBeNull();
  // Once subscriptionStatus flips ACTIVE the customerSig still hasn't been
  // explicitly seeded — the method just mirrors the signal.
  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
  });
  expect(await sw.purchases.getCustomerInfo()).toBe(sw.customerInfo.value);
  await sw.dispose();
});

test("logger: failures inside delegate callbacks are surfaced via onLog instead of silently swallowed", async () => {
  const logs: Array<{ scope: string; message: string; error: string | null }> = [];
  const delegate: SuperwallDelegate = {
    onLog: (_level, scope, message, _info, error) => {
      logs.push({ scope, message, error });
    },
    onUserAttributesChange: () => {
      throw new Error("delegate boom");
    },
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: noopFetch,
    storage: newAdapter(),
    delegate,
    options: { logging: { level: "warn" } },
  });
  await sw.ready;
  // Trigger the delegate hook by mutating user attributes.
  sw.user.setAttributes({ plan: "free" } as never);
  // Two ticks: signal flush → delegate fire → caught error → logger.warn → onLog.
  await tick();
  await tick();
  await tick();

  const captured = logs.find((l) =>
    l.message.includes("onUserAttributesChange threw"),
  );
  expect(captured).toBeDefined();
  expect(captured!.scope).toBe("superwallCore");
  expect(captured!.error).toContain("delegate boom");
  await sw.dispose();
});

test("counters: firstSeenAt bootstrapped on first run + totalPaywallViews increments on paywall_open", async () => {
  const adapter = newAdapter();
  const captured: Array<Record<string, unknown>> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/enrich")) {
      // Capture the device payload sent on each enrichment POST.
      const body = JSON.parse(init?.body as string) as {
        device: Record<string, unknown>;
      };
      captured.push(body.device);
      return new Response(JSON.stringify({ user: {}, device: {} }));
    }
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [],
          paywallResponses: [],
          products: [],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  // First run — firstSeenAt should be bootstrapped + persisted.
  const sw1 = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: adapter,
  });
  await sw1.ready;
  expect(typeof captured[0]!.appInstallDate).toBe("string");
  expect(captured[0]!.appInstallDate).not.toBe("");
  expect(captured[0]!.totalPaywallViews).toBe(0);
  const firstSeenISO = captured[0]!.appInstallDate as string;
  await sw1.dispose();

  // Second run with the same storage — firstSeenAt should match (not regenerated).
  // Cache-hot path fires revalidation in the background, so wait for the
  // enrichment to land before asserting.
  const sw2 = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: adapter,
  });
  await sw2.ready;
  for (let i = 0; i < 100 && captured.length < 2; i++) {
    await tick();
  }
  expect(captured[1]!.appInstallDate).toBe(firstSeenISO);
  await sw2.dispose();
});

test("entitlements.byProductIds: returns config-derived entitlements before any purchase", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [],
          paywallResponses: [],
          products: [
            { id: "pro_yearly", entitlements: [{ id: "pro" }] },
            { id: "vip", entitlements: [{ id: "pro" }, { id: "vip_only" }] },
          ],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    if (url.includes("/api/v1/enrich"))
      return new Response(JSON.stringify({ user: {}, device: {} }));
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
  });
  await sw.ready;

  const proOnly = sw.entitlements.byProductIds(["pro_yearly"]);
  expect(proOnly.map((e) => e.id)).toEqual(["pro"]);
  expect(proOnly[0]!.isActive).toBe(false); // not purchased

  const vipBundle = sw.entitlements.byProductIds(["vip"]);
  expect(vipBundle.map((e) => e.id).sort()).toEqual(["pro", "vip_only"]);

  // Unknown productId → empty.
  expect(sw.entitlements.byProductIds(["nope"])).toEqual([]);
  await sw.dispose();
});

test("configure: POSTs confirm_assignments after eager assignment", async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          buildId: "b1",
          triggerOptions: [
            {
              placementName: "checkout",
              rules: [
                {
                  expression: "",
                  experiment: {
                    id: "exp_checkout_0",
                    groupId: "grp",
                    variants: [
                      { id: "v_a", type: "treatment", paywallId: "pw_a" },
                    ],
                  },
                },
              ],
            },
          ],
          paywallResponses: [],
          products: [],
          toggles: [],
          localization: { locales: [{ locale: "en-US" }] },
        }),
      );
    }
    if (url.includes("/api/v1/enrich"))
      return new Response(JSON.stringify({ user: {}, device: {} }));
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
  });
  await sw.ready;

  const confirmCall = calls.find((c) =>
    c.url.includes("/api/v1/confirm_assignments"),
  );
  expect(confirmCall).toBeDefined();
  const body = JSON.parse(confirmCall!.body!) as {
    assignments: Array<{
      experimentId: string;
      variant: { id: string; type: string };
    }>;
  };
  expect(body.assignments).toHaveLength(1);
  expect(body.assignments[0]).toEqual({
    experimentId: "exp_checkout_0",
    variant: { id: "v_a", type: "treatment" },
  });
  await sw.dispose();
});

test("refreshConfiguration: re-fetches static_config and re-runs eager assignment", async () => {
  let configCalls = 0;
  const buildConfig = (buildId: string) =>
    JSON.stringify({
      buildId,
      triggerOptions: [
        {
          placementName: "checkout",
          rules: [
            {
              expression: "",
              experiment: {
                id: "exp_checkout_0",
                groupId: "grp_test",
                variants: [
                  {
                    id: `var_${buildId}`,
                    type: "treatment",
                    paywallId: `pw_${buildId}`,
                  },
                ],
              },
            },
          ],
        },
      ],
      paywallResponses: [
        {
          identifier: `pw_${buildId}`,
          url: `https://paywalls.superwall.test/pw_${buildId}`,
        },
      ],
      products: [],
      toggles: [],
      localization: { locales: [{ locale: "en-US" }] },
    });

  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      configCalls++;
      return new Response(buildConfig(configCalls === 1 ? "v1" : "v2"));
    }
    if (url.includes("/api/v1/enrich")) {
      return new Response(JSON.stringify({ user: {}, device: {} }));
    }
    return new Response("", { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch,
    storage: newAdapter(),
    presenter: {
      present: async () => ({ type: "declined" }),
      dismiss: () => {},
    },
  });
  await sw.ready;
  expect(configCalls).toBe(1);

  await sw.refreshConfiguration();
  expect(configCalls).toBe(2);

  // The fresh config carries pw_v2; verify register hits it.
  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("pw_v2");
  }
  await sw.dispose();
});

test("configure: cached config makes sw.ready resolve before a hanging fetch — register() can fire against cache", async () => {
  // Pre-seed storage with a cached config carrying the enableConfigRefresh
  // toggle. On configure(), the fetch deadline should fire (1s) and the
  // cached config stays in place — `register()` must resolve to the
  // cached paywall, not paywallNotAvailable.
  const cachedPayload = {
    buildId: "cached_build",
    triggerOptions: [
      {
        placementName: "checkout",
        rules: [
          {
            expression: "",
            experiment: {
              id: "exp_cached",
              groupId: "grp_cached",
              variants: [
                { id: "var_cached", type: "treatment", paywallId: "pw_cached" },
              ],
            },
          },
        ],
      },
    ],
    paywallResponses: [
      { identifier: "pw_cached", url: "https://paywalls.superwall.test/pw_cached" },
    ],
    products: [],
    toggles: [{ key: "enableConfigRefresh", enabled: true }],
    localization: { locales: [{ locale: "en-US" }] },
  };
  const adapter = newAdapter();
  adapter.set(
    "superwall.config",
    JSON.stringify({ buildId: "cached_build", payload: cachedPayload }),
  );

  // fetch that hangs for static_config; resolves enrichment fast.
  const hangingFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Promise<Response>(() => {
        /* never resolves */
      });
    }
    if (url.includes("/api/v1/enrich")) {
      return new Response(JSON.stringify({ user: {}, device: {} }), { status: 200 });
    }
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;

  const presented: string[] = [];
  const presenter: PaywallPresenter = {
    present: async (info) => {
      presented.push(info.identifier);
      return { type: "declined" };
    },
    dismiss: () => {},
  };
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: hangingFetch,
    storage: adapter,
    presenter,
  });

  const t0 = Date.now();
  await sw.ready;
  const elapsed = Date.now() - t0;
  // Deadline is 1s (sub status UNKNOWN, not ACTIVE). Allow generous slack
  // for CI variance but make sure we didn't hang.
  expect(elapsed).toBeLessThan(2500);

  const r = await sw.placements.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("pw_cached");
  }
  await sw.dispose();
});
