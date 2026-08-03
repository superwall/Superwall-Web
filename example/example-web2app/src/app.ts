// Browser example for @superwall/web2app.
//
// Flow: enter the web2app (STRIPE-platform) app's pk_… key → configure →
// "Show paywall" registers a placement, which presents EMBEDDED on this page
// (iframe overlay + embedded Stripe checkout). When the purchase completes,
// `onPurchaseComplete` receives the redemption codes + destinations and the
// page stays put (afterPurchase defaults to "stay").

import { createWeb2App, type Web2App, type Web2AppPurchaseResult } from "@superwall/web2app";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
};

const apiKeyInput = $<HTMLInputElement>("#api-key");
const placementInput = $<HTMLInputElement>("#placement");
const registerBtn = $<HTMLButtonElement>("#register");
const statusEl = $("#status");
const resultPanel = $("#result-panel");
const codesEl = $("#codes");
const resultEl = $<HTMLPreElement>("#result");

// Test key for the review-lab web2app app; override with ?apiKey=pk_….
const DEFAULT_API_KEY = "pk_8610a1b862d329cc0ce2076fba5b26bca1fcbdd4cd7279ee";

// Allow ?apiKey=pk_…&placement=… for quick sharing of a configured page.
const params = new URLSearchParams(location.search);
const presetKey = params.get("apiKey");
apiKeyInput.value = presetKey ?? DEFAULT_API_KEY;
const presetPlacement = params.get("placement");
if (presetPlacement) placementInput.value = presetPlacement;

let web2app: Web2App | null = null;

const showResult = (result: Web2AppPurchaseResult) => {
  resultPanel.classList.add("visible");
  codesEl.textContent = result.redemptionCodes?.join(", ") ?? "(none)";
  resultEl.textContent = JSON.stringify(result, null, 2);
};

const configure = async (apiKey: string) => {
  await web2app?.dispose();
  statusEl.textContent = "Configuring…";
  registerBtn.disabled = true;

  web2app = createWeb2App({
    apiKey,
    onPurchaseComplete: showResult,
    // "stay" is the default; spelled out here because it's the point of the
    // demo — swap for "navigate" or { url: "/thanks" } to see the others.
    afterPurchase: "stay",
    superwall: {
      options: {
        // Temporary: point the base API at the review-lab deployment.
        networkEnvironment: {
          custom: {
            base: "ir-fix-web2app-websdk.prd.us-east-1.review-lab.superwall-services.com",
            collector: "collector.superwall.com",
            enrichment: "enrichment-api.superwall.com",
            subscriptions: "subscriptions-api.superwall.com",
          },
        },
      },
    },
  });
  // Expose for ad-hoc poking from the browser console.
  (globalThis as unknown as { web2app: Web2App }).web2app = web2app;

  try {
    await web2app.ready;
    statusEl.textContent = "Configured. Present away.";
    registerBtn.disabled = false;
  } catch (error) {
    statusEl.textContent = `Configuration failed: ${String(error)}`;
  }
};

let configureTimer: ReturnType<typeof setTimeout> | undefined;
apiKeyInput.addEventListener("input", () => {
  clearTimeout(configureTimer);
  const key = apiKeyInput.value.trim();
  if (!key.startsWith("pk_")) return;
  configureTimer = setTimeout(() => void configure(key), 400);
});
if (apiKeyInput.value.trim().startsWith("pk_")) {
  void configure(apiKeyInput.value.trim());
}

registerBtn.addEventListener("click", async () => {
  if (!web2app) return;
  resultPanel.classList.remove("visible");
  const outcome = await web2app.register({
    placement: placementInput.value.trim(),
    handler: {
      onSkip: (reason) => {
        statusEl.textContent = `Paywall skipped: ${JSON.stringify(reason)}`;
      },
      onError: (error) => {
        statusEl.textContent = `Paywall error: ${error.message}`;
      },
    },
  });
  if (outcome.type === "presented") {
    statusEl.textContent = `Paywall closed: ${outcome.result.type}`;
  }
});
