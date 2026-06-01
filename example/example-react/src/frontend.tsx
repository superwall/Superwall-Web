/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SuperwallProvider } from "@superwall/paywalls-react";
import {
  createBrowserPresenter,
  createBrowserStorage,
} from "@superwall/paywalls-js/browser";
import { App } from "./App";

const apiKey = "pk_ZNLGF8AlO2V50YDvC1y0c";
const reviewLab = "ir-feat-web-sdk-support.prd.us-east-1.review-lab.superwall-services.com";
const proxyBase = location.origin;
const proxyRewrites: Array<[RegExp, string]> = [
  [new RegExp(`^https://${reviewLab}`), `${proxyBase}/proxy/api`],
  [/^https:\/\/api\.superwall\.me/, `${proxyBase}/proxy/api`],
  [/^https:\/\/collector\.superwall\.me/, `${proxyBase}/proxy/collector`],
  [/^https:\/\/enrichment-api\.superwall\.com/, `${proxyBase}/proxy/enrichment`],
  [/^https:\/\/subscriptions-api\.superwall\.com/, `${proxyBase}/proxy/subscriptions`],
];

const proxiedFetch = ((input, init) => {
  const original =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const rewritten = proxyRewrites.reduce(
    (current, [pattern, replacement]) =>
      pattern.test(current) ? current.replace(pattern, replacement) : current,
    original,
  );
  return globalThis.fetch(rewritten, init);
}) as typeof fetch;

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <SuperwallProvider
      apiKey={apiKey}
      fetch={proxiedFetch}
      presenter={createBrowserPresenter({ presentation: "modal", testMode: true })}
      storage={createBrowserStorage()}
      options={{
        testModeBehavior: "always",
        networkEnvironment: {
          custom: {
            base: reviewLab,
            collector: "collector.superwall.me",
            enrichment: reviewLab,
            subscriptions: reviewLab,
          },
        },
      }}
    >
      <App />
    </SuperwallProvider>
  </StrictMode>
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
