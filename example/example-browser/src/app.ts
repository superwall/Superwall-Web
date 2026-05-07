// Browser example for @superwall/paywalls-js.
//
// Demonstrates: factory wiring, reactive Readable<T> bindings, namespace
// methods, and the typed event target. No framework — vanilla DOM only.

import { createSuperwall, type Readable } from "@superwall/paywalls-js";
import {
  createBrowserPresenter,
  createBrowserStorage,
} from "@superwall/paywalls-js/browser";

// ---------------------------------------------------------------------------
// SDK setup
// ---------------------------------------------------------------------------

const apiKey = "pk_8610a1b862d329cc0ce2076fba5b26bca1fcbdd4cd7279ee";

// Superwall BE doesn't return CORS headers for browser origins, so route
// every API call through the local Bun proxy (see server.ts).
const PROXY_BASE = location.origin;
const PROXY_REWRITES: Array<[RegExp, string]> = [
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
    presentation: "modal",
    testMode: true,
  }),
  storage: createBrowserStorage(),
  options: {
    testModeBehavior: "always",
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

const log = (...args: unknown[]) => {
  // Surface structured logs both in the browser console and in the event log.
  // eslint-disable-next-line no-console
  console.log("[example]", ...args);
};

const eventLog = $<HTMLPreElement>("#event-log");
const appendEvent = (type: string, detail: unknown) => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = document.createElement("div");
  line.innerHTML =
    `<span class="ts">${ts}</span> ` +
    `<span class="ev">${type}</span> ` +
    escapeHtml(fmt(detail));
  eventLog.appendChild(line);
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
  lastResult.textContent = fmt(v);
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
    const result = await sw.placements.register({
      placement: "test2",
      feature: () => log("feature ran!"),
    });
    setLastResult(
      result.type === "error"
        ? { type: "error", error: result.error.name + ": " + result.error.message }
        : result,
    );
  },
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
