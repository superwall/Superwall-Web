// Bun.serve + HTML imports per the workspace CLAUDE.md.
// Bun's bundler handles `<script type="module" src="./app.ts">` automatically.

import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

// Superwall BE doesn't return CORS headers for browser origins, so we proxy
// every API call through this Bun server. The example's app.ts rewrites
// upstream URLs (api.superwall.me, collector.superwall.me, …) to /proxy/*
// so the browser only ever talks to localhost.
// Set SW_REVIEW_LAB_HOST (e.g.
// "ir-feat-web-sdk-support.prd.us-east-1.review-lab.superwall-services.com")
// to route all four upstreams through one review-lab origin. Leave unset
// for production hosts.
const REVIEW_LAB = process.env.SW_REVIEW_LAB_HOST;
const PROXY_HOSTS: Record<string, string> = REVIEW_LAB
  ? {
      api: `https://${REVIEW_LAB}`,
      // Collector stays on prod even under review-lab — review envs don't
      // ingest events; collector POSTs would just 404 there.
      collector: "https://collector.superwall.me",
      enrichment: `https://${REVIEW_LAB}`,
      // Review-lab branch doesn't mount /subscriptions-api/*. Forward to dev.
      subscriptions: "https://subscriptions-api.superwall.dev",
    }
  : {
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
  // Strip upstream cache directives — Superwall's static_config sets
  // long-lived Cache-Control which had the browser serving stale config
  // across page reloads even with `cache: "no-store"` on the SDK fetch.
  // For local dev we always want fresh data through the proxy.
  responseHeaders.delete("etag");
  responseHeaders.delete("last-modified");
  responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  responseHeaders.set("Pragma", "no-cache");
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  // TEMPORARY HACK — review-lab static_config returns `"store": "PLAY_STORE"`
  // for products that are actually Stripe-backed. Rewrite to "STRIPE" on the
  // fly so the SDK's parser flags them correctly. Remove once the BE serves
  // the right value for Web apps.
  if (rest.includes("/api/v1/static_config")) {
    const text = await response.text();
    const patched = text.replace(/"store"\s*:\s*"PLAY_STORE"/g, '"store":"STRIPE"');
    return new Response(patched, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }
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
