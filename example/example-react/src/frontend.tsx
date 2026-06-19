/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SuperwallProvider } from "@superwall/paywalls-react";
import { App } from "./App";

const apiKey = "pk_ZNLGF8AlO2V50YDvC1y0c";
const reviewLab = "ir-feat-web-sdk-support.prd.us-east-1.review-lab.superwall-services.com";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <SuperwallProvider
      apiKey={apiKey}
      options={{
        testModeBehavior: "always",
        networkEnvironment: {
          custom: {
            base: reviewLab,
            collector: "collector.superwall.com",
            enrichment: "enrichment-api.superwall.com",
            subscriptions: "subscriptions-api.superwall.dev",
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
