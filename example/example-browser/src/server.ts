// Bun.serve + HTML imports per the workspace CLAUDE.md.
// Bun's bundler handles `<script type="module" src="./app.ts">` automatically.

import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  routes: { "/": index },
  development: { hmr: true, console: true },
  port,
});

console.log(`Open http://localhost:${port}`);
