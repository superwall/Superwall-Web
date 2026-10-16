# @superwall/example-preload-bench

Before/after benchmark for paywall preloading in `@superwall/paywalls-js`.

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
