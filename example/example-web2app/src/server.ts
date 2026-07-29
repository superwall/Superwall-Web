// Bun.serve + HTML imports per the workspace CLAUDE.md. Serves the static
// example page; the SDK talks to Superwall hosts directly from the browser.
//
// NOTE: for real (non-test-mode) checkout, the origin you serve this from
// must be listed under the app's Allowed Origins in the Superwall dashboard.

import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  routes: {
    "/": index,
  },
  development: { hmr: true, console: true },
  port,
});

console.log(`Open http://localhost:${port}`);
