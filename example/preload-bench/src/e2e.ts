#!/usr/bin/env bun
// End-to-end preload checks in Chromium (iPhone 13 emulation), run against
// both SDK builds:
//
//   bun run e2e [--base origin/main] [--live pk_…] [--live-placement home]
//
// mock: the bench's synthetic paywalls and mock config over a Fast 4G link,
//       one scenario per preload option.
// live: the real Superwall backend and a real paywall (needs network). The
//       key's config decides which paywall `--live-placement` presents.
//
// Every scenario states what the fixed SDK ("after") must do; "before" runs
// the same scenario for comparison and is never asserted. Exits non-zero
// when an "after" check fails. Screenshots go to .build/e2e/.

import { chromium, devices, type BrowserContext, type Request } from "playwright-core";
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { buildDir, buildSdks } from "./build.ts";
import { startServer } from "./server.ts";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "origin/main" },
    live: { type: "string", default: "pk_ZNLGF8AlO2V50YDvC1y0c" },
    "live-placement": { type: "string", default: "home" },
    "no-live": { type: "boolean", default: false },
  },
});

const { baseRev, headRev, dirty } = await buildSdks(args.base);
const server = startServer();
const shots = `${buildDir}/e2e`;
await mkdir(shots, { recursive: true });

// Route real traffic through the environment's proxy, if any; the local
// server is always reached directly. Passed as Chromium flags because
// Playwright's `proxy` option also sends loopback through the proxy.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  args: proxyUrl ? [`--proxy-server=${proxyUrl}`, "--proxy-bypass-list=localhost;127.0.0.1"] : [],
});

type Sdk = "before" | "after";
interface Outcome {
  readonly name: string;
  readonly sdk: Sdk;
  readonly observed: string;
  readonly pass: boolean | null;
}
const outcomes: Outcome[] = [];

interface PageRun {
  context: BrowserContext;
  /** Paywall document requests (any origin), in order. */
  docs: Request[];
  marks: () => Promise<Record<string, number>>;
  errors: () => Promise<string[]>;
  done: Promise<void>;
}

/** Open the host page with `query` and record paywall document requests. */
const open = async (query: Record<string, string>, isPaywallDoc: (r: Request) => boolean): Promise<PageRun> => {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const docs: Request[] = [];
  context.on("request", (r) => {
    if (r.resourceType() === "document" && isPaywallDoc(r)) docs.push(r);
  });
  const page = await context.newPage();
  const done = Promise.withResolvers<void>();
  await page.exposeBinding("__benchDone", () => done.resolve());
  await page.goto(`${server.url}?${new URLSearchParams(query)}`, { waitUntil: "commit" });
  const read = <T,>(key: "marks" | "errors") =>
    page.evaluate((k) => (window as unknown as { __bench: Record<string, unknown> }).__bench[k], key) as Promise<T>;
  return {
    context,
    docs,
    marks: () => read("marks"),
    errors: () => read("errors"),
    done: done.promise,
  };
};

const waitFor = async (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), Bun.sleep(ms).then(() => false)]);

/** Wait until `ready`, then `settleMs` more for background preloads. */
const settle = async (run: PageRun, settleMs: number) => {
  for (let i = 0; i < 300 && !(await run.marks())["ready"]; i++) await Bun.sleep(100);
  await Bun.sleep(settleMs);
};

const record = (name: string, sdk: Sdk, observed: string, pass: boolean) => {
  outcomes.push({ name, sdk, observed, pass: sdk === "after" ? pass : null });
  console.log(`${sdk === "after" ? (pass ? "PASS" : "FAIL") : "    "} [${sdk}] ${name}: ${observed}`);
};

const pathOf = (r: Request) => new URL(r.url()).pathname;
const isPresented = (r: Request) => new URL(r.url()).searchParams.has("client_surface");
const docNames = (docs: Request[]) =>
  docs.map((r) => `${pathOf(r).split("/").pop()}${isPresented(r) ? "(presented)" : ""}`).sort().join(", ") || "none";

// ── mock backend ────────────────────────────────────────────────────────────

server.link.setProfile({ bytesPerSecond: (9e6 * 0.9) / 8, latencyMs: 165 });
const mockDoc = (r: Request) => pathOf(r).startsWith("/paywalls/") && pathOf(r).endsWith(".html");

for (const sdk of ["before", "after"] as const) {
  // 1. register() right after ready: one download of the presented paywall.
  {
    const run = await open({ sdk, register: "web2app_onboarding" }, mockDoc);
    const loaded = await waitFor(run.done, 30_000);
    const onboarding = run.docs.filter((r) => pathOf(r) === "/paywalls/onboarding.html").length;
    const others = run.docs.filter((r) => pathOf(r) !== "/paywalls/onboarding.html").length;
    record(
      "mock: register right after ready",
      sdk,
      `paywall ${loaded ? "loaded" : "NOT loaded"}, onboarding.html ×${onboarding}, other paywall docs before it loaded ×${others}`,
      loaded && onboarding === 1 && others === 0,
    );
    await run.context.close();
  }

  // 2. Default automatic preload, no register: warms every reachable paywall.
  {
    const run = await open({ sdk }, mockDoc);
    await settle(run, 1_500);
    const names = docNames(run.docs);
    record(
      "mock: automatic preload (no register)",
      sdk,
      `preloaded ${names}`,
      names === "home.html, onboarding.html, special.html",
    );
    await run.context.close();
  }

  // 3. shouldPreload: false — nothing warms on its own.
  {
    const run = await open({ sdk, shouldPreload: "0" }, mockDoc);
    await settle(run, 1_500);
    record("mock: shouldPreload false", sdk, `preloaded ${docNames(run.docs)}`, run.docs.length === 0);
    await run.context.close();
  }

  // 4. shouldPreload: false + preloadFor(["home"]) — only that placement.
  {
    const run = await open({ sdk, shouldPreload: "0", preloadFor: "home" }, mockDoc);
    await settle(run, 1_500);
    const names = docNames(run.docs);
    record("mock: shouldPreload false + preloadFor(home)", sdk, `preloaded ${names}`, names === "home.html");
    await run.context.close();
  }

  // 5. disable_preload.triggers / .all from the config.
  {
    const run = await open({ sdk, disable: "home" }, mockDoc);
    await settle(run, 1_500);
    const names = docNames(run.docs);
    record(
      "mock: disable_preload.triggers [home]",
      sdk,
      `preloaded ${names}`,
      names === "onboarding.html, special.html",
    );
    await run.context.close();
  }
  {
    const run = await open({ sdk, disable: "all", preloadFor: "home" }, mockDoc);
    await settle(run, 1_500);
    record(
      "mock: disable_preload.all (+ preloadFor)",
      sdk,
      `preloaded ${docNames(run.docs)}`,
      run.docs.length === 0,
    );
    await run.context.close();
  }

  // 6. A preload still loading when a paywall is presented gets cancelled:
  //    the rest of it stops downloading. (Chrome barely fetches images in a
  //    hidden 1px iframe either way, so measure the 929 KB script.)
  {
    server.reset();
    const run = await open(
      { sdk, shouldPreload: "0", preloadFor: "home", register: "web2app_onboarding", registerDelay: "300" },
      mockDoc,
    );
    const loaded = await waitFor(run.done, 30_000);
    // Long enough for a preload that kept going to finish.
    await Bun.sleep(4_000);
    const homeStarted = run.docs.some((r) => pathOf(r) === "/paywalls/home.html" && !isPresented(r));
    const homeBytes = server.served
      .filter((x) => x.path.startsWith("/paywalls/home"))
      .reduce((n, x) => n + x.bytes, 0);
    const runtime = 929 * 1024;
    record(
      "mock: present cancels an in-flight preload",
      sdk,
      `paywall ${loaded ? "loaded" : "NOT loaded"}, home preload ${homeStarted ? "started" : "never started"}, ` +
        `${Math.round(homeBytes / 1024)} KB of it downloaded`,
      loaded && homeStarted && homeBytes < runtime,
    );
    await run.context.close();
  }
}

// ── live backend ────────────────────────────────────────────────────────────

if (!args["no-live"]) {
  server.link.setProfile({ bytesPerSecond: Infinity, latencyMs: 0 });
  const key = args.live!;
  const placement = args["live-placement"]!;
  const configRes = await fetch(`https://api.superwall.me/api/v1/static_config?pk=${key}`);
  if (!configRes.ok) throw new Error(`live static_config: HTTP ${configRes.status}`);
  const config = (await configRes.json()) as {
    trigger_options: Array<{ event_name: string; rules: Array<{ variants: Array<{ paywall_identifier?: string }> }> }>;
    paywall_responses: Array<{ identifier: string; url: string }>;
  };
  const urlOf = (identifier: string) => config.paywall_responses.find((p) => p.identifier === identifier)?.url;
  const pathsFor = (name: string) =>
    new Set(
      config.trigger_options
        .filter((t) => t.event_name === name)
        .flatMap((t) => t.rules.flatMap((r) => r.variants.map((v) => v.paywall_identifier)))
        .map((id) => (id ? urlOf(id) : undefined))
        .filter((u): u is string => Boolean(u))
        .map((u) => new URL(u).pathname),
    );
  const presentedPaths = pathsFor(placement);
  const allPaths = new Set(config.paywall_responses.map((p) => new URL(p.url).pathname));
  const liveDoc = (r: Request) => allPaths.has(pathOf(r));
  const short = (r: Request) => `…${pathOf(r).slice(-8)}${isPresented(r) ? "(presented)" : ""}`;

  for (const sdk of ["before", "after"] as const) {
    // A real paywall, presented right after ready: downloaded once, and it
    // renders with the products the SDK hands it (a price only shows up once
    // the SDK has answered the paywall's template request).
    {
      const run = await open({ sdk, key, register: placement }, liveDoc);
      const page = run.context.pages()[0]!;
      let text = "";
      for (let i = 0; i < 90 && !/\$\d/.test(text); i++) {
        await Bun.sleep(500);
        const frame = page.frames().find((f) => f.url().includes("client_surface="));
        text = (await frame?.evaluate(() => document.body?.innerText ?? "").catch(() => "")) ?? "";
      }
      const rendered = /\$\d/.test(text);
      await Bun.sleep(1_000); // let images settle for the screenshot
      await page.screenshot({ path: `${shots}/live-${sdk}.png` });
      const presented = run.docs.filter((r) => presentedPaths.has(pathOf(r)));
      const errors = await run.errors();
      record(
        `live: register("${placement}") right after ready`,
        sdk,
        `paywall ${rendered ? "rendered with prices" : "did NOT render prices"}, its document ×${presented.length}` +
          `${errors.length ? `, errors: ${errors.join("; ")}` : ""}`,
        rendered && presented.length === 1 && errors.length === 0,
      );
      await run.context.close();
    }
    // Opt-outs against the real config.
    {
      const run = await open({ sdk, key, shouldPreload: "0" }, liveDoc);
      await settle(run, 5_000);
      record(
        "live: shouldPreload false",
        sdk,
        `paywall documents requested: ${run.docs.map(short).join(", ") || "none"}`,
        run.docs.length === 0,
      );
      await run.context.close();
    }
    {
      const target = [...pathsFor("asdfg")];
      const run = await open({ sdk, key, shouldPreload: "0", preloadFor: "asdfg" }, liveDoc);
      await settle(run, 5_000);
      record(
        `live: shouldPreload false + preloadFor(asdfg)`,
        sdk,
        `paywall documents requested: ${run.docs.map(short).join(", ") || "none"}`,
        run.docs.length === target.length && run.docs.every((r) => target.includes(pathOf(r))),
      );
      await run.context.close();
    }
  }
}

await browser.close();
server.stop(true);

const failed = outcomes.filter((o) => o.pass === false);
console.log(
  `\nbefore: ${args.base} (${baseRev}), after: ${headRev}${dirty ? " + uncommitted changes" : ""}` +
    `\n${outcomes.filter((o) => o.pass).length} passed, ${failed.length} failed. Screenshots: ${shots}`,
);
process.exit(failed.length ? 1 : 0);
