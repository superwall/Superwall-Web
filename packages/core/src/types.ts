// Cross-SDK domain types. Anything shared between @superwall/paywalls-js
// (browser) and @superwall/server lives here. Browser-only and server-only
// types stay in their respective packages.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Subscription & entitlements

export type SubscriptionStatus =
  | { status: "UNKNOWN" }
  | { status: "INACTIVE" }
  | { status: "ACTIVE"; entitlements: Entitlement[] };

export type ProductStore =
  | "appStore"
  | "stripe"
  | "paddle"
  | "playStore"
  | "superwall"
  | "other";

export type LatestSubscriptionState =
  | "inGracePeriod"
  | "subscribed"
  | "expired"
  | "inBillingRetryPeriod"
  | "revoked";

export type LatestSubscriptionOfferType =
  | "trial"
  | "code"
  | "promotional"
  | "winback";

export interface Entitlement {
  id: string;
  type: "SERVICE_LEVEL";
  isActive: boolean;
  productIds: string[];
  latestProductId?: string;
  store?: ProductStore;
  startsAt?: number;
  renewedAt?: number;
  expiresAt?: number;
  isLifetime?: boolean;
  willRenew?: boolean;
  state?: LatestSubscriptionState;
  offerType?: LatestSubscriptionOfferType;
}

export interface Entitlements {
  active: Entitlement[];
  inactive: Entitlement[];
  all: Entitlement[];
}

export type PaywallPresentationStyle =
  | { type: "MODAL" }
  | { type: "FULLSCREEN" }
  | { type: "NO_ANIMATION" }
  | { type: "PUSH" }
  | { type: "DRAWER"; height: number; cornerRadius: number }
  | { type: "POPUP"; height: number; width: number; cornerRadius: number }
  | { type: "NONE" };

// Network environment selector. Both SDKs accept this on construction.

export interface CustomEnvironmentHosts {
  base: string;
  collector: string;
  enrichment: string;
  subscriptions: string;
}

export type NetworkEnvironment =
  | "release"
  | "releaseCandidate"
  | "developer"
  | { custom: CustomEnvironmentHosts };

export interface EnvironmentHosts {
  readonly base: string;
  readonly collector: string;
  readonly enrichment: string;
  readonly subscriptions: string;
}
