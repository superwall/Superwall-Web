// Browser example for @superwall/paywalls-js.
//
// Demonstrates: factory wiring, reactive Readable<T> bindings, namespace
// methods, and the typed event target. No framework — vanilla DOM only.

import {
  createSuperwall,
  type PaywallPresentationStyle,
  type Readable,
} from "@superwall/paywalls-js";

// ---------------------------------------------------------------------------
// SDK setup
// ---------------------------------------------------------------------------

const apiKey = "pk_ZNLGF8AlO2V50YDvC1y0c";

const sw = createSuperwall({
  apiKey,
  options: {
    // Demo only: simulate purchases instead of charging a real card.
    testModeBehavior: "always",
    networkEnvironment: "release",
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
// Signed entitlements JWT (for offline server-side verification via
// @superwall/verify). Show a truncated preview; null until a redeem /
// entitlements read returns one.
bind(sw.entitlementsToken, $("#s-token"), (t) =>
  t ? `${t.slice(0, 24)}…${t.slice(-12)} (${t.length} chars)` : "(none)",
);

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
    placement: "video_creation",
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
    const input = document.getElementById("identify-input") as HTMLInputElement | null;
    const userId = input?.value.trim() || "test_user_42";
    await sw.user.identify(userId);
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
  registerHome: async () => {
    const result = await sw.register({ placement: "home" });
    setLastResult(
      result.type === "error"
        ? { type: "error", error: result.error.name + ": " + result.error.message }
        : result,
    );
  },
  register: async () => {
    const result = await sw.register({
      placement: "video_creation",
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

  registerAiChat: async () => {
    const result = await sw.register({
      placement: "ai_chat",
      feature: () => {
        log("ai_chat feature ran! super pro unlocked");
      },
    });
    setLastResult(
      result.type === "error"
        ? { type: "error", error: result.error.name + ": " + result.error.message }
        : result,
    );
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

  // Send the signed entitlements JWT to the server for offline verification.
  verifyToken: async () => {
    const out = $<HTMLPreElement>("#verify-output");
    const token = sw.entitlementsToken.value;
    if (!token) {
      out.textContent =
        "No entitlements token yet — purchase or refresh entitlements first.";
      return;
    }
    out.textContent = "Verifying…";
    try {
      const res = await fetch("/api/verify-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      out.textContent = fmtPretty(data);
    } catch (err) {
      out.textContent = `Request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
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
