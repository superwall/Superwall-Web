// `createBrowserPresenter` — default `PaywallPresenter` for the browser.
//
// Mounts an iframe overlay (modal or fullscreen), bridges the v1
// `postMessage` contract from API.md §7.2, and resolves `present()` when
// the user dismisses or completes a purchase.
//
// v0 alpha intentionally implements a subset of inbound message types:
//   ping → reply with templates (empty stub for v0)
//   close → resolve as { type: "declined" }
//   restore → resolve as { type: "restored" }
//   restore_failed → no-op (logged future)
//   purchase → test-mode confirm OR observer-mode emit
//   open_url_external → window.open in a new tab
//
// Deferred to v1: request_callback / request_permission correlation,
// page_view, haptic_feedback, schedule_notification, request_store_review,
// the full `template_params_and_user_attributes` shape (we only need to
// satisfy `ping` for v0), and HTML substitutions.

import type {
  PaywallInfo,
  PaywallResult,
  Product,
} from "../types.ts";
import type {
  PaywallPresenter,
  PresentationContext,
} from "../presenter.ts";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface BrowserPresenterOptions {
  /** "modal" centers the iframe with a backdrop; "fullscreen" fills the
   *  viewport. Default: "modal". `"inline"` is deferred past v0. */
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
  /** Whether the SDK is in test mode. The factory takes this directly so
   *  the presenter can intercept purchase clicks accordingly. Defaults to
   *  false; the public Superwall instance toggles it via options. */
  testMode?: boolean;
}

// ---------------------------------------------------------------------------
// Presenter factory
// ---------------------------------------------------------------------------

const DEFAULT_Z_INDEX = 2147483000;

export const createBrowserPresenter = (
  options: BrowserPresenterOptions = {},
): PaywallPresenter => {
  // State for the in-flight presentation.
  let active: ActivePresentation | null = null;

  const present: PaywallPresenter["present"] = (info, ctx) => {
    if (typeof document === "undefined") {
      return Promise.reject(
        new Error("createBrowserPresenter requires a DOM (no `document` available)"),
      );
    }
    if (active !== null) {
      // Core enforces the single-paywall invariant before reaching here, but
      // a custom caller could bypass; reject defensively.
      return Promise.reject(
        new Error("BrowserPresenter is already presenting a paywall"),
      );
    }

    return new Promise<PaywallResult>((resolve, reject) => {
      const a = mount(info, ctx, options, resolve, reject);
      active = a;
      // External abort (sw.dismiss / sw.dispose) → tear down + resolve declined.
      const onAbort = () => {
        if (active === a) {
          tearDown(a);
          active = null;
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

  return { present, dismiss };
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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

/** Append §7.3 query params to the paywall URL. User context (alias, userId,
 *  locale, etc.) is injected post-load via `paywall.accept64`, not in the URL. */
const buildPaywallUrl = (info: PaywallInfo, debug: boolean): string => {
  try {
    const url = new URL(info.url);
    url.searchParams.set("platform", "web");
    url.searchParams.set("transport", "web");
    url.searchParams.set("debug", debug ? "true" : "false");
    return url.toString();
  } catch {
    // If `info.url` isn't parseable, fall back to a naive concat.
    const sep = info.url.includes("?") ? "&" : "?";
    return `${info.url}${sep}platform=web&transport=web&debug=${debug ? "true" : "false"}`;
  }
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
  iframe.allow = "payment";
  iframe.src = buildPaywallUrl(info, options.testMode === true);
  Object.assign(iframe.style, {
    border: "0",
    background: "transparent",
    width: isModal ? "min(420px, 96vw)" : "100vw",
    height: isModal ? "min(640px, 96vh)" : "100vh",
    borderRadius: isModal ? "12px" : "0",
    boxShadow: isModal ? "0 16px 48px rgba(0,0,0,0.32)" : "none",
  });
  overlay.appendChild(iframe);

  if (isModal && closeOnBackdrop) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        // Equivalent to a `close` postMessage from the paywall.
        const a = active$;
        if (a) {
          tearDown(a);
          active$ = null;
          a.resolve({ type: "declined" });
        }
      }
    });
  }

  const container = resolveContainer(options);
  container.appendChild(overlay);

  const paywallOrigin = originOf(iframe.src);

  // postMessage bridge — listen for paywall→SDK v1 envelopes.
  const messageListener = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (paywallOrigin && event.origin !== paywallOrigin) return;
    handleInbound(event.data, info, ctx, options, resolve, () => {
      const a = active$;
      if (a) {
        tearDown(a);
        active$ = null;
      }
    });
  };
  // Listen on `globalThis` rather than `window` so this works under
  // happy-dom / Node-with-DOM-polyfill / RN Web. They're the same in browsers.
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
  // Tracked separately so the backdrop click can reach the same tearDown.
  active$ = a;
  return a;
};

/** Module-level handle to whichever presenter call is currently in flight.
 *  The factory tracks its own `active` too — this redundancy lets the
 *  backdrop click handler (created inside `mount`) reach the right entry. */
let active$: ActivePresentation | null = null;

const tearDown = (a: ActivePresentation) => {
  try {
    (globalThis as unknown as EventTarget).removeEventListener(
      "message",
      a.messageListener as EventListener,
    );
  } catch {
    /* ignore */
  }
  try {
    a.overlay.remove();
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Inbound v1 envelope handling — see API.md §7.2
// ---------------------------------------------------------------------------

interface V1Envelope {
  version?: number;
  payload?: { events?: ReadonlyArray<{ event_name?: string; [k: string]: unknown }> };
}

const handleInbound = (
  data: unknown,
  info: PaywallInfo,
  ctx: PresentationContext,
  options: BrowserPresenterOptions,
  resolve: (r: PaywallResult) => void,
  cleanup: () => void,
): void => {
  const env = data as V1Envelope;
  if (!env || typeof env !== "object") return;
  const version = env.version ?? 1;
  if (version !== 1) return; // unknown future version — drop
  const events = env.payload?.events;
  if (!Array.isArray(events)) return;

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const name = evt.event_name;
    if (typeof name !== "string") continue;

    switch (name) {
      case "ping": {
        // Real templates land with the placement layer. v0 ack with an
        // empty templates bundle so the paywall knows the SDK heard it.
        sendTemplatesStub(ctx);
        break;
      }
      case "close": {
        cleanup();
        resolve({ type: "declined" });
        return;
      }
      case "restore": {
        // Stub — real restore goes through PurchaseController. Emit lifecycle.
        ctx.emit("restore_start", {});
        ctx.emit("restore_complete", {});
        cleanup();
        resolve({ type: "restored" });
        return;
      }
      case "restore_failed": {
        ctx.emit("restore_fail", { reason: String((evt as { reason?: unknown }).reason ?? "") });
        // Don't dismiss — the paywall stays open per Android behavior.
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
        // Build a stub Product. Real product hydration lands with config.
        const product: Product = {
          id: productIdentifier,
          store: "stripe", // TODO: derive from config
          entitlements: [],
        };
        handlePurchase(product, options, info, ctx, shouldDismiss, resolve, cleanup);
        return;
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
      // open_url, open_deep_link, custom, custom_placement, paywall_*,
      // transaction_*, request_*, page_view, haptic_feedback,
      // schedule_notification, user_attribute_updated, trial_started:
      // deferred to v1 — drop silently for v0.
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
      if (shouldDismiss) {
        cleanup();
        resolve({ type: "purchased", productId: product.id });
      }
    } else {
      ctx.emit("transaction_abandon", {
        product,
        paywall_info: _info,
      });
      // Don't dismiss on cancel — paywall stays open.
    }
  };

  if (options.testMode) {
    if (options.onTestPurchase) {
      options
        .onTestPurchase(product)
        .then(finalize)
        .catch(() => finalize("declined"));
    } else {
      // window.confirm fallback. Synchronous; resolve immediately.
      const ok =
        typeof confirm === "function"
          ? confirm(`Simulate purchase of ${product.id}?`)
          : true;
      finalize(ok ? "purchased" : "declined");
    }
    return;
  }

  // Non-test mode v0: emit `transaction_start`; observer-mode consumers
  // run their own checkout and call `sw.purchases.setSubscriptionStatus`.
  // The presenter just leaves the paywall open. (PurchaseController
  // wiring lands when that path is implemented end-to-end.)
};

/** Send an empty templates bundle to the paywall iframe. Real shape per
 *  API.md §7.2 — an array of {event_name, ...} objects. v0 sends a minimal
 *  acknowledgment so the paywall's `ping`-then-wait pattern unblocks. */
const sendTemplatesStub = (ctx: PresentationContext): void => {
  const a = active$;
  if (!a || !a.iframe.contentWindow) return;
  const payload = [
    { event_name: "products", products: [] },
    {
      event_name: "template_variables",
      variables: {
        user: {},
        device: {},
        params: ctx.params ?? {},
        products: [],
      },
    },
    { event_name: "template_substitutions_prefix", prefix: null },
  ];
  const base64 = base64UrlOfJson(payload);
  const message = {
    version: 1,
    channel: "paywall.accept64",
    payload: base64,
  };
  try {
    a.iframe.contentWindow.postMessage(
      message,
      a.paywallOrigin || "*",
    );
  } catch {
    /* iframe gone — no-op */
  }
};

const base64UrlOfJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  // btoa only handles latin1; JSON is ASCII-friendly here, but be safe.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
