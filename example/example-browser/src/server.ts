// Bun.serve + HTML imports per the workspace CLAUDE.md.
// Bun's bundler handles `<script type="module" src="./app.ts">` automatically.

import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

// Superwall BE doesn't return CORS headers for browser origins, so we proxy
// every API call through this Bun server. The example's app.ts rewrites
// upstream URLs (api.superwall.me, collector.superwall.me, …) to /proxy/*
// so the browser only ever talks to localhost.
const PROXY_HOSTS: Record<string, string> = {
  api: "https://api.superwall.me",
  collector: "https://collector.superwall.me",
  enrichment: "https://enrichment-api.superwall.com",
  subscriptions: "https://subscriptions-api.superwall.com",
};

const proxy = async (req: Request, target: string, rest: string): Promise<Response> => {
  const url = new URL(req.url);
  const upstream = `${target}${rest}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  const init: RequestInit = {
    method: req.method,
    headers,
    ...(req.method !== "GET" && req.method !== "HEAD" && { body: await req.arrayBuffer() }),
    redirect: "manual",
  };
  const response = await fetch(upstream, init);
  const responseHeaders = new Headers(response.headers);
  // Bun's fetch already decoded the body; clearing the encoding/length
  // headers prevents the browser from trying to gunzip plain bytes.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

Bun.serve({
  routes: { "/": index },
  development: { hmr: true, console: true },
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // /proxy/api/foo/bar → https://api.superwall.me/foo/bar
    const m = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (m && m[1] && PROXY_HOSTS[m[1]]) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }
      return proxy(req, PROXY_HOSTS[m[1]]!, m[2] ?? "");
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Open http://localhost:${port}`);
