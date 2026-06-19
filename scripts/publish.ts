#!/usr/bin/env bun
// Publish every publishable @superwall/* package, in dependency order.
//
//   bun run publish:all:first   # first release: bun publish --access public
//   bun run publish:all         # subsequent releases: bun publish
//   bun run publish:all:dry     # dry run (no upload)
//
// Scoped packages default to RESTRICTED on npm, so the FIRST publish of each
// needs `--access public` to make it public. After that the access level
// sticks and the flag is unnecessary — hence the two scripts.
//
// Any args after the script name are forwarded verbatim to `bun publish`, so
// you can also pass `--otp 123456`, `--tag next`, `--dry-run`, etc.
//
// Versions are assumed already in lockstep — run `bun run version:set <semver>`
// first. `workspace:*` deps are rewritten to the concrete version by
// `bun publish`, so publishing in dependency order keeps a freshly-published
// consumer installable immediately.

import { Glob } from "bun";

const PACKAGES_DIR = new URL("../packages/", import.meta.url).pathname;
const forwarded = process.argv.slice(2);
const dryRun = forwarded.includes("--dry-run");

interface Pkg {
  name: string;
  dir: string;
  version: string;
  deps: string[]; // workspace @superwall/* deps within this monorepo
}

// Discover publishable packages.
const pkgs = new Map<string, Pkg>();
for await (const rel of new Glob("*/package.json").scan(PACKAGES_DIR)) {
  const path = PACKAGES_DIR + rel;
  const json = JSON.parse(await Bun.file(path).text()) as {
    name?: string;
    version?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (json.private === true || !json.name) continue;
  pkgs.set(json.name, {
    name: json.name,
    dir: PACKAGES_DIR + rel.replace(/\/package\.json$/, ""),
    version: json.version ?? "",
    deps: [
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
    ],
  });
}

if (pkgs.size === 0) {
  console.error("publish: no publishable packages found.");
  process.exit(1);
}

// Topological sort so dependencies publish before their dependents.
const order: Pkg[] = [];
const visiting = new Set<string>();
const done = new Set<string>();
const visit = (name: string): void => {
  if (done.has(name)) return;
  if (visiting.has(name)) {
    throw new Error(`publish: dependency cycle through ${name}`);
  }
  visiting.add(name);
  const pkg = pkgs.get(name);
  if (pkg) {
    for (const dep of pkg.deps) if (pkgs.has(dep)) visit(dep);
    order.push(pkg);
    done.add(name);
  }
  visiting.delete(name);
};
for (const name of pkgs.keys()) visit(name);

console.log(
  `Publishing ${order.length} package(s)${dryRun ? " [dry run]" : ""}${
    forwarded.length ? ` (bun publish ${forwarded.join(" ")})` : ""
  }:`,
);
for (const p of order) console.log(`  ${p.name}@${p.version}`);
console.log("");

const failed: string[] = [];
for (const pkg of order) {
  console.log(`\n=== ${pkg.name}@${pkg.version} ===`);
  const proc = Bun.spawnSync(["bun", "publish", ...forwarded], {
    cwd: pkg.dir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    failed.push(pkg.name);
    console.error(`✗ ${pkg.name} failed (exit ${proc.exitCode})`);
    // Keep going — a single already-published version shouldn't abort the
    // rest of the release.
  } else {
    console.log(`✓ ${pkg.name}`);
  }
}

console.log("");
if (failed.length) {
  console.error(`Done with failures: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`All ${order.length} package(s) published${dryRun ? " [dry run]" : ""}.`);
