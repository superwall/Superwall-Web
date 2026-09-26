// `createBrowserPresenter` — default `PaywallPresenter` for the browser.
// Mounts an iframe overlay and bridges the v1 postMessage contract (API.md §7.2).

import type {
  CheckoutCompletion,
  PaywallInfo,
  PaywallPresentationStyle,
  PaywallResult,
  Product,
} from "../types.ts";
import type {
  PaywallBootstrap,
  PaywallPresenter,
  PresentationContext,
} from "../presenter.ts";
import type { JsonValue } from "../types.ts";
import { createPaywallHost, type HostMessage, type PaywallHost } from "./host.ts";
import {
  asProductIdentifier,
  asTransactionId,
  type ProductIdentifier,
  type TransactionId,
} from "../internal/brands.ts";

export interface BrowserPresenterOptions {
  /** Where to mount the overlay portal. Default: `document.body`. */
  container?: HTMLElement | (() => HTMLElement);
  /** Backdrop click closes the paywall (styles with a scrim only).
   *  Default: true. */
  closeOnBackdrop?: boolean;
  /** z-index for the overlay container. Default: 2147483000. */
  zIndex?: number;
  /**
   * When true, the overlay uses `position: absolute` and fills the container
   * element instead of covering the full viewport. The container must have
   * `position: relative` (or any non-static position) for this to work.
   * Default: false.
   */
  inline?: boolean;
  /** When the SDK is in test mode (`options.testModeBehavior`, threaded via
   *  `ctx.testMode`), purchase clicks are intercepted with a confirm()
   *  shim instead of real checkout. Supply this to replace the confirm()
   *  with custom UI: resolve `"purchased"` to simulate success or
   *  `"declined"` to cancel. */
  onTestPurchase?: (product: Product) => Promise<"purchased" | "declined">;
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
      // sw.dismiss / sw.dispose → tear down; declined unless a checkout
      // already completed on this presentation.
      const onAbort = () => {
        if (active === a) {
          active = null;
          tearDown(a);
          resolve(a.completed ?? { type: "declined" });
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
    a.resolve(a.completed ?? { type: "declined" });
  };

  const redeemDiscount: NonNullable<PaywallPresenter["redeemDiscount"]> = (
    code,
    onPosted,
  ) => {
    const a = active;
    // The SDK guards on presentation state before calling; no active paywall
    // here means the presentation was torn down mid-call — drop it.
    if (a === null) return;
    if (!a.ready) {
      // Iframe hasn't asked for templates yet — queue and flush on ready.
      a.pendingDiscountCode = code;
      a.pendingDiscountOnPosted = onPosted ?? null;
      return;
    }
    postRedeemDiscount(a, code);
    onPosted?.();
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
      // Cache-warm only — debug flag irrelevant, no ctx available here.
      const url = buildPaywallUrl(info, false, undefined, undefined);
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

  // The paywall-next controller inside the iframe posts trigger_fire,
  // paywall_open, paywall_close and checkout transaction events itself.
  return { present, dismiss, redeemDiscount, preload, tracksLifecycleEvents: true };
};

interface ActivePresentation {
  readonly overlay: HTMLDivElement | null;
  readonly iframe: HTMLIFrameElement;
  readonly paywallOrigin: string;
  readonly messageListener: (e: MessageEvent) => void;
  readonly keydownListener: (e: KeyboardEvent) => void;
  readonly resolve: (r: PaywallResult) => void;
  readonly ctx: PresentationContext;
  /** Set on `post_checkout_complete` when the SDK owns teardown: the paywall
   *  stays up until the SDK (or the developer's `onPurchase`) dismisses it,
   *  and every close path resolves this instead of `declined`. */
  completed: PaywallResult | null;
  /** Set once the iframe has requested its templates (`ping` /
   *  `template_params_and_user_attributes`) — i.e. it's mounted and ready to
   *  accept host commands like `redeem_discount`. */
  ready: boolean;
  /** Discount code requested before `ready`, flushed once the iframe asks for
   *  templates. `null` = nothing queued; `""` = a queued clear. Only the most
   *  recent matters (the paywall replaces an applied code atomically). */
  pendingDiscountCode: string | null;
  /** `onPosted` callback paired with `pendingDiscountCode`, fired when the
   *  queued code is actually written to the iframe on flush. */
  pendingDiscountOnPosted: (() => void) | null;
  /** Set when a framework paywall's `ping` asks for a host
   *  (`host_controlled`): the SDK then does what the web paywall app's
   *  controller does for a paywall.js paywall — priced templates, lifecycle
   *  events, the post-checkout lookup. `null` for paywall.js paywalls, whose
   *  controller does all three itself. */
  host: PaywallHost | null;
  /** Lifecycle messages that arrived before the paywall's `ping` said
   *  whether it wants a host (a framework paywall reports its entry
   *  `page_view` first); replayed to the host once it exists, else dropped. */
  earlyHostMessages: HostMessage[];
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

/** Weighted random pick across `url_config.endpoints`. Single endpoint or
 *  none → uses the canonical `info.url`. Total weights normalise to whatever
 *  the BE sends; we don't enforce sum=100. */
const pickEndpoint = (info: PaywallInfo): string => {
  const endpoints = info.urlEndpoints;
  if (!endpoints || endpoints.length === 0) return info.url;
  if (endpoints.length === 1) return endpoints[0]!.url;
  const total = endpoints.reduce((acc, e) => acc + Math.max(e.percentage, 0), 0);
  if (total <= 0) return endpoints[0]!.url;
  const roll = Math.random() * total;
  let cursor = 0;
  for (const e of endpoints) {
    cursor += Math.max(e.percentage, 0);
    if (roll < cursor) return e.url;
  }
  return endpoints[endpoints.length - 1]!.url;
};

/** Append bootstrap query params + the `#init=<base64(JSON)>` hash. Query
 *  params stay as they were (`platform`, `transport`, `debug`, `api_key`,
 *  `client_surface`, identity); the hash carries runtime config the
 *  in-iframe controller needs at boot (`placementSessionToken`, `hostOrigin`,
 *  `cancelUrl`, `identity`, `collector`, `apiBase`). Hash > query for these
 *  because (a) hash isn't logged by intermediate proxies, (b) the artifact
 *  schema kept `placementSessionToken` as a field name for compat — see the
 *  paywall app's `packages/web-paywalls/src/schema/controller.ts`. */
const buildPaywallUrl = (
  info: PaywallInfo,
  debug: boolean,
  bootstrap: PaywallBootstrap | undefined,
  initPayload: Record<string, unknown> | undefined,
): string => {
  const base = pickEndpoint(info);
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
      // SDK-built payload takes precedence; fallback shape is the legacy
      // bootstrap-derived hash (used by tests that don't construct the
      // full payload).
      // Standard base64 (not base64url) — the in-iframe controller decodes
      // with plain `atob()` which rejects URL-safe alphabet / missing
      // padding. Fragment characters `+` `/` `=` are RFC-3986-safe.
      url.hash = initPayload
        ? `init=${base64OfJson(initPayload)}`
        : buildInitHash(bootstrap);
    }
  };
  try {
    const url = new URL(base);
    apply(url);
    return url.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}platform=web&transport=web&debug=${debug ? "true" : "false"}`;
  }
};

/** Build the `#init=<base64>` hash payload. Mirrors the controller schema
 *  at `packages/web-paywalls/src/schema/controller.ts:49-69` — identity
 *  nests under `collector`, `userId` is a discriminated union, `deviceId`
 *  is always the persisted UUID. */
const buildInitHash = (b: PaywallBootstrap): string => {
  // `userId` flips to `appUserId` only when the merchant has explicitly
  // called `sw.identify(...)`. Anonymous users get the alias variant —
  // never both, never omitted (controller destructures non-defensively).
  const userId =
    b.appUserId && b.appUserId !== b.aliasId
      ? ({ type: "appUserId" as const, appUserId: b.appUserId })
      : ({ type: "aliasId" as const, aliasId: b.aliasId ?? "" });
  const payload: Record<string, unknown> = {
    // Field name kept for artifact-schema stability — in WEBAPP mode this
    // carries the raw pk_*, not a signed session token.
    placementSessionToken: b.apiKey,
    hostOrigin: b.hostOrigin ?? "",
    cancelUrl: b.cancelUrl ?? b.hostOrigin ?? "",
    apiBase: b.apiBase,
    collector: {
      url: b.collector,
      identity: {
        userId,
        deviceId: b.deviceId ?? "",
      },
    },
  };
  return `init=${base64OfJson(payload)}`;
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

interface PresentationSpec {
  readonly overlayAlignItems: "flex-end" | "center" | "stretch";
  readonly overlayJustifyContent: "center" | "stretch";
  readonly overlayBackground: string;
  readonly iframeWidth: string;
  readonly iframeHeight: string;
  readonly iframeBorderRadius: string;
  readonly iframeBoxShadow: string;
  /** Per-frame initial transform/opacity, animated to identity on mount. */
  readonly enter: "none" | "fade" | "slide-up" | "slide-right";
}

const DROP_SHADOW = "0 16px 48px rgba(0,0,0,0.32)";
const SCRIM = "rgba(0,0,0,0.6)";
const ENTER_DURATION_MS = 220;

const specFor = (style: PaywallPresentationStyle): PresentationSpec => {
  switch (style.type) {
    case "MODAL":
      // Bottom sheet — full-width, tall content sheet that pins to the
      // bottom of the viewport.
      return {
        overlayAlignItems: "flex-end",
        overlayJustifyContent: "center",
        overlayBackground: SCRIM,
        iframeWidth: "min(480px, 96vw)",
        iframeHeight: "min(900px, 96vh)",
        iframeBorderRadius: "12px 12px 0 0",
        iframeBoxShadow: "0 -16px 48px rgba(0,0,0,0.32)",
        enter: "slide-up",
      };
    case "DRAWER":
      return {
        overlayAlignItems: "flex-end",
        overlayJustifyContent: "center",
        overlayBackground: SCRIM,
        iframeWidth: "100vw",
        iframeHeight: `${style.height}vh`,
        iframeBorderRadius: `${style.cornerRadius}px ${style.cornerRadius}px 0 0`,
        iframeBoxShadow: "0 -16px 48px rgba(0,0,0,0.32)",
        enter: "slide-up",
      };
    case "POPUP":
      return {
        overlayAlignItems: "center",
        overlayJustifyContent: "center",
        overlayBackground: SCRIM,
        iframeWidth: `${style.width}vw`,
        iframeHeight: `${style.height}vh`,
        iframeBorderRadius: `${style.cornerRadius}px`,
        iframeBoxShadow: DROP_SHADOW,
        enter: "fade",
      };
    case "FULLSCREEN":
      return {
        overlayAlignItems: "stretch",
        overlayJustifyContent: "stretch",
        overlayBackground: "transparent",
        iframeWidth: "100vw",
        iframeHeight: "100vh",
        iframeBorderRadius: "0",
        iframeBoxShadow: "none",
        enter: "fade",
      };
    case "PUSH":
      return {
        overlayAlignItems: "stretch",
        overlayJustifyContent: "stretch",
        overlayBackground: "transparent",
        iframeWidth: "100vw",
        iframeHeight: "100vh",
        iframeBorderRadius: "0",
        iframeBoxShadow: "none",
        enter: "slide-right",
      };
    case "NO_ANIMATION":
    case "NONE":
      return {
        overlayAlignItems: "stretch",
        overlayJustifyContent: "stretch",
        overlayBackground: "transparent",
        iframeWidth: "100vw",
        iframeHeight: "100vh",
        iframeBorderRadius: "0",
        iframeBoxShadow: "none",
        enter: "none",
      };
  }
};

const initialTransformFor = (enter: PresentationSpec["enter"]): string => {
  switch (enter) {
    case "slide-up":
      return "translateY(100%)";
    case "slide-right":
      return "translateX(100%)";
    case "fade":
    case "none":
      return "none";
  }
};

// Use globalThis so this works under happy-dom / RN Web without double-casting at every call site.
const globalEvents = (): EventTarget =>
  typeof window !== "undefined" ? window : (globalThis as unknown as EventTarget);

const mount = (
  info: PaywallInfo,
  ctx: PresentationContext,
  options: BrowserPresenterOptions,
  resolve: (r: PaywallResult) => void,
  _reject: (e: Error) => void,
  onTearDown: (a: ActivePresentation) => void,
): ActivePresentation => {
  const style: PaywallPresentationStyle =
    info.presentationStyle ?? { type: "MODAL" };
  const spec = specFor(style);
  const closeOnBackdrop = options.closeOnBackdrop ?? true;
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;

  const overlay = options.inline ? null : document.createElement("div");
  if (overlay) {
    overlay.dataset["swPresenter"] = "overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: String(zIndex),
      display: "flex",
      alignItems: spec.overlayAlignItems,
      justifyContent: spec.overlayJustifyContent,
      background: spec.overlayBackground,
    });
  }

  const iframe = document.createElement("iframe");
  iframe.dataset["swPresenter"] = "iframe";
  // `payment *` (wildcard scope) is required for the nested Stripe iframe
  // to render Apple/Google Pay sheets. `publickey-credentials-get *` enables
  // passkey-based Link autofill where supported.
  iframe.allow = "payment *; publickey-credentials-get *";
  if (!ctx.bootstrap && typeof console !== "undefined") {
    // No bootstrap = the paywall server can't tell we're the Web SDK and
    // will route post-checkout completion via window.location.href inside
    // this iframe.
    console.warn(
      "[Superwall] presenter received no ctx.bootstrap — iframe URL will lack client_surface=web-sdk and post-checkout will trap-navigate inside the iframe.",
    );
  }
  iframe.src = buildPaywallUrl(
    info,
    ctx.testMode === true,
    ctx.bootstrap,
    ctx.initPayload,
  );
  const initialTransform = initialTransformFor(spec.enter);
  const initialOpacity = spec.enter === "fade" ? "0" : "1";
  Object.assign(iframe.style, {
    border: "0",
    background: "transparent",
    width: options.inline ? "100%" : spec.iframeWidth,
    height: options.inline ? "100%" : spec.iframeHeight,
    borderRadius: options.inline ? "0" : spec.iframeBorderRadius,
    boxShadow: options.inline ? "none" : spec.iframeBoxShadow,
    display: "block",
    transform: initialTransform,
    opacity: initialOpacity,
    transition:
      spec.enter === "none"
        ? "none"
        : `transform ${ENTER_DURATION_MS}ms ease-out, opacity ${ENTER_DURATION_MS}ms ease-out`,
  });

  const container = resolveContainer(options);
  if (overlay) {
    overlay.appendChild(iframe);
    container.appendChild(overlay);
  } else {
    container.appendChild(iframe);
  }

  // Animate to identity on next frame so the browser actually transitions
  // from the initial transform/opacity to the rest state.
  if (spec.enter !== "none" && typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => {
      iframe.style.transform = "none";
      iframe.style.opacity = "1";
    });
  }

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

  if (overlay && spec.overlayBackground !== "transparent" && closeOnBackdrop) {
    // Dismiss when the click lands on the backdrop itself OR anywhere
    // outside the iframe card. `e.target === overlay` alone is too strict
    // when the overlay holds extra wrapper elements (close button, etc.);
    // checking that the target isn't inside the iframe is the more
    // reliable test.
    overlay.addEventListener("click", (e) => {
      if (!slot.a) return;
      const target = e.target as Node | null;
      if (target && iframe.contains(target)) return;
      const a = slot.a;
      cleanupOnce();
      a.resolve(a.completed ?? { type: "declined" });
    });
  }
  // Escape key as a backup close — useful when the backdrop click handler
  // can't fire (transparent overlay, fullscreen iframe, etc.). Listener is
  // removed in tearDown so multiple paywalls don't accumulate keymaps.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!slot.a) return;
    const a = slot.a;
    cleanupOnce();
    a.resolve(a.completed ?? { type: "declined" });
  };
  globalEvents().addEventListener(
    "keydown",
    onKeydown as EventListener,
  );

  const messageListener = (event: MessageEvent) => {
    if (!slot.a) return;
    // Origin + source guards: only accept messages from the paywall iframe.
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
  globalEvents().addEventListener(
    "message",
    messageListener as EventListener,
  );

  const a: ActivePresentation = {
    overlay,
    iframe,
    paywallOrigin,
    messageListener,
    keydownListener: onKeydown,
    resolve,
    ctx,
    completed: null,
    ready: false,
    pendingDiscountCode: null,
    pendingDiscountOnPosted: null,
    host: null,
    earlyHostMessages: [],
  };
  slot.a = a;
  return a;
};

const tearDown = (a: ActivePresentation) => {
  try {
    globalEvents().removeEventListener(
      "message",
      a.messageListener as EventListener,
    );
  } catch (e) {
    console.warn("[Superwall] tearDown cleanup failed:", e);
  }
  try {
    globalEvents().removeEventListener(
      "keydown",
      a.keydownListener as EventListener,
    );
  } catch (e) {
    console.warn("[Superwall] tearDown cleanup failed:", e);
  }
  try {
    (a.overlay ?? a.iframe).remove();
  } catch (e) {
    console.warn("[Superwall] tearDown cleanup failed:", e);
  }
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

function readTransactionField(evt: { [k: string]: unknown }, key: "product_identifier"): ProductIdentifier | null;
function readTransactionField(evt: { [k: string]: unknown }, key: "transaction_id"): TransactionId | null;
function readTransactionField(
  evt: { [k: string]: unknown },
  key: "product_identifier" | "transaction_id",
): ProductIdentifier | TransactionId | null {
  const td = evt["transaction_data"];
  if (!td || typeof td !== "object") return null;
  const v = (td as Record<string, unknown>)[key];
  if (typeof v !== "string") return null;
  return key === "product_identifier" ? asProductIdentifier(v) : asTransactionId(v);
}

/** Parse a `post_checkout_complete` message into the public payload. Every
 *  field is read defensively — a malformed optional field is dropped, never
 *  thrown on. */
const readCheckoutCompletion = (
  evt: { [k: string]: unknown },
): CheckoutCompletion => {
  const productId = String(
    readString(evt, "product_identifier") ??
      readTransactionField(evt, "product_identifier") ??
      "",
  );
  const transactionId = readTransactionField(evt, "transaction_id");
  const td = (evt["transaction_data"] ?? {}) as Record<string, unknown>;
  const rawCodes = evt["redemption_codes"];
  const rawLinks = evt["deep_links"];
  const links =
    rawLinks && typeof rawLinks === "object"
      ? (rawLinks as Record<string, unknown>)
      : null;
  const ios = links && typeof links["ios"] === "string" ? links["ios"] : null;
  const android =
    links && typeof links["android"] === "string" ? links["android"] : null;
  const redirectUrl = readString(evt, "redirect_url");
  const entitlementsToken = readString(evt, "entitlements_token");
  return {
    productId,
    checkoutContextId: readString(evt, "checkout_context_id") ?? "",
    // Only an explicit `false` means "minted but not claimed". A paywall that
    // predates the field granted access server-side, and redeeming its codes
    // here would spend one the buyer could use on their phone.
    claimed: evt["claimed"] !== false,
    ...(transactionId !== null && {
      transaction: {
        transactionId: String(transactionId),
        productIdentifier: String(
          readTransactionField(evt, "product_identifier") ?? productId,
        ),
        ...(typeof td["currency"] === "string" && { currency: td["currency"] }),
        ...(typeof td["value"] === "number" && { value: td["value"] }),
      },
    }),
    redemptionCodes: Array.isArray(rawCodes)
      ? rawCodes.filter((c): c is string => typeof c === "string")
      : [],
    ...(redirectUrl !== null && { redirectUrl }),
    ...((ios !== null || android !== null) && {
      deepLinks: {
        ...(ios !== null && { ios }),
        ...(android !== null && { android }),
      },
    }),
    ...(entitlementsToken !== null && { entitlementsToken }),
  };
};

/** Read the product identifier from an iframe event, returning a branded type. */
const readProductId = (evt: { [k: string]: unknown }): ProductIdentifier =>
  asProductIdentifier(
    readString(evt, "product_identifier") ?? readString(evt, "product") ?? "",
  );

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
  if (!data || typeof data !== "object") return;
  // Two wire shapes from the paywall side:
  //   (a) v1 envelope — `{ version: 1, payload: { events: [{event_name, ...}] } }`
  //       used for templates / lifecycle batches.
  //   (b) flat single event — `{ event_name, ...fields }` used by the in-iframe
  //       WebPaywallController's `postMessageToHost` (e.g. `post_checkout_complete`).
  // Normalise both into an `events` array before dispatch.
  const env = data as V1Envelope & { event_name?: unknown };
  let events: ReadonlyArray<{ event_name?: string; [k: string]: unknown }>;
  if (typeof env.event_name === "string") {
    events = [env as { event_name?: string; [k: string]: unknown }];
  } else {
    const version = env.version ?? 1;
    if (version !== 1) return;
    const payloadEvents = env.payload?.events;
    if (!Array.isArray(payloadEvents)) return;
    events = payloadEvents;
  }

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const name = evt.event_name;
    if (typeof name !== "string") continue;

    switch (name) {
      case "ping":
      case "template_params_and_user_attributes": {
        sendTemplates(info, ctx, active);
        if (evt["host_controlled"] === true && !active.host && ctx.initPayload) {
          active.host = createPaywallHost({
            initPayload: ctx.initPayload,
            apiKey: ctx.bootstrap?.apiKey ?? "",
            ...(ctx.bootstrap?.sdkVersion ? { sdkVersion: ctx.bootstrap.sdkVersion } : {}),
            ...(ctx.user ? { user: ctx.user } : {}),
            ...(ctx.device ? { device: ctx.device } : {}),
            params: ctx.params as Record<string, unknown>,
            send: (messages) => postAccept64(active, messages),
          });
        }
        active.host?.open();
        for (const early of active.earlyHostMessages.splice(0)) active.host?.observe(early);
        // The iframe is now mounted + ready for host commands. Flush any
        // discount redeem queued before this point (latest wins).
        active.ready = true;
        if (active.pendingDiscountCode !== null) {
          const pending = active.pendingDiscountCode;
          const onPosted = active.pendingDiscountOnPosted;
          active.pendingDiscountCode = null;
          active.pendingDiscountOnPosted = null;
          postRedeemDiscount(active, pending);
          onPosted?.();
        }
        break;
      }
      case "close": {
        // The iframe controller sends `paywall_close` before posting this;
        // for a hosted framework paywall the host does.
        active.host?.observe(evt as HostMessage);
        ctx.onPaywallTrackedClose?.();
        cleanup();
        resolve(active.completed ?? { type: "declined" });
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
      // Routed internally via ctx.onPurchaseEvent → SDK PurchaseController, AND
      // surfaced as public transaction_* lifecycle events so consumers see
      // start / abandon / fail even in the iframe-driven register() flow.
      // (`complete` is in-flight only; the terminal success event is emitted
      // from post_checkout_complete.)
      case "stripe_checkout_prefetch":
      case "page_view": {
        if (active.host) active.host.observe(evt as HostMessage);
        else if (!active.ready) active.earlyHostMessages.push(evt as HostMessage);
        break;
      }
      case "stripe_checkout_start": {
        active.host?.observe(evt as HostMessage);
        const productId = readProductId(evt);
        ctx.onPurchaseEvent?.({ type: "start", productId: String(productId) });
        // Collector event comes from the iframe (or the server for
        // server-started checkouts) — local listeners only.
        ctx.emit(
          "transaction_start",
          {
            product: { id: String(productId), store: "stripe", entitlements: [] },
            paywall_info: info,
          },
          { wireEmit: false },
        );
        break;
      }
      case "stripe_checkout_submit": {
        active.host?.observe(evt as HostMessage);
        const productId = readProductId(evt);
        ctx.onPurchaseEvent?.({ type: "submit", productId: String(productId) });
        break;
      }
      case "stripe_checkout_complete": {
        if (active.host) {
          // The controller's step: look the checkout up and hand the SDK its
          // own `post_checkout_complete` (or `stripe_checkout_fail`).
          active.host.observe(evt as HostMessage);
          void active.host
            .completeCheckout(evt as HostMessage)
            .then((message) => handleInbound(message, info, ctx, options, resolve, cleanup, active));
        }
        const productId = readProductId(evt);
        const sessionId = readString(evt, "session_id") ?? readString(evt, "checkout_session_id");
        const entitlements = readEntitlements(evt);
        ctx.onPurchaseEvent?.({
          type: "complete",
          productId: String(productId),
          ...(sessionId !== null && { sessionId }),
          ...(entitlements && { entitlements }),
        });
        break;
      }
      case "stripe_checkout_fail": {
        active.host?.observe(evt as HostMessage);
        const productId = readProductId(evt);
        const error = readString(evt, "error") ?? readString(evt, "message");
        ctx.onPurchaseEvent?.({
          type: "fail",
          productId: String(productId),
          ...(error !== null && { error }),
        });
        ctx.emit("transaction_fail", {
          error: error ?? "stripe checkout failed",
          paywall_info: info,
        });
        break;
      }
      case "stripe_checkout_abandon": {
        active.host?.observe(evt as HostMessage);
        const productId = readProductId(evt);
        ctx.onPurchaseEvent?.({ type: "abandon", productId: String(productId) });
        // The iframe sends `transaction_abandon` itself — local listeners only.
        ctx.emit(
          "transaction_abandon",
          {
            product: { id: String(productId), store: "stripe", entitlements: [] },
            paywall_info: info,
          },
          { wireEmit: false },
        );
        break;
      }
      // Terminal success on the `client_surface=web-sdk` branch: the paywall's
      // WebPaywallController has finished its post-checkout server work (it
      // calls the complete-webapp endpoint itself) and posts this one message,
      // then does nothing else — no `close`, no navigation. Everything after
      // is the SDK's: entitlements / redemption and teardown.
      //
      // Distinct from the `purchase` case above, which is a bare intent
      // message from non-Stripe paywalls (the consumer drives their own
      // checkout and reports state via `sw.purchases.setSubscriptionStatus`).
      // A Stripe paywall fires both, and only this one is terminal.
      case "post_checkout_complete": {
        // The backend emits `transaction_complete` server-side before posting
        // this, so re-emitting it locally would double up consumer events.
        const checkout = readCheckoutCompletion(evt);
        const result: PaywallResult = {
          type: "purchased",
          productId: checkout.productId,
          checkout,
        };
        // Record the purchase BEFORE telling anyone. Event listeners and the
        // developer's `onPurchase` run synchronously inside the calls below,
        // and the obvious thing to do in them is `sw.dismiss()` — which reads
        // `completed` on its way out. Set any later and a paid checkout
        // resolves `declined`.
        if (ctx.ownsCheckoutTeardown) active.completed = result;
        // Notifications first (logging delegate, codes — for claimed and
        // unclaimed alike), then the routing that kicks off the SDK's default
        // handling / the developer's override, either of which may tear this
        // presentation down.
        ctx.emit("checkoutCompleted", { checkout, paywallInfo: info });
        if (checkout.redemptionCodes.length > 0) {
          ctx.emit("redemptionCodesReceived", {
            codes: checkout.redemptionCodes,
            claimed: checkout.claimed,
            productId: checkout.productId,
            checkoutContextId: checkout.checkoutContextId,
            paywallInfo: info,
          });
        }
        ctx.onPurchaseEvent?.({
          type: "postCheckout",
          productId: checkout.productId,
          checkout,
        });
        // Owned: stay up until the SDK's default handling dismisses, or the
        // developer's `onPurchase` does. Every close path resolves `completed`.
        if (ctx.ownsCheckoutTeardown) break;
        cleanup();
        resolve(result);
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
      case "open_url": {
        const url = typeof evt["url"] === "string" ? (evt["url"] as string) : null;
        if (!url) break;
        // Forward to the delegate; presenter does NOT navigate the host page.
        const browserType =
          evt["browser_type"] === "payment_sheet" ? "payment_sheet" : undefined;
        ctx.emit(
          "paywallWillOpenURL",
          browserType !== undefined ? { url, browserType } : { url },
        );
        break;
      }
      case "open_deep_link": {
        // Wire payload key is `link`, not `url`.
        const link = typeof evt["link"] === "string" ? (evt["link"] as string) : null;
        if (!link) break;
        ctx.emit("paywallWillOpenDeepLink", { url: link });
        break;
      }
      // Result of a `redeem_discount` command — from the SDK OR an in-paywall
      // "Redeem Discount" button. Split into the public `discount_redeem_complete`
      // / `discount_redeem_fail` events; the SDK matches them to a pending
      // `redeemDiscount()` by code. The clear path (empty code) is NOT
      // acknowledged, so no result arrives for it.
      case "discount_redemption_result": {
        const code = readString(evt, "code") ?? "";
        if (evt["valid"] === true) {
          const apc = evt["appliedProductCount"];
          ctx.emit("discount_redeem_complete", {
            code,
            paywall_info: info,
            ...(typeof apc === "number" && { appliedProductCount: apc }),
          });
        } else {
          // `reason` is an open union — forward any paywall value verbatim.
          const reason = readString(evt, "reason");
          ctx.emit("discount_redeem_fail", {
            code,
            paywall_info: info,
            ...(reason !== null && { reason }),
          });
        }
        break;
      }
      // Legacy `custom` action — `{ event_name: "custom", data: "<name>" }`,
      // same contract the mobile SDKs' paywall.js bridge uses. Bridged to
      // `SuperwallDelegate.onCustomPaywallAction` by the SDK core.
      case "custom": {
        const actionName = readString(evt, "data") ?? readString(evt, "name");
        if (!actionName) break;
        ctx.emit("customPaywallAction", { name: actionName });
        break;
      }
      case "user_attribute_updated": {
        active.host?.observe(evt as HostMessage);
        const raw = evt["attributes"];
        if (!Array.isArray(raw)) break;
        const attributes: Record<string, JsonValue> = {};
        for (const entry of raw) {
          if (!entry || typeof entry !== "object") continue;
          const { key, value } = entry as { key?: unknown; value?: unknown };
          if (typeof key !== "string" || key === "" || value === undefined) continue;
          attributes[key] = value as JsonValue;
        }
        if (Object.keys(attributes).length > 0) {
          ctx.onUserAttributesUpdate?.(attributes);
        }
        break;
      }
      case "custom_placement": {
        // paywall_info is the ACTIVE paywall, captured at present() time.
        const placementName =
          typeof evt["name"] === "string" ? (evt["name"] as string) : "";
        const params =
          typeof evt["params"] === "object" && evt["params"] !== null
            ? (evt["params"] as Record<string, JsonValue>)
            : {};
        ctx.emit("custom_placement", {
          placementName,
          paywall_info: info,
          params,
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
  // The iframe sends `transaction_start` for `purchase` clicks itself.
  ctx.emit(
    "transaction_start",
    {
      product,
      paywall_info: _info,
    },
    { wireEmit: false },
  );

  const finalize = (kind: "purchased" | "declined") => {
    if (kind === "purchased") {
      ctx.emit("transaction_complete", {
        product,
        paywall_info: _info,
        product_identifier: product.id,
      });
      // Emit `subscription_start` alongside transaction_complete. Web has
      // no trial-detection signal, so consumers that need to distinguish
      // first-time non-trial activations from trials should dedup via
      // product id + subscriptionStatus history.
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

  if (ctx.testMode) {
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

  // Non-test mode: the SDK doesn't run checkout for the bare `purchase`
  // message. The consumer runs their own checkout (listening for
  // `transaction_start`) and reports the outcome via
  // `sw.purchases.setSubscriptionStatus`. The presenter leaves the paywall
  // open and takes no further action.
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

/** Push a `redeem_discount` command to the iframe over the accept64 channel —
 *  same envelope `template_variables` uses. An empty `code` clears an applied
 *  discount. */
const postRedeemDiscount = (a: ActivePresentation, code: string): void => {
  postAccept64(a, [{ event_name: "redeem_discount", code }]);
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
  } catch (e) {
    console.warn("[Superwall] postMessage to paywall failed:", e);
  }
};

const base64OfJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  // btoa only handles latin1; encode UTF-8 bytes first.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
};

const base64UrlOfJson = (value: unknown): string =>
  base64OfJson(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
