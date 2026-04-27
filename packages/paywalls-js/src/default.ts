// Module-level "default instance" registry + tree-shakeable named-export
// proxies. Per API.md §2.7.
//
// First `createSuperwall(...)` call registers itself as the default; that
// instance's `dispose()` clears the registry. Named exports (`user`,
// `placements`, `purchases`, `entitlements`, `events`) lazily delegate to
// whatever the default is at the time the method is *called* (not when it
// is destructured) — so `const { identify } = user; await identify("u1")`
// works as long as `createSuperwall` has run by the time `identify` fires.

import { NoDefaultSuperwallError } from "./errors.ts";
import type { Readable } from "./signal.ts";
import type { Superwall } from "./superwall.ts";

let _default: Superwall | null = null;

/** Internal — invoked by `createSuperwall` on first construction. */
export const _registerDefault = (sw: Superwall): void => {
  if (_default !== null) return; // first-wins; subsequent createSuperwall calls don't replace
  _default = sw;
};

/** Internal — invoked by the instance's `dispose()` if it was the default. */
export const _clearDefault = (sw: Superwall): void => {
  if (_default === sw) _default = null;
};

/** Test-only — force-clear the default registry. Bun runs files in parallel
 *  in the same process, so module-level state can leak between test suites
 *  unless each suite resets in `beforeEach`. Not part of the public API. */
export const _resetDefaultForTests = (): void => {
  _default = null;
};

/** Public: get the default instance, or throw if none. Useful for advanced
 *  consumers that want explicit access (e.g. SSR code with multiple
 *  conditional instances). */
export const getDefaultSuperwall = (): Superwall => {
  if (_default === null) throw new NoDefaultSuperwallError();
  return _default;
};

const requireDefault = (): Superwall => getDefaultSuperwall();

// ---------------------------------------------------------------------------
// Lazy Readable<T> proxy — `.value` and `.subscribe()` defer to the current
// default instance's underlying signal at call time. The Readable contract
// is preserved (sync-on-attach, ===-stable .value, microtask coalescing)
// because we delegate to the real signal which honors all of those.
// ---------------------------------------------------------------------------

const lazyReadable = <T>(get: () => Readable<T>): Readable<T> => ({
  get value() {
    return get().value;
  },
  subscribe(run) {
    return get().subscribe(run);
  },
});

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

// Promise-returning proxies: `async` so `requireDefault()` throwing sync
// surfaces as a rejected Promise (consumers can `await ... .catch(...)`
// rather than wrap in try/catch). Sync proxies throw normally — that's
// the right shape for void-returning methods.

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

  // Lazy Readables — `.value` throws sync if no default; `subscribe` defers
  // to the underlying signal which honors the §2 contract.
  id: lazyReadable(() => requireDefault().user.id),
  aliasId: lazyReadable(() => requireDefault().user.aliasId),
  effectiveId: lazyReadable(() => requireDefault().user.effectiveId),
  isLoggedIn: lazyReadable(() => requireDefault().user.isLoggedIn),
  attributes: lazyReadable(() => requireDefault().user.attributes),
  integrationAttributes: lazyReadable(
    () => requireDefault().user.integrationAttributes,
  ),
} as const;

export const placements = {
  register: async (...args: Parameters<Superwall["placements"]["register"]>) =>
    requireDefault().placements.register(...args),
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
