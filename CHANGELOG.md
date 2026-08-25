# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

## Unreleased

### Fixed

- Route WEBAPP paywall-iframe API calls (`/api/checkout/initiate`, `/api/checkout/complete-webapp`, `/api/proxy/events`, `/api/products/variables`, `/api/post-checkout-redirect`) to the web paywall worker via a new `paywallWorker` host instead of the config API host, which does not serve those paths and fails the browser's CORS preflight. Custom environment hosts accept an optional `paywallWorker` that defaults to the production worker.

## 0.2.6 — 2026-08-19

### Fixed

- Ensure that in release builds no-cache is used to ensure config invalidation occurs

## 0.2.5

- Fix rejections, update README.
