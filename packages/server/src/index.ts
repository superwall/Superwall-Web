// @superwall/server — server-side entitlement enforcement for the Superwall web SDK.
//
// Quickstart:
//
//   import { Superwall } from "@superwall/server"
//
//   const sw = Superwall({
//     apiKey: process.env.SUPERWALL_API_KEY!,
//     userId: (req) => req.session?.userId ?? null,
//   })
//
//   app.get("/api/export", sw.requires("pro"), exportHandler)
//
// The browser SDK's local subscription state is writable from DevTools. This
// package gates routes server-to-server against Superwall's `/entitlements`
// endpoint so tampering with the client cannot grant access to real resources.

export { Superwall } from "./superwall.ts";
export type {
  SuperwallOptions,
  SuperwallInstance,
  EntitlementSpec,
  RequiresOptions,
  UserIdExtractor,
  CacheAdapter,
  CacheOptions,
  RequestInfo as OnRequestInfo,
  UnauthorizedContext,
  ConnectStyleRequest,
  ConnectStyleResponse,
  ConnectStyleNext,
} from "./types.ts";

// Re-export shared domain types so consumers don't need to also depend on @superwall/core.
export type {
  Entitlement,
  Entitlements,
  SubscriptionStatus,
  NetworkEnvironment,
  CustomEnvironmentHosts,
} from "@superwall/core";

export {
  SuperwallError,
  SuperwallNetworkError,
  SuperwallAuthError,
  SuperwallNotFoundError,
  SuperwallTimeoutError,
  SuperwallDecodingError,
} from "@superwall/core";
