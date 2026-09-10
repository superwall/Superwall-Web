# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

## Unreleased

### Added

- Post-purchase behaviors from the unified webapp/web2app config are now handled on `post_checkout_complete`: REDIRECT navigates to the merchant's `redirect_url` (after `paywallWillOpenURL`; a new-tab open would be popup-blocked without user activation — opt into it via `options.paywalls.postPurchaseRedirect: "newTab"`), and REDEEM / CUSTOM hand the `redemption_codes` to the merchant
- Redemption codes ride the purchased `PaywallResult` (`handler.onDismiss` / `register()`'s return value) as `redemptionCodes`, and fire a new local-only `redemptionCodesReceived` event with purchase context, bridged to `SuperwallDelegate.onRedemptionCodesReceived`
- The resolved behavior is surfaced as `postPurchaseBehavior` (`"GRANT_ACCESS" | "REDIRECT" | "REDEEM" | "CUSTOM"`, new `PostPurchaseBehavior` type) on the purchased `PaywallResult` and as `behavior` on `redemptionCodesReceived`
- Public `sw.redeem(code)` — redeem a `redemption_…` code for the current user; seeds `customerInfo`, flips `subscriptionStatus` on success, fires `onWillRedeemLink` / `onDidRedeemLink`, and now also works with a custom `PurchaseController`
- Four request headers the native SDKs already send: `X-Static-Config-Build-Id` (build id of the config in hand), `X-Request-Id` (fresh per request, for tracing a report back to one call), `X-Retry-Count` (config-fetch attempt), and `X-Entitlements` (comma-joined active entitlement ids)

### Fixed

- The paywall init payload now sends the paywall's database id (parsed from `paywall_responses[].id`, exposed as `PaywallInfo.databaseId`) as `paywallId`, keeping `paywallIdentifier` as the slug — matching what the native SDKs send; configs without the field fall back to the slug
- Request headers now match the native SDKs, so backend audience filters actually match web traffic: `X-Device-Interface-Style` sends `Light`/`Dark` (was lowercase), `X-Device-Locale` sends the POSIX form `en_US` (was BCP-47 `en-US`), and `X-Platform` sends `web` (was `Web`, which also disagreed with the `web` the paywall iframe sent)
- `X-Is-Sandbox` no longer reports which API host is configured. It now reports whether purchases are non-real — defaulting to the SDK's test-mode state and overridable via `options.isSandbox` for apps on Stripe test keys
- `X-Platform-Wrapper` is configurable via `options.platformWrapper` (default `"Web"`); `@superwall/paywalls-react` now identifies itself as `"React"`
- `post_checkout_complete` field names now match the wire (`transaction_data` / `redirect_url`, snake_case inner keys), so transaction enrichment is actually read
- `sw.redeem()` resolves an INVALID code as `{ type: "invalid", code }` instead of stuffing an `error` field into the invalid variant

## 0.2.7 — 2026-08-25

### Fixed

- Fix CORS issues by pointing to direct worker route
- Send the real SDK version as `sdkVersion` / `sdkVersionPadded` (was a hardcoded `0.0.0`), padded to the platform's 3-digit convention

## 0.2.6 — 2026-08-19

### Fixed

- Ensure that in release builds no-cache is used to ensure config invalidation occurs

## 0.2.5

- Fix rejections, update README.
