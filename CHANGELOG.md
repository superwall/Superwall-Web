# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

## Unreleased

### Fixed

- `identify()` with a different user while someone is already identified now resets first — fresh alias, vendor and device ids, subscription status, entitlements, attributes and assignments — exactly as the mobile SDKs do (iOS `reset(duringIdentify:)`). It used to keep the previous user's alias, and since subscriptions resolve through aliases, the next account signed in on a shared browser inherited the last one's subscription. Anonymous → identified still keeps the visitor's alias, and identifying the same user again changes nothing

## Unreleased

### Added

- The SDK now hosts framework (headless) paywalls the way the web paywall app's controller hosts paywall.js ones. A framework paywall's iframe has no controller around it, so when its `ping` carries `host_controlled: true` the presenter does the controller's three jobs for that presentation, with the controller's payloads: sends `experiment` and `template_variables` with the user's identity and the products priced from `/api/products/variables` (kept 24 h, so a reopened paywall prices on its first frame); reports the lifecycle to the collector (the open batch, `paywall_close`, `user_attributes`, `paywall_page_view`, `stripeCheckout_*`, `transaction_start` for a prefetched session, `transaction_abandon`); and turns `stripe_checkout_complete` into `post_checkout_complete` through `/api/post-checkout-redirect`. paywall.js paywalls are untouched

## 0.3.0 — 2026-09-25

### Added

- `post_checkout_complete` is now the single end of a web checkout, and the SDK owns everything after it — the paywall no longer posts `close` after a purchase and no longer sends `post_purchase_behavior`. Default handling switches on the payload's `claimed` flag: `true` ⇒ apply `entitlements_token` + grant / refresh entitlements; `false` ⇒ grant nothing (the grant is the server's job). Either way the SDK never redeems the checkout's redemption codes itself — they stay unspent for the buyer's mobile app and are handed to the developer on the payload. Then the SDK closes the paywall and fires `onDismiss`. It never navigates: `redirect_url` is surfaced as `checkout.redirectUrl` for the developer to follow. This runs whichever `PurchaseController` is installed. **This release must be live before the paywall change ships** — older SDKs wait for a `close` that never comes
- `handler.onPurchase(info, checkout)` on `register()` — replaces the default post-checkout handling entirely (no entitlements, redeem or teardown; call `sw.dismiss()` yourself, after which `register()` resolves `purchased`). Built for buy-on-web, redeem-in-app: show `checkout.redemptionCodes`, or hand `checkout.deepLinks.ios` / `.android` to an "Open in app" button
- New `CheckoutCompletion` type — `productId`, `checkoutContextId`, `claimed`, `transaction`, `redemptionCodes`, `redirectUrl`, `deepLinks`, `entitlementsToken` — passed to `onPurchase` and carried on the purchased `PaywallResult` as `checkout` (`handler.onDismiss` / `register()`'s return value)
- Local-only `checkoutCompleted` event, bridged to `SuperwallDelegate.onCheckoutCompleted(checkout, info)` — notification-only view of the same payload for logging / analytics; fires for every completed checkout (default handling or `onPurchase` override) before either acts on it
- Local-only `redemptionCodesReceived` event with purchase context, bridged to `SuperwallDelegate.onRedemptionCodesReceived`. Fires for claimed and unclaimed codes alike; `claimed` on the detail says which
- Public `sw.redeem(code)` — redeem a `redemption_…` code for the current user; seeds `customerInfo`, flips `subscriptionStatus` on success, fires `onWillRedeemLink` / `onDidRedeemLink`, and now also works with a custom `PurchaseController`
- Four request headers the native SDKs already send: `X-Static-Config-Build-Id` (build id of the config in hand), `X-Request-Id` (fresh per request, for tracing a report back to one call), `X-Retry-Count` (config-fetch attempt), and `X-Entitlements` (comma-joined active entitlement ids)

### Fixed

- The paywall init payload now sends the paywall's database id (parsed from `paywall_responses[].id`, exposed as `PaywallInfo.databaseId`) as `paywallId`, keeping `paywallIdentifier` as the slug — matching what the native SDKs send; configs without the field fall back to the slug
- Request headers now match the native SDKs, so backend audience filters actually match web traffic: `X-Device-Interface-Style` sends `Light`/`Dark` (was lowercase), `X-Device-Locale` sends the POSIX form `en_US` (was BCP-47 `en-US`), and `X-Platform` sends `web` (was `Web`, which also disagreed with the `web` the paywall iframe sent)
- `X-Is-Sandbox` no longer reports which API host is configured. It now reports whether purchases are non-real — defaulting to the SDK's test-mode state and overridable via `options.isSandbox` for apps on Stripe test keys
- `X-Platform-Wrapper` is configurable via `options.platformWrapper` (default `"Web"`); `@superwall/paywalls-react` now identifies itself as `"React"`
- `post_checkout_complete` field names now match the wire (`transaction_data` / `redirect_url`, snake_case inner keys), so transaction enrichment is actually read
- `sw.redeem()` resolves an INVALID code as `{ type: "invalid", code }` instead of stuffing an `error` field into the invalid variant

## 0.2.9 — 2026-09-18

### Fixed

- Allow SDK readiness to complete without waiting for analytics uploads or paywall preloading. Analytics remain ordered and support page-exit delivery.
- Apply user attributes set inside a paywall to the SDK user object, React state, delegate callbacks, and local `user_attributes` events without sending duplicate analytics.
- Persist user attributes across page reloads. Reset clears stored attributes, and switching from one identified user to another clears the previous user's attributes.

## 0.2.8 — 2026-09-16

### Changed

- Bump `@superwall/superscript` to 1.0.16.

### Added

- `PaywallInfo.databaseId`: the paywall's numeric database id from the static config, alongside the `identifier` slug.
- `PaywallPresenter.tracksLifecycleEvents`: set by the browser presenter so the SDK doesn't report lifecycle events the paywall iframe already sends.

### Fixed

- Send analytics attribution in the fields the dashboard reads (`$experiment_id`, `$variant_id`, `$paywall_id`, `$presented_by_event_name`, vendor id), for both SDK events and events from the paywall iframe. Campaign matched users, audience/placement charts and flow analytics were empty for Web SDK paywalls.
- Stop sending `trigger_fire`, `paywall_open`, `paywall_close` and checkout `transaction_start` / `transaction_abandon` twice when the paywall iframe already reports them.
- Fill `vendorId` / `deviceId` in the device attributes handed to the paywall iframe, so its `device_attributes` event carries them like the native SDKs do.

## 0.2.7 — 2026-08-25

### Fixed

- Fix CORS issues by pointing to direct worker route
- Send the real SDK version as `sdkVersion` / `sdkVersionPadded` (was a hardcoded `0.0.0`), padded to the platform's 3-digit convention

## 0.2.6 — 2026-08-19

### Fixed

- Ensure that in release builds no-cache is used to ensure config invalidation occurs

## 0.2.5

- Fix rejections, update README.
