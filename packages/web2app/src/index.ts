// @superwall/web2app — the Superwall Web SDK, packaged for web2app.
//
// A thin wrapper over `@superwall/paywalls-js` for apps on the web2app
// (STRIPE) platform: paywalls built in Superwall present EMBEDDED on your
// own site (iframe overlay + embedded Stripe checkout), and when a purchase
// completes you get the redemption code in a callback — by default the page
// never navigates away.
//
// The underlying Web SDK already detects a web2app app from its config
// (`platform === "STRIPE"`) and flips to the `web-app-sdk` iframe surface;
// this package exists so web2app consumers get an API shaped around that
// flow (callback-first purchase completion, no web-entitlement concepts)
// without reading Web SDK docs written for WEBAPP tenants.

import {
  createSuperwall,
  type CreateSuperwallOptions,
  type IdentityOptions,
  type JsonValue,
  type PaywallCloseReason,
  type RegisterPlacementArgs,
  type RegisterPlacementResult,
  type Superwall,
  type UserAttributes,
  type Web2AppPostPurchaseTargets,
} from "@superwall/paywalls-js";

export type { Web2AppPostPurchaseTargets } from "@superwall/paywalls-js";

/** Everything the backend resolved for a completed web2app purchase.
 *  `redemptionCodes` are the public (`redemption_…`) codes your mobile app
 *  redeems; the URLs/deep links carry the same codes pre-encoded. */
export type Web2AppPurchaseResult = Web2AppPostPurchaseTargets;

/** What happens to YOUR page after `onPurchaseComplete` returns:
 *  - `"stay"` (default): nothing — you own the post-purchase UX.
 *  - `"navigate"`: the SDK's default navigation (merchant-configured
 *    redirect URL from the dashboard when present, else the hosted
 *    redeem page).
 *  - `{ url }`: always navigate to this URL. */
export type AfterPurchase = "stay" | "navigate" | { url: string };

export interface CreateWeb2AppOptions {
  /** The web2app (STRIPE-platform) app's public API key (`pk_…`). Using a
   *  key from another platform (iOS/WEBAPP) will NOT present embedded
   *  web2app paywalls — checkout would be rejected on origin validation. */
  apiKey: string;
  /** Called after a purchase completes in the embedded paywall, with the
   *  redemption codes + resolved destinations. Runs after any per-call
   *  `register` handlers. Exceptions are caught and logged. */
  onPurchaseComplete?: (result: Web2AppPurchaseResult) => void;
  /** Post-purchase page behavior. Defaults to `"stay"`. */
  afterPurchase?: AfterPurchase;
  /** Advanced: passthrough to the underlying `createSuperwall` call. A
   *  `options.web2app.postPurchase` set here is overridden by this
   *  package's handler — use `onPurchaseComplete` + `afterPurchase`. */
  superwall?: Omit<CreateSuperwallOptions, "apiKey">;
}

export interface Web2App {
  /** Resolves when configuration finished (config fetched or cached). */
  readonly ready: Promise<void>;
  /** Escape hatch to the full underlying Web SDK instance. */
  readonly superwall: Superwall;

  /** Evaluate a placement and, if the user matches a paywall variant,
   *  present it embedded on this page. Mirrors `Superwall.register`. */
  register(args: RegisterPlacementArgs): Promise<RegisterPlacementResult>;

  identify(userId: string, opts?: IdentityOptions): Promise<void>;
  setUserAttributes(attrs: Partial<UserAttributes>): void;
  signOut(): Promise<void>;
  reset(): Promise<void>;

  track(event: string, properties?: Record<string, JsonValue>): void;
  page(name?: string, properties?: Record<string, JsonValue>): void;

  /** Force-close the presented paywall. */
  dismiss(reason?: PaywallCloseReason): void;
  /** Tear down the runtime. Idempotent. */
  dispose(): Promise<void>;
}

/** The `web2app.postPurchase` handler `createWeb2App` installs. Contract
 *  (see `navigateAfterWeb2AppPurchase` in paywalls-js): returning `false`
 *  falls through to the SDK's default navigation; any other return means
 *  handled. Exported for tests. */
export const buildPostPurchaseHandler = (
  onPurchaseComplete: ((result: Web2AppPurchaseResult) => void) | undefined,
  afterPurchase: AfterPurchase,
): ((targets: Web2AppPostPurchaseTargets) => boolean | void) => {
  return (targets) => {
    if (onPurchaseComplete) {
      try {
        onPurchaseComplete(targets);
      } catch (error) {
        console.warn("[Superwall] onPurchaseComplete handler threw", error);
      }
    }
    if (afterPurchase === "navigate") return false;
    if (typeof afterPurchase === "object" && afterPurchase.url) {
      const loc = (globalThis as { location?: { href?: string } }).location;
      if (loc) {
        try {
          loc.href = afterPurchase.url;
        } catch (error) {
          console.warn("[Superwall] post-purchase navigation failed", {
            target: afterPurchase.url,
            error,
          });
        }
      }
    }
    return; // handled — no default navigation
  };
};

/** Merge the wrapper's post-purchase handler into the passthrough
 *  `createSuperwall` options. Pure; exported for tests. */
export const buildSuperwallOptions = (
  opts: CreateWeb2AppOptions,
): CreateSuperwallOptions => {
  const passthrough = opts.superwall ?? {};
  return {
    ...passthrough,
    apiKey: opts.apiKey,
    options: {
      ...passthrough.options,
      web2app: {
        ...passthrough.options?.web2app,
        postPurchase: buildPostPurchaseHandler(
          opts.onPurchaseComplete,
          opts.afterPurchase ?? "stay",
        ),
      },
    },
  };
};

export const createWeb2App = (opts: CreateWeb2AppOptions): Web2App => {
  const sw = createSuperwall(buildSuperwallOptions(opts));

  return {
    ready: sw.ready,
    superwall: sw,
    register: (args) => sw.register(args),
    identify: (userId, identityOpts) => sw.user.identify(userId, identityOpts),
    setUserAttributes: (attrs) => sw.user.setAttributes(attrs),
    signOut: () => sw.user.signOut(),
    reset: () => sw.reset(),
    track: (event, properties) => sw.track(event, properties),
    page: (name, properties) => sw.page(name, properties),
    dismiss: (reason) => sw.dismiss(reason),
    dispose: () => sw.dispose(),
  };
};
