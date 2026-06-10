// @superwall/paywalls-js — headless core public surface.

export { SDK_VERSION } from "./version.ts";

export * from "./types.ts";
export * from "./errors.ts";
// Only the read-only `Readable<T>` view is public; `Writable<T>` and
// `createSignal` are internal-only.
export type { Readable } from "./signal.ts";
export {
  SuperwallEventTarget,
  type SuperwallEventMap,
  type LocalSuperwallEventMap,
  type AllSuperwallEvents,
  type SuperwallCustomEvent,
  type SuperwallDelegate,
} from "./events.ts";
export {
  createSuperwall,
  type CreateSuperwallOptions,
  type Superwall,
  type UserNamespace,
  type PlacementsNamespace,
  type PurchasesNamespace,
  type EntitlementsNamespace,
  type PaywallPresentationHandler,
  type PaywallOverrides,
  type RegisterPlacementArgs,
  type RegisterPlacementResult,
} from "./superwall.ts";
export type {
  PaywallPresenter,
  PresentationContext,
  SuperwallEventEmit,
  CustomPaywallState,
  CustomPaywallController,
  CustomPaywallMount,
  CustomPaywallRenderer,
  CustomPaywallTransactionPhase,
  CustomPaywallRestorationPhase,
} from "./presenter.ts";
// Tree-shakeable namespace proxies bound to the default (first-created) instance.
export {
  user,
  placements,
  register,
  purchases,
  entitlements,
  events,
  getDefaultSuperwall,
} from "./default.ts";
