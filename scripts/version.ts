#!/usr/bin/env bun
// Single-source-of-truth versioning for the @superwall/* packages.
//
// The root package.json `version` is the canonical SDK version; every
// publishable workspace package is stamped to match. Cross-package deps use
// `workspace:*`, which `bun publish` rewrites to the concrete version at
// publish time — so keeping every package on one version means published
// consumers get matching, in-lockstep dependency ranges.
//
//   bun run version:set 0.1.0   # set the root version + stamp all packages
//   bun run version:sync        # re-stamp all packages from the current root
//
// Private packages (the root, the examples) are skipped — they never publish.

import { Glob } from "bun";

const ROOT_URL = new URL("../package.json", import.meta.url);
const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;

// Permissive semver: x.y.z with optional -prerelease and +build metadata.
const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const readJson = async (path: string | URL): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(path).text());

// Preserve key order (JSON.parse/stringify keeps insertion order) and end with
// a trailing newline to match the repo's existing package.json formatting.
const writeJson = (path: string | URL, obj: unknown): Promise<number> =>
  Bun.write(path, `${JSON.stringify(obj, null, 2)}\n`);

const fail = (msg: string): never => {
  console.error(`version: ${msg}`);
  process.exit(1);
};

const root = await readJson(ROOT_URL);
const requested = process.argv[2];

if (requested !== undefined) {
  if (!SEMVER.test(requested)) fail(`"${requested}" is not a valid semver.`);
  root.version = requested;
  await writeJson(ROOT_URL, root);
}

const version = root.version;
if (typeof version !== "string" || !SEMVER.test(version)) {
  fail(
    `root package.json has no valid \`version\` (got ${JSON.stringify(
      version,
    )}). Set one: \`bun run version:set 0.1.0\`.`,
  );
}

const updated: string[] = [];
const skipped: string[] = [];
for await (const rel of new Glob("*/package.json").scan(PACKAGES_DIR)) {
  const path = PACKAGES_DIR + rel;
  const pkg = await readJson(path);
  if (pkg.private === true) {
    skipped.push(String(pkg.name ?? rel));
    continue;
  }
  if (pkg.version === version) continue;
  pkg.version = version;
  await writeJson(path, pkg);
  updated.push(`${pkg.name} ${pkg.version === version ? "→" : ""} ${version}`);
}

console.log(`Canonical version: ${version}`);
console.log(
  updated.length
    ? `Stamped:\n  ${updated.join("\n  ")}`
    : "All publishable packages already at this version.",
);
if (skipped.length) console.log(`Skipped (private): ${skipped.join(", ")}`);
