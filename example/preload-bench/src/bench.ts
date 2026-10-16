#!/usr/bin/env bun
// Paywall preload benchmark: `register()` right after `ready`, cold loads in
// Chromium emulating an iPhone, over a link shaped like DevTools' 4G presets.
//
//   bun run bench [--runs 5] [--base origin/main]
//
// Builds @superwall/paywalls-js twice — from `--base` (before) and from the
// working tree (after) — serves both next to a host page and three synthetic
// paywalls (see fixtures.ts), then measures how long the presented paywall
// takes to load and what else got downloaded meanwhile. Writes results.md.

import { $ } from "bun";
import { chromium, devices } from "playwright-core";
import { parseArgs } from "node:util";
import { rm } from "node:fs/promises";
import { assets, staticConfig } from "./fixtures.ts";
import { createLink, type LinkProfile } from "./link.ts";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    base: { type: "string", default: "origin/main" },
  },
});
const RUNS = Number(args.runs);

const here = import.meta.dir;
const repo = (await $`git rev-parse --show-toplevel`.cwd(here).text()).trim();
const buildDir = `${here}/../.build`;
const host = await Bun.file(`${here}/host.html`).text();

// ── SDK builds ──────────────────────────────────────────────────────────────

const bundle = async (entry: string, outdir: string) => {
  const out = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    conditions: ["@superwall/source"],
  });
  if (!out.success) throw new AggregateError(out.logs, `bundling ${entry} failed`);
};

await rm(buildDir, { recursive: true, force: true });
// The base's sources go under this package so they resolve its node_modules.
const baseSrc = `${buildDir}/base-src`;
await $`mkdir -p ${baseSrc}`;
await $`git -C ${repo} archive ${args.base} packages/paywalls-js/src packages/paywalls-js/package.json | tar -x -C ${baseSrc}`;
const baseRev = (await $`git -C ${repo} rev-parse --short ${args.base}`.text()).trim();
const headRev = (await $`git -C ${repo} rev-parse --short HEAD`.text()).trim();
const dirty = (await $`git -C ${repo} status --porcelain packages/paywalls-js/src`.text()).trim() !== "";
await bundle(`${baseSrc}/packages/paywalls-js/src/index.ts`, `${buildDir}/sdk/before`);
await bundle(`${repo}/packages/paywalls-js/src/index.ts`, `${buildDir}/sdk/after`);

// ── Server ──────────────────────────────────────────────────────────────────

/** One request as the server saw it. `bytes` grows as the link sends. */
interface Served {
  readonly path: string;
  /** Carries the SDK's present-time params — the paywall shown to the user. */
  readonly presented: boolean;
  bytes: number;
}
let served: Served[] = [];
const link = createLink();

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
      // Paywalls live on a second origin (as on the real paywall CDN), so
      // they get their own connection pool.
      return send(JSON.stringify(staticConfig(`http://127.0.0.1:${url.port}`)), "application/json");
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

// ── Measurement ─────────────────────────────────────────────────────────────

/** Chrome DevTools' throttling presets. */
const PROFILES = {
  "Slow 4G": { bytesPerSecond: (1.6e6 * 0.9) / 8, latencyMs: 562.5 },
  "Fast 4G": { bytesPerSecond: (9e6 * 0.9) / 8, latencyMs: 165 },
} satisfies Record<string, LinkProfile>;
type Profile = keyof typeof PROFILES;
type Sdk = "before" | "after";

interface Run {
  /** register() → presented onboarding paywall's window `load`. */
  registerToPaywall: number;
  /** Navigation start → same. */
  pageToPaywall: number;
  /** Requests for the onboarding paywall document (preload + present). */
  onboardingDocRequests: number;
  /** Bytes of the other campaigns' paywalls sent before the presented
   *  paywall finished loading. */
  otherPaywallBytes: number;
  /** All paywall bytes sent before the presented paywall finished loading. */
  paywallBytes: number;
}

const sum = (xs: Served[]) => xs.reduce((n, s) => n + s.bytes, 0);
const isPaywall = (s: Served) => s.path.startsWith("/paywalls/");
const isOnboardingDoc = (s: Served) => s.path === "/paywalls/onboarding.html";

const browser = await chromium.launch();

const runOnce = async (sdk: Sdk, profile: Profile): Promise<Run> => {
  link.setProfile(PROFILES[profile]);
  served = [];
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  try {
    const page = await context.newPage();
    let snapshot: Pick<Run, "otherPaywallBytes" | "paywallBytes" | "onboardingDocRequests"> | null = null;
    const done = Promise.withResolvers<void>();
    await page.exposeBinding("__benchDone", () => {
      snapshot ??= {
        onboardingDocRequests: served.filter(isOnboardingDoc).length,
        otherPaywallBytes: sum(served.filter((s) => isPaywall(s) && !s.path.startsWith("/paywalls/onboarding"))),
        paywallBytes: sum(served.filter(isPaywall)),
      };
      done.resolve();
    });
    await page.goto(`${server.url}?sdk=${sdk}`, { waitUntil: "commit" });
    await Promise.race([
      done.promise,
      Bun.sleep(120_000).then(() => Promise.reject(new Error(`${sdk}/${profile}: paywall never loaded`))),
    ]);
    const marks = await page.evaluate(
      () => (window as unknown as { __bench: { marks: Record<string, number> } }).__bench.marks,
    );
    if (process.env.BENCH_DEBUG) {
      console.log("  marks", marks);
      for (const s of served) console.log(`  ${s.presented ? "P" : " "} ${s.path} ${s.bytes}`);
    }
    return {
      registerToPaywall: marks["presentedLoaded"]! - marks["register"]!,
      pageToPaywall: marks["presentedLoaded"]!,
      ...snapshot!,
    };
  } finally {
    await context.close();
  }
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const results: Record<Profile, Record<Sdk, Run[]>> = {
  "Slow 4G": { before: [], after: [] },
  "Fast 4G": { before: [], after: [] },
};
for (const profile of Object.keys(PROFILES) as Profile[]) {
  // Interleave before/after so drift on the machine hits both equally.
  for (let i = 0; i < RUNS; i++) {
    for (const sdk of ["before", "after"] as const) {
      const r = await runOnce(sdk, profile);
      results[profile][sdk].push(r);
      console.log(
        `${profile} ${sdk.padEnd(6)} #${i + 1}  register→paywall ${Math.round(r.registerToPaywall)} ms, ` +
          `onboarding.html ×${r.onboardingDocRequests}, other paywalls ${Math.round(r.otherPaywallBytes / 1024)} KB`,
      );
    }
  }
}

await browser.close();
server.stop(true);

// ── Report ──────────────────────────────────────────────────────────────────

const secs = (n: number) => `${(n / 1000).toFixed(2)} s`;
const size = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;
const rows: string[] = [];
for (const profile of Object.keys(PROFILES) as Profile[]) {
  for (const sdk of ["before", "after"] as const) {
    const m = (k: keyof Run) => median(results[profile][sdk].map((r) => r[k]));
    rows.push(
      `| ${profile} | ${sdk} | ${secs(m("registerToPaywall"))} | ${secs(m("pageToPaywall"))} | ` +
        `${m("onboardingDocRequests")} | ${size(m("otherPaywallBytes"))} | ${size(m("paywallBytes"))} |`,
    );
  }
}
const report = `# Paywall preload benchmark

\`register({ placement: "web2app_onboarding" })\` right after \`await sw.ready\`,
cold loads in Chromium emulating an iPhone 13. Every response shares one link
shaped like Chrome DevTools' presets (Slow 4G: 1.44 Mbps, 562 ms latency;
Fast 4G: 8.1 Mbps, 165 ms latency). Medians of ${RUNS} runs per cell.

- before: \`${args.base}\` (${baseRev})
- after: ${headRev}${dirty ? " + uncommitted changes" : ""}

| Network | SDK | register → paywall loaded | page start → paywall loaded | onboarding.html downloads | other paywalls' bytes before it loaded | all paywall bytes before it loaded |
|---|---|---|---|---|---|---|
${rows.join("\n")}

The onboarding paywall is an 875 KB document. Two other live campaigns are
reachable from other placements: home (24 KB document, 929 KB script, 2.78 MB
image) and special offer (160 KB document, 540 KB image).
`;
await Bun.write(`${here}/../results.md`, report);
console.log(`\n${report}`);
