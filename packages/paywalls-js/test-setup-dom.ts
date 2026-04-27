// Bun preload — registers happy-dom globals (window, document, localStorage,
// HTMLIFrameElement, etc.) so browser-package tests can use the DOM. Wired
// via bunfig.toml `preload` for `*.dom.test.ts` files only; non-DOM tests
// continue to run in pure Bun.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  url: "https://app.example.test",
});
