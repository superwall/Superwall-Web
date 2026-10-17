# @superwall/example-preload-bench

Before/after benchmark and end-to-end checks for paywall preloading in
`@superwall/paywalls-js`.

A host page calls `createSuperwall()`, awaits `sw.ready`, and immediately
registers `web2app_onboarding`. The static config has three live campaigns:
the presented onboarding paywall (an 875 KB document), plus a "home" paywall
(929 KB script + 2.78 MB image) and a "special offer" reachable from other
placements. Each run is a cold load in Chromium emulating an iPhone 13.

Every response goes through one shaped link on the server (`src/link.ts`)
using Chrome DevTools' Slow 4G and Fast 4G presets. Shaping happens on the
server because DevTools/CDP throttling doesn't reliably cover iframe
navigations. Responses in flight share the bandwidth, and a response the
browser abandons stops using it.

## Run

From the workspace root:

```sh
bun install
cd example/preload-bench
bun run bench                  # 5 runs per cell, before = origin/main
bun run bench --runs 9 --base v0.3.1
```

"before" builds `packages/paywalls-js/src` from `--base`. "after" builds it
from the working tree. The script prints a table and writes it to
`results.md`. It needs a Chromium that Playwright can find, such as one from
`PLAYWRIGHT_BROWSERS_PATH`.

Set `BENCH_DEBUG=1` to print every request and the bytes sent for each run.

## End-to-end checks

```sh
bun run e2e                    # mock + live, before = origin/main
bun run e2e --no-live          # mock backend only, no network
bun run e2e --live pk_… --live-placement home
```

Runs the same scenarios in Chromium against both builds and asserts what the
fixed SDK must do. The "before" results are printed for comparison only. The
process exits non-zero if an "after" check fails.

- **mock** (synthetic paywalls over a Fast 4G link):
  - `register()` right after `ready`
  - default automatic preload
  - `shouldPreload: false`, with and without `preloadFor()`
  - `disable_preload.triggers` and `disable_preload.all`
  - presenting while a preload is still downloading
- **live** (the real Superwall backend and a real paywall):
  - `register()` right after `ready` must download the paywall once and
    render it with prices, which proves the SDK answered its template request
  - `shouldPreload: false` must warm nothing
  - `preloadFor()` must warm only the named placement

The default live key is the example app's public key. Its `home` placement
presents the first paywall in the config, which is the case that downloaded
twice. The `preloadFor()` live check names that key's `asdfg` placement.
Screenshots go to `.build/e2e/`.
