# Changelog

All notable changes to the `@superwall/*` web SDK packages are documented here.
Versions apply to every published package in lockstep (see `scripts/version.ts`).

## 0.2.6 — 2026-08-19

### Fixed

- **Config changes made in the dashboard could take hours to reach browsers.**
  The CDN serves `/api/v1/static_config` with a browser-facing
  `Cache-Control: max-age` of several hours, so the SDK's background config
  revalidation was answered from the browser's HTTP cache without ever hitting
  the network — and server-side cache purges triggered by dashboard changes
  can never reach a browser cache. The config fetch now uses
  `cache: "no-cache"` in the `release` environment, forcing revalidation with
  the CDN on every fetch (a 304 with cached-body reuse stays possible once the
  endpoint serves validators). Sandbox environments keep `cache: "no-store"`.
  Non-browser runtimes (Node, Bun) are unaffected — they have no HTTP cache,
  which is why only browser apps ever saw stale configs.

## 0.2.5

- Fix rejections, update README.
