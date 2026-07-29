import type { EnvironmentHosts, NetworkEnvironment } from "./types.ts";

// The web-paywall-app worker also serves the superwall.app zone in
// production (and superwallapp.dev on staging); switch these to the zone
// hosts once that routing is verified end-to-end for the /api/* paths.
const RELEASE_HOSTS: EnvironmentHosts = {
  base: "api.superwall.me",
  collector: "collector.superwall.com",
  enrichment: "enrichment-api.superwall.com",
  subscriptions: "subscriptions-api.superwall.com",
  webPaywallApp: "superwall-web-paywall-app.staffbar.workers.dev",
};

const RC_HOSTS: EnvironmentHosts = {
  base: "api.superwallcanary.com",
  collector: "collector.superwallcanary.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
  webPaywallApp: "superwall-web-paywall-app-stg.staffbar.workers.dev",
};

const DEV_HOSTS: EnvironmentHosts = {
  base: "api.superwall.dev",
  collector: "collector.superwall.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
  webPaywallApp: "superwall-web-paywall-app-stg.staffbar.workers.dev",
};

export const resolveHosts = (env: NetworkEnvironment): EnvironmentHosts => {
  if (typeof env === "string") {
    switch (env) {
      case "release":
        return RELEASE_HOSTS;
      case "releaseCandidate":
        return RC_HOSTS;
      case "developer":
        return DEV_HOSTS;
    }
  }
  return {
    ...env.custom,
    // Optional in CustomEnvironmentHosts — custom envs are typically internal
    // proxies for the API hosts and rarely re-home the paywall-app worker.
    webPaywallApp: env.custom.webPaywallApp ?? RELEASE_HOSTS.webPaywallApp,
  };
};

// Custom environments are typically internal proxies → assume production.
export const isSandbox = (env: NetworkEnvironment): boolean =>
  typeof env === "string" ? env !== "release" : false;
