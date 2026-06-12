// Bun.serve + HTML imports per the workspace CLAUDE.md.
// Bun's bundler handles `<script type="module" src="./app.ts">` automatically.
//
// No API proxy — the Superwall BE returns CORS headers for browser origins,
// so the SDK fetches the configured hosts directly (see app.ts).

import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  routes: { "/": index },
  development: { hmr: true, console: true },
  port,
});

console.log(`Open http://localhost:${port}`);
