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

// Replace with your own API key from the Superwall dashboard.
const apiKey = "pk_web_demo";

const sw = createSuperwall({
  apiKey,
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
  "identityHydrated",
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
      placement: "checkout",
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
