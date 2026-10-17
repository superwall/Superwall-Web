// Test server for the bench and e2e scripts: the host page, both SDK builds,
// a mock `/static_config`, and the synthetic paywalls from fixtures.ts. Every
// response streams through a shaped link (unshaped until `link.setProfile`).
// Paywalls are linked on 127.0.0.1 and the host on localhost, so they live
// on a second origin with its own connection pool, as on the real paywall CDN.

import { buildDir } from "./build.ts";
import { assets, staticConfig } from "./fixtures.ts";
import { createLink } from "./link.ts";

/** One request as the server saw it. `bytes` grows as the link sends. */
export interface Served {
  readonly path: string;
  /** Carries the SDK's present-time params — the paywall shown to the user. */
  readonly presented: boolean;
  bytes: number;
}

export const startServer = () => {
  const host = Bun.file(`${import.meta.dir}/host.html`);
  const link = createLink();
  const served: Served[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const send = async (body: string | Uint8Array | Blob, type: string) => {
        const bytes =
          typeof body === "string"
            ? new TextEncoder().encode(body)
            : body instanceof Blob
              ? new Uint8Array(await body.arrayBuffer())
              : body;
        const entry: Served = {
          path: url.pathname,
          presented: url.searchParams.has("client_surface"),
          bytes: 0,
        };
        served.push(entry);
        return new Response(link.stream(bytes, (n) => (entry.bytes += n)), {
          headers: {
            "Content-Type": type,
            "Content-Length": String(bytes.length),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        });
      };
      if (url.pathname === "/") return send(host, "text/html");
      if (url.pathname === "/mock/static_config") {
        const config = staticConfig(`http://127.0.0.1:${url.port}`);
        const disable = url.searchParams.get("disable");
        if (disable) {
          Object.assign(config, {
            disable_preload:
              disable === "all" ? { all: true, triggers: [] } : { all: false, triggers: disable.split(",") },
          });
        }
        return send(JSON.stringify(config), "application/json");
      }
      if (url.pathname.startsWith("/sdk/")) {
        const file = Bun.file(`${buildDir}${url.pathname}`);
        if (await file.exists()) return send(file, "text/javascript");
      }
      const asset = assets[url.pathname];
      if (asset) return send(asset.body, asset.type);
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: server.url,
    link,
    /** Requests since the last `reset()`. */
    served,
    reset() {
      served.length = 0;
    },
    stop: (force?: boolean) => server.stop(force),
  };
};
