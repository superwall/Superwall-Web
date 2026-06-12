import type { EnvironmentHosts, NetworkEnvironment } from "./types.ts";

const RELEASE_HOSTS: EnvironmentHosts = {
  base: "api.superwall.me",
  collector: "collector.superwall.com",
  enrichment: "enrichment-api.superwall.com",
  subscriptions: "subscriptions-api.superwall.com",
};

const RC_HOSTS: EnvironmentHosts = {
  base: "api.superwallcanary.com",
  collector: "collector.superwallcanary.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
};

const DEV_HOSTS: EnvironmentHosts = {
  base: "api.superwall.dev",
  collector: "collector.superwall.dev",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
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
  return env.custom;
};

// Custom environments are typically internal proxies → assume production.
export const isSandbox = (env: NetworkEnvironment): boolean =>
  typeof env === "string" ? env !== "release" : false;
