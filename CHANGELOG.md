# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

## Unreleased

### Added

- Post-purchase behaviors from the unified webapp/web2app config are now handled on `post_checkout_complete`: REDIRECT navigates to the merchant's `redirect_url` (after `paywallWillOpenURL`; a new-tab open would be popup-blocked without user activation — opt into it via `options.paywalls.postPurchaseRedirect: "newTab"`), and REDEEM / CUSTOM hand the `redemption_codes` to the merchant
- Redemption codes ride the purchased `PaywallResult` (`handler.onDismiss` / `register()`'s return value) as `redemptionCodes`, and fire a new local-only `redemptionCodesReceived` event with purchase context, bridged to `SuperwallDelegate.onRedemptionCodesReceived`
- The resolved behavior is surfaced as `postPurchaseBehavior` (`"GRANT_ACCESS" | "REDIRECT" | "REDEEM" | "CUSTOM"`, new `PostPurchaseBehavior` type) on the purchased `PaywallResult` and as `behavior` on `redemptionCodesReceived`
- Public `sw.redeem(code)` — redeem a `redemption_…` code for the current user; seeds `customerInfo`, flips `subscriptionStatus` on success, fires `onWillRedeemLink` / `onDidRedeemLink`, and now also works with a custom `PurchaseController`

### Fixed

- The paywall init payload now sends the paywall's database id (parsed from `paywall_responses[].id`, exposed as `PaywallInfo.databaseId`) as `paywallId`, keeping `paywallIdentifier` as the slug — matching what the native SDKs send; configs without the field fall back to the slug
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
