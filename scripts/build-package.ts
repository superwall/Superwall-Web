#!/usr/bin/env bun
// Shared build for every publishable @superwall/* package.
//
//   bun run ../../scripts/build-package.ts
//
// Run from the package directory (turbo does this via each package's `build`
// script). Emits ESM JS + .d.ts to dist/, one output file per source module
// (the module graph is preserved — no bundling). Every bare import (effect,
// @superwall/*, jose, react…) stays external so npm dedupes it in the
// consumer's tree.
//
// We transpile with tsc rather than bundling because Bun's bundler tree-shakes
// re-export-only barrels (e.g. ./browser) down to dangling `export {}` with no
// backing implementation. Per-module transpile sidesteps that and is the
// conventional shape for a library anyway.
//
// tsc's `rewriteRelativeImportExtensions` turns the `./x.ts` specifiers the
// source uses into `./x.js` on emit; the post-process below is a safety net
// for any specifier it leaves behind (notably in .d.ts output).

import { rm } from "node:fs/promises";
import { Glob } from "bun";

const cwd = process.cwd();
await rm(`${cwd}/dist`, { recursive: true, force: true });

const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

// Rewrite any leftover relative `.ts`/`.tsx` import specifiers in emitted JS
// and declarations to `.js` (covers `from "..."` and dynamic `import("...")`).
const rewriteSpecifiers = (src: string): string =>
  src
    .replace(/(\bfrom\s*")(\.\.?\/[^"]*?)\.tsx?(")/g, "$1$2.js$3")
    .replace(/(\bimport\(\s*")(\.\.?\/[^"]*?)\.tsx?(")/g, "$1$2.js$3");

let rewritten = 0;
for await (const rel of new Glob("**/*.{js,d.ts}").scan(`${cwd}/dist`)) {
  const file = Bun.file(`${cwd}/dist/${rel}`);
  const before = await file.text();
  const after = rewriteSpecifiers(before);
  if (after !== before) {
    await Bun.write(file, after);
    rewritten++;
  }
}

console.log(`build-package: ${cwd.split("/").pop()} → dist/ (${rewritten} specifier rewrites)`);
