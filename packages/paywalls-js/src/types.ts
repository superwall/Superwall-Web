// Public type surface for @superwall/paywalls-js. Pure types — no runtime.

// Cross-SDK domain types live in @superwall/core. Imported for in-file
// references and re-exported so the browser SDK's public surface is unchanged.
import type {
  JsonValue,
  SubscriptionStatus,
  ProductStore,
  LatestSubscriptionState,
  LatestSubscriptionOfferType,
  Entitlement,
  Entitlements,
  CustomEnvironmentHosts,
  NetworkEnvironment,
  PaywallPresentationStyle,
} from "@superwall/core";

export type {
  JsonValue,
  SubscriptionStatus,
  ProductStore,
  LatestSubscriptionState,
  LatestSubscriptionOfferType,
  Entitlement,
  Entitlements,
  CustomEnvironmentHosts,
  NetworkEnvironment,
  PaywallPresentationStyle,
};

// Module-augmentation surfaces. Apps extend these via `declare module
// "@superwall/paywalls-js"`. Defaults are `{}` so augmentation closes the shape.
//
// Example:
//   declare module "@superwall/paywalls-js" {
//     interface UserAttributes { email?: string; plan?: "free" | "pro" }
//     interface PlacementParams { screen?: string }
//     interface CustomCallbacks { submitEmail: { input: { email: string }; output: { ok: boolean } } }
//   }

export interface UserAttributes {}
export interface PlacementParams {}
export interface CustomCallbacks {}

export interface CustomCallbackDefinition {
  input: unknown;
  output: unknown;
}

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

// Subscription & entitlements types — see @superwall/core for the
// canonical definitions (Entitlement, Entitlements, SubscriptionStatus,
// ProductStore, LatestSubscriptionState, LatestSubscriptionOfferType).
// Imported and re-exported at the top of this file.

// Purchase controller — mirrors Android `PurchaseController`. Implement to
// override SDK purchase + restore handling. SDK ships an automatic
// implementation that drives the standard Stripe-paywall + redemption-code
// flow; consumers can swap it via `createSuperwall({purchaseController})`.

export type PurchaseResult =
  | { type: "purchased" }
  | { type: "cancelled" }
  | { type: "pending" }
  | { type: "failed"; error: Error };

export type RestorationResult =
  | { type: "restored" }
  | { type: "failed"; error: Error };

export interface PurchaseController {
  purchase(product: Product): Promise<PurchaseResult>;
  restorePurchases(): Promise<RestorationResult>;
  /** Optional one-shot lifecycle hook called once `configure()` settles.
   *  The default automatic controller uses it to detect a returning
   *  redemption-code redirect and start polling for web entitlements. */
  onConfigured?(): Promise<void>;
  /** Optional teardown called from `sw.dispose()`. The default automatic
   *  controller clears its entitlements-polling interval here so timers
   *  don't leak past the SDK instance's lifetime. */
  dispose?(): void;
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

// Paywall

// Surveys

/** When a survey should be shown relative to the paywall's outcome. */
export type SurveyShowCondition = "ON_MANUAL_CLOSE" | "ON_PURCHASE";

export interface SurveyOption {
  id: string;
  title: string;
}

/**
 * Post-paywall questionnaire attached to a paywall in the dashboard.
 * Up to one survey is shown per `assignmentKey`; subsequent paywall
 * dismissals dedupe via persisted storage.
 *
 * `presentationProbability` (0–1) is the chance the survey is shown
 * when its `presentationCondition` is met; the remainder is the
 * holdout group.
 */
export interface Survey {
  id: string;
  /** Stable key — once persisted, the SDK never re-shows for the same one. */
  assignmentKey: string;
  title: string;
  message: string;
  options: SurveyOption[];
  presentationCondition: SurveyShowCondition;
  /** 0–1. 0 = always holdout; 1 = always shown. */
  presentationProbability: number;
  /** Append an "Other" option that opens a free-text input. */
  includeOtherOption: boolean;
  /** Append a "Close" option that dismisses without selection. */
  includeCloseOption: boolean;
}

/** Outcome of `SurveyManager.presentSurveyIfAvailable`. */
export type SurveyPresentationResult = "show" | "holdout" | "noShow";

/** Outcome of a redemption-code redeem call. Surfaced on
 *  `SuperwallDelegate.onDidRedeemLink`. */
export type RedemptionResult =
  | {
      type: "success";
      code: string;
      entitlements: Entitlement[];
    }
  | {
      type: "error";
      code: string;
      error: string;
    }
  | {
      type: "expired";
      code: string;
    }
  | {
      type: "invalid";
      code: string;
    };

/** Why a paywall closed. */
export type PaywallCloseReason =
  | "systemLogic"
  | "forNextPaywall"
  | "webViewFailedToLoad"
  | "manualClose"
  | "none";

/** Whether a given close reason should complete the registration result —
 *  i.e. invoke the feature block / resolve the result handler. `forNextPaywall`
 *  and `none` short-circuit because another paywall is taking over. */
export const closeReasonShouldComplete = (r: PaywallCloseReason): boolean =>
  r !== "forNextPaywall" && r !== "none";

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
  /** Per-paywall product slot mapping from the paywall config. Each entry
   *  carries `product` (slot name like "primary"), `productId`, `product_id`.
   *  Forwarded verbatim into the paywall iframe's templates bundle so the
   *  iframe's checkout-click handler can resolve clicked product slots. */
  rawProducts?: ReadonlyArray<Record<string, JsonValue>>;
  /** Pre-encoded `paywalljs_event` base64 payload (substitutions + page
   *  styles). Sent to the iframe as a separate `accept64` after the main
   *  templates bundle. */
  paywalljsEvent?: string;
  /** Dashboard "web checkout destination" flag from config. SDK no longer
   *  branches on it for URL derivation (every paywall iframes its own
   *  editor URL), but kept on the type for downstream / analytics use. */
  webCheckoutDestination?: string;
  /** Per-paywall presentation style from `presentation_style_v3`. The
   *  presenter selects dimensions, position, and animation from this.
   *  Defaults to `{ type: "MODAL" }` when the wire omits / sends an
   *  unrecognized value. */
  presentationStyle?: PaywallPresentationStyle;
  /** Post-paywall surveys. The first survey whose `presentationCondition`
   *  matches the paywall outcome wins. The SDK dedupes via
   *  `assignmentKey` so a returning user only sees each survey once. */
  surveys?: Survey[];
  /** Weighted load-balanced editor URLs. When present with >1 entry, the
   *  presenter picks one by cumulative-weight random selection at mount
   *  time. When absent or single-entry, `url` is used. */
  urlEndpoints?: ReadonlyArray<{
    url: string;
    percentage: number;
    timeoutMs?: number;
  }>;
  backgroundColorHex?: string;
  darkBackgroundColorHex?: string;
  /** Raw v2 product list, forwarded verbatim into the iframe `#init=`
   *  payload alongside `resolveVariables: true`. Server resolves the
   *  per-locale `ProductVariables` instead of the SDK. */
  productsV2?: ReadonlyArray<Record<string, JsonValue>>;
  closeReason?: PaywallCloseReason;
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
  | { type: "placementNotFound" }
  | { type: "userSubscribed" };

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

// Custom callbacks, computed properties, integration attributes

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

// Options

// CustomEnvironmentHosts + NetworkEnvironment moved to @superwall/core;
// re-exported at the top of this file.

export interface PaywallOptions {
  container?: HTMLElement | (() => HTMLElement);
  shouldPreload?: boolean;
  closeOnBackdrop?: boolean;
  zIndex?: number;
  isHapticFeedbackEnabled?: boolean;
  shouldShowPurchaseFailureAlert?: boolean;
  shouldShowWebRestorationAlert?: boolean;
  shouldShowWebPurchaseConfirmationAlert?: boolean;
  automaticallyDismiss?: boolean;
  /** Test-mode override. */
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

// Storage adapter — default impls live in /browser and `createMemoryStorage()`.

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
 * about cross-tool interop (encrypted-cookie or remote-KV adapters) should
 * treat exactly these keys as the contract.
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
  /** Latest redemption response (JSON-encoded). Replayed on configure so
   *  the entitlements granted via web checkout survive page reloads. */
  latestRedemption: "superwall.latestRedemption",
  /** Last shown survey's `assignmentKey`. Dedupes survey presentation —
   *  the SDK never re-shows for the same key once it's persisted. */
  surveyAssignmentKey: "superwall.surveyAssignmentKey",
} as const;

export type StorageKeyName = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
