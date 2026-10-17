// Builds @superwall/paywalls-js twice for the bench and e2e scripts:
// `before` from a git ref, `after` from the working tree.

import { $ } from "bun";
import { rm } from "node:fs/promises";

export const buildDir = `${import.meta.dir}/../.build`;

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

/** Bundle both SDKs into `<buildDir>/sdk/{before,after}/index.js`. */
export const buildSdks = async (base: string) => {
  const repo = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).text()).trim();
  await rm(`${buildDir}/sdk`, { recursive: true, force: true });
  await rm(`${buildDir}/base-src`, { recursive: true, force: true });
  // The base's sources go under this package so they resolve its node_modules.
  const baseSrc = `${buildDir}/base-src`;
  await $`mkdir -p ${baseSrc}`;
  await $`git -C ${repo} archive ${base} packages/paywalls-js/src packages/paywalls-js/package.json | tar -x -C ${baseSrc}`;
  await bundle(`${baseSrc}/packages/paywalls-js/src/index.ts`, `${buildDir}/sdk/before`);
  await bundle(`${repo}/packages/paywalls-js/src/index.ts`, `${buildDir}/sdk/after`);
  return {
    baseRev: (await $`git -C ${repo} rev-parse --short ${base}`.text()).trim(),
    headRev: (await $`git -C ${repo} rev-parse --short HEAD`.text()).trim(),
    dirty: (await $`git -C ${repo} status --porcelain packages/paywalls-js/src`.text()).trim() !== "",
  };
};
