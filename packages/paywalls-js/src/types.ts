// Public type surface for @superwall/paywalls-js.
// Mirrors API.md §10 (primitives, subscription, paywall, callbacks, options).
// Pure types — no runtime. Errors live in ./errors.ts.

// ---------------------------------------------------------------------------
// 10.1 — Module augmentation surfaces
//
// Apps augment these via:
//   declare module "@superwall/paywalls-js" {
//     interface UserAttributes { email?: string; plan?: "free" | "pro" }
//     interface PlacementParams { screen?: string }
//     interface CustomCallbacks { submitEmail: { input: { email: string }; output: { ok: boolean } } }
//   }
// Defaults are `{}` so augmentation actually closes the shape.
// ---------------------------------------------------------------------------

export interface UserAttributes {}
export interface PlacementParams {}
export interface CustomCallbacks {}

export interface CustomCallbackDefinition {
  input: unknown;
  output: unknown;
}

// ---------------------------------------------------------------------------
// 10.2 — Primitives
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ConfigurationStatus = "pending" | "configured" | "failed";

export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

export type LogScope =
  | "all"
  | "cache"
  | "configManager"
  | "debugManager"
  | "device"
  | "identityManager"
  | "localization"
  | "network"
  | "paywallEvents"
  | "paywallPresentation"
  | "paywallView"
  | "placements"
  | "productsManager"
  | "superwallCore"
  | "transactions";

export interface IdentityOptions {
  restorePaywallAssignments?: boolean;
}

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ---------------------------------------------------------------------------
// 10.3 — Subscription & entitlements
// ---------------------------------------------------------------------------

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
  startsAt?: number; // ms since epoch
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
  // `web` bucket deferred to v1; see API.md §2.4
}

export interface Product {
  id: string;
  name?: string;
  entitlements: Entitlement[];
  store: ProductStore;
}

export interface CustomerInfo {
  userId: string;
  subscriptions: SubscriptionTransaction[];
  nonSubscriptions: NonSubscriptionTransaction[];
  entitlements: Entitlement[];
}

export interface SubscriptionTransaction {
  transactionId: string;
  productId: string;
  purchaseDate: number; // ms since epoch
  willRenew: boolean;
  isRevoked: boolean;
  isInGracePeriod: boolean;
  isInBillingRetryPeriod: boolean;
  isActive: boolean;
  expirationDate?: number;
  offerType?: LatestSubscriptionOfferType;
  subscriptionGroupId?: string;
  store?: ProductStore;
}

export interface NonSubscriptionTransaction {
  transactionId: string;
  productId: string;
  purchaseDate: number;
  isConsumable: boolean;
  isRevoked: boolean;
  store?: ProductStore;
}

export interface StoreTransaction {
  configRequestId: string;
  appSessionId: string;
  transactionDate?: string;
  originalTransactionIdentifier: string;
  storeTransactionId?: string;
  originalTransactionDate?: string;
  webOrderLineItemID?: string;
  appBundleId?: string;
  subscriptionGroupId?: string;
  isUpgraded?: boolean;
  expirationDate?: string;
  offerId?: string;
  revocationDate?: string;
}

export type RestoreType =
  | { type: "viaPurchase"; storeTransaction?: StoreTransaction }
  | { type: "viaRestore" };

export interface TransactionProduct {
  id: string;
  store: ProductStore;
  isConsumable?: boolean;
}

export interface PageViewData {
  pageNodeId: string;
  flowPosition: number;
  pageName: string;
  navigationNodeId: string;
  previousPageNodeId?: string;
  previousFlowPosition?: number;
  navigationType: string;
  timeOnPreviousPageMs?: number;
}

// ---------------------------------------------------------------------------
// 10.4 — Paywall
// ---------------------------------------------------------------------------

export interface PaywallInfo {
  identifier: string;
  name: string;
  url: string;
  experiment?: Experiment;
  productIds: string[];
  products: Product[];
  presentedByPlacementWithName?: string;
  presentedByPlacementWithId?: string;
  presentedByPlacementAt?: string;
  presentedBy?: string;
  presentationSourceType?: string;
  responseLoadStartTime?: string;
  responseLoadCompleteTime?: string;
  responseLoadFailTime?: string;
  responseLoadDuration?: number;
  webViewLoadStartTime?: string;
  webViewLoadCompleteTime?: string;
  webViewLoadFailTime?: string;
  webViewLoadDuration?: number;
  productsLoadStartTime?: string;
  productsLoadCompleteTime?: string;
  productsLoadFailTime?: string;
  productsLoadDuration?: number;
  paywalljsVersion?: string;
  isFreeTrialAvailable?: boolean;
  featureGatingBehavior?: "gated" | "nonGated";
  closeReason?:
    | "systemLogic"
    | "forNextPaywall"
    | "webViewFailedToLoad"
    | "manualClose"
    | "none";
  computedPropertyRequests?: ComputedPropertyRequest[];
  state?: Record<string, JsonValue>;
}

export interface Experiment {
  id: string;
  groupId: string;
  variant: Variant;
}

export interface Variant {
  id: string;
  type: "treatment" | "holdout";
  paywallId?: string;
}

export interface ConfirmedAssignment {
  experimentId: string;
  variant: Variant;
}

export type PaywallResult =
  | { type: "purchased"; productId: string; transaction?: StoreTransaction }
  | { type: "declined" }
  | { type: "restored" };

export type PaywallSkippedReason =
  | { type: "holdout"; experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" };

export type PresentationResult =
  | { type: "paywall"; experiment: Experiment }
  | { type: "holdout"; experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" }
  | { type: "paywallNotAvailable" };

export type TriggerResult =
  | { type: "placementNotFound" }
  | { type: "noAudienceMatch" }
  | { type: "paywall"; experiment: Experiment }
  | { type: "holdout"; experiment: Experiment }
  | { type: "error"; error: string };

export type PaywallPresentationRequestStatusType =
  | "presentation"
  | "noPresentation"
  | "timeout";

export type PaywallPresentationRequestStatusReason =
  | { type: "debuggerPresented" }
  | { type: "paywallAlreadyPresented" }
  | { type: "holdout"; experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" }
  | { type: "noPaywallView" }
  | { type: "noPresenter" }
  | { type: "noConfig" }
  | { type: "subsStatusTimeout" };

// ---------------------------------------------------------------------------
// 10.5 — Custom callbacks, computed properties, integration attributes
// ---------------------------------------------------------------------------

export interface CustomCallback {
  name: string;
  variables?: Record<string, JsonValue>;
}

export interface CustomCallbackResult {
  status: "success" | "failure";
  data?: Record<string, JsonValue>;
}

export interface ComputedPropertyRequest {
  type: ComputedPropertyRequestType;
  eventName: string;
}

export type ComputedPropertyRequestType =
  | "minutesSince"
  | "hoursSince"
  | "daysSince"
  | "monthsSince"
  | "yearsSince"
  | "placementsInHour"
  | "placementsInDay"
  | "placementsInWeek"
  | "placementsInMonth"
  | "placementsSinceInstall";

// Closed superset of Android's 24 third-party providers.
export type IntegrationAttribute =
  | "adjustId"
  | "amplitudeDeviceId"
  | "amplitudeUserId"
  | "appsflyerId"
  | "brazeAliasName"
  | "brazeAliasLabel"
  | "onesignalId"
  | "fbAnonId"
  | "firebaseAppInstanceId"
  | "iterableUserId"
  | "iterableCampaignId"
  | "iterableTemplateId"
  | "mixpanelDistinctId"
  | "mparticleId"
  | "clevertapId"
  | "airshipChannelId"
  | "kochavaDeviceId"
  | "tenjinId"
  | "posthogUserId"
  | "customerioId"
  | "meta"
  | "amplitude"
  | "mixpanel"
  | "googleAds"
  | "googleAppSetId"
  | "appstackId"
  | "custom";

// ---------------------------------------------------------------------------
// 10.6 — Options
// ---------------------------------------------------------------------------

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

export interface PaywallOptions {
  presentation?: "modal" | "fullscreen";
  container?: HTMLElement | (() => HTMLElement);
  shouldPreload?: boolean;
  closeOnBackdrop?: boolean;
  zIndex?: number;
  isHapticFeedbackEnabled?: boolean;
  shouldShowPurchaseFailureAlert?: boolean;
  shouldShowWebRestorationAlert?: boolean;
  shouldShowWebPurchaseConfirmationAlert?: boolean;
  automaticallyDismiss?: boolean;
  /** Test-mode override; see API.md §6. */
  onTestPurchase?: (product: Product) => Promise<"purchased" | "declined">;
}

export interface SuperwallOptions {
  paywalls?: PaywallOptions;
  networkEnvironment?: NetworkEnvironment;
  localeIdentifier?: string;
  logging?: { level?: LogLevel; scopes?: LogScope[] };
  testModeBehavior?: "automatic" | "whenEnabledForUser" | "never" | "always";
  /** Default 6. */
  maxConfigRetryCount?: number;
  enableExperimentalDeviceVariables?: boolean;
  isExternalDataCollectionEnabled?: boolean;
  identity?: { cookieDomain?: string; cookieSecure?: boolean };
  appVersion?: string;
  appBuild?: string;
  bundleId?: string;
  /** BE/non-browser environments: `location.origin` substitute for `X-URL-Scheme`. */
  urlScheme?: string;
}

export type PartialSuperwallOptions = DeepPartial<SuperwallOptions>;

// ---------------------------------------------------------------------------
// 5 — Storage adapter (public interface; default impls live in /browser
// and in `createMemoryStorage()`). API.md §5.
// ---------------------------------------------------------------------------

/**
 * Persistence layer for identity, counters, and computed properties.
 * Methods may return synchronously or as a Promise; the SDK normalizes
 * both internally.
 */
export interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
}

/**
 * Canonical storage keys the SDK reads/writes. Adapter authors who care
 * about cross-tool interop (e.g. encrypted-cookie or remote-KV adapters)
 * should treat exactly these keys as the contract.
 *
 * Resolves API.md §14 #7 (storage key contract) by promoting the key set
 * to a public constant.
 */
export const STORAGE_KEYS = {
  aliasId: "superwall.aliasId",
  appUserId: "superwall.appUserId",
  vendorId: "superwall.vendorId",
  deviceId: "superwall.deviceId",
  seed: "superwall.seed",
  userAttributes: "superwall.userAttributes",
  integrationAttributes: "superwall.integrationAttributes",
  firstSeenAt: "superwall.firstSeenAt",
  totalPaywallViews: "superwall.totalPaywallViews",
  lastPaywallViewAt: "superwall.lastPaywallViewAt",
  computedProperties: "superwall.computedProperties",
  /** JSON-encoded `ConfirmedAssignment[]` — replayed when network/config
   *  unavailable so cached experiment assignments survive offline. */
  assignments: "superwall.assignments",
  /** ISO timestamp of the last successful `purchases.restore()`. Used to
   *  dedupe rapid restore calls and surface to the host app. */
  lastRestoreAt: "superwall.lastRestoreAt",
  /** Cached `static_config` payload (JSON-encoded `{buildId, payload}`).
   *  Replayed on configure so offline-first works; revalidated by the next
   *  `static_config` fetch. */
  config: "superwall.config",
} as const;

export type StorageKeyName = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
