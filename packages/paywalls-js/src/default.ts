// Module-level default-instance registry + lazy named-export proxies. First
// `createSuperwall(...)` wins; its `dispose()` clears the registry. Proxies
// resolve the default at call time, not at destructure time.

import { NoDefaultSuperwallError } from "./errors.ts";
import type { Readable } from "./signal.ts";
import type { Superwall } from "./superwall.ts";

let _default: Superwall | null = null;

/** Internal — invoked by `createSuperwall` on first construction. */
export const _registerDefault = (sw: Superwall): void => {
  if (_default !== null) return; // first-wins
  _default = sw;
};

/** Internal — invoked by the instance's `dispose()` if it was the default. */
export const _clearDefault = (sw: Superwall): void => {
  if (_default === sw) _default = null;
};

/** Test-only — force-clear the default registry. Not part of the public API. */
export const _resetDefaultForTests = (): void => {
  _default = null;
};

/** Get the default instance, or throw if none has been created. */
export const getDefaultSuperwall = (): Superwall => {
  if (_default === null) throw new NoDefaultSuperwallError();
  return _default;
};

const requireDefault = (): Superwall => getDefaultSuperwall();

// Lazy Readable<T> proxy — defers `.value` and `.subscribe()` to the current
// default instance's signal at call time.
const lazyReadable = <T>(get: () => Readable<T>): Readable<T> => ({
  get value() {
    return get().value;
  },
  subscribe(run) {
    return get().subscribe(run);
  },
});

// Promise-returning proxies are `async` so a missing-default throw surfaces
// as a rejected Promise. Sync proxies throw normally.

export const user = {
  identify: async (...args: Parameters<Superwall["user"]["identify"]>) =>
    requireDefault().user.identify(...args),
  signOut: async () => requireDefault().user.signOut(),
  setAttributes: (...args: Parameters<Superwall["user"]["setAttributes"]>) =>
    requireDefault().user.setAttributes(...args),
  setIntegrationAttribute: (
    ...args: Parameters<Superwall["user"]["setIntegrationAttribute"]>
  ) => requireDefault().user.setIntegrationAttribute(...args),
  setIntegrationAttributes: (
    ...args: Parameters<Superwall["user"]["setIntegrationAttributes"]>
  ) => requireDefault().user.setIntegrationAttributes(...args),

  id: lazyReadable(() => requireDefault().user.id),
  aliasId: lazyReadable(() => requireDefault().user.aliasId),
  effectiveId: lazyReadable(() => requireDefault().user.effectiveId),
  isLoggedIn: lazyReadable(() => requireDefault().user.isLoggedIn),
  attributes: lazyReadable(() => requireDefault().user.attributes),
  integrationAttributes: lazyReadable(
    () => requireDefault().user.integrationAttributes,
  ),
} as const;

/** Top-level `register` aliasing the named-export pattern of the mobile
 *  SDKs. `superwall.register(...)` on the default instance. */
export const register = async (
  ...args: Parameters<Superwall["register"]>
): ReturnType<Superwall["register"]> => requireDefault().register(...args);

/** Fire-and-forget analytics event tracking on the default instance. Thin
 *  alias over `register` with no paywall handler/feature — events are
 *  queryable via Superwall's Query API. See `Superwall.trackPlacement`. */
export const trackPlacement = async (
  ...args: Parameters<Superwall["trackPlacement"]>
): ReturnType<Superwall["trackPlacement"]> =>
  requireDefault().trackPlacement(...args);

export const placements = {
  getPresentationResult: async (
    ...args: Parameters<Superwall["placements"]["getPresentationResult"]>
  ) => requireDefault().placements.getPresentationResult(...args),
  confirmAllAssignments: async () =>
    requireDefault().placements.confirmAllAssignments(),
  preloadAll: async () => requireDefault().placements.preloadAll(),
  preloadFor: async (...args: Parameters<Superwall["placements"]["preloadFor"]>) =>
    requireDefault().placements.preloadFor(...args),
} as const;

export const purchases = {
  restore: async () => requireDefault().purchases.restore(),
  refreshCustomerInfo: async () => requireDefault().purchases.refreshCustomerInfo(),
  setSubscriptionStatus: (
    ...args: Parameters<Superwall["purchases"]["setSubscriptionStatus"]>
  ) => requireDefault().purchases.setSubscriptionStatus(...args),
} as const;

export const entitlements = {
  active: lazyReadable(() => requireDefault().entitlements.active),
  inactive: lazyReadable(() => requireDefault().entitlements.inactive),
  all: lazyReadable(() => requireDefault().entitlements.all),
  byProductIds: (
    ...args: Parameters<Superwall["entitlements"]["byProductIds"]>
  ) => requireDefault().entitlements.byProductIds(...args),
} as const;

export const track = (
  ...args: Parameters<Superwall["track"]>
): void => requireDefault().track(...args);

export const page = (
  ...args: Parameters<Superwall["page"]>
): void => requireDefault().page(...args);

export const events = {
  addEventListener: ((...args: Parameters<Superwall["events"]["addEventListener"]>) =>
    requireDefault().events.addEventListener(
      ...(args as Parameters<Superwall["events"]["addEventListener"]>),
    )) as Superwall["events"]["addEventListener"],
  removeEventListener: ((...args: Parameters<Superwall["events"]["removeEventListener"]>) =>
    requireDefault().events.removeEventListener(
      ...(args as Parameters<Superwall["events"]["removeEventListener"]>),
    )) as Superwall["events"]["removeEventListener"],
  dispatchEvent: (event: Event) => requireDefault().events.dispatchEvent(event),
} as const;
