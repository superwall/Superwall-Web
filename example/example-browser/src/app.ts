// Browser example for @superwall/paywalls-js.
//
// Demonstrates: factory wiring, reactive Readable<T> bindings, namespace
// methods, and the typed event target. No framework — vanilla DOM only.

import {
  createSuperwall,
  type PaywallPresentationStyle,
  type Readable,
} from "@superwall/paywalls-js";
import {
  createBrowserPresenter,
  createBrowserStorage,
} from "@superwall/paywalls-js/browser";

// ---------------------------------------------------------------------------
// SDK setup
// ---------------------------------------------------------------------------

const apiKey = "pk_ZNLGF8AlO2V50YDvC1y0c";

// Review-lab override: when this host is set, the SDK builds URLs against
// it (via `networkEnvironment.custom`) AND the local proxy forwards there
// (server.ts reads SW_REVIEW_LAB_HOST). Keep both in sync — same string
// here as in the env var.
const REVIEW_LAB =
  "ir-feat-web-sdk-support.prd.us-east-1.review-lab.superwall-services.com";

// Superwall BE doesn't return CORS headers for browser origins, so route
// every API call through the local Bun proxy (see server.ts). The proxy
// rewrites prod hosts AND review-lab → /proxy/* so flipping REVIEW_LAB
// requires no per-host wiring.
const PROXY_BASE = location.origin;
const PROXY_REWRITES: Array<[RegExp, string]> = [
  [/^https:\/\/subscriptions-api\.superwall\.dev/, `${PROXY_BASE}/proxy/subscriptions`],
  [new RegExp(`^https://${REVIEW_LAB}`), `${PROXY_BASE}/proxy/api`],
  [/^https:\/\/api\.superwall\.me/, `${PROXY_BASE}/proxy/api`],
  [/^https:\/\/collector\.superwall\.me/, `${PROXY_BASE}/proxy/collector`],
  [/^https:\/\/enrichment-api\.superwall\.com/, `${PROXY_BASE}/proxy/enrichment`],
  [/^https:\/\/subscriptions-api\.superwall\.com/, `${PROXY_BASE}/proxy/subscriptions`],
];

const proxiedFetch: typeof fetch = (input, init) => {
  const original =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  let rewritten = original;
  for (const [pattern, replacement] of PROXY_REWRITES) {
    if (pattern.test(rewritten)) {
      rewritten = rewritten.replace(pattern, replacement);
      break;
    }
  }
  if (rewritten === original) {
    return globalThis.fetch(input, init);
  }
  // Re-issue with the rewritten URL but preserve the request init.
  return globalThis.fetch(rewritten, init);
};

const sw = createSuperwall({
  apiKey,
  fetch: proxiedFetch,
  presenter: createBrowserPresenter({
    testMode: true,
  }),
  storage: createBrowserStorage(),
  options: {
    testModeBehavior: "always",
    // Load the iframe from the PR-preview paywall worker instead of the
    // editor preview host. Also makes the iframe's relative collector URL
    // (`/api/proxy/events`) resolve against the worker.
    paywallHostOverride:
      "https://superwall-web-paywall-app-pr-3123.superstaging.workers.dev",
    // Point all four upstreams at the review-lab. The SDK's own fetches
    // are rewritten through the local proxy by `proxiedFetch` above; the
    // value here also drives `apiBase` / `collector` in the iframe's
    // `#init=` hash so the in-iframe controller's fetches land on the
    // same backend (those go direct, no proxy possible cross-origin).
    networkEnvironment: {
      custom: {
        base: REVIEW_LAB,
        // Collector stays on prod — review-lab doesn't ingest events.
        collector: "collector.superwall.me",
        enrichment: REVIEW_LAB,
        // Review-lab branch doesn't mount /subscriptions-api/*. Point at the
        // dev subscriptions host instead.
        subscriptions: "subscriptions-api.superwall.dev",
      },
    },
  },
});

// Expose for ad-hoc poking from the browser console.
(globalThis as unknown as { sw: typeof sw }).sw = sw;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
};

const fmt = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (v === "") return '""';
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const fmtPretty = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

const previewOf = (v: unknown, max = 80): string => {
  const s = fmt(v);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
};

const hasDetail = (v: unknown): boolean => {
  if (v === undefined || v === null || v === "") return false;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
};

const log = (...args: unknown[]) => {
  // Surface structured logs both in the browser console and in the event log.
  // eslint-disable-next-line no-console
  console.log("[example]", ...args);
};

const MAX_EVENTS = 200;

const eventLog = $<HTMLPreElement>("#event-log");
const appendEvent = (type: string, detail: unknown) => {
  const ts = new Date().toISOString().slice(11, 23);
  const expandable = hasDetail(detail);

  const entry = document.createElement("div");
  entry.className = expandable ? "entry collapsed" : "entry";

  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML =
    `<span class="ts">${ts}</span>` +
    `<span class="ev">${escapeHtml(type)}</span>` +
    (expandable
      ? `<span class="preview">${escapeHtml(previewOf(detail))}</span>`
      : "");
  entry.appendChild(head);

  if (expandable) {
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = fmtPretty(detail);
    entry.appendChild(body);
    head.addEventListener("click", () => entry.classList.toggle("collapsed"));
  }

  eventLog.appendChild(entry);

  while (eventLog.childElementCount > MAX_EVENTS) {
    eventLog.firstElementChild?.remove();
  }

  eventLog.scrollTop = eventLog.scrollHeight;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );

// ---------------------------------------------------------------------------
// Bind Readables → DOM
// ---------------------------------------------------------------------------

// AbortController so HMR re-runs cleanly tear down the previous wiring.
const ac = new AbortController();
const previous = (globalThis as unknown as { __swExampleCleanup?: () => void })
  .__swExampleCleanup;
if (previous) previous();
(globalThis as unknown as { __swExampleCleanup?: () => void }).__swExampleCleanup =
  () => ac.abort();

const bind = <T>(r: Readable<T>, target: HTMLElement, render?: (v: T) => string) => {
  const unsubscribe = r.subscribe((v) => {
    target.textContent = render ? render(v) : fmt(v);
  });
  ac.signal.addEventListener("abort", unsubscribe, { once: true });
};

bind(sw.user.id, $("#s-user-id"), (v) => v || "(empty)");
bind(sw.user.aliasId, $("#s-user-alias"), (v) => v || "(empty)");
bind(sw.user.effectiveId, $("#s-user-effective"), (v) => v || "(empty)");
bind(sw.subscriptionStatus, $("#s-sub"));
// Auto-unhide the pro panel whenever sub status flips ACTIVE (covers
// page reload after a previous purchase + post-purchase flip from APC).
const cleanupProGate = sw.subscriptionStatus.subscribe((status) => {
  const panel = document.getElementById("entitled-panel");
  if (!panel) return;
  if (status.status === "ACTIVE") panel.hidden = false;
});
ac.signal.addEventListener("abort", cleanupProGate, { once: true });
bind(sw.isPaywallPresented, $("#s-presented"), String);

const configBadge = $<HTMLDivElement>("#config-badge");
const cleanupConfig = sw.configurationStatus.subscribe((status) => {
  configBadge.textContent = status;
  configBadge.classList.toggle("active", status === "configured");
  configBadge.classList.toggle("inactive", status !== "configured");
});
ac.signal.addEventListener("abort", cleanupConfig, { once: true });

// ---------------------------------------------------------------------------
// Wire-bound + local-only events → log panel
// ---------------------------------------------------------------------------

const watch = [
  "paywall_open",
  "paywall_close",
  "transaction_start",
  "transaction_complete",
  "subscriptionStatus_didChange",
  "first_seen",
  "session_start",
] as const;

for (const name of watch) {
  sw.events.addEventListener(
    name,
    // SuperwallEventTarget dispatches CustomEvent instances; `detail` carries
    // the typed payload from the SuperwallEventMap entry.
    (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      appendEvent(name, detail);
    },
    { signal: ac.signal },
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const lastResult = $<HTMLDivElement>("#last-result");
const setLastResult = (v: unknown) => {
  lastResult.textContent = fmtPretty(v);
};

/** Fire `register()` against the `home` placement with a per-call
 *  presentation-style override. The SDK applies the override after
 *  resolving the paywall config so it wins over `presentation_style_v3`. */
const registerWithStyle = async (
  presentationStyle: PaywallPresentationStyle,
): Promise<void> => {
  const result = await sw.register({
    placement: "home",
    overrides: { presentationStyle },
    feature: () => log("feature ran!"),
  });
  setLastResult(
    result.type === "error"
      ? { type: "error", error: result.error.name + ": " + result.error.message }
      : result,
  );
};

const handlers: Record<string, () => Promise<void> | void> = {
  identify: async () => {
    await sw.user.identify("test_user_42");
    log("identified");
  },
  signOut: async () => {
    await sw.user.signOut();
    log("signed out");
  },
  subActive: () => {
    sw.purchases.setSubscriptionStatus({
      status: "ACTIVE",
      entitlements: [
        {
          id: "pro",
          type: "SERVICE_LEVEL",
          isActive: true,
          productIds: ["pro_yearly"],
        },
      ],
    });
  },
  subInactive: () => {
    sw.purchases.setSubscriptionStatus({ status: "INACTIVE" });
  },
  register: async () => {
    const result = await sw.register({
      placement: "home",
      // Real feature gate — unhides the "pro feature unlocked" panel.
      // For gated paywalls this runs only after a successful purchase /
      // when the user is already entitled. For non-gated paywalls it
      // runs on close too. See `RegisterPlacementArgs.feature` docs.
      feature: () => {
        log("feature ran! unlocking pro panel");
        const panel = document.getElementById("entitled-panel");
        if (panel) panel.hidden = false;
        const out = document.getElementById("pro-output");
        if (out) out.textContent = "Pro features unlocked at " + new Date().toLocaleTimeString();
      },
    });
    setLastResult(
      result.type === "error"
        ? { type: "error", error: result.error.name + ": " + result.error.message }
        : result,
    );
  },

  // Direct purchase outside a paywall presentation. With the default
  // automaticPurchaseController, this awaits a `post_checkout_complete`
  // event for the given product id — so it only resolves if a paywall
  // is open in parallel and the user completes Stripe checkout. To use
  // this standalone, supply a custom PurchaseController that initiates
  // Stripe checkout directly.
  purchase: async () => {
    log("calling sw.purchases.purchase(pro_yearly)…");
    const result = await sw.purchases.purchase({
      id: "pro_yearly",
      store: "stripe",
      entitlements: [],
    });
    setLastResult(result);
    log("purchase resolved:", result);
  },

  // "Pro feature" demo handlers — wired only after the user is entitled.
  genReport: () => {
    const out = document.getElementById("pro-output");
    if (!out) return;
    const rows = Array.from({ length: 5 }, (_, i) => {
      const day = new Date(Date.now() - i * 86_400_000).toDateString();
      const value = Math.round(40 + Math.random() * 120);
      return `${day.padEnd(20)}  ${String(value).padStart(4)} pts`;
    }).join("\n");
    out.textContent =
      "Weekly Report — generated " +
      new Date().toLocaleTimeString() +
      "\n────────────────────────────────────\n" +
      rows;
  },
  openDocs: () => {
    window.open("https://superwall.com/docs", "_blank", "noopener");
  },

  // Presentation-style override gallery. Each fires register() with a
  // different `overrides.presentationStyle` so the paywall renders in that
  // style regardless of what `presentation_style_v3` says in the config.
  styleModal: () => registerWithStyle({ type: "MODAL" }),
  styleFullscreen: () => registerWithStyle({ type: "FULLSCREEN" }),
  styleNoAnimation: () => registerWithStyle({ type: "NO_ANIMATION" }),
  stylePush: () => registerWithStyle({ type: "PUSH" }),
  styleDrawer: () =>
    registerWithStyle({ type: "DRAWER", height: 60, cornerRadius: 16 }),
  stylePopup: () =>
    registerWithStyle({ type: "POPUP", height: 70, width: 50, cornerRadius: 16 }),
  styleNone: () => registerWithStyle({ type: "NONE" }),
  dismiss: () => {
    sw.dismiss();
  },
  reset: async () => {
    await sw.reset();
    setLastResult("—");
  },
};

document.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
  btn.addEventListener(
    "click",
    async () => {
      const act = btn.dataset.act ?? "";
      const fn = handlers[act];
      if (!fn) return;
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        log("action failed", act, err);
        setLastResult({
          type: "thrown",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        btn.disabled = false;
      }
    },
    { signal: ac.signal },
  );
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

sw.ready
  .then(() => log("Superwall ready"))
  .catch((err) => log("Superwall failed to configure", err));
