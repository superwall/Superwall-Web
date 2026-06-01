import { test, expect, beforeEach } from "bun:test";
import type { PaywallInfo } from "../types.ts";
import type { PresentationContext } from "../presenter.ts";
import { createBrowserPresenter } from "./presenter.ts";

const tick = () => new Promise<void>((r) => queueMicrotask(r));
// Allow happy-dom to flush its message queue (postMessage is async).
const flushMessages = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

const stubInfo = (id = "pw_1"): PaywallInfo => ({
  identifier: id,
  name: id,
  url: `https://paywalls.superwall.test/${id}`,
  productIds: [],
  products: [],
});

const newCtx = (
  overrides: Partial<PresentationContext> = {},
): PresentationContext => ({
  placement: "checkout",
  params: {},
  signal: new AbortController().signal,
  emit: () => {},
  ...overrides,
});

beforeEach(() => {
  // Strip any stray overlays from a previous test (just in case).
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// mount / dismiss / overlay structure
// ---------------------------------------------------------------------------

test("present mounts an iframe overlay into document.body", async () => {
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(stubInfo("pw_x"), newCtx());
  await tick();

  const overlay = document.querySelector('[data-sw-presenter="overlay"]');
  const iframe = document.querySelector(
    'iframe[data-sw-presenter="iframe"]',
  ) as HTMLIFrameElement | null;
  expect(overlay).not.toBeNull();
  expect(iframe).not.toBeNull();
  expect(iframe!.src).toContain("paywalls.superwall.test/pw_x");

  presenter.dismiss();
  await presentation;
  expect(document.querySelector('[data-sw-presenter="overlay"]')).toBeNull();
});

test("iframe URL has platform=web&transport=web&debug=false appended (§7.3)", async () => {
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(stubInfo("pw_a"), newCtx());
  await tick();

  const iframe = document.querySelector(
    "iframe",
  ) as HTMLIFrameElement;
  const url = new URL(iframe.src);
  expect(url.searchParams.get("platform")).toBe("web");
  expect(url.searchParams.get("transport")).toBe("web");
  expect(url.searchParams.get("debug")).toBe("false");

  presenter.dismiss();
  await presentation;
});

test("test mode flips debug=true in the iframe URL", async () => {
  const presenter = createBrowserPresenter({ testMode: true });
  const presentation = presenter.present(stubInfo("pw_a"), newCtx());
  await tick();

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const url = new URL(iframe.src);
  expect(url.searchParams.get("debug")).toBe("true");

  presenter.dismiss();
  await presentation;
});

test("iframe URL carries #init=<base64> hash with placementSessionToken + identity + apiBase + collector", async () => {
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(
    stubInfo("pw_init"),
    newCtx({
      bootstrap: {
        apiKey: "pk_test_abc",
        appUserId: "user_1",
        aliasId: "alias_1",
        email: "u@example.test",
        deviceId: "11111111-1111-1111-1111-111111111111",
        hostOrigin: "https://merchant.test",
        cancelUrl: "https://merchant.test/checkout",
        apiBase: "https://api.superwall.me",
        collector: "https://collector.superwall.me",
        sdkVersion: "1.2.3",
        clientSurface: "web-sdk",
      },
    }),
  );
  await tick();

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const url = new URL(iframe.src);
  expect(url.hash).toMatch(/^#init=/);
  // Hash carries standard base64 (controller decodes with plain atob).
  const json = JSON.parse(atob(url.hash.slice("#init=".length)));
  expect(json.placementSessionToken).toBe("pk_test_abc");
  expect(json.apiBase).toBe("https://api.superwall.me");
  expect(json.hostOrigin).toBe("https://merchant.test");
  expect(json.cancelUrl).toBe("https://merchant.test/checkout");
  // collector.identity carries the discriminated userId + deviceId UUID;
  // top-level identity is gone (lived under collector now to match the
  // controller's destructure).
  expect(json.collector).toEqual({
    url: "https://collector.superwall.me",
    identity: {
      userId: { type: "appUserId", appUserId: "user_1" },
      deviceId: "11111111-1111-1111-1111-111111111111",
    },
  });

  presenter.dismiss();
  await presentation;
});

test("anonymous user → collector.identity.userId is the aliasId variant", async () => {
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(
    stubInfo("pw_anon"),
    newCtx({
      bootstrap: {
        apiKey: "pk_anon",
        // appUserId omitted (anonymous).
        aliasId: "$SuperwallAlias:abc",
        deviceId: "11111111-1111-1111-1111-111111111111",
        hostOrigin: "https://merchant.test",
        apiBase: "https://api.superwall.me",
        collector: "https://collector.superwall.me",
        sdkVersion: "1.0.0",
        clientSurface: "web-sdk",
      },
    }),
  );
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const json = JSON.parse(
    atob(new URL(iframe.src).hash.slice("#init=".length)),
  );
  expect(json.collector.identity.userId).toEqual({
    type: "aliasId",
    aliasId: "$SuperwallAlias:abc",
  });
  expect(json.collector.identity.deviceId).toBe(
    "11111111-1111-1111-1111-111111111111",
  );
  presenter.dismiss();
  await presentation;
});

test("weighted endpoint pick uses urlEndpoints when present", async () => {
  // Single endpoint = always picked, regardless of weight.
  const presenter = createBrowserPresenter();
  const info: PaywallInfo = {
    ...stubInfo("pw_ep"),
    url: "https://default.test/fallback",
    urlEndpoints: [
      { url: "https://endpoint-a.test/x", percentage: 100 },
    ],
  };
  const presentation = presenter.present(info, newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  expect(iframe.src).toContain("endpoint-a.test/x");
  expect(iframe.src).not.toContain("default.test/fallback");
  presenter.dismiss();
  await presentation;
});

test("iframe URL carries bootstrap params + client_surface=web-sdk when ctx.bootstrap is set", async () => {
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(
    stubInfo("pw_b"),
    newCtx({
      bootstrap: {
        apiKey: "pk_test_123",
        appUserId: "user_42",
        aliasId: "alias_xyz",
        email: "u@example.test",
        deviceId: "11111111-1111-1111-1111-111111111111",
        hostOrigin: "https://merchant.test",
        apiBase: "https://api.superwall.me",
        collector: "https://collector.superwall.me",
        sdkVersion: "1.2.3",
        clientSurface: "web-sdk",
      },
    }),
  );
  await tick();

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const url = new URL(iframe.src);
  expect(url.searchParams.get("api_key")).toBe("pk_test_123");
  expect(url.searchParams.get("app_user_id")).toBe("user_42");
  expect(url.searchParams.get("alias_id")).toBe("alias_xyz");
  expect(url.searchParams.get("email")).toBe("u@example.test");
  expect(url.searchParams.get("device_id")).toBe(
    "11111111-1111-1111-1111-111111111111",
  );
  expect(url.searchParams.get("host_origin")).toBe("https://merchant.test");
  expect(url.searchParams.get("sdk_version")).toBe("1.2.3");
  expect(url.searchParams.get("client_surface")).toBe("web-sdk");

  // iframe `allow` attr enables Apple/Google Pay inside the nested Stripe iframe.
  expect(iframe.allow).toContain("payment *");
  expect(iframe.allow).toContain("publickey-credentials-get *");

  presenter.dismiss();
  await presentation;
});

test("post_checkout_complete (flat shape from controller's postMessageToHost) resolves purchased", async () => {
  // The in-iframe controller posts a flat `{event_name, ...}` message — NOT
  // the v1 envelope. Our handler accepts both shapes.
  const presenter = createBrowserPresenter();
  const info = stubInfo("pw_flat");
  const ctx = newCtx();
  const presentation = presenter.present(info, ctx);
  await tick();

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const origin = new URL(iframe.src).origin;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        event_name: "post_checkout_complete",
        checkout_context_id: "ckctx_flat",
        product_identifier: "pro_yearly",
        transaction_data: undefined,
        redirect_url: undefined,
      },
      origin,
      source: iframe.contentWindow,
    } as MessageEventInit),
  );
  const r = await presentation;
  expect(r.type).toBe("purchased");
  if (r.type === "purchased") expect(r.productId).toBe("pro_yearly");
});

test("redirect_required calls window.open and emits paywallWillOpenURL", async () => {
  const emitted: Array<[string, unknown]> = [];
  const opens: string[] = [];
  const originalOpen = globalThis.open;
  // happy-dom's window.open returns null and triggers navigation; stub it.
  (globalThis as { open?: unknown }).open = (url: string) => {
    opens.push(url);
    return null;
  };
  try {
    const presenter = createBrowserPresenter();
    const info = stubInfo("pw_redir");
    const ctx = newCtx({
      emit: (name, detail) => emitted.push([name as string, detail]),
    });
    const presentation = presenter.present(info, ctx);
    await tick();

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const origin = new URL(iframe.src).origin;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          version: 1,
          payload: {
            events: [
              { event_name: "redirect_required", url: "https://stripe.com/checkout/abc" },
            ],
          },
        },
        origin,
        source: iframe.contentWindow,
      } as MessageEventInit),
    );
    await flushMessages();
    expect(opens).toEqual(["https://stripe.com/checkout/abc"]);
    expect(emitted.find(([n]) => n === "paywallWillOpenURL")).toBeDefined();
    presenter.dismiss();
    await presentation;
  } finally {
    (globalThis as { open?: unknown }).open = originalOpen;
  }
});

test("post_checkout_complete resolves purchased + routes via onPurchaseEvent + does NOT emit transaction_complete (BE does it)", async () => {
  const emitted: Array<[string, unknown]> = [];
  const purchaseEvents: unknown[] = [];
  const presenter = createBrowserPresenter();
  const info = stubInfo("pw_pc");
  const ctx = newCtx({
    emit: (name, detail) => emitted.push([name as string, detail]),
    onPurchaseEvent: (ev) => purchaseEvents.push(ev),
  });
  const presentation = presenter.present(info, ctx);
  await tick();

  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const origin = new URL(iframe.src).origin;
  // Flat shape — what the controller's `postMessageToHost` actually sends.
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        event_name: "post_checkout_complete",
        checkout_context_id: "ckctx_42",
        product_identifier: "pro_yearly",
        transaction_data: undefined,
        redirect_url: undefined,
      },
      origin,
      source: iframe.contentWindow,
    } as MessageEventInit),
  );

  const r = await presentation;
  expect(r.type).toBe("purchased");
  if (r.type === "purchased") {
    expect(r.productId).toBe("pro_yearly");
  }
  // BE emits transaction_complete server-side before sending this event —
  // local emission would duplicate consumer callbacks.
  expect(emitted.map(([n]) => n)).not.toContain("transaction_complete");
  expect(emitted.map(([n]) => n)).not.toContain("subscription_start");
  // Internal channel still routes the postCheckout signal to APC.
  const pc = purchaseEvents.find(
    (e) => (e as { type: string }).type === "postCheckout",
  ) as undefined | { type: string; productId: string; checkoutContextId: string };
  expect(pc).toBeDefined();
  expect(pc!.productId).toBe("pro_yearly");
  expect(pc!.checkoutContextId).toBe("ckctx_42");
});

test("custom container option mounts the overlay there instead of body", async () => {
  const host = document.createElement("section");
  host.id = "custom-host";
  document.body.appendChild(host);

  const presenter = createBrowserPresenter({ container: host });
  const presentation = presenter.present(stubInfo(), newCtx());
  await tick();

  expect(host.querySelector('[data-sw-presenter="overlay"]')).not.toBeNull();
  expect(
    document.body.querySelector(':scope > [data-sw-presenter="overlay"]'),
  ).toBeNull();

  presenter.dismiss();
  await presentation;
});

test("calling present while one is active rejects", async () => {
  const presenter = createBrowserPresenter();
  const first = presenter.present(stubInfo(), newCtx());
  await tick();
  await expect(presenter.present(stubInfo(), newCtx())).rejects.toThrow(
    /already presenting/i,
  );
  presenter.dismiss();
  await first;
});

test("dismiss before any present is a no-op", () => {
  const presenter = createBrowserPresenter();
  expect(() => presenter.dismiss()).not.toThrow();
});

// ---------------------------------------------------------------------------
// AbortSignal-driven dismissal (sw.dismiss / sw.dispose)
// ---------------------------------------------------------------------------

test("aborting the context's signal tears down the overlay + resolves declined", async () => {
  const ac = new AbortController();
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx({ signal: ac.signal }));
  await tick();
  expect(document.querySelector("iframe")).not.toBeNull();
  ac.abort();
  await expect(result).resolves.toEqual({ type: "declined" });
  expect(document.querySelector("iframe")).toBeNull();
});

// ---------------------------------------------------------------------------
// Inbound message handling — synthetic postMessage simulating the paywall
// ---------------------------------------------------------------------------

const dispatchFromPaywall = (
  iframe: HTMLIFrameElement,
  events: ReadonlyArray<Record<string, unknown>>,
) => {
  const event = new MessageEvent("message", {
    data: { version: 1, payload: { events } },
    source: iframe.contentWindow,
    origin: new URL(iframe.src).origin,
  });
  globalThis.dispatchEvent(event);
};

test("close message resolves the presentation as declined", async () => {
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  dispatchFromPaywall(iframe, [{ event_name: "close" }]);
  await expect(result).resolves.toEqual({ type: "declined" });
});

test("restore message fires lifecycle events and resolves restored", async () => {
  const emitted: Array<[string, unknown]> = [];
  const presenter = createBrowserPresenter();
  const result = presenter.present(
    stubInfo(),
    newCtx({ emit: (name, detail) => emitted.push([name, detail]) }),
  );
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  dispatchFromPaywall(iframe, [{ event_name: "restore" }]);
  await expect(result).resolves.toEqual({ type: "restored" });

  const names = emitted.map(([n]) => n);
  expect(names).toContain("restore_start");
  expect(names).toContain("restore_complete");
});

test("origin filter drops messages from the wrong origin", async () => {
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  // Wrong origin — must be dropped (presentation stays open).
  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: { version: 1, payload: { events: [{ event_name: "close" }] } },
      source: iframe.contentWindow,
      origin: "https://attacker.example.test",
    }),
  );
  await flushMessages();
  expect(document.querySelector("iframe")).not.toBeNull();

  // Right origin — closes.
  dispatchFromPaywall(iframe, [{ event_name: "close" }]);
  await expect(result).resolves.toEqual({ type: "declined" });
});

test("source filter drops messages whose source isn't the iframe", async () => {
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: { version: 1, payload: { events: [{ event_name: "close" }] } },
      source: globalThis as unknown as MessageEventSource,
      origin: new URL(iframe.src).origin,
    }),
  );
  await flushMessages();
  expect(document.querySelector("iframe")).not.toBeNull();

  dispatchFromPaywall(iframe, [{ event_name: "close" }]);
  await expect(result).resolves.toEqual({ type: "declined" });
});

test("unknown version is dropped", async () => {
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: { version: 99, payload: { events: [{ event_name: "close" }] } },
      source: iframe.contentWindow,
      origin: new URL(iframe.src).origin,
    }),
  );
  await flushMessages();
  expect(document.querySelector("iframe")).not.toBeNull();

  dispatchFromPaywall(iframe, [{ event_name: "close" }]);
  await result;
});

// ---------------------------------------------------------------------------
// Test mode purchase flow
// ---------------------------------------------------------------------------

test("test mode purchase with onTestPurchase=purchased resolves as purchased", async () => {
  const presenter = createBrowserPresenter({
    testMode: true,
    onTestPurchase: async () => "purchased",
  });
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  dispatchFromPaywall(iframe, [
    {
      event_name: "purchase",
      product_identifier: "pro_yearly",
      should_dismiss: true,
    },
  ]);

  const r = await result;
  expect(r).toEqual({ type: "purchased", productId: "pro_yearly" });
});

test("test mode purchase with onTestPurchase=declined keeps paywall open", async () => {
  let abandonCount = 0;
  const presenter = createBrowserPresenter({
    testMode: true,
    onTestPurchase: async () => "declined",
  });
  const presentation = presenter.present(
    stubInfo(),
    newCtx({
      emit: (name) => {
        if (name === "transaction_abandon") abandonCount++;
      },
    }),
  );
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  dispatchFromPaywall(iframe, [
    { event_name: "purchase", product_identifier: "p1", should_dismiss: true },
  ]);
  await flushMessages();

  // Still presented.
  expect(document.querySelector("iframe")).not.toBeNull();
  expect(abandonCount).toBe(1);

  // Dismiss to clean up.
  presenter.dismiss();
  await presentation;
});

test("test mode purchase with should_dismiss=false stays open after purchase resolves", async () => {
  const purchases: string[] = [];
  const presenter = createBrowserPresenter({
    testMode: true,
    onTestPurchase: async () => "purchased",
  });
  const presentation = presenter.present(
    stubInfo(),
    newCtx({
      emit: (name, detail) => {
        if (name === "transaction_complete") {
          purchases.push((detail as { product_identifier: string }).product_identifier);
        }
      },
    }),
  );
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;

  dispatchFromPaywall(iframe, [
    { event_name: "purchase", product_identifier: "addon", should_dismiss: false },
  ]);
  await flushMessages();

  expect(purchases).toEqual(["addon"]);
  expect(document.querySelector("iframe")).not.toBeNull(); // still open

  presenter.dismiss();
  await presentation;
});

// ---------------------------------------------------------------------------
// open_url_external — opens a new tab via window.open
// ---------------------------------------------------------------------------

test("custom_placement is forwarded via ctx.emit (P1)", async () => {
  const emitted: Array<{ name: string; detail: unknown }> = [];
  const presenter = createBrowserPresenter();
  const presentation = presenter.present(
    stubInfo("pw_a"),
    newCtx({
      emit: (name, detail) => emitted.push({ name, detail }),
    }),
  );
  await tick();
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  dispatchFromPaywall(iframe, [
    {
      event_name: "custom_placement",
      name: "upsell_clicked",
      params: { upgrade: "yearly" },
    },
  ]);
  await flushMessages();

  const cp = emitted.find((e) => e.name === "custom_placement");
  expect(cp).toBeDefined();
  const detail = cp!.detail as {
    placementName: string;
    paywall_info: { identifier: string };
    params: Record<string, unknown>;
  };
  expect(detail.placementName).toBe("upsell_clicked");
  expect(detail.paywall_info.identifier).toBe("pw_a");
  expect(detail.params).toEqual({ upgrade: "yearly" });

  presenter.dismiss();
  await presentation;
});

test("open_url_external calls globalThis.open with the url", async () => {
  const opened: Array<[string, string | undefined, string | undefined]> = [];
  const originalOpen = globalThis.open;
  // happy-dom's open returns a Window proxy; replace with a recorder.
  (globalThis as { open: typeof open }).open = ((
    url: string,
    target?: string,
    features?: string,
  ) => {
    opened.push([url, target, features]);
    return null as unknown as Window;
  }) as typeof open;

  try {
    const presenter = createBrowserPresenter();
    const presentation = presenter.present(stubInfo(), newCtx());
    await tick();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    dispatchFromPaywall(iframe, [
      { event_name: "open_url_external", url: "https://help.example.com" },
    ]);
    await flushMessages();

    expect(opened).toEqual([
      ["https://help.example.com", "_blank", "noopener"],
    ]);

    presenter.dismiss();
    await presentation;
  } finally {
    (globalThis as { open: typeof open }).open = originalOpen;
  }
});

// ---------------------------------------------------------------------------
// Backdrop click closes (modal mode default)
// ---------------------------------------------------------------------------

test("modal backdrop click resolves declined when closeOnBackdrop is true (default)", async () => {
  const presenter = createBrowserPresenter();
  const result = presenter.present(stubInfo(), newCtx());
  await tick();
  const overlay = document.querySelector(
    '[data-sw-presenter="overlay"]',
  ) as HTMLDivElement;
  // Click the overlay itself (not the iframe inside).
  overlay.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await expect(result).resolves.toEqual({ type: "declined" });
});

test("closeOnBackdrop=false does NOT dismiss on backdrop click", async () => {
  const presenter = createBrowserPresenter({ closeOnBackdrop: false });
  const presentation = presenter.present(stubInfo(), newCtx());
  await tick();
  const overlay = document.querySelector(
    '[data-sw-presenter="overlay"]',
  ) as HTMLDivElement;
  overlay.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flushMessages();
  expect(document.querySelector("iframe")).not.toBeNull();
  presenter.dismiss();
  await presentation;
});

test("preload(): mounts a hidden iframe and removes it after load", async () => {
  const presenter = createBrowserPresenter();
  const info = {
    ...stubInfo("pw_warm"),
  };
  const done = presenter.preload!(info);
  const preloadFrame = document.querySelector(
    'iframe[data-sw-preload="pw_warm"]',
  ) as HTMLIFrameElement | null;
  expect(preloadFrame).not.toBeNull();
  expect(preloadFrame!.style.opacity).toBe("0");
  // Simulate load → cleanup runs.
  preloadFrame!.dispatchEvent(new Event("load"));
  await done;
  expect(
    document.querySelector('iframe[data-sw-preload="pw_warm"]'),
  ).toBeNull();
});
