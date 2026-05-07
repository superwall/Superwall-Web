// `createBrowserPresenter` — default `PaywallPresenter` for the browser.
// Mounts an iframe overlay and bridges the v1 postMessage contract (API.md §7.2).

import type {
  PaywallInfo,
  PaywallResult,
  Product,
} from "../types.ts";
import type {
  PaywallBootstrap,
  PaywallPresenter,
  PresentationContext,
} from "../presenter.ts";

export interface BrowserPresenterOptions {
  /** "modal" centers the iframe with a backdrop; "fullscreen" fills the
   *  viewport. Default: "modal". */
  presentation?: "modal" | "fullscreen";
  /** Where to mount the overlay portal. Default: `document.body`. */
  container?: HTMLElement | (() => HTMLElement);
  /** Backdrop click closes the paywall (modal only). Default: true. */
  closeOnBackdrop?: boolean;
  /** z-index for the overlay container. Default: 2147483000. */
  zIndex?: number;
  /** Test-mode override: instead of `window.confirm`, call this with the
   *  product. Resolve with `"purchased"` to simulate a successful purchase
   *  or `"declined"` to cancel. */
  onTestPurchase?: (product: Product) => Promise<"purchased" | "declined">;
  /** Whether the SDK is in test mode; intercepts purchase clicks. Default: false. */
  testMode?: boolean;
}

const DEFAULT_Z_INDEX = 2147483000;

export const createBrowserPresenter = (
  options: BrowserPresenterOptions = {},
): PaywallPresenter => {
  let active: ActivePresentation | null = null;

  const present: PaywallPresenter["present"] = (info, ctx) => {
    if (typeof document === "undefined") {
      return Promise.reject(
        new Error("createBrowserPresenter requires a DOM (no `document` available)"),
      );
    }
    if (active !== null) {
      // Defensive — core normally enforces the single-paywall invariant.
      return Promise.reject(
        new Error("BrowserPresenter is already presenting a paywall"),
      );
    }

    warnHostPolicyOnce(ctx);
    return new Promise<PaywallResult>((resolve, reject) => {
      const onTearDown = (a: ActivePresentation) => {
        if (active === a) active = null;
      };
      const a = mount(
        info,
        ctx,
        options,
        resolve,
        reject,
        onTearDown,
      );
      active = a;
      // sw.dismiss / sw.dispose → tear down and resolve declined.
      const onAbort = () => {
        if (active === a) {
          active = null;
          tearDown(a);
          resolve({ type: "declined" });
        }
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const dismiss: PaywallPresenter["dismiss"] = () => {
    if (active === null) return;
    const a = active;
    active = null;
    tearDown(a);
    a.resolve({ type: "declined" });
  };

  /** Warm a paywall by firing a hidden iframe. The iframe is removed once
   *  the URL has loaded — bytes stay in the browser HTTP cache so the next
   *  `present(info)` for the same URL avoids the network round-trip.
   *  No-op on SSR. iOS Safari throttles hidden iframes; cache warming is
   *  best-effort there. */
  const preload: NonNullable<PaywallPresenter["preload"]> = (info) =>
    new Promise<void>((resolve) => {
      if (typeof document === "undefined") {
        resolve();
        return;
      }
      const url = buildPaywallUrl(info, options.testMode === true, undefined);
      const iframe = document.createElement("iframe");
      iframe.dataset["swPreload"] = info.identifier;
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      Object.assign(iframe.style, {
        position: "absolute",
        width: "1px",
        height: "1px",
        opacity: "0",
        pointerEvents: "none",
        border: "0",
        left: "-9999px",
        top: "-9999px",
      });
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        try {
          iframe.remove();
        } catch {}
        resolve();
      };
      iframe.addEventListener("load", cleanup, { once: true });
      iframe.addEventListener("error", cleanup, { once: true });
      // Hard cap so a never-loading iframe doesn't leak.
      setTimeout(cleanup, 8_000);
      iframe.src = url;
      try {
        (options.container && typeof options.container !== "function"
          ? options.container
          : document.body
        ).appendChild(iframe);
      } catch {
        cleanup();
      }
    });

  return { present, dismiss, preload };
};

interface ActivePresentation {
  readonly overlay: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
  readonly paywallOrigin: string;
  readonly messageListener: (e: MessageEvent) => void;
  readonly resolve: (r: PaywallResult) => void;
  readonly ctx: PresentationContext;
}

const resolveContainer = (
  options: BrowserPresenterOptions,
): HTMLElement => {
  if (options.container) {
    return typeof options.container === "function"
      ? options.container()
      : options.container;
  }
  return document.body;
};

/** Append §7.3 query params + identity bootstrap. User context is also
 *  re-injected post-load via `paywall.accept64`; the URL params are what
 *  the SSR loader uses to mint the placement session token AND what the
 *  paywall server uses to switch routing (`client_surface=web-sdk`). */
const buildPaywallUrl = (
  info: PaywallInfo,
  debug: boolean,
  bootstrap: PaywallBootstrap | undefined,
): string => {
  const apply = (url: URL) => {
    url.searchParams.set("platform", "web");
    url.searchParams.set("transport", "web");
    url.searchParams.set("debug", debug ? "true" : "false");
    if (bootstrap) {
      url.searchParams.set("api_key", bootstrap.apiKey);
      url.searchParams.set("client_surface", bootstrap.clientSurface);
      url.searchParams.set("sdk_version", bootstrap.sdkVersion);
      if (bootstrap.appUserId) {
        url.searchParams.set("app_user_id", bootstrap.appUserId);
      }
      if (bootstrap.aliasId) {
        url.searchParams.set("alias_id", bootstrap.aliasId);
      }
      if (bootstrap.email) {
        url.searchParams.set("email", bootstrap.email);
      }
      if (bootstrap.deviceId) {
        url.searchParams.set("device_id", bootstrap.deviceId);
      }
      if (bootstrap.hostOrigin) {
        url.searchParams.set("host_origin", bootstrap.hostOrigin);
      }
    }
  };
  try {
    const url = new URL(info.url);
    apply(url);
    return url.toString();
  } catch {
    // Relative or malformed URL — fall back to manual append. Best-effort,
    // skip bootstrap to avoid double-encoding edge cases.
    const sep = info.url.includes("?") ? "&" : "?";
    return `${info.url}${sep}platform=web&transport=web&debug=${debug ? "true" : "false"}`;
  }
};

/** One-time dev-mode advisory: browsers can't expose top-frame
 *  Permissions-Policy / CSP headers via JS, so this is informational
 *  rather than a real check. Surface the merchant-side requirements
 *  so they can wire them up. Skipped in test mode and after the first
 *  call. No-op outside a browser. */
let _hostPolicyWarned = false;
const warnHostPolicyOnce = (ctx: PresentationContext): void => {
  if (_hostPolicyWarned) return;
  _hostPolicyWarned = true;
  if (typeof console === "undefined" || typeof window === "undefined") return;
  const tenant = (() => {
    try {
      return new URL(ctx.bootstrap?.hostOrigin ?? window.location.href).host;
    } catch {
      return "your tenant";
    }
  })();
  const paywallOrigin = "https://*.superwall.app";
  // Group header so it's collapsible — keeps the console clean for everyone
  // not chasing checkout setup issues.
  try {
    console.groupCollapsed(
      "[Superwall] Web SDK host policy checklist (info; cannot be auto-verified)",
    );
    console.info(
      `Permissions-Policy: payment=(self "${paywallOrigin}")`,
    );
    console.info(
      `Content-Security-Policy: frame-src ${paywallOrigin} https://js.stripe.com https://hooks.stripe.com; script-src https://js.stripe.com; connect-src https://api.stripe.com https://m.stripe.network ${paywallOrigin}`,
    );
    console.info(
      `Tenant: ${tenant} — required for Apple Pay / Google Pay inside the embedded checkout iframe.`,
    );
    console.groupEnd();
  } catch {}
};

const originOf = (urlStr: string): string => {
  try {
    return new URL(urlStr).origin;
  } catch {
    return "";
  }
};

const mount = (
  info: PaywallInfo,
  ctx: PresentationContext,
  options: BrowserPresenterOptions,
  resolve: (r: PaywallResult) => void,
  _reject: (e: Error) => void,
  onTearDown: (a: ActivePresentation) => void,
): ActivePresentation => {
  const isModal = (options.presentation ?? "modal") === "modal";
  const closeOnBackdrop = options.closeOnBackdrop ?? true;
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;

  const overlay = document.createElement("div");
  overlay.dataset["swPresenter"] = "overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: String(zIndex),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: isModal ? "rgba(0,0,0,0.6)" : "transparent",
  });

  const iframe = document.createElement("iframe");
  iframe.dataset["swPresenter"] = "iframe";
  // `payment *` (wildcard scope) is required for the nested Stripe iframe
  // to render Apple/Google Pay sheets. `publickey-credentials-get *` enables
  // passkey-based Link autofill where supported.
  iframe.allow = "payment *; publickey-credentials-get *";
  iframe.src = buildPaywallUrl(info, options.testMode === true, ctx.bootstrap);
  Object.assign(iframe.style, {
    border: "0",
    background: "transparent",
    // Modal: tall sheet sized for typical paywall content. Was 420x640;
    // most production paywalls bottom-out around 1100px tall on desktop
    // and need at least ~480px wide for product cards to lay out.
    width: isModal ? "min(480px, 96vw)" : "100vw",
    height: isModal ? "min(900px, 96vh)" : "100vh",
    borderRadius: isModal ? "12px" : "0",
    boxShadow: isModal ? "0 16px 48px rgba(0,0,0,0.32)" : "none",
    display: "block",
  });
  overlay.appendChild(iframe);

  const container = resolveContainer(options);
  container.appendChild(overlay);

  const paywallOrigin = originOf(iframe.src);

  // Forward ref: listeners need `a` before it's constructed.
  const slot: { a: ActivePresentation | null } = { a: null };

  const cleanupOnce = () => {
    const a = slot.a;
    if (!a) return;
    slot.a = null;
    onTearDown(a);
    tearDown(a);
  };

  if (isModal && closeOnBackdrop) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && slot.a) {
        const a = slot.a;
        cleanupOnce();
        a.resolve({ type: "declined" });
      }
    });
  }

  const messageListener = (event: MessageEvent) => {
    if (!slot.a) return;
    if (event.source !== iframe.contentWindow) return;
    if (paywallOrigin && event.origin !== paywallOrigin) return;
    handleInbound(
      event.data,
      info,
      ctx,
      options,
      resolve,
      cleanupOnce,
      slot.a,
    );
  };
  // `globalThis` instead of `window` so this works under happy-dom / RN Web.
  (globalThis as unknown as EventTarget).addEventListener(
    "message",
    messageListener as EventListener,
  );

  const a: ActivePresentation = {
    overlay,
    iframe,
    paywallOrigin,
    messageListener,
    resolve,
    ctx,
  };
  slot.a = a;
  return a;
};

const tearDown = (a: ActivePresentation) => {
  try {
    (globalThis as unknown as EventTarget).removeEventListener(
      "message",
      a.messageListener as EventListener,
    );
  } catch {}
  try {
    a.overlay.remove();
  } catch {}
};

// Inbound v1 envelope handling — see API.md §7.2

interface V1Envelope {
  version?: number;
  payload?: { events?: ReadonlyArray<{ event_name?: string; [k: string]: unknown }> };
}

const readString = (
  evt: { [k: string]: unknown },
  key: string,
): string | null => (typeof evt[key] === "string" ? (evt[key] as string) : null);

const readTransactionData = (
  evt: { [k: string]: unknown },
):
  | {
      transactionId: string;
      productIdentifier: string;
      currency?: string;
      value?: number;
    }
  | undefined => {
  const td = evt["transactionData"];
  if (!td || typeof td !== "object") return undefined;
  const obj = td as Record<string, unknown>;
  if (
    typeof obj["transactionId"] !== "string" ||
    typeof obj["productIdentifier"] !== "string"
  ) {
    return undefined;
  }
  const out: {
    transactionId: string;
    productIdentifier: string;
    currency?: string;
    value?: number;
  } = {
    transactionId: obj["transactionId"],
    productIdentifier: obj["productIdentifier"],
  };
  if (typeof obj["currency"] === "string") out.currency = obj["currency"];
  if (typeof obj["value"] === "number") out.value = obj["value"];
  return out;
};

const readTransactionField = (
  evt: { [k: string]: unknown },
  key: "productIdentifier" | "transactionId",
): string | null => {
  const td = evt["transactionData"];
  if (!td || typeof td !== "object") return null;
  const v = (td as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
};

const readEntitlements = (
  evt: { [k: string]: unknown },
): ReadonlyArray<{ id: string; productIds?: string[] }> | undefined => {
  const raw = evt["entitlements"];
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ id: string; productIds?: string[] }> = [];
  for (const e of raw) {
    if (e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string") {
      const entry: { id: string; productIds?: string[] } = {
        id: (e as { id: string }).id,
      };
      const pids = (e as { productIds?: unknown }).productIds;
      if (Array.isArray(pids)) {
        entry.productIds = pids.filter((p): p is string => typeof p === "string");
      }
      out.push(entry);
    }
  }
  return out;
};

const handleInbound = (
  data: unknown,
  info: PaywallInfo,
  ctx: PresentationContext,
  options: BrowserPresenterOptions,
  resolve: (r: PaywallResult) => void,
  cleanup: () => void,
  active: ActivePresentation,
): void => {
  const env = data as V1Envelope;
  if (!env || typeof env !== "object") return;
  const version = env.version ?? 1;
  if (version !== 1) return;
  const events = env.payload?.events;
  if (!Array.isArray(events)) return;

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const name = evt.event_name;
    if (typeof name !== "string") continue;

    switch (name) {
      case "ping":
      case "template_params_and_user_attributes": {
        sendTemplates(info, ctx, active);
        break;
      }
      case "close": {
        cleanup();
        resolve({ type: "declined" });
        return;
      }
      case "restore": {
        ctx.emit("restore_start", {});
        ctx.emit("restore_complete", {});
        cleanup();
        resolve({ type: "restored" });
        return;
      }
      case "restore_failed": {
        ctx.emit("restore_fail", { reason: String((evt as { reason?: unknown }).reason ?? "") });
        // Stay open on failure.
        break;
      }
      case "purchase": {
        const productIdentifier =
          typeof evt["product_identifier"] === "string"
            ? (evt["product_identifier"] as string)
            : typeof evt["product"] === "string"
              ? (evt["product"] as string)
              : "";
        const shouldDismiss =
          typeof evt["should_dismiss"] === "boolean"
            ? (evt["should_dismiss"] as boolean)
            : true;
        const product: Product = {
          id: productIdentifier,
          store: "stripe", // TODO: derive from config
          entitlements: [],
        };
        handlePurchase(product, options, info, ctx, shouldDismiss, resolve, cleanup);
        return;
      }
      // Stripe checkout lifecycle from the paywall iframe's WebCheckoutController.
      // Routed internally via ctx.onPurchaseEvent → SDK PurchaseController.
      // Not surfaced as public events.
      case "stripe_checkout_start": {
        const productId = readString(evt, "product_identifier") ?? readString(evt, "product") ?? "";
        ctx.onPurchaseEvent?.({ type: "start", productId });
        break;
      }
      case "stripe_checkout_submit": {
        const productId = readString(evt, "product_identifier") ?? readString(evt, "product") ?? "";
        ctx.onPurchaseEvent?.({ type: "submit", productId });
        break;
      }
      case "stripe_checkout_complete": {
        const productId = readString(evt, "product_identifier") ?? readString(evt, "product") ?? "";
        const sessionId = readString(evt, "session_id") ?? readString(evt, "checkout_session_id");
        const entitlements = readEntitlements(evt);
        ctx.onPurchaseEvent?.({
          type: "complete",
          productId,
          ...(sessionId !== null && { sessionId }),
          ...(entitlements && { entitlements }),
        });
        break;
      }
      case "stripe_checkout_fail": {
        const productId = readString(evt, "product_identifier") ?? readString(evt, "product") ?? "";
        const error = readString(evt, "error") ?? readString(evt, "message");
        ctx.onPurchaseEvent?.({
          type: "fail",
          productId,
          ...(error !== null && { error }),
        });
        break;
      }
      case "stripe_checkout_abandon": {
        const productId = readString(evt, "product_identifier") ?? readString(evt, "product") ?? "";
        ctx.onPurchaseEvent?.({ type: "abandon", productId });
        break;
      }
      // Terminal success signal from the paywall's WebPaywallController on
      // the `client_surface=web-sdk` branch — the controller has finished
      // its post-checkout server work (POST /checkout/session/complete,
      // redemption resolution) and would otherwise have done a top-frame
      // navigation. We resolve the purchase here.
      // ---------------------------------------------------------------
      // Two parallel terminal-success paths exist in this dispatcher and
      // they MUST stay separate:
      //   • `purchase` (line ~`case "purchase":` above) — StoreKit-style
      //     trigger from non-Stripe / observer-mode paywalls. Resolves
      //     immediately on click.
      //   • `post_checkout_complete` (this case) — Stripe-checkout flow on
      //     `client_surface=web-sdk`. Resolves AFTER the paywall's
      //     WebPaywallController finishes its server-side post-checkout
      //     work (POST /checkout/session/complete + redemption).
      // Don't unify them — a Stripe paywall fires both `purchase`
      // (intent) and `post_checkout_complete` (terminal); only the latter
      // is the real success signal.
      // ---------------------------------------------------------------
      case "post_checkout_complete": {
        const productId =
          readString(evt, "product_identifier") ??
          readTransactionField(evt, "productIdentifier") ??
          "";
        const checkoutContextId = readString(evt, "checkout_context_id") ?? "";
        const redirectUrl = readString(evt, "redirectUrl");
        const transactionData = readTransactionData(evt);
        ctx.onPurchaseEvent?.({
          type: "postCheckout",
          productId,
          checkoutContextId,
          ...(transactionData && { transactionData }),
          ...(redirectUrl !== null && { redirectUrl }),
        });
        const product: Product = {
          id: productId,
          store: "stripe",
          entitlements: [],
        };
        ctx.emit("transaction_complete", {
          product,
          paywall_info: info,
          product_identifier: productId,
          ...(transactionData?.transactionId && {
            transaction_id: transactionData.transactionId,
          }),
          ...(transactionData?.currency && { currency: transactionData.currency }),
          ...(typeof transactionData?.value === "number" && {
            value: transactionData.value,
          }),
        });
        ctx.emit("subscription_start", { product, paywall_info: info });
        if (redirectUrl) {
          // Merchant-configured post-purchase URL. We surface but never
          // navigate the host frame — the consumer decides.
          ctx.emit(
            "paywallWillOpenURL" as never,
            { url: redirectUrl } as never,
          );
        }
        cleanup();
        resolve({ type: "purchased", productId });
        return;
      }
      // The paywall's `redirect` checkout directive would otherwise do
      // `window.location.href = checkoutUrl` inside our iframe (trapping
      // the navigation). The paywall change to emit a structured
      // `redirect_required` message is open with their team — until then
      // this handler is dead code. When it lands, payload is `{ url }`
      // and we open in a new tab; the merchant can also subscribe to
      // `paywallWillOpenURL` for custom handling.
      case "redirect_required": {
        const url = readString(evt, "url");
        if (!url) break;
        ctx.emit(
          "paywallWillOpenURL" as never,
          { url } as never,
        );
        if (typeof globalThis.open === "function") {
          try {
            globalThis.open(url, "_blank", "noopener");
          } catch {}
        }
        break;
      }
      case "open_url_external": {
        const url = typeof evt["url"] === "string" ? (evt["url"] as string) : null;
        if (url && typeof globalThis.open === "function") {
          try {
            globalThis.open(url, "_blank", "noopener");
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case "open_url": {
        const url = typeof evt["url"] === "string" ? (evt["url"] as string) : null;
        if (!url) break;
        // Forward to the delegate; presenter does NOT navigate the host page.
        const browserType =
          evt["browser_type"] === "payment_sheet" ? "payment_sheet" : undefined;
        ctx.emit(
          "paywallWillOpenURL" as never,
          (browserType !== undefined
            ? { url, browserType }
            : { url }) as never,
        );
        break;
      }
      case "open_deep_link": {
        // Wire payload key is `link`, not `url`.
        const link = typeof evt["link"] === "string" ? (evt["link"] as string) : null;
        if (!link) break;
        ctx.emit(
          "paywallWillOpenDeepLink" as never,
          { url: link } as never,
        );
        break;
      }
      case "custom_placement": {
        // paywall_info is the ACTIVE paywall, captured at present() time.
        const placementName =
          typeof evt["name"] === "string" ? (evt["name"] as string) : "";
        const params =
          typeof evt["params"] === "object" && evt["params"] !== null
            ? (evt["params"] as Record<string, never>)
            : {};
        ctx.emit("custom_placement", {
          placementName,
          paywall_info: info,
          params: params as never,
        });
        break;
      }
      default:
        break;
    }
  }
};

const handlePurchase = (
  product: Product,
  options: BrowserPresenterOptions,
  _info: PaywallInfo,
  ctx: PresentationContext,
  shouldDismiss: boolean,
  resolve: (r: PaywallResult) => void,
  cleanup: () => void,
): void => {
  ctx.emit("transaction_start", {
    product,
    paywall_info: _info,
  });

  const finalize = (kind: "purchased" | "declined") => {
    if (kind === "purchased") {
      ctx.emit("transaction_complete", {
        product,
        paywall_info: _info,
        product_identifier: product.id,
      });
      // Emit `subscription_start` alongside transaction_complete. Web has
      // no trial-detection signal in observer mode, so consumers that need
      // to distinguish first-time non-trial activations from trials should
      // dedup via product id + subscriptionStatus history.
      ctx.emit("subscription_start", {
        product,
        paywall_info: _info,
      });
      if (shouldDismiss) {
        cleanup();
        resolve({ type: "purchased", productId: product.id });
      }
    } else {
      ctx.emit("transaction_abandon", {
        product,
        paywall_info: _info,
      });
      // Stay open on cancel.
    }
  };

  if (options.testMode) {
    if (options.onTestPurchase) {
      options
        .onTestPurchase(product)
        .then(finalize)
        .catch(() => finalize("declined"));
    } else {
      const ok =
        typeof confirm === "function"
          ? confirm(`Simulate purchase of ${product.id}?`)
          : true;
      finalize(ok ? "purchased" : "declined");
    }
    return;
  }

  // Non-test mode: observer-mode consumers run their own checkout and call
  // `sw.purchases.setSubscriptionStatus`. The presenter leaves the paywall open.
};

/** Send the templates bundle (API.md §7.2): products + template_variables
 *  (user, device, params, products) + substitutions prefix. The `products`
 *  array is the per-paywall slot mapping from config (verbatim — the iframe's
 *  click handler keys off the `product` slot name). The second `accept64`
 *  carries the BE-issued `paywalljs_event` (template_substitutions +
 *  page_styles); falls back to an empty stub if the paywall config didn't
 *  ship one. */
const sendTemplates = (
  info: PaywallInfo,
  ctx: PresentationContext,
  a: ActivePresentation,
): void => {
  if (!a.iframe.contentWindow) return;
  // Prefer the raw per-paywall product mapping (carries `product` slot name);
  // fall back to a synthesized list from the catalog products when absent.
  const products =
    info.rawProducts && info.rawProducts.length > 0
      ? [...info.rawProducts]
      : info.products.map((p) => ({
          product: p.id,
          productId: p.id,
          product_id: p.id,
        }));
  const variables = {
    user: ctx.user ?? {},
    device: ctx.device ?? {},
    params: ctx.params ?? {},
    products,
  };
  const payload = [
    { event_name: "products", products },
    { event_name: "template_variables", variables },
    { event_name: "template_substitutions_prefix", prefix: null },
  ];
  postAccept64(a, payload);

  // Second accept64: the BE-issued paywalljs_event (substitutions + styles)
  // forwarded verbatim. Some paywalls expect this immediately after the
  // templates bundle; not sending it leaves their click handlers reading
  // undefined `substitutions`. Falls back to an empty stub if absent.
  if (info.paywalljsEvent) {
    postRawAccept64(a, info.paywalljsEvent);
  } else {
    postAccept64(a, [
      { event_name: "template_substitutions", substitutions: [] },
      { event_name: "page_styles", pageStyles: [] },
    ]);
  }
};

const postAccept64 = (a: ActivePresentation, payload: unknown): void => {
  postRawAccept64(a, base64UrlOfJson(payload));
};

const postRawAccept64 = (a: ActivePresentation, base64: string): void => {
  const message = {
    version: 1,
    channel: "paywall.accept64",
    payload: base64,
  };
  try {
    a.iframe.contentWindow!.postMessage(message, a.paywallOrigin || "*");
  } catch {}
};

const base64UrlOfJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  // btoa only handles latin1; encode UTF-8 bytes first.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
