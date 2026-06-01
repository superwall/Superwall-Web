# Superwall Web SDK — Public API

Web-native TypeScript SDK for Superwall. Wire-compatible with the iOS / Android / Flutter SDKs (same config, collector, enrichment, and subscriptions endpoints) but the developer-facing API is designed for modern web — factory-created instances, reactive signals, `EventTarget`, tree-shakeable named exports, module augmentation for user/placement types, and React 19 Suspense for the React bindings.

There is no parity/compat surface. One API, web-native.

Status: **proposal, not implemented.**

---

## 0. Package layout

Monorepo. Bun workspaces + Turborepo 2.x.

```
Superwall-Web/
  package.json              # workspace root
  turbo.json
  packages/
    paywalls-js/             # headless core
    paywalls-react/          # React bindings (v0)
    paywalls-vue/             # (future)
    paywalls-svelte/          # (future)
    paywalls-solid/           # (future)
```

| Package | Contents | Runs in |
|---|---|---|
| `@superwall/paywalls-js` | Headless core: `createSuperwall` factory, reactive signals, `EventTarget`, network client, local placement evaluation, purchase orchestration, `PaywallPresenter` contract, storage adapter interface. **No DOM refs at module load.** | Node, Bun, edge, workers, SSR, browser |
| `@superwall/paywalls-js/browser` (subpath) | Factories for the browser environment: `createBrowserPresenter` (iframe overlay + postMessage v1 bridge + preload via hidden iframes) and `createBrowserStorage` (localStorage + cookies). | Browser only |
| `@superwall/paywalls-react` | `SuperwallProvider`, `useSuperwall`, `useSignal`, `useUser`, `usePlacement`, `useSuperwallEvent`. Built for React 19: Suspense + `use()` + `useSyncExternalStore`. | Browser |
| `@superwall/paywalls-react/server` (subpath, **v1 target**) | Server Actions helpers — `getPresentationResult`, etc., read identity from `cookies()`. | Node / edge (Next 15 RSC, Remix server) |
| `@superwall/paywalls-vue`, `-svelte`, `-solid` | Framework-idiomatic bindings. | Browser |

ESM-only, `"exports"` map. CJS added only if a real consumer needs it.

### 0.1 Runtime architecture (internal)

`@superwall/paywalls-js` runtime is built on **Effect** (`effect@3.x`). All internal services use `Effect.Service` with `Layer`-based composition; concurrency uses `Effect.Deferred` / `Queue` / `Fiber`; reactive state is `SubscriptionRef`; errors are `Schema.TaggedError`; tracing uses `Effect.fn("Service.method")`. The `@effect/language-service` plugin is enabled for compile-time Effect-specific diagnostics.

**The Effect runtime never leaks past the public surface.** Every public method is either:
- a thin façade that calls `Effect.runPromise(...)` on an internal effect and returns a `Promise<T>`, or
- a synchronous read off a `Readable<T>` (vanilla façade over an internal `SubscriptionRef<T>`).

Public errors stay as the plain TS classes in §10.7. Internally we throw equivalent `Schema.TaggedError` variants for `Effect.catchTag` ergonomics; at the `runPromise` boundary we catch and rethrow as the documented public class. The two hierarchies are 1:1 (same `code` field, same payload shape), maintained side by side.

**Branded entity IDs are internal only.** `UserId`, `AliasId`, `VendorId`, `DeviceId`, `PlacementName`, `ExperimentId`, `VariantId`, `EntitlementId`, `ProductId`, `PaywallIdentifier` are branded inside `src/internal/brands.ts` and used across internal service boundaries. Public types in §10 keep plain `string`. Casts happen at the public/internal boundary; consumers never import a brand or call `UserId.make(...)`.

**`@superwall/paywalls-react` mirrors the same firewall.** The Provider wires internal state through `@effect-atom/atom-react` (Atom families, `Result.builder` for effectful renders) for ergonomic React-Effect interop. Public hooks (`useSuperwall`, `useSignal`, `useUser`, `usePlacement`, `useSuperwallEvent`) remain `useSyncExternalStore`-shaped over the public `Readable<T>` contract. An opt-in `@superwall/paywalls-react/atom` subpath exposing the underlying Atoms may ship later for consumers who want Effect-native React integration.

Trade-offs accepted:
- Bundle size: `effect` core + a slim subset of `@effect/platform` adds ~30–40 KB min+gz to consumers. Acceptable for an SDK that already loads an iframe + analytics.
- Contributor onboarding: anyone touching internals needs Effect fluency; the `effect-best-practices` skill in `.claude/skills/` is the reference.
- Public API immune to Effect churn: the Promise / EventTarget / `Readable<T>` boundary is the firewall.

---

## 1. Creating an instance

The factory returns an instance synchronously and kicks off configuration in the background. **Consumers do not need to await `ready` before calling methods** — every method internally awaits `ready` before doing network or presenter work. Synchronous reads (`sw.user.id.value`, `sw.subscriptionStatus.value`) return immediately from persisted storage. `await sw.ready` is only needed to gate UI rendering (e.g. inside React's `<SuperwallProvider>` via Suspense — see §9) or to know that initial config + enrichment have landed.

Operation semantics before `ready` resolves:
- **Mutations** (`identify`, `signOut`, `setAttributes`, `setIntegrationAttribute(s)`, `setSubscriptionStatus`, `setLogLevel`, `setLocale`, `setDelegate`, `dismiss`) — apply to local state synchronously where possible; any network side effect (enrichment, event emission) queues and flushes in arrival order on `ready`.
- **Queries that need config** (`register`, `getPresentationResult`, `confirmAllAssignments`, `purchases.restore`, `purchases.refreshCustomerInfo`, `placements.preloadAll`/`preloadFor`) — internally `await sw.ready` then proceed. Caller's `await` resolves once the underlying op completes.
- **`reset()`** — clears local state immediately, then awaits `ready` and resyncs.

If `configure` ultimately fails, `sw.ready` rejects with the configuration error. All queued ops then reject with the same error; `configurationStatus` becomes `"failed"`.

```ts
import { createSuperwall } from "@superwall/paywalls-js";
import { createBrowserPresenter } from "@superwall/paywalls-js/browser";

const sw = createSuperwall({
  apiKey: "pk_web_...",
  options: { /* SuperwallOptions, see §10 */ },

  // Optional extensions (all pre-creation; no runtime setters)
  presenter: createBrowserPresenter(),        // omit on BE; required to call sw.placements.register
  purchaseController: myPurchaseController,    // omit = observer mode
  delegate: myDelegate,                        // global event callbacks
  storage: myStorageAdapter,                   // default: localStorage + cookies in browser
  identity: {
    aliasId:        "$SuperwallAlias:...",     // optional pre-seed (useful on BE/SSR)
    appUserId:      "user_123",                // optional pre-seed
    vendorId:       "...",
    vendorIdProvider: async () => "...",       // e.g., plug in FingerprintJS here
  },
});

await sw.ready;
```

```ts
function createSuperwall(opts: CreateSuperwallOptions): Superwall;

interface CreateSuperwallOptions {
  apiKey: string;
  options?: SuperwallOptions;
  presenter?: PaywallPresenter;
  purchaseController?: PurchaseController;
  delegate?: SuperwallDelegate;
  storage?: StorageAdapter;
  identity?: {
    aliasId?: string;
    appUserId?: string;
    vendorId?: string;
    vendorIdProvider?: () => Promise<string>;
  };
}
```

Multiple instances are supported (useful for tests, Storybook, edge multi-tenant). The **default instance** is the first one created in the process; the tree-shakeable named exports (§2.7) target it.

---

## 2. The `Superwall` instance

Everything is organized under semantic namespaces. No `get*` getters; reactive reads go through `Readable<T>` (a framework-agnostic signal type).

```ts
interface Superwall {
  readonly apiKey: string;
  readonly ready: Promise<void>;
  readonly isConfigured: Readable<boolean>;
  readonly configurationStatus: Readable<ConfigurationStatus>;

  readonly user: UserNamespace;
  readonly placements: PlacementsNamespace;
  readonly purchases: PurchasesNamespace;
  readonly entitlements: EntitlementsNamespace;

  readonly subscriptionStatus: Readable<SubscriptionStatus>;
  readonly customerInfo: Readable<CustomerInfo | null>;
  readonly latestPaywallInfo: Readable<PaywallInfo | null>;   // currently-presented OR last-dismissed; null until first present; cleared on reset(); unchanged on PaywallAlreadyPresentedError
  readonly isPaywallPresented: Readable<boolean>;             // true between present() and its resolution; only one at a time (§3)

  readonly events: SuperwallEventTarget;

  readonly logLevel: Readable<LogLevel>;
  readonly locale: Readable<string | null>;

  setLogLevel(level: LogLevel): void;
  setLocale(locale: string | null): void;
  setDelegate(delegate: SuperwallDelegate | null): void;  // swap the global delegate; handler stays placement-scoped

  reset(): Promise<void>;
  dismiss(): void;
}

interface Readable<T> {
  readonly value: T;
  /**
   * Subscribe to changes. **The callback fires synchronously once with the
   * current value on attach** (Svelte store contract). Returns an unsubscribe
   * function. Call-site teardown is fine, but framework adapters
   * (`useSyncExternalStore`) rely on the sync-on-attach guarantee.
   */
  subscribe(run: (value: T) => void): () => void;
}
```

**Implementation contract (normative):**
- `value` MUST return a `===`-equal reference between change notifications. Derived signals MUST memoize. Non-stable references break React `useSyncExternalStore` (infinite re-render).
- `subscribe` MUST fire the listener synchronously once with the current value before returning.
- Notifications MUST be coalesced — a single mutation that touches multiple signals MUST NOT fire any listener twice in the same microtask.

`Readable<T>` is intentionally minimal — identical to the Svelte store contract, drop-in for Preact signals via `.value`, and consumable from React via `useSyncExternalStore` (`.value` serves as the snapshot). For TC39 Signals interop, wrap with `Signal.State` externally.

### 2.1 `sw.user`

```ts
interface UserNamespace {
  readonly id:             Readable<string>;          // "" until identify(); use effectiveId for the fallback-to-alias value
  readonly aliasId:        Readable<string>;
  readonly effectiveId:    Readable<string>;          // id || aliasId — explicit, not hidden
  readonly isLoggedIn:     Readable<boolean>;
  readonly attributes:     Readable<UserAttributes>;
  readonly integrationAttributes: Readable<Partial<Record<IntegrationAttribute, string>>>;

  identify(userId: string, opts?: IdentityOptions): Promise<void>;
  signOut(): Promise<void>;
  setAttributes(attrs: Partial<UserAttributes>): void;
  setIntegrationAttribute(attr: IntegrationAttribute, value: string | null): void;
  setIntegrationAttributes(attrs: Partial<Record<IntegrationAttribute, string | null>>): void;
}
```

### 2.2 `sw.placements`

```ts
interface PlacementsNamespace {
  register(args: RegisterPlacementArgs): Promise<RegisterPlacementResult>;
  getPresentationResult(placement: string, params?: PlacementParams): Promise<PresentationResult>;
  confirmAllAssignments(): Promise<ConfirmedAssignment[]>;
  preloadAll(): Promise<void>;
  preloadFor(placementNames: string[]): Promise<void>;
}

interface RegisterPlacementArgs {
  placement: string;
  params?: PlacementParams;
  handler?: PaywallPresentationHandler;   // placement-scoped callbacks (local)
  feature?: () => void | Promise<void>;   // runs if entitled / purchased / non-gated skip
}

interface PaywallPresentationHandler {
  onPresent?(info: PaywallInfo): void;
  onDismiss?(info: PaywallInfo, result: PaywallResult): void;
  onError?(error: Error): void;
  onSkip?(reason: PaywallSkippedReason): void;

  /**
   * Per-callback handler map. Each key maps to a function that receives the
   * typed `input` and returns the typed `output`. TS narrows both sides per key.
   * Unhandled callbacks fall through to the global `SuperwallDelegate.onCustomPaywallAction`
   * (if any) or resolve as `{ status: "failure" }`.
   */
  customCallbacks?: {
    [K in keyof CustomCallbacks]?: (
      input: CustomCallbacks[K]["input"]
    ) =>
      | CustomCallbacks[K]["output"]
      | Promise<CustomCallbacks[K]["output"]>;
  };
}

type RegisterPlacementResult =
  | { type: "presented"; info: PaywallInfo; result: PaywallResult }
  | { type: "skipped";   reason: PaywallSkippedReason }
  | { type: "entitled" }
  | { type: "error";     error: Error };

type PresentationResult =
  | { type: "paywall";              experiment: Experiment }
  | { type: "holdout";              experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" }
  | { type: "paywallNotAvailable" };
```

Flow: internally `await sw.ready` → local placement eval → if paywall needed, call the injected `PaywallPresenter` → await result → run `feature` per rules → fire events. Errors:
- `NoPresenterRegisteredError` — no presenter injected and a paywall is required.
- `PaywallAlreadyPresentedError` — a paywall is already on screen; one-at-a-time invariant (§3).
- `NotConfiguredError` — `sw.ready` rejected (configuration failed).

These reject the `register` promise *and* fire `RegisterPlacementResult` as `{ type: "error", error }`.

### 2.3 `sw.purchases`

```ts
interface PurchasesNamespace {
  restore(): Promise<RestorationResult>;
  refreshCustomerInfo(): Promise<CustomerInfo>;
  setSubscriptionStatus(s: SubscriptionStatus): void;        // observer mode: host pushes status after checkout
}
```

No `setPurchaseController` at runtime — it's wired at `createSuperwall`. See §4.

### 2.4 `sw.entitlements`

```ts
interface EntitlementsNamespace {
  readonly active:   Readable<Entitlement[]>;
  readonly inactive: Readable<Entitlement[]>;
  readonly all:      Readable<Entitlement[]>;
  byProductIds(ids: string[]): Entitlement[];
}
// `web` bucket (web-originated only) deferred until v1 when cross-platform
// customer sync ships. Unaugmented it would duplicate `all`.
```

### 2.5 `sw.events`

Native `EventTarget` with a typed overload — `AbortSignal`-based auto-cleanup.

```ts
interface SuperwallEventTarget extends EventTarget {
  addEventListener<K extends keyof AllSuperwallEvents>(
    type: K,
    listener: (event: SuperwallCustomEvent<K>) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof AllSuperwallEvents>(
    type: K,
    listener: (event: SuperwallCustomEvent<K>) => void,
    options?: EventListenerOptions,
  ): void;
  dispatchEvent(event: Event): boolean;
}

type AllSuperwallEvents = SuperwallEventMap & LocalSuperwallEventMap;
type SuperwallCustomEvent<K extends keyof AllSuperwallEvents> =
  CustomEvent<AllSuperwallEvents[K]>;
```

Usage:
```ts
const ac = new AbortController();

sw.events.addEventListener("paywall_open", (e) => {
  console.log(e.detail.paywall_info.identifier);
}, { signal: ac.signal });

sw.events.addEventListener("identityHydrated", (e) => {                 // local-only (§8.2)
  if (e.detail.aliasChanged) console.log("alias changed on hydration");
}, { signal: ac.signal });

// `subscriptionStatus_didChange` carries no payload on the wire (Android parity).
// For typed `(from, to)` use the SuperwallDelegate (§2.6) instead.
sw.events.addEventListener("subscriptionStatus_didChange", (e) => {
  console.log("subscription status changed; read sw.subscriptionStatus.value");
}, { signal: ac.signal });

ac.abort();   // removes all listeners attached with this signal
```

Wire-bound event names match Android's mixed convention (see §11.4); local-only events use camelCase (see §8.2). The maps are closed — module augmentation is not used for event types, only for user/placement/callback types (§10.1).

### 2.6 Global `SuperwallDelegate`

Coexists with `EventTarget`. Use cases:
- `EventTarget` — scoped listeners (a component listens, unsubscribes on unmount via `AbortController`).
- `SuperwallDelegate` — process-wide observability (analytics forwarder, logger). One delegate at a time. Fires the same underlying events.
- Placement `handler` (§2.2) — per-`register` callbacks that only care about that placement's lifecycle.

```ts
interface SuperwallDelegate {
  onEvent?(info: SuperwallEventInfo): void;                              // firehose — every event
  onSubscriptionStatusChange?(from: SubscriptionStatus, to: SubscriptionStatus): void;
  onCustomerInfoChange?(from: CustomerInfo, to: CustomerInfo): void;
  onUserAttributesChange?(newAttributes: Partial<UserAttributes>): void;
  onCustomPaywallAction?(name: string): void;
  onPaywallWillPresent?(info: PaywallInfo): void;
  onPaywallDidPresent?(info: PaywallInfo): void;
  onPaywallWillDismiss?(info: PaywallInfo): void;
  onPaywallDidDismiss?(info: PaywallInfo): void;
  onPaywallWillOpenURL?(url: string): void;
  onLog?(level: LogLevel, scope: LogScope, message: string | null, info: Record<string, JsonValue> | null, error: string | null): void;
}
```

Pass at `createSuperwall({ delegate })` or swap with `sw.setDelegate(delegate | null)`.

### 2.7 Tree-shakeable named exports

For consumers that only want a couple of operations and don't need to juggle the instance explicitly:

```ts
import {
  createSuperwall,
  user,
  placements,
  purchases,
  entitlements,
  events,
} from "@superwall/paywalls-js";

// All operate on the DEFAULT instance (first created in the process).
// Throw `NoDefaultSuperwallError` if called before createSuperwall.

user.identify("abc123");
await placements.register({ placement: "paywall_trigger" });
events.addEventListener("paywall_close", (e) => { ... });
```

These are thin proxies — e.g. `user.identify(...)` is literally `getDefaultSuperwall().user.identify(...)`. Tree-shakeable: if you only import `user`, the rest drops.

---

## 3. Presenter contract

Core calls this; subpath packages and custom clients implement it.

```ts
interface PaywallPresenter {
  present(info: PaywallInfo, ctx: PresentationContext): Promise<PaywallResult>;
  dismiss(reason?: string): void;
  preload?(info: PaywallInfo): Promise<void>;
}

interface PresentationContext {
  placement: string;
  params: PlacementParams;
  signal: AbortSignal;
  emit: SuperwallEventEmit;    // presenter forwards paywall→SDK events into the event bus
}
```

**Single-paywall invariant.** Core enforces one active paywall at a time, matching iOS/Android. If `register` is called while a paywall is presented, core rejects with `PaywallAlreadyPresentedError` *before* calling `present()` again. Presenters can rely on never receiving overlapping `present()` calls. Custom presenters that need to display multiple paywalls concurrently are explicitly out of scope; they'd need to implement queueing or take responsibility for the invariant themselves.

v0 ships:
- `@superwall/paywalls-js/browser` → `createBrowserPresenter(options?)`: iframe overlay, postMessage v1 bridge, preload via hidden iframes, built-in test-mode confirm dialog. Single overlay portal — naturally enforces one-at-a-time.

Custom implementations: BE apps (HTTP-response presenter), React Native Web, test fixtures (auto-resolve presenter).

---

## 4. Purchase model

No platform store on web. Products carry a `store` tag from config.

### Observer mode (default)
No `purchaseController` passed to `createSuperwall`. Paywall purchase clicks dispatch `transaction_start` + `custom_placement`/custom-callback events; host app runs its own checkout (Stripe/Paddle), then calls `sw.purchases.setSubscriptionStatus({ status: "ACTIVE", entitlements: [...] })`. Core fires `subscriptionStatus_didChange` and dismisses the paywall.

### Controller mode
```ts
interface PurchaseController {
  purchase(product: Product): Promise<PurchaseResult>;   // product.store distinguishes stripe/paddle/...
  restore(): Promise<RestorationResult>;
}

type PurchaseResult =
  | { type: "purchased" }
  | { type: "cancelled" }
  | { type: "pending" }
  | { type: "failed"; error: Error };

type RestorationResult =
  | { type: "restored" }
  | { type: "failed"; error: Error };
```

Attached via `createSuperwall({ purchaseController })`. Core awaits the controller and drives events + `PaywallResult`. No runtime swap.

First-party Stripe/Paddle adapters are out of scope for v0.

---

## 5. Storage adapter

All identity + counters persist through an adapter. Default in the browser subpath writes to localStorage + mirror cookies.

```ts
interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
}
```

The adapter receives namespaced keys like `superwall.aliasId`, `superwall.appUserId`, `superwall.vendorId`, `superwall.deviceId`, `superwall.seed`, `superwall.userAttributes`, `superwall.integrationAttributes`, `superwall.firstSeenAt`, `superwall.totalPaywallViews`, `superwall.lastPaywallViewAt`, `superwall.computedProperties`.

The default storage from `/browser` (`createBrowserStorage()`) also mirrors key identity values into cookies (§7.4) so SSR and the hosted dashboard/paywall can see them cross-origin.

On BE / SSR the caller either passes a custom adapter or pre-seeds identity via `createSuperwall({ identity: { aliasId, appUserId } })`.

---

## 6. Test mode

`options.testModeBehavior: "automatic" | "whenEnabledForUser" | "never" | "always"`. When active, the default browser presenter intercepts `purchase` messages from the paywall and resolves via `options.paywalls.onTestPurchase` if provided, else falls back to `window.confirm`:

```ts
paywalls?: {
  onTestPurchase?: (product: Product) => Promise<"purchased" | "declined">;
  // ...
}
```

- Default (`window.confirm("Simulate purchase of {productId}?")`): blocking, unstylable, but zero-config.
- Custom `onTestPurchase`: lets Playwright/Cypress/unit tests drive the flow deterministically, lets apps style a real modal, works on mobile Safari where `confirm` is throttled.

Outcome → events:
- `"purchased"` → emit `transaction_start` + `transaction_complete`, resolve `PaywallResult` as `{ type: "purchased", productId }`, dismiss.
- `"declined"` → emit `transaction_abandon`, resolve as `{ type: "declined" }`, paywall stays open.

No debug panel / developer overlay in v0. Custom `PaywallPresenter` implementations handle their own test-mode UX.

---

## 7. Default browser presenter (`@superwall/paywalls-js/browser`)

```ts
import { createBrowserPresenter } from "@superwall/paywalls-js/browser";

const presenter = createBrowserPresenter({
  presentation: "modal",                   // "modal" | "fullscreen"   ("inline" deferred)
  container: () => document.body,
  shouldPreload: true,
  closeOnBackdrop: true,
  zIndex: 2147483000,
  isHapticFeedbackEnabled: true,
  shouldShowPurchaseFailureAlert: true,
  shouldShowWebRestorationAlert: true,
  shouldShowWebPurchaseConfirmationAlert: true,
  automaticallyDismiss: true,
});
```

Passed to `createSuperwall({ presenter })`. React's `<SuperwallProvider>` attaches a default one automatically; vanilla-JS consumers wire it themselves.

### 7.1 Preload
For each known paywall URL, mount a hidden iframe (`display: none; width: 1px; height: 1px`) in a detached container. Let it fetch + render. Keep resident (swap into the visible overlay on `present`) or destroy per `shouldPreload`. Paywall HTML is immutable, cached by the browser's HTTP cache (`Cache-Control: public, max-age=31536000, immutable` on the host).

### 7.2 Paywall ↔ SDK protocol (v1)

Bidirectional via `window.postMessage`. Shapes copied from Android `PaywallMessage.kt` and `PaywallMessageHandler.kt` verbatim. The web SDK does what the Android `JavascriptInterface` + `evaluateJavascript` calls do, just over `postMessage` because the paywall iframe is cross-origin.

**Origin policy.** SDK validates `event.origin` against the configured paywall host (derived from `PaywallInfo.url`) and `event.source === iframe.contentWindow`. Messages from any other origin/source are dropped silently and counted as decode failures. Paywall posts to `window.parent.postMessage(msg, "*")` (it doesn't know the host origin); SDK posts to `iframe.contentWindow.postMessage(msg, paywallOrigin)` (never `"*"`).

**Versioning.** Envelope `version` defaults to 1. Messages with `version > 1` are dropped + logged; we bump when we add breaking fields. Unknown `event_name` values within a known version are dropped + logged.

**Correlation, timeouts, lifecycle.**
- `request_permission` and `request_callback` carry `request_id` from the paywall; SDK echoes it on the response.
- SDK enforces a 15-second response timeout; on timeout, replies with `status: "FAILURE"` (callback) or `status: "UNSUPPORTED"` (permission) and abandons the request.
- On `dismiss` or iframe destruction, SDK drops in-flight `request_id`s without responding; paywall-side shim must tolerate missing responses.
- `request_id` collisions (paywall reuses an ID) are treated as paywall error: SDK rejects the second request with `status: "FAILURE"`.
- Hot-reload / SDK restart: the presenter's lifecycle owns the iframe — recreating the SDK without dismissing the presenter leaks pending requests. React's `<SuperwallProvider>` calls `presenter.dismiss()` on unmount.

#### Paywall → SDK

Iframe calls `window.parent.postMessage(msg, "*")`. Envelope:
```json
{ "version": 1, "payload": { "events": [ { "event_name": "...", /* type-specific keys */ } ] } }
```
Multiple events may be batched in a single `events` array.

Active v1 event names + payload keys (verbatim from Android `PaywallMessage.kt:33-315`):

| `event_name` | Payload keys | Notes |
|---|---|---|
| `ping` | `version: string` | parses to `OnReady(paywallJsVersion)` |
| `close` | — | |
| `restore` | — | |
| ~~`restore_failed`~~ | — | **Removed** — Android `PaywallMessage.parsePaywallMessage` has no `restore_failed` branch (would throw `IllegalArgumentException`). Restoration failures are signalled internally via SDK state, not as an inbound message. |
| `open_url` | `url: string`, `browser_type?: "payment_sheet"` | in-overlay or payment sheet |
| `open_url_external` | `url: string` | new tab, `target="_blank" rel="noopener"` |
| `open_deep_link` | `link: string` | **key is `link`, not `url`** |
| `purchase` | `product: string`, `product_identifier: string`, `should_dismiss?: boolean` (default `true`) | snake_case payload keys |
| `custom` | `data: string` | legacy |
| `custom_placement` | `name: string`, `params: object` | |
| `request_store_review` | `review_type: "external" \| "in-app"` | **wire name is `request_store_review`, not `request_review`** |
| `user_attribute_updated` | `attributes: Array<{key: string, value: any}>` | **singular `attribute`, payload is array of `{key,value}` objects, not a map** |
| `schedule_notification` | `type?: "TRIAL_STARTED" \| "unsupported"`, `id?, title?, subtitle?, body?, delay?` | deferred in v0 |
| `request_permission` | `permission_type: string`, `request_id: string` | |
| `page_view` | `page_node_id: string`, `flow_position: number`, `page_name: string`, `navigation_node_id: string`, `previous_page_node_id?: string`, `previous_flow_position?: number`, `type: string` (navigation type), `time_on_previous_page_ms?: number` | |
| `haptic_feedback` | `haptic_type: "light" \| "medium" \| "heavy" \| "success" \| "warning" \| "error" \| "selection"` | no-op unless Vibration API |
| `request_callback` | `request_id: string`, `name: string`, `behavior: string`, `variables?: object` | |

Note: `template_params_and_user_attributes` is **not** an inbound message — it's a synthetic internal message Android constructs after `ping` to ask the SDK to deliver templates. On web, the SDK delivers templates directly in response to `ping`.

#### SDK → paywall

SDK calls `iframe.contentWindow.postMessage(msg, paywallOrigin)`. The paywall-side web shim routes these to the same `window.paywall.*` / `window.app.*` JS surface Android invokes via `evaluateJavascript`:

```json
{ "version": 1, "channel": "paywall.accept64", "payload": "<BASE64_URL_SAFE>" }
{ "version": 1, "channel": "paywall.accept",   "payload": [ /* raw JSON array */ ] }
{ "version": 1, "channel": "app.getAllState", "request_id": "..." }
```

`paywall.accept64` payload is **base64-url of a UTF-8 JSON array** of one or more `{event_name, ...}` objects (Android calls `accept64` separately for each logical bundle — templates first, then HTML substitutions, then any response messages).

Templates bundle (sent after `ping` arrives) — array of these four objects, in order (mirrors Android `TemplateLogic.kt:24-88`):

```json
[
  { "event_name": "products",
    "products": [ /* ProductItem[] from config */ ] },

  { "event_name": "template_variables",
    "variables": {
      "user":      { /* user attributes */ },
      "device":    { /* device attributes (§11.5) */ },
      "params":    { /* placement params */ },
      "products":  [ /* ProductVariable[] — required, may be empty */ ],
      "primary":   { /* product subs, optional */ },
      "secondary": { /* product subs, optional */ },
      "tertiary":  { /* product subs, optional */ }
    } },

  { "event_name": "template_substitutions_prefix",
    "prefix": "freeTrial" },           // or null

  // NOTE: this object uses camelCase keys, unlike its siblings
  { "eventName":     "experiment",
    "experimentId":  "...",
    "variantId":     "...",
    "campaignId":    "..." }           // serialized from paywall.experiment.groupId
]
```

HTML substitutions bundle (sent immediately after templates) — Android emits via `accept64` with the same `[{event_name, ...}]` array shape but with substitution-specific events (TBD — confirm with paywall.js once accessible).

Response messages (each sent as its own `accept64` call after the corresponding inbound `request_*`):

| Trigger | `accept64` payload (decoded) |
|---|---|
| `request_permission` | `[{ "event_name": "permission_result", "permission_type": "...", "request_id": "...", "status": "GRANTED" \| "DENIED" \| "UNSUPPORTED" }]` |
| `request_callback` | `[{ "event_name": "callback_result", "request_id": "...", "name": "...", "status": "SUCCESS" \| "FAILURE", "data"?: object }]` |

`window.app.getAllState()` is a synchronous JS call on the paywall page, not a postMessage round-trip — Android invokes it via `evaluateJavascript` and reads the return value. On web, the SDK posts the message and the paywall-side shim is expected to reply via a `accept64` follow-up (TBD — confirm with paywall.js).

`paywall.accept` (raw JSON array, not base64) is for game-controller payloads on Android. Unused on web.

### 7.3 Paywall URL construction
Opaque URL from config + three SDK-appended query params only:
```
platform=web&transport=web&debug={true|false}
```
User context (userId, alias, locale, entitlements, experiment, product overrides) is injected post-load via `paywall.accept64`. Preloaded iframes are reusable across users and placements.

### 7.4 Identity persistence (default `createBrowserStorage()`)

- **Alias ID**: `$SuperwallAlias:<uuid-v4>` (matches Android `IdentityLogic.generateAlias`).
- **Vendor ID**: `uuid-v4`, web-generated. Stable-per-browser-profile; no fingerprinting in v0 (see §7.5).
- **Device ID**: `sha256(vendorId)` short hash.
- **localStorage keys**: `superwall.aliasId`, `superwall.appUserId`, `superwall.vendorId`, `superwall.deviceId`, `superwall.seed`, `superwall.userAttributes`, `superwall.integrationAttributes`, `superwall.firstSeenAt`, `superwall.totalPaywallViews`, `superwall.lastPaywallViewAt`, `superwall.computedProperties`.
- **Cookies** (matching sibling Superwall tools):
  - `_sw_alias_id` — alias ID.
  - `sw_checkout_experimentId` — active checkout experiment assignment (populated when SDK confirms a checkout-placement assignment).
  - `_sw_last_email` — last email submitted via paywall (populated from `user_attributes_updated` events).
  - `_sw_user_id`, `_sw_vendor_id` — **TBD name** for appUserId / vendorId.
  - All: `SameSite=Lax`, `Secure` in production, `Path=/`, 2-year max-age. Domain via `options.identity.cookieDomain`.
- On startup: read cookie → read localStorage → if alias missing, generate; if userId missing, don't fabricate one (`sw.user.id.value === ""`, `effectiveId === aliasId`).

#### SSR hydration

When the same `Superwall` instance is constructed on the server (with `identity` pre-seeded from request cookies) and then rehydrated on the client, identity is reconciled per field with **client localStorage as the winner**:

```
for each field in [aliasId, appUserId, vendorId]:
  client = localStorage.get(field)
  cookie = identity[field] (passed in via createSuperwall on server, sent as initial state to client)
  resolved = client ?? cookie ?? generated()
```

After resolution the SDK re-mirrors `resolved` to both localStorage and cookies so they're consistent. Rationale: localStorage is authoritative (§7.4); cookies are a mirror for SSR/cross-origin readability. A cookie value that disagrees with localStorage means something else (an older session, a different browser profile signed-in elsewhere, manual cookie edit) wrote the cookie out-of-band; trust the SDK's own persistent store.

A `identityHydrated` event fires after reconciliation. **Placement decisions computed during SSR (via `getPresentationResult`) are best-effort** — the client will re-evaluate after hydration if the resolved identity differs from the seed, and the React `<SuperwallProvider>` triggers a re-render in that case.

### 7.5 Fingerprinting (not bundled)
Browser anti-fingerprinting is degrading accuracy (Safari ITP, Firefox RFP, Chrome Privacy Sandbox); privacy/legal cost is non-trivial; FingerprintJS free is low-accuracy, Pro is paid with its own API key. Instead of bundling a library:
```ts
createSuperwall({ identity: { vendorIdProvider: () => fingerprintJS.load().then(fp => fp.get()).then(r => r.visitorId) } });
```
Default is the persisted UUID.

---

## 8. Events

### 8.1 `SuperwallEventMap` (v0)

**TS keys are the wire `event_name` strings verbatim.** Strings copied from Android `SuperwallEvent.kt` `rawName` properties; payload keys match the snake_case wire keys Android emits (so `paywall_info` not `paywallInfo`, `product_identifier` not `productId`, etc.). No translation layer.

The naming convention is mixed by Android's design: most lifecycle events are pure snake_case (`first_seen`, `paywall_open`); paywall-load lifecycle and did-change events use `camelSnake_suffix` (`paywallResponseLoad_start`, `subscriptionStatus_didChange`); a few cross-platform-product events use `camelCase_suffix` (`freeTrial_start`, `nonRecurringProduct_purchase`).

```ts
interface SuperwallEventMap {
  // lifecycle
  first_seen:                              {};
  app_open:                                {};
  app_close:                               {};
  app_launch:                              {};
  app_install:                             {};
  session_start:                           {};
  reset:                                   {};
  config_refresh:                          {};
  config_fail:                             {};
  config_attributes:                       {};
  confirm_all_assignments:                 {};
  device_attributes:                       { attributes: Record<string, JsonValue> };
  user_attributes:                         { attributes: Partial<UserAttributes> };
  integration_attributes:                  { audienceFilterParams: Record<string, JsonValue> };
  identity_alias:                          {};
  deepLink_open:                           { uri: string };

  // subscription / customer
  subscriptionStatus_didChange:            {};
  customerInfo_didChange:                  { from: CustomerInfo; to: CustomerInfo };

  // placements
  trigger_fire:                            { placementName: string; result: TriggerResult };
  paywallPresentationRequest:              { status: PaywallPresentationRequestStatusType; reason?: PaywallPresentationRequestStatusReason };

  // paywall lifecycle
  paywall_open:                            { paywall_info: PaywallInfo };
  paywall_page_view:                       { paywallInfo: PaywallInfo; data: PageViewData };
  paywall_close:                           { paywall_info: PaywallInfo };
  paywall_decline:                         { paywall_info: PaywallInfo };
  paywallPreload_start:                    { paywallCount: number };
  paywallPreload_complete:                 { paywallCount: number };
  paywallResponseLoad_start:               { triggeredPlacementName?: string };
  paywallResponseLoad_notFound:            { triggeredPlacementName?: string };
  paywallResponseLoad_complete:            { triggeredPlacementName?: string; paywall_info: PaywallInfo };
  paywallResponseLoad_fail:                { triggeredPlacementName?: string };
  paywallWebviewLoad_start:                { paywall_info: PaywallInfo };
  paywallWebviewLoad_complete:             { paywall_info: PaywallInfo };
  paywallWebviewLoad_fail:                 { paywall_info: PaywallInfo; errorMessage?: string };
  paywallWebviewLoad_timeout:              { paywall_info: PaywallInfo };
  paywallProductsLoad_start:               { triggeredPlacementName?: string; paywall_info: PaywallInfo };
  paywallProductsLoad_complete:            { triggeredPlacementName?: string; paywall_info: PaywallInfo };
  paywallProductsLoad_fail:                { errorMessage?: string; triggeredPlacementName?: string; paywall_info: PaywallInfo };
  paywallResourceLoad_fail:                { url: string; error: string };
  shimmerView_start:                       {};
  shimmerView_complete:                    { duration: number };

  // transactions
  transaction_start:                       { product: Product; paywall_info: PaywallInfo };
  transaction_complete:                    { transaction?: StoreTransaction; product: Product; paywall_info: PaywallInfo; product_identifier: string };
  transaction_fail:                        { error: string; paywall_info: PaywallInfo };
  transaction_abandon:                     { product: Product; paywall_info: PaywallInfo };
  transaction_timeout:                     { paywall_info: PaywallInfo };
  transaction_restore:                     { restoreType: RestoreType; paywall_info: PaywallInfo };
  restore_start:                           {};
  restore_complete:                        {};
  restore_fail:                            { reason: string };
  subscription_start:                      { product: Product; paywall_info: PaywallInfo };
  freeTrial_start:                         { product: Product; paywall_info: PaywallInfo; trial_end_date: string };
  nonRecurringProduct_purchase:            { product: TransactionProduct; paywall_info: PaywallInfo };

  // enrichment
  enrichment_start:                        {};
  enrichment_complete:                     { userEnrichment: Record<string, JsonValue | null>; deviceEnrichment: Record<string, JsonValue | null> };
  enrichment_fail:                         {};

  // custom
  custom_placement:                        { placementName: string; paywall_info: PaywallInfo; params: Record<string, JsonValue> };

  // misc
  review_requested:                        { count: number };
  permission_requested:                    { permissionName: string; paywallIdentifier: string };
  permission_granted:                      { permissionName: string; paywallIdentifier: string };
  permission_denied:                       { permissionName: string; paywallIdentifier: string };
}
```

Dropped from Android (per product owner):
- `cel_expression_result`, `error_thrown` — internal-only.
- `review_granted`, `review_denied` — out of v0.
- `survey_response`, `survey_close` — surveys deferred.
- `redemption_start` / `redemption_complete` / `redemption_fail` — redemption deferred.
- `testModeModal_open` / `testModeModal_close` — debug UI deferred.
- `paywallWebviewLoad_fallback` — Android-only.
- `touchesBegan`, `adServicesTokenRequest*`, `paywallWebviewProcessTerminated` — native-only.

### 8.2 Local-only events (`LocalSuperwallEventMap`)

Web-specific signals that fire on `sw.events` (and `useSuperwallEvent`) but are **never POSTed to the collector**. Naming is camelCase (no wire convention to match):

```ts
interface LocalSuperwallEventMap {
  identityHydrated:        { source: "client" | "cookie" | "generated"; aliasChanged: boolean; userChanged: boolean };  // fires once after SSR hydration (§7.4)
  // future: presenterAttached, presenterDetached, hmrReset, ...
}
```

`SuperwallEventTarget.addEventListener` is typed against the union `keyof SuperwallEventMap | keyof LocalSuperwallEventMap`. The internal wire emitter consults a `LOCAL_ONLY: ReadonlySet<string>` derived from `keyof LocalSuperwallEventMap` and skips emission for those keys.

### 8.3 Wire emission

Each event in `SuperwallEventMap` (NOT `LocalSuperwallEventMap`) POSTs to the collector (§11.3) as:
```json
{ "event_id": "<uuid>", "event_name": "<key from SuperwallEventMap>", "parameters": { /* detail */ }, "created_at": "<ISO>" }
```
`event_name` and parameter keys match Android verbatim — `paywall_info` is the JSON key for the paywall info object, `product_identifier` on `transaction_complete`, `audienceFilterParams` on `integration_attributes`, etc. The TS-side `SuperwallEventMap` keys ARE the wire strings.

---

## 9. React bindings (`@superwall/paywalls-react`)

React 19 idiomatic. Provider owns instance creation; Suspense waits for `ready`.

### 9.1 Provider

```tsx
import { SuperwallProvider } from "@superwall/paywalls-react";

<SuperwallProvider
  apiKey="pk_web_..."
  options={{ /* SuperwallOptions */ }}
  purchaseController={myController}
  delegate={myDelegate}
  // identity?: ..., storage?: ..., presenter?: ...
>
  <Suspense fallback={<Loading />}>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </Suspense>
</SuperwallProvider>
```

- Creates the instance via `createSuperwall` on mount.
- Attaches a default `createBrowserPresenter()` unless one is passed.
- SSR-safe: on server, Provider renders children without touching `window`.
- **HMR / Fast Refresh resilient (normative):** the Provider holds the instance in a module-level `WeakRef`-keyed registry by `apiKey`. On unmount it dismisses the active paywall (`presenter.dismiss()`) and clears in-flight `request_id`s. On re-mount with the same `apiKey`, it reuses the existing instance instead of creating a new one — so dev sessions don't leak iframes or duplicate event listeners.

### 9.2 Gating render on configuration

**You usually don't need to gate.** Per §1, every SDK method internally awaits `sw.ready`. Synchronous reads (`sw.user.id.value`, `sw.subscriptionStatus.value`) work immediately from persisted storage; mutations queue; `register` blocks. Most React trees can render eagerly, including under SSR / RSC.

Use `use(sw.ready)` only when:
- Reading enrichment-derived values (server-augmented user/device attrs) and you don't want to render with the pre-enrichment snapshot.
- Pre-loading paywalls (`sw.placements.preloadFor([...])`) needs to happen before first paint.
- You explicitly want a Suspense fallback while the initial config + enrichment land.

```tsx
import { useSuperwall } from "@superwall/paywalls-react";
import { use, Suspense } from "react";

function ConfigGate({ children }: { children: ReactNode }) {
  const sw = useSuperwall();
  use(sw.ready);                // suspends until configured; throws to nearest ErrorBoundary on fail
  return <>{children}</>;
}

<Suspense fallback={<Loading />}>
  <ConfigGate>
    <PostEnrichmentTree />
  </ConfigGate>
</Suspense>
```

**SSR / RSC caveat.** `use(sw.ready)` will suspend during SSR, which delays render of the entire subtree until config + enrichment resolve. For RSC / streaming SSR consumers, prefer **rendering eagerly** (do not gate with `use(sw.ready)` server-side). The Provider hydrates with seeded identity (§7.4) so cached state is enough for first paint; client-side re-render after hydration is automatic if the resolved identity differs.

No `<SuperwallLoading>` / `<SuperwallLoaded>` / `<SuperwallError>` components — `<Suspense>` + `<ErrorBoundary>` replace them when you do choose to gate.

### 9.3 Hooks

```ts
useSuperwall(): Superwall;

useSignal<T>(signal: Readable<T>): T;             // useSyncExternalStore adapter
useSignalValue<T>(signal: Readable<T>): T;        // alias; just clearer intent

useUser(): {
  id: string;
  aliasId: string;
  effectiveId: string;
  isLoggedIn: boolean;
  attributes: UserAttributes;
  integrationAttributes: Partial<Record<IntegrationAttribute, string>>;
  subscriptionStatus: SubscriptionStatus;
  customerInfo: CustomerInfo | null;
  entitlements: Entitlement[];           // active
  identify: Superwall["user"]["identify"];
  signOut:  Superwall["user"]["signOut"];
  setAttributes: Superwall["user"]["setAttributes"];
  setIntegrationAttribute:  Superwall["user"]["setIntegrationAttribute"];
  setIntegrationAttributes: Superwall["user"]["setIntegrationAttributes"];
};

usePlacement(handler?: PaywallPresentationHandler): {
  register: (args: RegisterPlacementArgs) => Promise<RegisterPlacementResult>;
  state:    PaywallState;
};

useSuperwallEvent<K extends keyof SuperwallEventMap>(
  type: K,
  listener: (event: SuperwallCustomEvent<K>) => void,
): void;     // auto-cleanup on unmount via internal AbortController
```

### 9.4 `PaywallState`

```ts
type PaywallState =
  | { type: "idle" }
  | { type: "presented"; info: PaywallInfo }
  | { type: "dismissed"; info: PaywallInfo; result: PaywallResult }
  | { type: "skipped";   reason: PaywallSkippedReason }
  | { type: "error";     error: Error };
```

### 9.5 Optimistic UX pattern (example, not API)

Purchase flow with `useOptimistic` + `useTransition`:

```tsx
function UpgradeButton() {
  const { subscriptionStatus } = useUser();
  const { register } = usePlacement();
  const [optimistic, setOptimistic] = useOptimistic(subscriptionStatus);
  const [isPending, startTransition] = useTransition();

  const onClick = () => startTransition(async () => {
    setOptimistic({ status: "ACTIVE", entitlements: [/* placeholder */] });
    const res = await register({ placement: "upgrade_cta" });
    if (res.type !== "presented" || res.result.type !== "purchased") {
      setOptimistic(subscriptionStatus);  // roll back
    }
  });

  return <button disabled={isPending} onClick={onClick}>
    {optimistic.status === "ACTIVE" ? "✓ Pro" : "Upgrade"}
  </button>;
}
```

---

## 10. Core types

### 10.1 Module augmentation — user-facing generics without generics

Apps declare their own shapes once; types flow everywhere with zero ceremony.

```ts
// your app's types.d.ts
declare module "@superwall/paywalls-js" {
  interface UserAttributes {
    email?: string;
    plan?: "free" | "pro" | "enterprise";
    teamId?: string;
    seatCount?: number;
  }

  interface PlacementParams {
    screen?: string;
    referrer?: string;
  }

  interface CustomCallbacks {
    openHelp:    { input: {};                  output: void };
    submitEmail: { input: { email: string };   output: { ok: boolean } };
  }
}
```

Defaults when not augmented:
```ts
interface UserAttributes   {}    // closed; augment to add fields
interface PlacementParams  {}
interface CustomCallbacks  {}
```

`{}` + module augmentation gives strict closed-shape typing — unaugmented apps that want loose typing can pass `Record<string, JsonValue>` through escape hatches (`setAttributes(attrs as UserAttributes)`). This matches how TanStack Router and Fastify model augmentable surfaces.

### 10.2 Primitive types

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

type ConfigurationStatus = "pending" | "configured" | "failed";
type LogLevel = "debug" | "info" | "warn" | "error" | "none";
type LogScope =
  | "all" | "cache" | "configManager" | "debugManager" | "device"
  | "identityManager" | "localization" | "network" | "paywallEvents"
  | "paywallPresentation" | "paywallView" | "placements"
  | "productsManager" | "superwallCore" | "transactions";

interface IdentityOptions { restorePaywallAssignments?: boolean }
```

### 10.3 Subscription & entitlements

```ts
type SubscriptionStatus =
  | { status: "UNKNOWN" }
  | { status: "INACTIVE" }
  | { status: "ACTIVE"; entitlements: Entitlement[] };

type ProductStore = "appStore" | "stripe" | "paddle" | "playStore" | "superwall" | "other";
type LatestSubscriptionState = "inGracePeriod" | "subscribed" | "expired" | "inBillingRetryPeriod" | "revoked";
type LatestSubscriptionOfferType = "trial" | "code" | "promotional" | "winback";

interface Entitlement {
  id: string;
  type: "SERVICE_LEVEL";
  isActive: boolean;
  productIds: string[];
  latestProductId?: string;
  store?: ProductStore;
  startsAt?: number;                     // ms since epoch (internal convention)
  renewedAt?: number;
  expiresAt?: number;
  isLifetime?: boolean;
  willRenew?: boolean;
  state?: LatestSubscriptionState;
  offerType?: LatestSubscriptionOfferType;
}

interface Product {
  id: string;
  name?: string;
  entitlements: Entitlement[];
  store: ProductStore;
}

interface CustomerInfo {
  userId: string;
  subscriptions: SubscriptionTransaction[];
  nonSubscriptions: NonSubscriptionTransaction[];
  entitlements: Entitlement[];
}

interface SubscriptionTransaction {
  transactionId: string;
  productId: string;
  purchaseDate: number;                  // ms since epoch
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

interface NonSubscriptionTransaction {
  transactionId: string;
  productId: string;
  purchaseDate: number;
  isConsumable: boolean;
  isRevoked: boolean;
  store?: ProductStore;
}

interface StoreTransaction {
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

type RestoreType =
  | { type: "viaPurchase"; storeTransaction?: StoreTransaction }
  | { type: "viaRestore" };

// Used by the `nonRecurringProduct_purchase` event.
interface TransactionProduct {
  id: string;
  store: ProductStore;
  // mirrors Flutter PNonSubscriptionTransaction fields where relevant
  isConsumable?: boolean;
}

// Used by the `paywall_page_view` event (matches Android `PageViewData`).
interface PageViewData {
  pageNodeId: string;
  flowPosition: number;
  pageName: string;
  navigationNodeId: string;
  previousPageNodeId?: string;
  previousFlowPosition?: number;
  navigationType: string;
  timeOnPreviousPageMs?: number;
}
```

### 10.4 Paywall

```ts
interface PaywallInfo {
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
  responseLoadStartTime?: string;  responseLoadCompleteTime?: string;  responseLoadFailTime?: string;  responseLoadDuration?: number;
  webViewLoadStartTime?: string;   webViewLoadCompleteTime?: string;   webViewLoadFailTime?: string;   webViewLoadDuration?: number;
  productsLoadStartTime?: string;  productsLoadCompleteTime?: string;  productsLoadFailTime?: string;  productsLoadDuration?: number;
  paywalljsVersion?: string;
  isFreeTrialAvailable?: boolean;
  featureGatingBehavior?: "gated" | "nonGated";
  closeReason?: "systemLogic" | "forNextPaywall" | "webViewFailedToLoad" | "manualClose" | "none";
  computedPropertyRequests?: ComputedPropertyRequest[];
  // surveys omitted in v0
  // localNotifications omitted in v0
  state?: Record<string, JsonValue>;
}

interface Experiment { id: string; groupId: string; variant: Variant }
interface Variant { id: string; type: "treatment" | "holdout"; paywallId?: string }
interface ConfirmedAssignment { experimentId: string; variant: Variant }

// What the user did with a presented paywall.
type PaywallResult =
  | { type: "purchased"; productId: string; transaction?: StoreTransaction }
  | { type: "declined" }
  | { type: "restored" };

// Why a paywall was skipped without being presented. Strict subset of
// `RegisterPlacementResult` (§2.2) — the `reason` field there reuses this type.
type PaywallSkippedReason =
  | { type: "holdout";            experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" };

// Event-info shape for the `triggerFire` event (§8.1). Wire-parity with
// Flutter `PTriggerResult` / Android `TriggerResult`; kept distinct from
// `PresentationResult` because its variants differ (`error` exists here;
// `paywallNotAvailable` does not).
type TriggerResult =
  | { type: "placementNotFound" }
  | { type: "noAudienceMatch" }
  | { type: "paywall";  experiment: Experiment }
  | { type: "holdout";  experiment: Experiment }
  | { type: "error";    error: string };

type PaywallPresentationRequestStatusType = "presentation" | "noPresentation" | "timeout";
type PaywallPresentationRequestStatusReason =
  | { type: "debuggerPresented" }
  | { type: "paywallAlreadyPresented" }
  | { type: "holdout";            experiment: Experiment }
  | { type: "noAudienceMatch" }
  | { type: "placementNotFound" }
  | { type: "noPaywallView" }
  | { type: "noPresenter" }
  | { type: "noConfig" }
  | { type: "subsStatusTimeout" };
```

### 10.5 Callbacks, computed properties, integration attrs

```ts
interface ComputedPropertyRequest { type: ComputedPropertyRequestType; eventName: string }
type ComputedPropertyRequestType =
  | "minutesSince" | "hoursSince" | "daysSince" | "monthsSince" | "yearsSince"
  | "placementsInHour" | "placementsInDay" | "placementsInWeek" | "placementsInMonth"
  | "placementsSinceInstall";

// Closed set — mirrors the Android 24-provider superset.
type IntegrationAttribute =
  | "adjustId" | "amplitudeDeviceId" | "amplitudeUserId" | "appsflyerId"
  | "brazeAliasName" | "brazeAliasLabel" | "onesignalId" | "fbAnonId"
  | "firebaseAppInstanceId" | "iterableUserId" | "iterableCampaignId" | "iterableTemplateId"
  | "mixpanelDistinctId" | "mparticleId" | "clevertapId" | "airshipChannelId"
  | "kochavaDeviceId" | "tenjinId" | "posthogUserId" | "customerioId"
  | "meta" | "amplitude" | "mixpanel" | "googleAds" | "googleAppSetId"
  | "appstackId" | "custom";
```

### 10.6 Options

```ts
interface SuperwallOptions {
  paywalls?: PaywallOptions;
  networkEnvironment?: "release" | "releaseCandidate" | "developer" | { custom: CustomEnvironmentHosts };
  localeIdentifier?: string;
  logging?: { level?: LogLevel; scopes?: LogScope[] };
  testModeBehavior?: "automatic" | "whenEnabledForUser" | "never" | "always";
  maxConfigRetryCount?: number;               // default 6
  enableExperimentalDeviceVariables?: boolean;
  isExternalDataCollectionEnabled?: boolean;
  identity?: { cookieDomain?: string; cookieSecure?: boolean };
  appVersion?: string;
  appBuild?: string;
  bundleId?: string;
}

interface PaywallOptions {
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
  onTestPurchase?: (product: Product) => Promise<"purchased" | "declined">;   // test mode override (§6)
}

interface CustomEnvironmentHosts {
  base: string;
  collector: string;
  enrichment: string;
  subscriptions: string;
}
```

Not on web (removed entirely — TS errors on use): `isGameControllerEnabled`, `passIdentifiersToPlayStore`, `shouldBypassAppTransactionCheck`, `useMockReviews`, `shouldObservePurchases`.

### 10.7 Errors

All errors thrown by the SDK extend a common base for `instanceof` discrimination. Stable `code` field for non-TS consumers.

```ts
class SuperwallError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.name = "SuperwallError"; this.code = code; }
}

class NotConfiguredError extends SuperwallError {
  constructor(public readonly cause?: Error) {
    super("Superwall is not configured (sw.ready rejected).", "NOT_CONFIGURED");
    this.name = "NotConfiguredError";
  }
}

class NoPresenterRegisteredError extends SuperwallError {
  constructor(public readonly placement: string) {
    super(`No PaywallPresenter registered; cannot present "${placement}".`, "NO_PRESENTER");
    this.name = "NoPresenterRegisteredError";
  }
}

class PaywallAlreadyPresentedError extends SuperwallError {
  constructor(
    public readonly attemptedPlacement: string,
    public readonly currentPaywallInfo: PaywallInfo,
  ) {
    super(`Paywall already presented (${currentPaywallInfo.identifier}); cannot present "${attemptedPlacement}".`, "PAYWALL_ALREADY_PRESENTED");
    this.name = "PaywallAlreadyPresentedError";
  }
}

class NoDefaultSuperwallError extends SuperwallError {
  constructor() {
    super("No default Superwall instance — call createSuperwall() before using named exports.", "NO_DEFAULT_INSTANCE");
    this.name = "NoDefaultSuperwallError";
  }
}

class NetworkError extends SuperwallError {
  constructor(message: string, public readonly status?: number, public readonly cause?: Error) {
    super(message, "NETWORK");
    this.name = "NetworkError";
  }
}

class ConfigurationFetchError extends SuperwallError {
  constructor(public readonly cause: Error, public readonly attempt: number) {
    super(`Failed to fetch SDK configuration (attempt ${attempt}).`, "CONFIG_FETCH");
    this.name = "ConfigurationFetchError";
  }
}

class PresenterError extends SuperwallError {
  constructor(message: string, public readonly cause?: Error) {
    super(message, "PRESENTER");
    this.name = "PresenterError";
  }
}

class StorageError extends SuperwallError {
  constructor(message: string, public readonly cause?: Error) {
    super(message, "STORAGE");
    this.name = "StorageError";
  }
}
```

All exported from `@superwall/paywalls-js`. Errors thrown by `register` are also surfaced on `RegisterPlacementResult` as `{ type: "error", error }` (the same `Error` instance).

---

## 11. Wire protocol

Identical to Android — web SDK is wire-compatible.

### 11.1 Environments

| env | base | collector | enrichment | subscriptions |
|---|---|---|---|---|
| `release` | `api.superwall.me` | `collector.superwall.me` | `enrichment-api.superwall.com` | `subscriptions-api.superwall.com` |
| `releaseCandidate` | `api.superwallcanary.com` | `collector.superwallcanary.com` | `enrichment-api.superwall.dev` | `subscriptions-api.superwall.dev` |
| `developer` | `api.superwall.dev` | `collector.superwall.dev` | `enrichment-api.superwall.dev` | `subscriptions-api.superwall.dev` |
| `custom` | all four user-provided | | | |

### 11.2 Endpoints

| purpose | method | path |
|---|---|---|
| Static config | `GET` | `/api/v1/static_config?pk={API_KEY}` (base) |
| Event ingestion | `POST` | `/api/v1/events` (collector) |
| Enrichment | `POST` | `/api/v1/enrich` (enrichment) |
| Confirm assignments | `POST` | `/api/v1/confirm_assignments` (base) |
| Web redemption | `POST` | `/subscriptions-api/public/v1/redeem` (subscriptions) — **deferred past v0** |

### 11.3 Request headers (web-adapted)

```
Authorization: Bearer {API_KEY}
Content-Type: application/json
X-Platform: Web
X-Platform-Environment: SDK
X-Platform-Wrapper: Web
X-App-User-ID: {appUserId or ""}
X-Alias-ID: {aliasId}
X-URL-Scheme: {location.origin on browser; options.urlScheme on BE, "" if unset}
X-Vendor-ID: {persisted UUID}
X-App-Version: {options.appVersion or ""}
X-OS-Version: {UA-CH platformVersion, fallback UA parse}
X-Device-Model: {UA-CH model, fallback ""}
X-Device-Locale: {navigator.language}
X-Device-Language-Code: {navigator.language.split("-")[0]}
X-Device-Currency-Code: {Intl.NumberFormat().resolvedOptions().currency}
X-Device-Currency-Symbol: {derived}
X-Device-Timezone-Offset: {-(new Date().getTimezoneOffset() * 60)}
X-App-Install-Date: {firstSeenAt, ISO}
X-Device-Interface-Style: {"light" | "dark"}
X-SDK-Version: {package version}
X-Bundle-ID: {options.bundleId or location.hostname}
X-Is-Sandbox: {networkEnvironment !== "release"}
X-Entitlement-Status: {"ACTIVE" | "INACTIVE" | "UNKNOWN"}
X-Current-Time: {now ISO}
X-Static-Config-Build-Id: {config.buildId or ""}
```
Dropped from Android on web: `X-Radio-Type`, `X-Low-Power-Mode`, `X-Git-Sha`, `X-Build-Time`.

### 11.4 Events payload

```json
{ "events": [
  { "event_id": "<uuid>", "event_name": "<key from SuperwallEventMap>", "parameters": { ... }, "created_at": "<ISO>" }
]}
```

`event_name` strings match iOS/Android verbatim (e.g. `paywallResponseLoad_start`, `subscriptionStatus_didChange`). All events in `SuperwallEventMap` (§8.1) are POSTed (no client-side filtering).

### 11.5 Device attributes

Sent as the `device` field in enrichment requests, as the `deviceAttributes` map on every event, and as headers (subset). Mirrors Android `DeviceTemplate.kt` verbatim. **Wire serialization is mostly camelCase**; three keys differ from their Kotlin property names via `@SerialName`:

| Kotlin property | Wire key |
|---|---|
| `platformWrapper` | `platform_wrapper` |
| `platformWrapperVersion` | `platform_wrapper_version` |
| `capabilitiesConfig` | `capabilities_config` |

(Android also annotates `capabilities` with `@SerialName("capabilities")` — identity match, no effect on the wire.) All other keys serialize as their Kotlin names (camelCase, e.g. `appInstallDate`, `timezoneOffset`). The table below uses the wire key for each row.

| Key | Type | Web source |
|---|---|---|
| `publicApiKey` | string | configured `apiKey` |
| `platform` | `"Web"` | const |
| `platform_wrapper` | string | `"Web"` |
| `platform_wrapper_version` | string | framework package version |
| `appUserId` | string | identity |
| `aliases` | string[] | `[aliasId]` |
| `vendorId` | string | persisted UUID (or `vendorIdProvider()` if set) |
| `deviceId` | string | `sha256(vendorId)` short hash (hex, truncated to 16 chars) |
| `appVersion` | string | `options.appVersion ?? ""` |
| `appVersionPadded` | string | zero-padded `appVersion` for version-compare CEL (Android parity) |
| `appBuildString` | string | `options.appBuild ?? ""` |
| `appBuildStringNumber` | number? | parsed from `appBuild` |
| `osVersion` | string | UA-CH `platformVersion`, fallback UA regex |
| `deviceModel` | string | UA-CH `model`, fallback `""` |
| `deviceLocale` | string | `navigator.language` |
| `preferredLocale` | string | `navigator.languages[0] ?? navigator.language` (Android parity) |
| `preferredLanguageCode` | string | `deviceLocale.split("-")[0]` |
| `deviceLanguageCode` | string | Android-specific locale-derived; web: same as `preferredLanguageCode` (parity column) |
| `regionCode` | string | `deviceLocale.split("-")[1] ?? ""` |
| `preferredRegionCode` | string | `preferredLocale.split("-")[1] ?? ""` (Android parity) |
| `deviceCurrencyCode` | string | `Intl.NumberFormat().resolvedOptions().currency` |
| `deviceCurrencySymbol` | string | derived via `Intl.NumberFormat(...).formatToParts(0)` |
| `timezoneOffset` | number | `-new Date().getTimezoneOffset() * 60` |
| `interfaceStyle` | `"Light" \| "Dark"` | `matchMedia("(prefers-color-scheme: dark)")` |
| `interfaceStyleMode` | `"automatic" \| "manual"` | `"automatic"` (no user override yet) |
| `bundleId` | string | `options.bundleId ?? location.hostname` |
| `appInstallDate` | string | `firstSeenAt`, ISO |
| `isSandbox` | `"true" \| "false"` | `networkEnvironment !== "release"` — stringified for Android parity |
| `isFirstAppOpen` | boolean | `!storage.didTrackFirstSession` |
| `sdkVersion` | string | package version |
| `sdkVersionPadded` | string | zero-padded `sdkVersion` for version-compare CEL (Android parity) |
| `daysSinceInstall` / `minutesSinceInstall` | number | from `firstSeenAt` |
| `daysSinceLastPaywallView` / `minutesSinceLastPaywallView` | number? | from `lastPaywallViewAt` |
| `totalPaywallViews` | number | counter |
| `utcDate`, `localDate`, `utcTime`, `localTime`, `utcDateTime`, `localDateTime` | string | derived at send time |
| `activeEntitlements` | string[] | active ids |
| `activeEntitlementsObject` | `{id,type}[]` | same |
| `subscriptionStatus` | `"ACTIVE" \| "INACTIVE" \| "UNKNOWN"` | current |
| `activeProducts` | string[] | active product IDs |
| `reviewRequestCount` | number | counter |
| `deviceTier` | `"desktop" \| "tablet" \| "mobile"` | UA-CH + viewport |
| `capabilities` | string[] | `["paywall_event_receiver", "multiple_paywall_urls", "config_caching"]` (verbatim from Android `Capability.kt`) |
| `capabilities_config` | `Array<{name: string, ...}>` | Polymorphic array (one entry per capability), discriminated by `name`. Example: `[{"name":"paywall_event_receiver", "event_names":["transaction_start","transaction_restore","transaction_complete","restore_start","restore_fail","restore_complete","transaction_fail","transaction_abandon","transaction_timeout","paywall_open","paywall_close"]}, {"name":"multiple_paywall_urls"}, {"name":"config_caching"}]` |
| **Web-specific** | | |
| `userAgent` | string | `navigator.userAgent` |
| `viewportWidth` / `viewportHeight` | number | `innerWidth` / `innerHeight` |
| `screenWidth` / `screenHeight` | number | `screen.width` / `screen.height` |
| `devicePixelRatio` | number | `devicePixelRatio` |
| `connectionType` | string? | `navigator.connection?.effectiveType` |
| `hardwareConcurrency` | number? | `navigator.hardwareConcurrency` |
| `deviceMemory` | number? | `navigator.deviceMemory` |
| `cookiesEnabled` | boolean | `navigator.cookieEnabled` |

Compatibility note: Android emits `radioType`, `isLowPowerModeEnabled`, `isMac`, `kotlinVersion` as part of `DeviceTemplate`. The web SDK will emit them as constants/defaults rather than omit them, so CEL audience filters that reference these keys don't break:
- `radioType: ""` (empty; web has no radio; consumers should prefer `connectionType`)
- `isLowPowerModeEnabled: false`
- `isMac: false` (replaced by `deviceTier`/`deviceModel` for desktop/mobile distinction)
- `kotlinVersion: ""`

Need to confirm with the collector/CEL team whether these should instead be omitted; tracked in §14.

**Computed properties.** `daysSince_{eventName}`, `paywallsInHour`, `paywallsInDay`, `paywallsInWeek`, `paywallsInMonth`, `placementsSinceInstall` — computed from event history in IndexedDB (`superwall.events` object store), merged into `device` on enrichment and `deviceAttributes` on placement eval.

### 11.6 Enrichment

`POST /api/v1/enrich` body:
```json
{ "user": { /* user attributes */ }, "device": { /* keys from §11.5 */ } }
```

Called on `configure` and on every `identify`. The BE enriches user/device attributes based on the `vendorId + userId + alias` triple and returns:
```json
{ "user": { ... }, "device": { ... } }
```
Merged back into `userAttributes` and `deviceAttributes` before next config fetch / event emit.

Client cache keyed by request body hash; 500ms fresh-window (Android parity); stale fallback on failure.

### 11.7 Cache semantics

| Resource | Mechanism |
|---|---|
| Config | Client cache keyed by `buildId` via `X-Static-Config-Build-Id`. 500ms (subscribed) / 1s fresh-window; stale fallback on timeout/failure. |
| Enrichment | Same as config: 500ms/1s + stale fallback. |
| Paywall HTML | Immutable. Browser HTTP cache; host serves `Cache-Control: public, max-age=31536000, immutable`. No SDK-side disk cache. Preloaded iframes resident per `shouldPreload`. |
| Events / postbacks / confirm | `POST`, no caching. |

No `ETag` / `If-None-Match` / `Cache-Control` on SDK-originated requests (Android parity). Revalidation is build-id based.

---

## 12. BE-safe API surface

`@superwall/paywalls-js` (no subpath) is safe in Node / Bun / edge / workers / SSR.

Always callable:
- `createSuperwall` (pass `identity` to pre-seed, or a `storage` adapter)
- `await sw.ready`
- All `sw.user.*` operations
- All `sw.entitlements.*`, `sw.subscriptionStatus`, `sw.customerInfo`
- `sw.placements.getPresentationResult`, `sw.placements.confirmAllAssignments`
- `sw.events.addEventListener`
- `sw.setDelegate`, `sw.setLogLevel`, `sw.setLocale`, `sw.reset`

Requires a presenter (pass one at `createSuperwall`):
- `sw.placements.register` — throws `NoPresenterRegisteredError` otherwise.
- `sw.placements.preloadAll` / `preloadFor` — throws without a presenter that implements `preload?`.

Browser-only (in `/browser` subpath):
- `createBrowserPresenter`, `createBrowserStorage`.

No localStorage/cookies touched from the headless root. Callers manage identity persistence via `createSuperwall({ identity, storage })`.

> **Deferred:** per-attribute BE fallback table (what every `navigator.*` / `screen.*` / `matchMedia` / `location.*` / `window.*` / IndexedDB reference resolves to on Node / Bun / edge when unavailable). Computed-property storage on BE (no IndexedDB) also needs a spec — likely a caller-provided KV on the `storage` adapter. Tracked in §14.

---

## 13. v0 scope

**In**
- `createSuperwall` + `sw.ready`, default-instance named exports (`user`, `placements`, etc.)
- Namespaced instance API with reactive signals (`Readable<T>`)
- `EventTarget`-based event bus with typed `addEventListener`
- Global `SuperwallDelegate` + placement-scoped `handler`
- `createBrowserPresenter` (modal/fullscreen, preload via hidden iframes, test-mode confirm dialog)
- `paywalls-react` — Provider, `use(sw.ready)`, hooks (`useSuperwall`, `useSignal`, `useUser`, `usePlacement`, `useSuperwallEvent`)
- Config + collector + enrichment + `confirm_assignments` endpoints
- Identity persistence (localStorage authoritative, cookies mirrored — `_sw_alias_id`, `sw_checkout_experimentId`, `_sw_last_email`, plus TBD user/vendor cookies)
- Pluggable `StorageAdapter`
- Pluggable `vendorIdProvider`
- Integration attributes (closed union)
- Computed property requests
- Preload APIs
- Custom callbacks via module-augmented `CustomCallbacks`
- Module augmentation for `UserAttributes`, `PlacementParams`, `CustomCallbacks`
- Test mode (browser confirm dialog)
- `maxConfigRetryCount` option

**Out (deferred)**
- Surveys
- Local notifications
- Deep links (`handleDeepLink`, deep-link delegate callbacks)
- Web code redemption
- `overrideProductsByName`
- `"inline"` paywall presentation
- First-party Stripe/Paddle purchase controller adapters
- Bundled fingerprinting
- `paywalls-react/server` RSC helpers (v1 target)
- Debug panel / developer overlay (v1 target)
- Vue / Svelte / Solid bindings

---

## 14. Open

All implementation-blocking items resolved. Remaining opens are product/coordination questions, not design holes.

1. **BE-safe fallback table** — every `navigator.*`, `screen.*`, `matchMedia`, `location.*`, `window.*`, IndexedDB reference in §11.5 needs a documented server-side behavior. Computed-property storage on BE needs a non-IndexedDB path (KV via `storage` adapter).
2. **Multi-tab coordination** — concurrent localStorage writes; paywall open in two tabs; cookie write races. BroadcastChannel sync, or last-writer-wins.
3. **Cookie naming for user ID + vendor ID** — `_sw_user_id`, `_sw_vendor_id` provisional.
4. **Enrichment response merge precedence** — Android merges server `device` over client. Same on web, or keep client values authoritative for browser-only keys (`viewport`, `devicePixelRatio`, `connectionType`)?
5. **`sw_checkout_experimentId` / `_sw_last_email` write semantics** — SDK-written or read-only? If also sibling-tool-written, conflict policy?
6. **Compat values for native-only device attrs** — confirm with collector/CEL team whether to send `radioType: ""`, `isLowPowerModeEnabled: false`, `isMac: false`, `kotlinVersion: ""` as compat defaults or omit entirely.
7. **Storage key contract** — keys listed in §5 (`superwall.aliasId` etc.) are default-adapter internals. Promote to a public `STORAGE_KEYS` constant for adapter authors, or document as not-stable.
8. **`window.app.getAllState()` response transport on web** — Android invokes via `evaluateJavascript` and reads return value synchronously; on cross-origin web, requires a paywall-side `accept64` reply convention. Confirm with paywall.js.
9. **Mobile Safari preload** — hidden iframes are throttled (autoplay suspended, timers coalesced, fetch budget cut). Either feature-detect and disable preload on iOS Safari, or document as known limitation.
10. **HTML substitutions bundle shape** — §7.2 templates bundle is locked but the HTML substitutions `accept64` payload shape (sent immediately after templates) needs verification against paywall.js. TBD pending source access.
