import { it, expect } from "@effect/vitest";
import {
  createSuperwall as _createSuperwall,
  NoPresenterRegisteredError,
  NotConfiguredError,
  type PlacementParams,
  type StorageAdapter,
  type SubscriptionStatus,
  type Superwall,
  type SuperwallDelegate,
} from "./index.ts";

// The public API no longer takes a create-time `presenter` — presenters are
// resolved per `register()` call (override > custom paywall > default
// browser). Tests historically injected a fake presenter at construction;
// this shim preserves that ergonomic by stripping `presenter` and wrapping
// `register` to inject it, so every `createSuperwall({ presenter })` call
// site keeps working while exercising the real register-level path.
const createSuperwall = (
  options: Parameters<typeof _createSuperwall>[0] & {
    presenter?: import("./presenter.ts").PaywallPresenter;
  },
): Superwall => {
  const { presenter, ...rest } = options;
  const sw = _createSuperwall(rest);
  if (presenter) {
    const orig = sw.register.bind(sw);
    (sw as { register: Superwall["register"] }).register = (args) =>
      orig({ presenter, ...args });
  }
  return sw;
};

const tick = () => new Promise<void>((r) => queueMicrotask(r));

// `sw.purchases.purchase()` is hidden from the public API for now (it only
// resolves while a paywall presents). The skipped purchase tests below still
// reference the internal behavior through this cast — drop it when the method
// is re-exposed on PurchasesNamespace.
const hiddenPurchase = (
  sw: Superwall,
  product: { id: string; store: string; entitlements: unknown[] },
): Promise<{ type: string }> =>
  (
    sw.purchases as unknown as {
      purchase: (p: typeof product) => Promise<{ type: string }>;
    }
  ).purchase(product);

const EMPTY_STATIC_CONFIG = JSON.stringify({
  build_id: "test_build",
  trigger_options: [],
  paywall_responses: [],
  products: [],
  toggles: [],
});

// Default fetch for tests that don't exercise the network: returns a valid
// empty static_config so configure() flips to "configured", and 204 for
// everything else.
import { buildInitPayload } from "./superwall.ts";

it("buildInitPayload includes all controller-required slices + resolveVariables:true", () => {
  const payload = buildInitPayload({
    info: {
      identifier: "pw_init",
      name: "Init Test",
      url: "https://user-content.test/runtime/x",
      productIds: ["price_1", "price_2"],
      products: [],
      productsV2: [
        {
          sw_composite_product_id: "stripe:price_1",
          reference_name: "primary",
          store_product: {
            store: "STRIPE",
            product_identifier: "price_1",
            trial_days: 7,
          },
        },
      ],
      backgroundColorHex: "#ffffff",
      darkBackgroundColorHex: "#000000",
    },
    placement: "checkout",
    params: { src: "home" } as PlacementParams,
    decision: {
      kind: "paywall",
      experiment: {
        id: "exp_1",
        groupId: "grp_1",
        variant: { id: "var_1", type: "treatment", paywallId: "pw_init" },
      },
    },
    application: { name: "Acme", iconUrl: "https://cdn/acme.png" },
    bootstrap: {
      apiKey: "pk_test",
      sdkVersion: "1.0.0",
      collector: "https://collector.superwall.com",
      apiBase: "https://api.superwall.me",
      clientSurface: "web-sdk",
      hostOrigin: "https://merchant.test",
      cancelUrl: "https://merchant.test/cancel",
    },
    aliasId: "$SuperwallAlias:abc",
    appUserId: undefined,
    deviceId: "11111111-1111-1111-1111-111111111111",
    email: undefined,
    userAttributes: { plan: "free" },
    deviceAttributes: { deviceLocale: "en-US", appVersion: "1.0.0" },
  });
  // Top-level shape
  expect(payload["placementSessionToken"]).toBe("pk_test");
  expect(payload["resolveVariables"]).toBe(true);
  expect(payload["transactionAbandon"]).toBeNull();
  expect(payload["integrations"]).toEqual([]);
  expect(payload["isFirstAssignment"]).toBe(false);
  expect(payload["application"]).toEqual({
    name: "Acme",
    iconUrl: "https://cdn/acme.png",
  });
  expect(payload["backgroundColorHex"]).toEqual({
    light: "#ffffff",
    dark: "#000000",
  });
  expect(Array.isArray(payload["products"])).toBe(true);
  expect((payload["products"] as unknown[]).length).toBe(1);
  // Collector slices
  const c = payload["collector"] as Record<string, unknown>;
  // Events route through the paywall app's CORS-enabled proxy, built
  // absolute against `apiBase` so it follows whatever host the iframe
  // controller is configured against.
  expect((c["url"] as string)).toBe("https://api.superwall.me/api/proxy/events");
  expect(c["headers"]).toMatchObject({
    "x-public-api-key": "pk_test",
    "x-device-id": "11111111-1111-1111-1111-111111111111",
    "x-platform": "web",
    "x-sdk-version": "1.0.0",
  });
  expect((c["placementEventId"] as string).length).toBeGreaterThan(0);
  expect((c["identity"] as { userId: { type: string } }).userId.type).toBe(
    "aliasId",
  );
  expect(c["experimentSlice"]).toEqual({
    experimentId: "exp_1",
    variantId: "var_1",
  });
  expect(c["paywallSlice"]).toMatchObject({
    paywallId: "pw_init",
    paywallProductIds: "price_1,price_2",
    paywallUrl: "https://user-content.test/runtime/x",
  });
  expect((c["presentmentSlice"] as { isFreeTrialAvailable: boolean }).isFreeTrialAvailable).toBe(true);
  expect((c["presentmentSlice"] as { presentationSourceType: string }).presentationSourceType).toBe("register");
  expect((c["presentmentSlice"] as { presentedBy: string }).presentedBy).toBe("placement");
  expect(c["placementParamsSlice"]).toEqual({ placementParams: { src: "home" } });
  expect(c["productSlice"]).toEqual({});
  // CheckoutContext
  const cc = payload["checkoutContext"] as Record<string, unknown>;
  expect(cc["paywall"]).toMatchObject({ paywallId: "pw_init" });
  expect(cc["experiment"]).toEqual({ experimentId: "exp_1", variantId: "var_1" });
  expect((cc["identity"] as { userId: { type: string } }).userId.type).toBe(
    "aliasId",
  );
  expect(cc["products"]).toEqual({});
});

const noopFetch = ((input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/v1/static_config")) {
    return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
  }
  return Promise.resolve(new Response("", { status: 204 }));
}) as unknown as typeof fetch;

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
/** Minimal real static_config with a "checkout" placement → "pw_default"
 *  paywall. Shared by makeWithPaywall + tests that need a recording fetch. */
const CHECKOUT_STATIC_CONFIG = {
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
      sw_composite_product_id: "pro_yearly",
      store_product: {
        store: "STRIPE",
        product_identifier: "pro_yearly",
      },
      entitlements: [{ identifier: "pro", type: "SERVICE_LEVEL" }],
    },
  ],
  toggles: [],
  localization: { locales: [{ locale: "en-US" }] },
};

const makeWithPaywall = (
  override: Partial<Parameters<typeof createSuperwall>[0]> = {},
): Superwall => {
  const fakeFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return Promise.resolve(new Response(JSON.stringify(CHECKOUT_STATIC_CONFIG)));
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

it("createSuperwall returns an instance synchronously", () => {
  const sw = make();
  expect(sw.apiKey).toBe("pk_test");
  expect(sw.ready).toBeInstanceOf(Promise);
  expect(sw.events).toBeDefined();
  expect(sw.user).toBeDefined();
});

it("sw.ready resolves once identity hydrates and lifecycle events fire", async () => {
  const sw = make();
  await sw.ready;
  expect(sw.isConfigured.value).toBe(true);
  expect(sw.configurationStatus.value).toBe("configured");
  await sw.dispose();
});

it("subscriptionStatus is persisted and replayed on reopen (shared storage)", async () => {
  const adapter = newAdapter();
  // First session: go ACTIVE, then dispose (simulates closing the tab).
  const sw1 = make({ storage: adapter });
  await sw1.ready;
  sw1.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["p"] }],
  });
  await tick();
  expect(await adapter.get("superwall.subscriptionStatus")).toContain("ACTIVE");
  await sw1.dispose();

  // Second session with the SAME storage: status replays from cache
  // immediately on ready (not UNKNOWN).
  const sw2 = make({ storage: adapter });
  await sw2.ready;
  expect(sw2.subscriptionStatus.value.status).toBe("ACTIVE");
  await sw2.dispose();
});

it("reset() clears the cached subscriptionStatus so it doesn't replay", async () => {
  const adapter = newAdapter();
  const sw1 = make({ storage: adapter });
  await sw1.ready;
  sw1.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["p"] }],
  });
  await tick();
  await sw1.reset();
  await tick();
  expect(await adapter.get("superwall.subscriptionStatus")).toBeNull();
  await sw1.dispose();

  const sw2 = make({ storage: adapter });
  await sw2.ready;
  expect(sw2.subscriptionStatus.value.status).toBe("UNKNOWN");
  await sw2.dispose();
});

it("reset() re-checks entitlements for the new identity → UNKNOWN resolves to INACTIVE", async () => {
  // Entitlements endpoint returns a valid empty set → the post-reset
  // re-check should flip UNKNOWN → INACTIVE (not leave it UNKNOWN).
  const entFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
    }
    if (url.includes("/entitlements")) {
      return Promise.resolve(
        new Response(JSON.stringify({ entitlements: [], customerInfo: { entitlements: [] } })),
      );
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;

  const sw = make({ fetch: entFetch });
  await sw.ready;
  // Seed an ACTIVE status, then reset.
  sw.purchases.setSubscriptionStatus({
    status: "ACTIVE",
    entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["p"] }],
  });
  await tick();
  await sw.reset();
  // reset awaits onConfigured → immediate /entitlements refresh → INACTIVE.
  await tick();
  await new Promise<void>((r) => setTimeout(r, 10));
  expect(sw.subscriptionStatus.value.status).toBe("INACTIVE");
  await sw.dispose();
});

it("identity hydration writes alias + vendor + device into the storage adapter", async () => {
  const adapter = newAdapter();
  const sw = make({ storage: adapter });
  await sw.ready;
  expect(await adapter.get("superwall.aliasId")).toMatch(/^\$SuperwallAlias:/);
  expect(await adapter.get("superwall.vendorId")).toBeTruthy();
  expect(await adapter.get("superwall.deviceId")).toMatch(/^[0-9a-f]{16}$/);
  await sw.dispose();
});

it("seeded identity values are picked up + persisted", async () => {
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

it("identify updates id / effectiveId / isLoggedIn signals", async () => {
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

it("signOut clears the userId but keeps the alias", async () => {
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

it("identify() triggers a background /entitlements refresh when the user ID changes", async () => {
  let entitlementsCalls = 0;
  const entFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config"))
      return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
    if (url.includes("/entitlements")) {
      entitlementsCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ entitlements: [], customerInfo: { entitlements: [] } })),
      );
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;

  const sw = make({ fetch: entFetch });
  await sw.ready;
  // onConfigured fires once at startup
  const callsAfterConfigure = entitlementsCalls;

  // Identifying as a new user should trigger a background refresh
  await sw.user.identify("user_new");
  await new Promise<void>((r) => setTimeout(r, 20));
  expect(entitlementsCalls).toBeGreaterThan(callsAfterConfigure);

  // Identifying with the same ID again should NOT trigger another refresh
  const callsAfterFirst = entitlementsCalls;
  await sw.user.identify("user_new");
  await new Promise<void>((r) => setTimeout(r, 20));
  expect(entitlementsCalls).toBe(callsAfterFirst);

  await sw.dispose();
});

it("identify({ restorePaywallAssignments: true }) re-fetches config before resolving", async () => {
  let configCalls = 0;
  const countingFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      configCalls++;
      return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;

  const sw = make({ fetch: countingFetch });
  await sw.ready;
  const callsAfterConfigure = configCalls;

  // Without the option: no config re-fetch.
  await sw.user.identify("user_plain");
  expect(configCalls).toBe(callsAfterConfigure);

  // With the option: identify() blocks on a fresh config fetch + re-assign.
  await sw.user.identify("user_restored", { restorePaywallAssignments: true });
  expect(configCalls).toBe(callsAfterConfigure + 1);

  // The Assignments pending gate must have drained — register() paths that
  // await phase=Ready would hang otherwise. getPresentationResult exercises
  // the config read-side without needing a presenter.
  const result = await sw.placements.getPresentationResult("nonexistent");
  expect(result.type).toBe("placementNotFound");
  await sw.dispose();
});

it("customPaywallAction event bridges to delegate.onCustomPaywallAction", async () => {
  const actions: string[] = [];
  const sw = make({
    delegate: { onCustomPaywallAction: (name) => actions.push(name) },
  });
  await sw.ready;

  sw.events.dispatchEvent(
    new CustomEvent("customPaywallAction", { detail: { name: "contact_support" } }),
  );
  await tick();
  await tick();
  expect(actions).toEqual(["contact_support"]);
  await sw.dispose();
});

it("setAttributes merges into the attributes signal", async () => {
  const sw = make();
  await sw.ready;
  sw.user.setAttributes({ email: "a@b.co" } as Partial<typeof sw.user.attributes.value>);
  expect((sw.user.attributes.value as { email?: string }).email).toBe("a@b.co");
  await sw.dispose();
});

it("setIntegrationAttribute writes + null clears", async () => {
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

it("setSubscriptionStatus updates subscriptionStatus + entitlements + fires delegate", async () => {
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
// entitlements token (for @superwall/verify) surfaced from /entitlements
// ---------------------------------------------------------------------------

/** Poll a predicate across macrotasks until true or a short timeout — the
 *  onConfigured `/entitlements` refresh is fire-and-forget, so we can't count
 *  ticks deterministically. */
const waitFor = async (pred: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
};

/** Fetch that serves the entitlements endpoint with a configurable body. */
const entitlementsFetch = (
  bodyForEntitlements: () => Record<string, unknown>,
): typeof fetch =>
  ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config"))
      return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
    if (url.includes("/api/v1/enrich"))
      return Promise.resolve(new Response(JSON.stringify({ user: {}, device: {} })));
    if (url.includes("/entitlements"))
      return Promise.resolve(
        new Response(JSON.stringify(bodyForEntitlements())),
      );
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;

it("surfaces entitlementsToken from /entitlements via getter + readable", async () => {
  const sw = make({
    fetch: entitlementsFetch(() => ({
      entitlements: [{ id: "pro", isActive: true }],
      entitlementsToken: "tok_abc",
    })),
  });
  await sw.ready;

  await waitFor(() => sw.purchases.getEntitlementsToken() === "tok_abc");
  expect(sw.entitlementsToken.value).toBe("tok_abc");
  await sw.dispose();
});

it("entitlementsToken is null when the backend omits it (best-effort)", async () => {
  const sw = make({
    fetch: entitlementsFetch(() => ({
      entitlements: [{ id: "pro", isActive: true }],
    })),
  });
  await sw.ready;

  // Let the onConfigured refresh settle; token must stay null, not throw.
  await waitFor(() => sw.subscriptionStatus.value.status === "ACTIVE");
  expect(sw.purchases.getEntitlementsToken()).toBeNull();
  await sw.dispose();
});

it("reset() clears the entitlements token", async () => {
  const sw = make({
    fetch: entitlementsFetch(() => ({
      entitlements: [{ id: "pro", isActive: true }],
      entitlementsToken: "tok_abc",
    })),
  });
  await sw.ready;
  await waitFor(() => sw.purchases.getEntitlementsToken() === "tok_abc");

  await sw.reset();
  await tick();
  expect(sw.purchases.getEntitlementsToken()).toBeNull();
  expect(sw.entitlementsToken.value).toBeNull();
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// customerInfo — populated from /entitlements reads
// ---------------------------------------------------------------------------

it("/entitlements refresh populates customerInfo (readable + getCustomerInfo)", async () => {
  const sw = make({
    fetch: entitlementsFetch(() => ({
      customerInfo: {
        entitlements: [
          { identifier: "pro", isActive: true, productIds: ["pro_yearly"] },
          { identifier: "plus", isActive: false, productIds: ["plus_monthly"] },
        ],
      },
    })),
  });
  await sw.ready;

  await waitFor(() => sw.customerInfo.value !== null);
  const info = sw.customerInfo.value!;
  expect(info.userId).toBe(sw.user.effectiveId.value);
  expect(info.entitlements).toEqual([
    { id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["pro_yearly"] },
    { id: "plus", type: "SERVICE_LEVEL", isActive: false, productIds: ["plus_monthly"] },
  ]);
  // No transaction history on the web wire shape yet.
  expect(info.subscriptions).toEqual([]);
  expect(info.nonSubscriptions).toEqual([]);
  expect(await sw.purchases.getCustomerInfo()).toBe(info);
  await sw.dispose();
});

it("entitlements.active/inactive/all derive from status + customerInfo", async () => {
  const sw = make({
    fetch: entitlementsFetch(() => ({
      customerInfo: {
        entitlements: [
          { identifier: "pro", isActive: true, productIds: ["pro_yearly"] },
          { identifier: "plus", isActive: false, productIds: ["plus_monthly"] },
        ],
      },
    })),
  });
  await sw.ready;

  await waitFor(
    () =>
      sw.entitlements.active.value.length === 1 &&
      sw.entitlements.inactive.value.length === 1,
  );
  expect(sw.entitlements.active.value.map((e) => e.id)).toEqual(["pro"]);
  expect(sw.entitlements.inactive.value).toEqual([
    { id: "plus", type: "SERVICE_LEVEL", isActive: false, productIds: ["plus_monthly"] },
  ]);
  expect(sw.entitlements.all.value.map((e) => e.id)).toEqual(["pro", "plus"]);

  // byProductIds surfaces the real inactive entitlement, not a config stub.
  const byProduct = sw.entitlements.byProductIds(["plus_monthly"]);
  expect(byProduct).toEqual([
    { id: "plus", type: "SERVICE_LEVEL", isActive: false, productIds: ["plus_monthly"] },
  ]);
  await sw.dispose();
});

it("refreshCustomerInfo() forces a read and reconciles status + snapshot", async () => {
  let active = false;
  const sw = make({
    fetch: entitlementsFetch(() => ({
      customerInfo: {
        entitlements: active ? [{ identifier: "pro", isActive: true }] : [],
      },
    })),
  });
  await sw.ready;
  await waitFor(() => sw.subscriptionStatus.value.status === "INACTIVE");

  // Backend state changes out-of-band; a manual refresh must pick it up
  // without waiting for the 10-min poll.
  active = true;
  const info = await sw.purchases.refreshCustomerInfo();
  expect(info).not.toBeNull();
  expect(info!.entitlements.map((e) => e.id)).toEqual(["pro"]);
  expect(sw.customerInfo.value).toBe(info);
  expect(sw.subscriptionStatus.value.status).toBe("ACTIVE");
  await sw.dispose();
});

it("refreshCustomerInfo() resolves with the prior snapshot when the read fails", async () => {
  let fail = false;
  const failableFetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config"))
      return Promise.resolve(new Response(EMPTY_STATIC_CONFIG));
    if (url.includes("/entitlements")) {
      if (fail) return Promise.resolve(new Response("", { status: 500 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            customerInfo: { entitlements: [{ identifier: "pro", isActive: true }] },
          }),
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;

  const sw = make({ fetch: failableFetch });
  await sw.ready;
  await waitFor(() => sw.customerInfo.value !== null);
  const before = sw.customerInfo.value;

  fail = true;
  // Must resolve (not reject) and leave prior state intact.
  const info = await sw.purchases.refreshCustomerInfo();
  expect(info).toBe(before);
  expect(sw.subscriptionStatus.value.status).toBe("ACTIVE");
  await sw.dispose();
});

it("onCustomerInfoChange fires on a change between two non-null snapshots", async () => {
  let active = false;
  const changes: Array<[string[], string[]]> = [];
  const sw = make({
    fetch: entitlementsFetch(() => ({
      customerInfo: {
        entitlements: active ? [{ identifier: "pro", isActive: true }] : [],
      },
    })),
    delegate: {
      onCustomerInfoChange: (from, to) => {
        changes.push([
          from.entitlements.map((e) => e.id),
          to.entitlements.map((e) => e.id),
        ]);
      },
    },
  });
  await sw.ready;
  await waitFor(() => sw.customerInfo.value !== null);

  active = true;
  await sw.purchases.refreshCustomerInfo();
  await waitFor(() => changes.length === 1);
  expect(changes[0]).toEqual([[], ["pro"]]);

  // Identical set re-applied (poll semantics) → deduped, no second call.
  await sw.purchases.refreshCustomerInfo();
  await tick();
  expect(changes).toHaveLength(1);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

it("sw.events receives the lifecycle events fired during configure", async () => {
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

it("setDelegate(null) detaches the active delegate", async () => {
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

it("reset regenerates identity, clears subscription + paywall state", async () => {
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
// register — real impl (§2h-§2i)
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

it("register with no DOM + no presenter returns NoPresenterRegisteredError", async () => {
  // With a DOM, no-presenter falls back to the default browser presenter.
  // Without one (SSR / headless), there's nothing to present → error.
  const realDoc = (globalThis as { document?: unknown }).document;
  delete (globalThis as { document?: unknown }).document;
  try {
    const sw = makeWithPaywall();
    await sw.ready;
    const r = await sw.register({ placement: "checkout" });
    expect(r.type).toBe("error");
    if (r.type === "error") {
      expect(r.error).toBeInstanceOf(NoPresenterRegisteredError);
    }
    await sw.dispose();
  } finally {
    (globalThis as { document?: unknown }).document = realDoc;
  }
});

it("register with a per-call presenter override uses it (no create-time presenter)", async () => {
  const presenter = presenterThatResolves({ type: "purchased", productId: "pro_yearly" });
  const sw = makeWithPaywall(); // no presenter at construction
  await sw.ready;
  const r = await sw.register({ placement: "checkout", presenter });
  expect(r.type).toBe("presented");
  expect(presenter.presented.length).toBe(1);
  await sw.dispose();
});

it("register: ACTIVE subscription → skipped { type: 'userSubscribed' } and runs feature", async () => {
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
  const r = await sw.register({
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

it("register({ paywall }) renders a custom paywall, fires lifecycle, and controller.buy resolves purchased", async () => {
  // Custom PurchaseController so controller.buy actually resolves (the
  // default one would await an iframe checkout that never comes).
  const customController = {
    purchase: async () => ({ type: "purchased" as const }),
    restorePurchases: async () => ({ type: "restored" as const }),
  };
  const sw = makeWithPaywall({ purchaseController: customController });
  await sw.ready;

  const lifecycle: string[] = [];
  sw.events.addEventListener("paywall_open", () => lifecycle.push("open"));
  sw.events.addEventListener("paywall_close", () => lifecycle.push("close"));

  let captured: {
    state: import("./presenter.ts").CustomPaywallState;
    controller: import("./presenter.ts").CustomPaywallController;
  } | null = null;

  const r = await sw.register({
    placement: "checkout",
    paywall: ({ state, controller }) => {
      // Mirror the React wrapper: subscribe + drive the controller.
      const unsub = state.subscribe((s) => {
        captured = { state: s, controller };
      });
      // Buy on next tick.
      queueMicrotask(() =>
        controller.buy({ id: "pro_yearly", store: "stripe", entitlements: [] }),
      );
      return () => unsub();
    },
  });

  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.result.type).toBe("purchased");
  }
  expect(lifecycle).toEqual(["open", "close"]);
  // Custom renderer saw products from config.
  expect(captured).not.toBeNull();
  await sw.dispose();
});

it("register({ paywall }) controller.close resolves declined + tears down", async () => {
  const customController = {
    purchase: async () => ({ type: "purchased" as const }),
    restorePurchases: async () => ({ type: "restored" as const }),
  };
  const sw = makeWithPaywall({ purchaseController: customController });
  await sw.ready;
  let teardownCalled = false;
  const r = await sw.register({
    placement: "checkout",
    paywall: ({ controller }) => {
      queueMicrotask(() => controller.close());
      return () => {
        teardownCalled = true;
      };
    },
  });
  expect(r.type).toBe("presented");
  if (r.type === "presented") expect(r.result.type).toBe("declined");
  expect(teardownCalled).toBe(true);
  await sw.dispose();
});

it("register presents, awaits result, fires lifecycle events + handler callbacks", async () => {
  const presenter = presenterThatResolves({ type: "purchased", productId: "p1" });
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  const lifecycle: string[] = [];
  sw.events.addEventListener("paywall_open", () => lifecycle.push("open"));
  sw.events.addEventListener("paywall_close", () => lifecycle.push("close"));

  let onPresent: PaywallInfo | null = null;
  let onDismiss: { info: PaywallInfo; result: PaywallResult } | null = null;
  let featureRan = false;

  const r = await sw.register({
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

it("register fires trigger_fire with the placement + paywall result", async () => {
  const presenter = presenterThatResolves({ type: "declined" });
  const sw = makeWithPaywall({ presenter });
  await sw.ready;
  const fires: Array<{ placementName: string; result: { type: string } }> = [];
  sw.events.addEventListener("trigger_fire", (ev) => {
    fires.push((ev as CustomEvent).detail);
  });
  await sw.register({ placement: "checkout" });
  expect(fires).toHaveLength(1);
  expect(fires[0]!.placementName).toBe("checkout");
  expect(fires[0]!.result.type).toBe("paywall");
  await sw.dispose();
});

it("register does NOT fire trigger_fire for an unknown placement", async () => {
  const presenter = presenterThatResolves({ type: "declined" });
  const sw = makeWithPaywall({ presenter });
  await sw.ready;
  let fired = false;
  sw.events.addEventListener("trigger_fire", () => {
    fired = true;
  });
  await sw.register({ placement: "does_not_exist" });
  expect(fired).toBe(false);
  await sw.dispose();
});

it("register: declined result on a config-driven nonGated paywall RUNS the feature", async () => {
  // Config carries `featureGatingBehavior: "nonGated"` on the paywall —
  // even when the user dismisses, the consumer's feature callback fires.
  // Mirrors Android `featureGatingBehavior` semantics.
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          build_id: "b1",
          trigger_options: [
            {
              event_name: "checkout",
              rules: [
                {
                  experiment_id: "exp_x",
                  experiment_group_id: "grp",
                  expression_cel: "",
                  variants: [
                    {
                      variant_id: "v_a",
                      variant_type: "TREATMENT",
                      paywall_identifier: "pw_x",
                    },
                  ],
                },
              ],
            },
          ],
          paywall_responses: [
            {
              identifier: "pw_x",
              url: "https://paywalls.superwall.test/pw_x",
              feature_gating: "NON_GATED",
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

  const r = await sw.register({
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

it("register: declined result on a config-driven gated paywall does NOT run feature", async () => {
  // Same setup as above but featureGatingBehavior: "gated" — feature must NOT fire.
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          build_id: "b1",
          trigger_options: [
            {
              event_name: "checkout",
              rules: [
                {
                  experiment_id: "exp_x",
                  experiment_group_id: "grp",
                  expression_cel: "",
                  variants: [
                    {
                      variant_id: "v_a",
                      variant_type: "TREATMENT",
                      paywall_identifier: "pw_x",
                    },
                  ],
                },
              ],
            },
          ],
          paywall_responses: [
            {
              identifier: "pw_x",
              url: "https://paywalls.superwall.test/pw_x",
              feature_gating: "GATED",
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

  const r = await sw.register({
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

it("register: declined result on a (default-gated) paywall does NOT run feature", async () => {
  const presenter = presenterThatResolves({ type: "declined" });
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  let featureRan = false;
  const r = await sw.register({
    placement: "checkout",
    feature: () => {
      featureRan = true;
    },
  });

  expect(r.type).toBe("presented");
  expect(featureRan).toBe(false);
  await sw.dispose();
});

it("register enforces the single-paywall invariant — second call → PaywallAlreadyPresentedError", async () => {
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

  const first = sw.register({ placement: "checkout" });
  await started; // presenter has been invoked → isPaywallPresented is true
  expect(sw.isPaywallPresented.value).toBe(true);

  // Second register collides regardless of placement.
  const second = await sw.register({ placement: "checkout" });
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

it("register: presenter throw → { type: 'error', error: PresenterError }, isPaywallPresented resets", async () => {
  const boom: PaywallPresenter = {
    present: () => {
      throw new Error("iframe gone");
    },
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter: boom });
  await sw.ready;

  let onError: Error | null = null;
  const r = await sw.register({
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

it("register: presentation context exposes placement + params + signal + emit", async () => {
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

  await sw.register({
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

it("dismiss aborts the in-flight presentation and tells the presenter", async () => {
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

  const reg = sw.register({ placement: "checkout" });
  await started; // presenter invoked → currentAbort wired
  expect(sw.isPaywallPresented.value).toBe(true);

  sw.dismiss();
  const r = await reg;

  expect(dismissCalls).toBe(1);
  expect(r.type).toBe("error");
  expect(sw.isPaywallPresented.value).toBe(false);
  await sw.dispose();
});

it("getPresentationResult returns placementNotFound for placements not in config", async () => {
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

it("confirmAllAssignments returns [] until experiments processing lands", async () => {
  const sw = make();
  await sw.ready;
  const r = await sw.placements.confirmAllAssignments();
  expect(r).toEqual([]);
  await sw.dispose();
});

it("preloadAll / preloadFor are no-ops without config (do not throw)", async () => {
  const sw = make();
  await sw.ready;
  await sw.placements.preloadAll();
  await sw.placements.preloadFor(["a", "b"]);
  await sw.dispose();
});

// ---------------------------------------------------------------------------
// dispose idempotence
// ---------------------------------------------------------------------------

it("dispose is idempotent + safe to call multiple times", async () => {
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
    if (url.includes("/api/v1/static_config")) {
      return new Response(EMPTY_STATIC_CONFIG);
    }
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

it("configure POSTs enrichment with current user attributes + merges response into the user signal", async () => {
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
  // Attribution fields (landing_page etc.) may be present from the test env's
  // location — use toMatchObject so the assertion stays stable across envs.
  expect(body.user).toMatchObject({ email: "a@b.co" });
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

it("enrichment failure does NOT block sw.ready (emits enrichment_fail)", async () => {
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

it("configure emits enrichment_start + enrichment_complete around the network call", async () => {
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

it("configure replays cached ConfirmedAssignment[] from storage", async () => {
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

it("confirmAllAssignments returns [] when storage is empty (fresh install)", async () => {
  const sw = make();
  await sw.ready;
  expect(await sw.placements.confirmAllAssignments()).toEqual([]);
  await sw.dispose();
});

it("corrupt assignments cache is silently dropped (no throw)", async () => {
  const adapter = newAdapter();
  await adapter.set(STORAGE_KEYS.assignments, "{not json");
  const sw = createSuperwall({ apiKey: "pk_test", fetch: noopFetch, storage: adapter });
  await sw.ready;
  expect(await sw.placements.confirmAllAssignments()).toEqual([]);
  await sw.dispose();
});

it("reset() clears the assignments cache from both signal and storage", async () => {
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

it("purchases.restore() emits lifecycle events and persists lastRestoreAt", async () => {
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

it("configure replays lastRestoreAt from storage on a return visit", async () => {
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

it("reset() clears the lastRestoreAt cache from storage", async () => {
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

it("delegate.onUserAttributesChange fires when sw.user.setAttributes is called", async () => {
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

it("paywallWillOpenURL local event is delivered to the delegate", async () => {
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

it("paywall_open with stub info does NOT POST to collector (P0-3)", async () => {
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

  await sw.register({ placement: "checkout" });
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

it("paywall_decline fires on declined results (P1, parity with Android)", async () => {
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "declined" }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  let declineCount = 0;
  sw.events.addEventListener("paywall_decline", () => declineCount++);

  await sw.register({ placement: "checkout" });
  await tick();

  expect(declineCount).toBe(1);
  await sw.dispose();
});

it("paywall_decline does NOT fire on purchased / restored results", async () => {
  const presenter: PaywallPresenter = {
    present: async () => ({ type: "purchased", productId: "p" }),
    dismiss: () => {},
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;

  let declineCount = 0;
  sw.events.addEventListener("paywall_decline", () => declineCount++);
  await sw.register({ placement: "checkout" });
  await tick();
  expect(declineCount).toBe(0);
  await sw.dispose();
});

it("after declined dismiss, isPaywallPresented resets to false (regression for P0-2)", async () => {
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

  await sw.register({ placement: "checkout" });
  await tick();
  expect(sw.isPaywallPresented.value).toBe(false);

  // Second register works (proves signal isn't stuck).
  const r = await sw.register({ placement: "checkout" });
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
  build_id: "test_build",
  trigger_options: (overrides.triggers ?? []).map((t) => ({
    event_name: t.placementName,
    rules: t.rules.map((r, i) => ({
      // Each rule needs its own experiment id — backend guarantees this.
      // The helper used to share `exp_<placement>` across rules; that
      // collided once eager assignment landed (one experimentId can only
      // resolve to one variant), so different rules masked each other.
      experiment_id: `exp_${t.placementName}_${i}`,
      experiment_group_id: "grp_test",
      expression_cel: r.expression,
      variants: [
        {
          variant_id: `var_${t.placementName}_${i}`,
          variant_type: (r.variantType ?? "treatment").toUpperCase(),
          ...(r.paywallId !== undefined && { paywall_identifier: r.paywallId }),
        },
      ],
    })),
  })),
  paywall_responses: (overrides.paywalls ?? []).map((p) => ({
    identifier: p.identifier,
    ...(p.name !== undefined && { name: p.name }),
    ...(p.url !== undefined && { url: p.url }),
    ...(p.productIds !== undefined && { product_ids: p.productIds }),
  })),
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

it("register: empty audience matches → presents the config-driven paywall", async () => {
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

  const r = await sw.register({ placement: "checkout" });
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

it("register: holdout variant → skipped { type: 'holdout', experiment }", async () => {
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
  const r = await sw.register({
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

it("register: placement not in config → skipped placementNotFound", async () => {
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
  const r = await sw.register({
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

it("register: variant pick is sticky — same alias re-evaluates → same paywall", async () => {
  // Two-variant experiment with explicit 50/50; the alias-driven hash
  // bucket determines which one fires. Either way, BOTH register calls
  // should land on the same one.
  const { fetch } = configFetchRecorder({
    build_id: "test_build",
    trigger_options: [
      {
        event_name: "checkout",
        rules: [
          {
            experiment_id: "exp_split",
            experiment_group_id: "grp",
            expression_cel: "",
            variants: [
              { variant_id: "v_a", variant_type: "TREATMENT", paywall_identifier: "pw_a", percentage: 50 },
              { variant_id: "v_b", variant_type: "TREATMENT", paywall_identifier: "pw_b", percentage: 50 },
            ],
          },
        ],
      },
    ],
    paywall_responses: [
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

  await sw.register({ placement: "checkout" });
  await sw.register({ placement: "checkout" });
  await sw.register({ placement: "checkout" });

  // All three calls hit the same paywall — sticky variant.
  expect(new Set(presented).size).toBe(1);

  // The chosen experiment is in the confirmed-assignments cache.
  const confirmed = await sw.placements.confirmAllAssignments();
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]!.experimentId).toBe("exp_split");

  await sw.dispose();
});

it("register: rule expression evaluates against user attributes via Superscript", async () => {
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

  const r = await sw.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    // Second rule (`plan == "free"`) matched, so we present `pw_upsell`.
    expect(r.info.identifier).toBe("pw_upsell");
  }
  await sw.dispose();
});

it("paywallWillOpenDeepLink local event is delivered to the delegate", async () => {
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

it("configure: failing static_config fetch retries exactly once before giving up", async () => {
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

it("purchases.getProducts: returns config-derived products as Product[]", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          build_id: "b1",
          trigger_options: [],
          paywall_responses: [],
          products: [
            {
              sw_composite_product_id: "pro_yearly",
              name: "Pro Yearly",
              store_product: {
                store: "STRIPE",
                product_identifier: "pro_yearly",
              },
              entitlements: [{ identifier: "pro", type: "SERVICE_LEVEL" }],
            },
            { sw_composite_product_id: "no_entitlements" },
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

it("purchases.getCustomerInfo: returns the current customerSig snapshot", async () => {
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

it("logger: failures inside delegate callbacks are surfaced via onLog instead of silently swallowed", async () => {
  const logs: Array<{ scope: string; message: string | null; error: string | null }> = [];
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
    l.message?.includes("onUserAttributesChange threw"),
  );
  expect(captured).toBeDefined();
  expect(captured!.scope).toBe("superwallCore");
  expect(captured!.error).toContain("delegate boom");
  await sw.dispose();
});

it("counters: firstSeenAt bootstrapped on first run + totalPaywallViews increments on paywall_open", async () => {
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
          build_id: "b1",
          trigger_options: [],
          paywall_responses: [],
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

it("entitlements.byProductIds: returns config-derived entitlements before any purchase", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          build_id: "b1",
          trigger_options: [],
          paywall_responses: [],
          products: [
            {
              sw_composite_product_id: "pro_yearly",
              entitlements: [{ identifier: "pro" }],
            },
            {
              sw_composite_product_id: "vip",
              entitlements: [{ identifier: "pro" }, { identifier: "vip_only" }],
            },
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

it("configure: POSTs confirm_assignments after eager assignment", async () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/api/v1/static_config")) {
      return new Response(
        JSON.stringify({
          build_id: "b1",
          trigger_options: [
            {
              event_name: "checkout",
              rules: [
                {
                  experiment_id: "exp_checkout_0",
                  experiment_group_id: "grp",
                  expression_cel: "",
                  variants: [
                    {
                      variant_id: "v_a",
                      variant_type: "TREATMENT",
                      paywall_identifier: "pw_a",
                    },
                  ],
                },
              ],
            },
          ],
          paywall_responses: [],
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
    assignments: Array<{ experiment_id: string; variant_id: string }>;
  };
  expect(body.assignments).toHaveLength(1);
  // Flat snake_case, variant.id flattened, type dropped (BE contract).
  expect(body.assignments[0]).toEqual({
    experiment_id: "exp_checkout_0",
    variant_id: "v_a",
  });
  await sw.dispose();
});

it("refreshConfiguration: re-fetches static_config and re-runs eager assignment", async () => {
  let configCalls = 0;
  const buildConfig = (buildId: string) =>
    JSON.stringify({
      build_id: buildId,
      trigger_options: [
        {
          event_name: "checkout",
          rules: [
            {
              experiment_id: "exp_checkout_0",
              experiment_group_id: "grp_test",
              expression_cel: "",
              variants: [
                {
                  variant_id: `var_${buildId}`,
                  variant_type: "TREATMENT",
                  paywall_identifier: `pw_${buildId}`,
                },
              ],
            },
          ],
        },
      ],
      paywall_responses: [
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
  const r = await sw.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("pw_v2");
  }
  await sw.dispose();
});

it("configure: cached config makes sw.ready resolve before a hanging fetch — register() can fire against cache", async () => {
  // Pre-seed storage with a cached config carrying the enableConfigRefresh
  // toggle. On configure(), the fetch deadline should fire (1s) and the
  // cached config stays in place — `register()` must resolve to the
  // cached paywall, not paywallNotAvailable.
  const cachedPayload = {
    build_id: "cached_build",
    trigger_options: [
      {
        event_name: "checkout",
        rules: [
          {
            experiment_id: "exp_cached",
            experiment_group_id: "grp_cached",
            expression_cel: "",
            variants: [
              {
                variant_id: "var_cached",
                variant_type: "TREATMENT",
                paywall_identifier: "pw_cached",
              },
            ],
          },
        ],
      },
    ],
    paywall_responses: [
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

  const r = await sw.register({ placement: "checkout" });
  expect(r.type).toBe("presented");
  if (r.type === "presented") {
    expect(r.info.identifier).toBe("pw_cached");
  }
  await sw.dispose();
});


// ---------------------------------------------------------------------------
// Stripe discount (promotion code) redemption — public API via sw.activePaywall
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import { DiscountError } from "./errors.ts";
import type { DiscountRedemptionResult } from "./types.ts";

/** Presenter that stays "presented" until dismissed, captures the ctx so the
 *  test can push results back, and records redeemDiscount codes. `postMode`
 *  controls when the presenter reports the code posted (fires `onPosted`):
 *  "immediate" (ready paywall) or "manual" (simulates a pre-ready queue —
 *  call `flush()` to post + arm the SDK timeout). */
const controllablePresenter = (postMode: "immediate" | "manual" = "immediate") => {
  let ctxRef: PresentationContext | null = null;
  let infoRef: PaywallInfo | null = null;
  const redeemCodes: string[] = [];
  let resolvePresent: ((r: PaywallResult) => void) | null = null;
  let queuedOnPosted: (() => void) | null = null;
  const presenter: PaywallPresenter = {
    present: (info, ctx) => {
      ctxRef = ctx;
      infoRef = info;
      return new Promise<PaywallResult>((res) => {
        resolvePresent = res;
      });
    },
    dismiss: () => resolvePresent?.({ type: "declined" }),
    redeemDiscount: (code, onPosted) => {
      redeemCodes.push(code);
      if (postMode === "immediate") onPosted?.();
      else queuedOnPosted = onPosted ?? null;
    },
  };
  return {
    presenter,
    redeemCodes,
    /** Simulate the pre-ready queue flushing (posts + arms the SDK timeout). */
    flush: () => {
      const cb = queuedOnPosted;
      queuedOnPosted = null;
      cb?.();
    },
    /** Simulate the paywall posting a result — the presenter splits it into
     *  the public discount_redeem_complete / discount_redeem_fail events. */
    emitResult: (detail: DiscountRedemptionResult) => {
      if (detail.valid) {
        ctxRef?.emit("discount_redeem_complete", {
          code: detail.code,
          paywall_info: infoRef!,
          ...(detail.appliedProductCount !== undefined && {
            appliedProductCount: detail.appliedProductCount,
          }),
        });
      } else {
        ctxRef?.emit("discount_redeem_fail", {
          code: detail.code,
          paywall_info: infoRef!,
          ...(detail.reason !== undefined && { reason: detail.reason }),
        });
      }
    },
    dismiss: () => resolvePresent?.({ type: "declined" }),
  };
};

/** Poll a nullable read until it yields a value (register reaches present()
 *  after several runtime round-trips — more than a single microtask). */
const pollValue = async <T>(read: () => T | null, tries = 100): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const v = read();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("pollValue timed out");
};

/** Present a paywall and return the active handle + rig. Caller must dismiss. */
const presentWithDiscounts = async (
  postMode: "immediate" | "manual" = "immediate",
) => {
  const rig = controllablePresenter(postMode);
  const sw = makeWithPaywall({ presenter: rig.presenter });
  await sw.ready;
  const reg = sw.register({ placement: "checkout" });
  const paywall = await pollValue(() => sw.activePaywall.value);
  return { sw, reg, rig, paywall };
};

it("activePaywall is null before present, a handle while presented, null after dismiss", async () => {
  const rig = controllablePresenter();
  const sw = makeWithPaywall({ presenter: rig.presenter });
  await sw.ready;
  expect(sw.activePaywall.value).toBeNull();
  const reg = sw.register({ placement: "checkout" });
  await pollValue(() => sw.activePaywall.value);
  expect(sw.activePaywall.value).not.toBeNull();
  rig.dismiss();
  await reg;
  expect(sw.activePaywall.value).toBeNull();
  await sw.dispose();
});

it("redeemDiscount posts the code and resolves on a matching result", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const promise = paywall!.redeemDiscount("SUMMER20");
  expect(rig.redeemCodes).toEqual(["SUMMER20"]);
  rig.emitResult({ code: "SUMMER20", valid: true, appliedProductCount: 2 });
  await expect(promise).resolves.toEqual({
    code: "SUMMER20",
    valid: true,
    appliedProductCount: 2,
  });
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("redeemDiscount trims the code before posting + matching", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const promise = paywall!.redeemDiscount("  SAVE10  ");
  expect(rig.redeemCodes).toEqual(["SAVE10"]);
  rig.emitResult({ code: "SAVE10", valid: false, reason: "code_not_found" });
  await expect(promise).resolves.toEqual({
    code: "SAVE10",
    valid: false,
    reason: "code_not_found",
  });
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("a non-matching result does NOT settle a pending redeem (matched by code)", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const promise = paywall!.redeemDiscount("WANT");
  let settled = false;
  void promise.then(() => { settled = true; });
  // An unrelated result (e.g. in-paywall button for a different code) arrives.
  rig.emitResult({ code: "OTHER", valid: true, appliedProductCount: 1 });
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBe(false);
  // The matching result settles it.
  rig.emitResult({ code: "WANT", valid: true, appliedProductCount: 1 });
  await expect(promise).resolves.toMatchObject({ code: "WANT", valid: true });
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("redeemDiscount times out (gap #1: paywall posts no result) as { valid:false, reason:'timeout' }", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  vi.useFakeTimers();
  try {
    const promise = paywall!.redeemDiscount("NORESULT");
    vi.advanceTimersByTime(10_000);
    await expect(promise).resolves.toEqual({
      code: "NORESULT",
      valid: false,
      reason: "timeout",
    });
  } finally {
    vi.useRealTimers();
  }
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("a queued (pre-ready) redeem does NOT start its timeout until the code is actually posted", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts("manual");
  vi.useFakeTimers();
  try {
    let settled = false;
    const promise = paywall!.redeemDiscount("SLOWLOAD");
    void promise.then(() => { settled = true; });
    // Still queued in the presenter — advancing past the window must NOT time out.
    vi.advanceTimersByTime(20_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    // Iframe becomes ready → presenter posts → SDK arms the timeout NOW.
    rig.flush();
    vi.advanceTimersByTime(10_000);
    await expect(promise).resolves.toEqual({
      code: "SLOWLOAD",
      valid: false,
      reason: "timeout",
    });
  } finally {
    vi.useRealTimers();
  }
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("a second redeemDiscount supersedes the first (older settles, not hangs)", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const first = paywall!.redeemDiscount("A");
  const second = paywall!.redeemDiscount("B");
  await expect(first).resolves.toEqual({
    code: "A",
    valid: false,
    reason: "superseded",
  });
  rig.emitResult({ code: "B", valid: true, appliedProductCount: 1 });
  await expect(second).resolves.toEqual({
    code: "B",
    valid: true,
    appliedProductCount: 1,
  });
  expect(rig.redeemCodes).toEqual(["A", "B"]);
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("clearDiscount posts an empty code, returns void, and settles a pending redeem", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const pending = paywall!.redeemDiscount("SUMMER20");
  expect(paywall!.clearDiscount()).toBeUndefined();
  expect(rig.redeemCodes).toEqual(["SUMMER20", ""]);
  await expect(pending).resolves.toEqual({
    code: "SUMMER20",
    valid: false,
    reason: "superseded",
  });
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("dismissal settles a pending redeem as { reason: 'paywall_dismissed' }", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const pending = paywall!.redeemDiscount("INFLIGHT");
  rig.dismiss();
  await expect(pending).resolves.toEqual({
    code: "INFLIGHT",
    valid: false,
    reason: "paywall_dismissed",
  });
  await reg;
  await sw.dispose();
});

it("redeemDiscount rejects an empty/whitespace code with DiscountError(empty_code)", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  await expect(paywall!.redeemDiscount("   ")).rejects.toBeInstanceOf(DiscountError);
  await expect(paywall!.redeemDiscount("   ")).rejects.toMatchObject({ reason: "empty_code" });
  expect(rig.redeemCodes).toEqual([]);
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("a stale handle rejects with DiscountError(no_paywall_presented) after dismissal", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  rig.dismiss();
  await reg;
  // Handle captured while presented; paywall is now gone.
  await expect(paywall!.redeemDiscount("SUMMER20")).rejects.toMatchObject({
    reason: "no_paywall_presented",
  });
  await sw.dispose();
});

it("redeemDiscount rejects with DiscountError(unsupported_presenter) when the presenter has no channel", async () => {
  // A custom presenter without a redeemDiscount method (e.g. an override).
  const slot: { resolve: ((r: PaywallResult) => void) | null } = { resolve: null };
  const presenter: PaywallPresenter = {
    present: (_info, _ctx) => new Promise<PaywallResult>((res) => { slot.resolve = res; }),
    dismiss: () => slot.resolve?.({ type: "declined" }),
  };
  const sw = makeWithPaywall({ presenter });
  await sw.ready;
  const reg = sw.register({ placement: "checkout" });
  const paywall = await pollValue(() => sw.activePaywall.value);
  await expect(paywall!.redeemDiscount("SUMMER20")).rejects.toMatchObject({
    reason: "unsupported_presenter",
  });
  slot.resolve?.({ type: "declined" });
  await reg;
  await sw.dispose();
});

it("discount_redeem_complete fires as a public event for paywall-initiated redemptions", async () => {
  const { sw, reg, rig, paywall } = await presentWithDiscounts();
  const seen: Array<Record<string, unknown>> = [];
  sw.events.addEventListener("discount_redeem_complete", (e) => seen.push(e.detail));
  // No SDK-initiated redeem is pending — this is an in-paywall button result.
  rig.emitResult({ code: "BUTTON50", valid: true, appliedProductCount: 3 });
  await pollValue(() => (seen.length > 0 ? seen : null));
  expect(seen).toEqual([
    { code: "BUTTON50", appliedProductCount: 3, paywall_info: paywall!.info },
  ]);
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("discount_redeem_fail reaches the onEvent firehose (wire-bound analytics)", async () => {
  const rig = controllablePresenter();
  const seen: Array<[string, Record<string, unknown>]> = [];
  const delegate: SuperwallDelegate = {
    onEvent: (name, detail) => seen.push([name, detail as Record<string, unknown>]),
  };
  const sw = makeWithPaywall({ presenter: rig.presenter, delegate });
  await sw.ready;
  const reg = sw.register({ placement: "checkout" });
  await pollValue(() => sw.activePaywall.value);
  rig.emitResult({ code: "DLG", valid: false, reason: "code_invalid" });
  await pollValue(() =>
    seen.find(([n]) => n === "discount_redeem_fail") ? seen : null,
  );
  const fail = seen.find(([n]) => n === "discount_redeem_fail");
  expect(fail![1]).toMatchObject({ code: "DLG", reason: "code_invalid" });
  rig.dismiss();
  await reg;
  await sw.dispose();
});

it("discount_redeem_complete / _fail POST to the collector with correlation context", async () => {
  const posted: Array<{ event_name: string; parameters: Record<string, unknown> }> = [];
  const recordingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/static_config")) {
      return Promise.resolve(new Response(JSON.stringify(CHECKOUT_STATIC_CONFIG)));
    }
    if (url.includes("/api/v1/enrich")) {
      return Promise.resolve(new Response(JSON.stringify({ user: {}, device: {} })));
    }
    if (url.includes("/api/v1/events") && init?.body) {
      const parsed = JSON.parse(init.body as string) as { events: typeof posted };
      posted.push(...parsed.events);
    }
    return Promise.resolve(new Response("", { status: 204 }));
  }) as unknown as typeof fetch;
  const rig = controllablePresenter();
  const sw = createSuperwall({
    apiKey: "pk_test",
    fetch: recordingFetch,
    storage: newAdapter(),
    presenter: rig.presenter,
  });
  await sw.ready;
  const reg = sw.register({ placement: "checkout" });
  await pollValue(() => sw.activePaywall.value);
  rig.emitResult({ code: "GOOD", valid: true, appliedProductCount: 1 });
  rig.emitResult({ code: "BAD", valid: false, reason: "code_not_found" });
  await pollValue(() =>
    posted.some((e) => e.event_name === "discount_redeem_fail") ? posted : null,
  );
  const complete = posted.find((e) => e.event_name === "discount_redeem_complete");
  const fail = posted.find((e) => e.event_name === "discount_redeem_fail");
  expect(complete?.parameters).toMatchObject({ code: "GOOD", appliedProductCount: 1 });
  expect(fail?.parameters).toMatchObject({ code: "BAD", reason: "code_not_found" });
  // Auto-context threads the presentation id so analytics can correlate the
  // redemption to the paywall session.
  expect(complete?.parameters).toHaveProperty("$presentation_id");
  rig.dismiss();
  await reg;
  await sw.dispose();

// ── navigateAfterWeb2AppPurchase (web-app-sdk post-purchase host navigation) ──

import { navigateAfterWeb2AppPurchase } from "./superwall.ts";

const withStubbedLocation = (fn: (loc: { href: string }) => void): void => {
  const loc = { href: "" };
  vi.stubGlobal("location", loc);
  try {
    fn(loc);
  } finally {
    vi.unstubAllGlobals();
  }
};

const NAV_TARGETS = {
  redirectUrl: "https://merchant.com/order-complete",
  redemptionUrl: "https://tenant.superwall.app/redeem?codes=redemption_abc",
  manageUrl: "https://tenant.superwall.app/manage",
} as const;

it("navigates to the merchant-configured redirectUrl by default", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(NAV_TARGETS, undefined);
    expect(loc.href).toBe(NAV_TARGETS.redirectUrl);
  });
});

it("falls back to the redeem page when no redirectUrl is configured", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(
      { redemptionUrl: NAV_TARGETS.redemptionUrl },
      "default",
    );
    expect(loc.href).toBe(NAV_TARGETS.redemptionUrl);
  });
});

it("a {url} option wins over every BE-resolved target", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(NAV_TARGETS, { url: "https://custom.com/thanks" });
    expect(loc.href).toBe("https://custom.com/thanks");
  });
});

it('"none" never navigates', () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(NAV_TARGETS, "none");
    expect(loc.href).toBe("");
  });
});

it("a handler returning non-false is treated as handled (no navigation)", () => {
  withStubbedLocation((loc) => {
    const handler = vi.fn(() => undefined);
    navigateAfterWeb2AppPurchase(NAV_TARGETS, handler);
    expect(handler).toHaveBeenCalledWith(NAV_TARGETS);
    expect(loc.href).toBe("");
  });
});

it("a handler returning false falls through to the default navigation", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(NAV_TARGETS, () => false);
    expect(loc.href).toBe(NAV_TARGETS.redirectUrl);
  });
});

it("a throwing handler is treated as handled and never crashes navigation", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase(NAV_TARGETS, () => {
      throw new Error("merchant bug");
    });
    expect(loc.href).toBe("");
  });
});

it("does nothing when no target resolves", () => {
  withStubbedLocation((loc) => {
    navigateAfterWeb2AppPurchase({ manageUrl: NAV_TARGETS.manageUrl }, undefined);
    // manageUrl is exposed to handlers but is never an automatic destination.
    expect(loc.href).toBe("");
  });
});
