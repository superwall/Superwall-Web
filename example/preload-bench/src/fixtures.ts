// Synthetic paywalls and static config for the preload benchmark.
//
// Sizes mirror a real customer report: the presented onboarding paywall is an
// 875 KB document, and two other live campaigns (a "home" paywall with a
// 929 KB runtime and a 2.78 MB hero PNG, and a smaller "special offer") are
// reachable from other placements. Bodies are pseudo-random so compression
// can't hide their size.

const KB = 1024;

/** Deterministic incompressible filler, base64 so it's safe inside HTML/JS. */
const filler = (bytes: number, seed: number): string => {
  let x = seed >>> 0 || 1;
  const raw = new Uint8Array(Math.ceil((bytes * 3) / 4));
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = x & 0xff;
  }
  return Buffer.from(raw).toString("base64").slice(0, bytes);
};

/** Paywall document. Posts `paywall-load` to the host on window load, flagged
 *  `presented` when the URL carries the SDK's present-time bootstrap params
 *  (preload iframes don't). */
const paywallHtml = (id: string, size: number, extraHead = ""): string => {
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title>${extraHead}
<script>
addEventListener("load", () => parent.postMessage({
  bench: "paywall-load",
  id: ${JSON.stringify(id)},
  presented: location.search.includes("client_surface="),
}, "*"));
</script></head><body><h1>${id}</h1><!--`;
  const tail = `--></body></html>`;
  return head + filler(Math.max(0, size - head.length - tail.length), size) + tail;
};

export const assets: Record<string, { body: string | Uint8Array; type: string }> = {
  "/paywalls/onboarding.html": {
    body: paywallHtml("onboarding", 875 * KB),
    type: "text/html",
  },
  "/paywalls/home.html": {
    body: paywallHtml(
      "home",
      24 * KB,
      `<script src="/paywalls/home-runtime.js"></script>`,
    ).replace("<body>", `<body><img src="/paywalls/home-hero.png">`),
    type: "text/html",
  },
  "/paywalls/home-runtime.js": {
    body: `/*${filler(929 * KB, 7)}*/`,
    type: "text/javascript",
  },
  "/paywalls/home-hero.png": {
    body: new TextEncoder().encode(filler(2780 * KB, 11)),
    type: "image/png",
  },
  "/paywalls/special.html": {
    body: paywallHtml("special", 160 * KB).replace(
      "<body>",
      `<body><img src="/paywalls/special-hero.png">`,
    ),
    type: "text/html",
  },
  "/paywalls/special-hero.png": {
    body: new TextEncoder().encode(filler(540 * KB, 13)),
    type: "image/png",
  },
};

/** `/api/v1/static_config` for three live campaigns. The host registers
 *  `web2app_onboarding`; the other two placements are elsewhere in the app. */
export const staticConfig = (origin: string) => {
  const campaign = (placement: string, paywall: string) => ({
    event_name: placement,
    rules: [
      {
        experiment_id: `exp_${paywall}`,
        experiment_group_id: `grp_${paywall}`,
        expression_cel: "",
        variants: [
          {
            variant_id: `var_${paywall}`,
            variant_type: "TREATMENT",
            percentage: 100,
            paywall_identifier: paywall,
          },
        ],
      },
    ],
  });
  const paywall = (identifier: string, file: string) => ({
    id: identifier,
    identifier,
    name: identifier,
    url: `${origin}/paywalls/${file}.html`,
  });
  return {
    build_id: "bench",
    trigger_options: [
      campaign("web2app_onboarding", "pw_onboarding"),
      campaign("home", "pw_home"),
      campaign("special_offer", "pw_special"),
    ],
    // The presented paywall is among the first two the SDK warms, which is
    // when the report saw it downloaded twice on every cold load.
    paywall_responses: [
      paywall("pw_onboarding", "onboarding"),
      paywall("pw_home", "home"),
      paywall("pw_special", "special"),
    ],
    products: [],
    toggles: [],
    localization: { locales: [{ locale: "en-US" }] },
  };
};
