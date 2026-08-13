// Side-effect entrypoint: importing `@superwall/paywalls-js/browser/auto`
// eagerly loads the default browser presenter module. The SDK core lazy-loads
// the presenter via dynamic `import()` on first `register()`; this entrypoint
// forces the module to be bundled and evaluated up front so that import
// resolves instantly — useful for bundler setups that can't ship dynamic
// chunks and to avoid the chunk-load cost on first presentation.

import "./presenter.ts";

export {};
