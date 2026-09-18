# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

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
