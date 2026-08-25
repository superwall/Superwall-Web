import type { EnvironmentHosts, NetworkEnvironment } from "./types.ts";

const RELEASE_HOSTS: EnvironmentHosts = {
  base: "api.superwall.me",
  collector: "collector.superwall.com",
  enrichment: "enrichment-api.superwall.com",
  subscriptions: "subscriptions-api.superwall.com",
  paywallWorker: "web-api.superwall.app",
};

const RC_HOSTS: EnvironmentHosts = {
  base: "api.superwallcanary.com",
  collector: "collector.superwallcanary.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
  paywallWorker: "web-api.superwallbeta.app",
};

const DEV_HOSTS: EnvironmentHosts = {
  base: "api.superwall.dev",
  collector: "collector.superwall.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
  paywallWorker: "web-api.superwallapp.dev",
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
  // Custom environments predate `paywallWorker`; fall back to the production
  // worker (consistent with isSandbox treating custom as production).
  return { paywallWorker: RELEASE_HOSTS.paywallWorker, ...env.custom };
};

// Custom environments are typically internal proxies → assume production.
export const isSandbox = (env: NetworkEnvironment): boolean =>
  typeof env === "string" ? env !== "release" : false;
