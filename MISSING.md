# What's missing in v0 alpha

The headless core + browser presenter + React bindings + example all ship and have 180+ passing tests. This file is the honest inventory of what *isn't* shipped yet — bugs caught in code review, deferred features from `API.md`, and known limitations against the iOS / Android / Flutter SDKs.

Two categories:

- **🐛 Code-review issues** found during the post-implementation review pass. These are bugs in landed code; fix before promoting `0.0.1-alpha` → `0.0.1`.
- **🚧 Deferred scope** — features intentionally cut from v0 alpha per `API.md` §13 (v0 scope) and §14 (open questions). Track for v0.1 / v1.

Each item links the relevant `API.md` section where applicable.

> **Major separate workstream:** `@superwall/server` + hardened security model. The browser SDK's local subscription state is trivially writable from DevTools, so any developer using `register({ feature })` as a real access gate is one console line away from being bypassed. The fix is a server-side SDK that gates routes via Superwall's existing `/entitlements` endpoint, plus a docs reframe making client-side gating cosmetic-only. Full design — threat model, package layout, server SDK API surface, browser SDK changes, backend changes, rollout phases — lives in [`SERVER_SDK.md`](./SERVER_SDK.md). Not tracked in the v0 → v1 lists below because it's a new product surface, not deferred v0 scope.

---

## 🐛 Code-review issues — fix before next release

### ✅ P0 (all fixed)

- ~~**`createBrowserPresenter` cross-instance bleed.**~~ **DONE** — module-level `active$` removed; per-instance `ActivePresentation` is now threaded through the `mount` / `handleInbound` / `sendTemplatesStub` closures via a small forward-ref slot. Two presenters on one page no longer cross-talk.
- ~~**`register` lifecycle leaves `presentedSig` permanently true on failure.**~~ **DONE** — open-lifecycle wrapped in try/finally; `presentedSig` + `latestPaywallSig` reset on failure.
- ~~**`paywall_*` wire emission with stub `PaywallInfo`.**~~ **DONE** — `EventBus.publish` accepts `{wireEmit?: boolean}`; the SDK detects stub paywalls (`info.identifier.startsWith("stub_")`) and passes `wireEmit: false` through `paywall_open` / `paywall_close` / `paywall_decline`. EventTarget + delegate still fire (so consumer hooks work); collector POST is skipped.
- ~~**`createSignal` runs `Effect.runSync(SubscriptionRef.set(...))` per write.**~~ **DONE** — `signal.ts` rewritten as pure vanilla TS; `__ref` escape hatch + Effect-side dual-write removed. One Effect dependency dropped from the public-facing primitive.

### P1 (4 fixed this round; 3 remain)

- ~~**`deleteCookie` ignores `Secure` / `SameSite` / `Path`.**~~ **DONE** — `CookieWriteOptions` now applies to `deleteCookie`; `BrowserStorage.{remove, clear}` pass the configured attributes through. Cookies set with `SameSite=Lax; Secure` now reliably delete on Safari / Chrome.
- ~~**`paywall_decline` never emitted on `result.type === "declined"`.**~~ **DONE** — register lifecycle now publishes `paywall_decline` alongside `paywall_close` when `result.type === "declined"`. Cross-platform analytics parity restored.
- ~~**`custom_placement` from paywall is silently dropped.**~~ **DONE** — browser presenter inbound switch now handles `custom_placement` and forwards to `ctx.emit("custom_placement", ...)` with the active `paywall_info` + paywall-supplied `params`. Consumers of `useSuperwallEvent("custom_placement", …)` fire.
- ~~**`isSandbox` mis-flagged for custom environments.**~~ **DONE** — `isSandbox` now returns `false` for any custom-host env (assumes production proxy). Consumers needing sandbox semantics on a custom env override the header.

- ~~**`runtime.runPromise(...).catch(() => {})` swallows all errors silently.**~~ **DONE** — `superwall.ts` ships `runFireAndForget(scope, label, eff)` + `logViaRuntime(scope, label, cause)` helpers. All silent `.catch(() => {})` sites in superwall.ts now route through them so failures surface via `delegate.onLog`. `EventBus.withDelegate` accepts an optional `onError` callback; bridges (`onUserAttributesChange`, `onPaywallWillOpenURL`, `onCustomerInfoChange`, etc.) pass `logViaRuntime` so a throwing delegate doesn't disappear into the void. Test: `logger: failures inside delegate callbacks are surfaced via onLog instead of silently swallowed`.
- ~~**`useDelegate` blindly clears the global delegate on unmount.**~~ **DONE** — per-Superwall stack of `{id, delegate}` entries (WeakMap). Each `useDelegate` push gets a unique `Symbol`; unmount removes only that entry and re-applies whatever's now top. No more "second unmount kicks the first." Test: `useDelegate: unmounting one of two stacked hooks leaves the other installed`.
- ~~**`useSignal` + tree-shakeable `lazyReadable` infinite-loop risk.**~~ **DONE (defensive)** — `useSignal` now stores the signal in a ref and reads through it, so subscribe + getSnapshot identities stay stable across renders even if the caller passes a fresh signal object every render. Test: `useSignal: unstable signal identity per render doesn't trigger infinite re-render`.

### P2 (post-alpha polish)

- `superwall.ts` uses a `Layer` cast where `Layer.mergeAll` would clean up the type. Refactor.
- `eventBus.ts` `parameters: detail as unknown as Record<string, JsonValue>` — needs a `toWire(detail)` helper before the eventual collector POST handles non-JSON-serializable types.
- `superwall.ts:hydrationSource` always reports `"cookie"` if any seed value is present, regardless of source. Defer real source until `BrowserStorage` reports lane.
- `paywall_open` lifecycle order: signal updates fire before `onPaywallWillPresent`, but `Will*` semantics imply "before state change."
- `internal/network.ts:fetchImpl` resolved at construction — `globalThis.fetch` swaps after construction are ignored.
- Provider-registry leak risk for SPAs creating Providers with route-derived `apiKey`s. Add `disposeProviderInstance(apiKey)` to the public surface.
- `internal/identity.ts:hydrate` not idempotent — second call regenerates the snapshot. Either guard or test.
- `superwall.ts:540` dead `throw err` branch (translateInternalError always returns Error).
- Test hygiene: `presenter.test.ts` doesn't reset the module-level `active$` (subsumed by P0 #1 fix).
- Header `X-App-User-ID: ""` for anonymous — confirm collector accepts vs. omitting.

---

## 🚧 Deferred scope (v0 → v1)

### Backend / runtime

- ~~**Real placement evaluation.**~~ **DONE** — Full pipeline: `ConfigService.getPlacement` → `AudienceEvaluator` (Superscript CEL via WASM) → `AssignmentService.getOrAssign` (sticky-by-cache, percentage-respecting variant pick — per-call `Math.random()` + cumulative-range bucket, exact Android `ConfigLogic.chooseVariant` parity) → `ConfigService.getPaywall` lookup → real `PaywallInfo` built from config + presented. `featureGatingBehavior` flows config → PaywallInfo → register's declined handler: `nonGated` declined runs the feature, `gated` (default) does not. Skipped paths (placementNotFound/noAudienceMatch/holdout) always run feature (no paywall to gate). Backend `/api/v1/confirm_assignments` POST also wired (above). Tests cover both gated + nonGated declined paths plus the stub-paywall default-gated path.
- ~~**Static config processing.**~~ **DONE (parsing layer)** — `internal/config.ts` ships `ConfigService` (`Context.Tag`): fetches `/api/v1/static_config` on configure, parses to typed `RawConfig` / `RawTrigger` / `RawAudienceRule` / `RawExperimentRef` / `RawPaywallResponse` / `RawProductItem`, caches `{buildId, payload}` to `STORAGE_KEYS.config` for offline replay, hydrates from cache on configure (cache-first → revalidating fetch). `getPlacement(name)` / `getPaywall(id)` / `getProducts()` lookups exposed. **Still deferred:** audience-rule (CEL) evaluator + experiment-assignment picker that consumes the parsed triggers — that's what'll let `register()` return real `paywall` / `holdout` / `noAudienceMatch` results instead of always presenting a stub.
- ~~**Enrichment.** Endpoint defined in `NetworkService` but `configure()` doesn't call `/api/v1/enrich` yet, doesn't merge the response into `userAttributes`/`deviceAttributes`.~~ **DONE** — `configure()` POSTs `{user, device}` after identity hydration, merges the `user` enrichment response into the user-attributes signal (Android-style server-wins), emits `enrichment_start`/`enrichment_complete`/`enrichment_fail`. Per-`identify` re-enrichment is still TODO. Device-attributes payload is empty until the full `deviceAttributes` builder lands. (`API.md` §11.6)
- ~~**`confirmAllAssignments`.**~~ **DONE** — local side: per-call random variant pick over cumulative percentage ranges (matches Android `ConfigLogic.chooseVariant` exactly), sticky per `experimentId`, persisted to `STORAGE_KEYS.assignments`, replayed on next session, repicked when the cached variant id no longer exists. Backend side: `NetworkService.postConfirmAssignments` POSTs the local sticky picks to `/api/v1/confirm_assignments` after every `eagerAssign` (configure + refreshConfiguration). Best-effort. Test: `configure: POSTs confirm_assignments after eager assignment`.
- **Restore-state cache.** `purchases.restore()` now persists `superwall.lastRestoreAt` (ms-epoch) on every call, fires `restore_start`/`restore_complete`. Loaded on configure for parity with Android's offline state. **Still deferred:** PurchaseController-driven restore (no actual store interaction); dedup-against-rapid-retry logic.
- ~~**Computed properties** (`daysSince_*`, `paywallsInHour`, `paywallsInDay`, `paywallsInWeek`, `paywallsInMonth`, …).~~ **DONE** — `internal/computed.ts` ships a full `ComputedPropertiesService`: persists event history (FIFO 2000 records) under `STORAGE_KEYS.computedProperties`; computes `daysSince` / `minutesSince` / `hoursSince` / `monthsSince` / `yearsSince` / `placementsInHour|Day|Week|Month` / `placementsSinceInstall`. Wired into `EventBus.publish` so every wire-bound event auto-records. Reset hooks clear it. The audience-rule evaluator (still deferred — see "Real placement evaluation" above) is the consumer that will read these values.
- ~~**Device attributes payload.**~~ **DONE** — `internal/deviceAttributes.ts` ships `buildDeviceAttributes(input)` covering ~50 keys per API.md §11.5. Cross-platform compat defaults emitted so iOS/Android CEL filters don't break. Pure / SSR-safe. Wired into `runEnrichment` AND audience evaluator. **Counters wired:** `firstSeenAt` is bootstrapped on first `configure()` and persisted (survives `sw.reset()`); `totalPaywallViews` + `lastPaywallViewAt` increment on every `paywall_open` wire emission. `appInstallDate` / `daysSinceInstall` / `minutesSinceInstall` / `daysSinceLastPaywallView` / `minutesSinceLastPaywallView` / `totalPaywallViews` all populated from the persisted counters; `isFirstAppOpen = totalPaywallViews === 0`. **Still deferred:** (a) `osVersion` + `deviceModel` from UA-CH (currently `""`); (b) `reviewRequestCount` tracker (no review-request hook on web yet).
- **Retry / cache.** `NetworkService` has no `Schedule.exponential` retry honoring `maxConfigRetryCount`, no 500ms / 1s fresh-window cache, no stale-fallback. (`API.md` §11.7)
- **Local notifications, surveys, web code redemption** — entire feature areas deferred per `API.md` §13.

### Browser presenter — postMessage v1 inbound types not yet handled

**Update:** `open_url`, `open_url_external`, `open_deep_link`, `custom_placement`, and `template_params_and_user_attributes` are now handled (URL/deep-link forward via `ctx.emit` and bridge to delegate methods; `template_params_and_user_attributes` shares the same templates-bundle reply as `ping`). Remaining deferred:

Per `API.md` §7.2, Android's `PaywallMessage.kt` defines ~20 inbound types. v0 alpha handles 8: `ping`, `template_params_and_user_attributes`, `close`, `restore`, `restore_failed`, `purchase`, `open_url_external`, `open_url`/`open_deep_link`/`custom_placement`. Deferred:

- `custom` — should forward via `ctx.emit`
- `paywall_open`, `paywall_close`, `paywall_decline` (paywall-side acks)
- `transaction_start`, `transaction_complete`, `trial_started`
- `user_attribute_updated`
- `request_review` (Android: `request_store_review`)
- `request_permission` — needs `request_id` correlation for `permission_result` reply
- `request_callback` — needs `request_id` correlation for `callback_result` reply, plus `customCallbacks` handler-map plumbing into `register`
- `schedule_notification` — defer with surveys / local notifications
- `page_view` — paywall analytics
- `haptic_feedback` — Vibration API path

Outbound (SDK → paywall) channels deferred:
- Real templates bundle from config + identity + product subs (currently stubbed empty array)
- HTML substitutions bundle (sent as a separate `accept64` after templates per Android)
- `permission_result` / `callback_result` responses
- `app.getAllState()` request transport over postMessage

### React bindings

- **`useOptimistic` / `useTransition` examples.** API.md §9.5 has the example; we don't ship a doc page yet.
- **`paywalls-react/server` subpath** for Next 15 RSC + Remix server actions reading identity from `cookies()`. (`API.md` §0)
- **`@superwall/paywalls-react/atom`** — opt-in subpath exposing the underlying Atoms via `@effect-atom/atom-react` for consumers wanting Effect-native React. (`API.md` §0.1)

### Other framework bindings

- `@superwall/paywalls-vue`, `@superwall/paywalls-svelte`, `@superwall/paywalls-solid` — listed in `API.md` §0 as future packages; not started.

### v0.1 product / coordination items (from `API.md` §14)

- BE-safe fallback table — every `navigator.*` / `screen.*` / `matchMedia` / `location.*` / `window.*` / IndexedDB reference needs a documented server-side behavior. Computed-property storage on BE needs a non-IndexedDB path.
- Multi-tab coordination — concurrent `localStorage` writes, paywall open in two tabs, cookie write races. BroadcastChannel sync, or last-writer-wins.
- Cookie naming for user ID + vendor ID — `_sw_user_id`, `_sw_vendor_id` are provisional; sibling-tool conventions to be confirmed.
- Enrichment response merge precedence — Android merges server `device` over client; for browser-only keys (`viewport`, `devicePixelRatio`, `connectionType`) client should arguably win.
- `sw_checkout_experimentId` / `_sw_last_email` cookie write semantics — SDK-written or read-only? Conflict policy if also sibling-tool-written?
- Compat values for native-only device attrs — confirm whether to send `radioType: ""`, `isLowPowerModeEnabled: false`, `isMac: false`, `kotlinVersion: ""` as cross-platform CEL-friendly defaults or omit entirely.
- Mobile Safari preload — hidden iframes are throttled; either feature-detect + disable on iOS Safari or document as a known limitation.
- HTML substitutions bundle shape — the second `accept64` Android sends after templates needs verification against `paywall.js`.
- `window.app.getAllState()` response transport on web — Android invokes via `evaluateJavascript` and reads return value synchronously; cross-origin web requires a paywall-side `accept64` reply convention.

---

---

## 🪞 Parity gaps vs Android (caught in post-impl audit, not in original spec)

These are real Android-side surface that didn't make it into our spec. Each is small enough to land independently; none is blocking the alpha.

### Public methods Android exposes that Web doesn't

- ~~**`Superwall.refreshConfiguration()`**~~ **DONE** — `sw.refreshConfiguration()` re-runs `ConfigService.fetch()` + `eagerAssign`. Re-entrancy-safe via the actor serializer. Test: `refreshConfiguration: re-fetches static_config and re-runs eager assignment`.
- ~~**`Superwall.getProducts()`**~~ **DONE** — `sw.purchases.getProducts()` returns config-derived `Product[]` (id, name, store, entitlement stubs with `isActive: false`).
- **`Superwall.observePurchaseStart` / `observePurchaseResult` / `observePurchaseError`** — Flow-style observation of the purchase lifecycle, separate from per-`register` callbacks. On web a Promise/Observable equivalent would consume the same EventBus events but typed.
- **`Superwall.addListeners(flow)`** — Android forwards `SuperwallEventInfo` as a Kotlin Flow; web has `sw.events` (`EventTarget`) which covers the same surface. **Intentional drop** — call out in docs.
- **`Superwall.togglePaywallSpinner(boolean)`** / **`Superwall.showAlert(...)`** — UI control over the active paywall. Web's iframe presenter could expose equivalents (`sw.dismiss()` exists; spinner / alert do not).
- **`Superwall.setInterfaceStyle("dark" | "light")`** — Android theme override that flows through to the paywall. **Intentional drop** for web — paywall consumes `prefers-color-scheme` directly via the iframe; document in API.md §10.6.
- ~~**`Superwall.purchase(product)`**~~ **DONE** — `sw.purchases.purchase(product, { onCheckout })` drives a one-shot purchase outside a paywall. Same lifecycle as a presenter-driven purchase: `transaction_start` → caller's checkout handler → `transaction_complete` + `subscription_start` on success, `transaction_abandon` on cancel, `{ type: "error" }` on throw. Tests cover both purchased + declined paths.
- ~~**`getCustomerInfo()` as a method**~~ **DONE** — `sw.purchases.getCustomerInfo()` returns a `Promise<CustomerInfo | null>` resolving to the current `customerSig` snapshot. Signal version (`sw.customerInfo`) still preferred for reactive consumption; the method is for Android-port ergonomics.

### Delegate callbacks (all 5 landed)

- ~~**`handleLog(level, scope, message, info, error)`**~~ **DONE** — `onLog` exposed on `SuperwallDelegate`. Internal `Logger` primitive at `internal/logger.ts` routes through the bus → delegate. No internal log call sites yet (swallowed-error sites can migrate incrementally), but the surface is ready for analytics forwarding.
- ~~**`paywallWillOpenURL(url)` / `paywallWillOpenDeepLink(url)`**~~ **DONE** — `open_url` / `open_deep_link` inbound postMessages now handled by the browser presenter; forwarded via local-only `paywallWillOpenURL` / `paywallWillOpenDeepLink` events; bridged to the typed delegate callbacks in `configure()`.
- ~~**`userAttributesDidChange(newAttrs)` / `customerInfoDidChange(from, to)`**~~ **DONE** — both delegate hooks fire from signal-subscribe bridges in `configure()`. Web also exposes the values as `Readable<T>` signals; the delegate version is for Android consumers porting code over.

### Cross-cutting: typed actor state machines (Android `ConfigState.kt` + `IdentityState.kt`)

**Update — actor alignment + sequential dispatch landed.** `internal/config.ts` ships `ConfigState` ADT (`None | Retrieving | Retrying | Retrieved(config) | Failed(error, retryCount)`) + pure `ConfigUpdates` reducers; `internal/identity.ts` ships `IdentityPhase = Pending(items) | Ready` + `IdentityPending` ADT + set-semantic `IdentityUpdates.begin/end`. Both services now serialize mutating ops through `internal/actor.ts` — a tiny `SubscriptionRef + Effect.makeSemaphore(1)` pair exposing `dispatch(label, effect)`. Concurrent `fetch() + reset()` (config) and `identify() + reset()` (identity) land in arrival order; the snapshot is never half-applied. Phase mutations are intentionally lock-free so they can bracket dispatched ops without deadlocking. `superwall.ts` brackets `configure() / identify() / reset()` with matching pending items, and `register()` blocks on `IdentityService.awaitReady()` before audience evaluation. We do *not* implement Android's sealed `Actions` / `TypedAction<Context>` machinery — the user-visible parity (sequential mutation + observable transitions + re-entry guards) lands without it; the sealed-class shape is internal Kotlin ergonomics, not behaviour. Tests cover pure reducers, `getConfig` projection, fetch transitions, concurrent-fetch dedup, slow-fetch+reset arrival order, identify+reset arrival order with no half-applied snapshot, and `awaitReady` polling under timeout.

Android models *both* config and identity as typed actor-style state machines — Android's `Reducer<T>` (pure `Updates`) + `TypedAction<Context>` (effectful `Actions`) split. Web's previous shape was a flat `RawConfig | null` ref + a bag of signals; the recent refactor closes the structural gap. Reading both Android files together makes the pattern explicit:

- **`IdentityState`** — record `{appUserId, aliasId, seed, userAttributes, phase, appInstalledAtString}` where `phase = Pending(Set<Pending>) | Ready` and `Pending = Configuration | Identification(id) | Attributes | Reset | Seed | Assignments`. `Ready` is computed: when the pending set drains, phase flips. This is the typed equivalent of "are we ready to register?" — it's not just `configured`, it's "configured AND not in the middle of identify/seed-resolve/assignments-fetch."
- **`ConfigState`** — sealed ADT `None | Retrieving | Retrying | Retrieved(config) | Failed(error, retryCount)`. `Updates` are pure (just transitions); `Actions` carry the effects (`FetchConfig`, `HandleFetchFailure`, `RefreshConfig`, `ApplyConfig`, `ReevaluateTestMode`, `PreloadIfEnabled` / `PreloadAll` / `PreloadByNames`, `GetAssignments`).

Why it matters for parity:

1. ~~**Pending-set semantics on identity.**~~ **DONE** — `IdentityPhase` exposes `Pending(items) | Ready`; `register()` awaits `phase === Ready`. Phase brackets are wired around `configure() / identify() / reset()`. Tests in `identity.test.ts` cover pure reducers + the `awaitReady()` polling loop; `IdentityUpdates.begin` is set-semantic so duplicate begins are no-ops, `end` flips to Ready when the set drains.
2. ~~**State observability + re-entry guard.**~~ **DONE for config** — `ConfigService.state()` returns the full `ConfigState`; `fetch()` no-ops while `Retrieving|Retrying` (concurrent callers settle on the same in-flight result via `awaitSettle`). Test: `ConfigService.fetch concurrent calls share one in-flight network round-trip`. **Still deferred:** an equivalent observability surface on `configure()` itself (today there's `statusSig` + `configuredSig`; could collapse to a typed `SuperwallState` ADT later).
3. **Action/Update split as a reasoning tool.** Pure transitions are testable in isolation (Android has `IdentityStateReducerTest`); effects are layered on top. Web now has the pure `ConfigUpdates` / `IdentityUpdates` reducers exported + tested, but the *Actions* (FetchConfig, ApplyConfig, Identify, ResolveSeed, etc.) still live inline in `superwall.ts:configure` and the user-namespace methods. Worth following up with a typed `Actions` namespace per service if more parity gaps land.

Remaining alignment work, in roughly priority order:
- **Pending.Seed resolve action.** Today `identify()` clears Seed unconditionally in a finally. Android dispatches a `ResolveSeed` action that reads `featureFlags.enableUserIdSeed` and computes `userId.sha256MappedToRange()`. Land this when audience rules start using `seed` as a CEL input.
- **Pending.Assignments after `identify`.** Android adds `Pending.Assignments` after identify so register() blocks until the new user's assignments are pulled. Web doesn't have a server-side confirm POST yet, so this is moot until `confirm_assignments` lands.
- **Configure re-entry guard.** Today calling `createSuperwall(...)` twice with the same apiKey returns the cached instance, but a hypothetical second `configure()` would refetch. Lift to a typed `SuperwallState` so it's observable + re-entry-safe.
- **Reducer test coverage on superwall integration.** `identity.test.ts` covers the pure reducers; an integration test that proves `sw.placements.register()` actually waits on an in-flight `sw.user.identify()` is harder to write because identify() resolves synchronously today. Land it once an async hook (server-side seed resolve, assignments fetch) sits on the identify path.

### Config state machine gaps (vs Android `ConfigState.kt`)

Android models config as a typed state machine — `None | Retrieving | Retrying | Retrieved(config) | Failed(error)` — driven by `ConfigActions` (`FetchConfig`, `ApplyConfig`, `Refresh`, `Reset`). Web's `ConfigService` is a flat fetch-cache-return with no explicit state surface. Specific deltas:

- **State machine.** No `ConfigState` ADT exposed. Consumers can't observe "config is being retried" vs "config failed terminally." Add a `Readable<ConfigStatus>` to the public surface so apps can disable paywall triggers while config is mid-fetch.
- ~~**Fetch deadline + stale fallback.**~~ **DONE** — `superwall.ts` configure-flow wraps `config.fetch()` in `Effect.timeout(cacheLimit)` when (a) a hydrated cache exists AND (b) the cached config carries `toggles[].enableConfigRefresh = true`. `cacheLimit` mirrors Android `ConfigState.kt:86`: `500 millis` when `subscriptionStatus.status === "ACTIVE"`, `1 second` otherwise. On timeout *or* fetch error, the hydrated cache stays in place and `configured` flips true — `register()` resolves against the cached config rather than blocking on a hung fetch. When the toggle is off (or no cache exists), fetch runs unbounded (matches Android's gating). Test: `configure: hanging static_config fetch falls back to cached config under enableConfigRefresh deadline`. **Still deferred:** `Either.Success(oldConfig)` background-replace once the slow fetch eventually returns (Android keeps the deferred running and swaps if it lands later — we currently let it dangle).
- ~~**Parallel deferred fetches.**~~ **PARTIAL — done for `config` + `enrichment`.** `superwall.ts` configure-flow now runs `config.fetch()` + `runEnrichment` concurrently via `Effect.all([...], { concurrency: "unbounded" })`. Both are independently best-effort and race the fetch deadline (config) / no-deadline (enrichment) without blocking each other. **Still deferred:** `attributesDeferred` — Android's third parallel branch builds the device-attributes payload off-thread. Web's deviceAttributes assembly hasn't landed yet (own MISSING entry "Device attributes payload"); when it does, fold it into the same `Effect.all`.
- **`enableConfigRefresh` feature flag.** Android gates the cache-TTL behavior behind this server-side flag. Not modeled web-side.
- ~~**Bounded auto-retry.**~~ **DONE** — Retry now lives inside `ConfigService.fetch` itself: state surfaces `Retrieving → Retrying → Retrieved | Failed` so external observers see the in-flight retry. Single retry max on raw fetch error (network / parse), matching Android `HandleFetchFailure` (`newRetries <= 1`). Deadline timeout is a separate signal and does NOT trigger a retry — a slow-but-eventual fetch is "use cache," not "fetch failed." Tests: `configure: failing static_config fetch retries exactly once before giving up`, `ConfigService.fetch surfaces Retrying between attempts (fail → retry → succeed)`.
- ~~**Eager `choosePaywallVariants(triggers)` on apply.**~~ **DONE** — `AssignmentService.chooseAllVariants(experiments)` lands in `internal/assignments.ts`. Called from `configure()` after `hydrateFromStorage()` *and* after `config.fetch()`, so the cache is fully populated before the first `register()` fires (and re-runs when fresh config introduces new experiments / removes stale variants). Existing assignments stay sticky; only new / orphaned ones are repicked. Lets `confirmAllAssignments` return a complete snapshot pre-first-use (matches Android `ConfigLogic.chooseAllVariants` / `ApplyConfig` action). **Still deferred:** the BE upload itself (see `confirmAllAssignments` above).
- ~~**`extractEntitlementsByProductId`.**~~ **DONE** — pure helper `extractEntitlementsByProductId(products)` in `internal/config.ts` builds `Map<productId, entitlementIds[]>`. `superwall.ts:applyEntitlementsByProductId` runs after every `eagerAssign` (configure + refresh). `entitlements.byProductIds(ids)` now unions active entitlements with config-derived stubs (`isActive: false`) so consumers can answer "what entitlements does this product grant?" before any purchase event lands. Tests cover the helper + the integration path.
- **Background refresh after cached-config boot.** Android serves the cached config immediately (synchronous) and kicks a background fetch (`Refresh` action) to revalidate. Web's flow is similar (cache-first → revalidating fetch) but the revalidation isn't wrapped in the state-machine transition, so consumers can't observe "fresh config landed" to trigger re-evaluation of pending `register()`s.
- ~~**`paywallPreload.preloadAllPaywalls(config)`.**~~ **DONE (HTTP-cache warm)** — `BrowserPresenter.preload(info)` mounts an off-screen 1×1 iframe with the paywall URL, listens for `load`, then removes the iframe (HTTP cache retains the bytes). `superwall.ts:warmPaywalls(config)` iterates cached `paywallResponses` (capped at 6) and runs `presenter.preload` with concurrency 2. iOS Safari throttles hidden iframes — best-effort there, documented. Test: `preload(): mounts a hidden iframe and removes it after load`. **Still deferred:** an actual iframe pool with hand-off (where `present(info)` reuses the warmed iframe instead of creating a new one) — current win is purely HTTP-cache, not connection/parse reuse.
- **`GetAssignments` action.** Android's `GetAssignments` confirms assignments against the server (the missing `confirm_assignments` POST also tracked above). Same gap, called out from the state-machine angle.

### Wire events missing

- ~~**`subscription_start`**~~ **DONE** — already in `SuperwallEventMap`; emission wired in `browser/presenter.ts:handlePurchase` alongside `transaction_complete`. Trial-vs-non-trial discrimination on web is observer-mode-dependent — comment notes consumers can dedup via product id + subscriptionStatus history.

### Computed-property triggers in audience rules

The full chain is now wired:

1. ~~Storage backend~~ ✅ (`internal/computed.ts`)
2. ~~Counter increment on event emission~~ ✅ (every wire-bound event records)
3. ~~CEL expression evaluator~~ ✅ — `internal/audience.ts` uses `@superwall/superscript@0.2.5` (same WASM CEL runtime iOS/Android/Flutter ship). Pre-resolves `paywallsInHour|Day|Week|Month` / `placementsSinceInstall` / `daysSince` / `minutesSince` / etc. into the host-context map before each eval; Superscript callbacks read from there.

**Still deferred:** event-specific `daysSince_<eventName>` lookups (today we pre-resolve the canonical computed-property names; per-event ones need the eventName threaded through the audience rule's CEL expression to know which lookups to seed).

---

## How to read this file as a contributor

1. **Picking up a P0 / P1?** Open `API.md` first — the spec is the source of truth for behavior. The fix should be mechanically derived from the spec.
2. **Tackling a deferred feature?** Check whether it has a §X reference in `API.md`. If not, write the spec amendment first; land code second.
3. **Spotted something not on this list?** Add it under the right section + open a PR.

The plan was reviewed three times during design and once after implementation. Today's gap between the spec and the code is documented here; closing each item ratchets the SDK toward parity with the iOS / Android / Flutter implementations.
