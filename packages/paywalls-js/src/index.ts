// @superwall/paywalls-js — headless core public surface.
// Per API.md. v0 alpha: types + errors + version constant only.
// Runtime (createSuperwall, store, network, presenter) lands incrementally.

export { SDK_VERSION } from "./version.ts";

export * from "./types.ts";
export * from "./errors.ts";
// Public reactive-read primitive. Only the read-only `Readable<T>` view ships
// from the package barrel; `Writable<T>` and `createSignal` are intentionally
// internal-only — public services expose `Readable<T>` via `asReadable`.
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
  type RegisterPlacementArgs,
  type RegisterPlacementResult,
} from "./superwall.ts";
export type {
  PaywallPresenter,
  PresentationContext,
  SuperwallEventEmit,
} from "./presenter.ts";
// Tree-shakeable namespace proxies — bind to the default Superwall instance
// (first-created). See API.md §2.7. Importing only `user` drops `placements`
// etc. via standard ESM dead-code elimination.
export {
  user,
  placements,
  purchases,
  entitlements,
  events,
  getDefaultSuperwall,
} from "./default.ts";
