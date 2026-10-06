#!/usr/bin/env bun
// Cut the GitHub release for the current SDK version. Run by publish.yml
// right after the npm publish, so every version on npm has a release.
//
//   bun run scripts/github-release.ts             # create it (needs `gh` + GH_TOKEN)
//   bun run scripts/github-release.ts --dry-run   # print the notes, create nothing
//
// The release is tagged with the root package.json version, bare semver
// (`0.3.2`, matching the existing `0.2.0` tag), on the current commit. Notes
// are that version's section of CHANGELOG.md plus the published packages.
//
// Runs only on the push that bumps the version — the root version differs
// from the first parent's — so merging an unbumped PR never tags code that
// isn't what's on npm. Idempotent: an existing release is left alone, so a
// re-run of the same commit is safe.

import { $, Glob } from "bun";

const dryRun = process.argv.includes("--dry-run");
const ROOT = new URL("../", import.meta.url).pathname;
const REPO = "superwall/Superwall-Web";

const readJson = async (path: string) =>
  JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;

const version = String((await readJson(`${ROOT}package.json`)).version);

// Root version on the first parent (the previous `main`). Unreadable — e.g. a
// shallow clone without the parent — counts as bumped; the existing-release
// check below still keeps this idempotent.
const previousVersion = await $`git show HEAD^1:package.json`
  .cwd(ROOT)
  .quiet()
  .nothrow()
  .then((r) =>
    r.exitCode === 0 ? String(JSON.parse(r.stdout.toString()).version) : null,
  );
if (previousVersion === version) {
  console.log(`Version unchanged (${version}) — no release to cut.`);
  process.exit(0);
}

if (!dryRun) {
  const existing = await $`gh release view ${version} --repo ${REPO}`
    .quiet()
    .nothrow();
  if (existing.exitCode === 0) {
    console.log(`Release ${version} already exists — skipping.`);
    process.exit(0);
  }
}

// This version's CHANGELOG section: from its `## <version>` heading to the
// next `## ` heading.
const changelog = await Bun.file(`${ROOT}CHANGELOG.md`).text();
const lines = changelog.split("\n");
const start = lines.findIndex(
  (l) => l === `## ${version}` || l.startsWith(`## ${version} `),
);
let section: string | null = null;
if (start !== -1) {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

const packages: string[] = [];
for await (const rel of new Glob("*/package.json").scan(`${ROOT}packages/`)) {
  const pkg = await readJson(`${ROOT}packages/${rel}`);
  if (pkg.private !== true) packages.push(String(pkg.name));
}
packages.sort();

const notes = [
  section ??
    `_No \`## ${version}\` section in CHANGELOG.md — see the commits below._`,
  "",
  "### Packages",
  "",
  `All published to npm at \`${version}\`:`,
  "",
  ...packages.map(
    (name) => `- [\`${name}\`](https://www.npmjs.com/package/${name}/v/${version})`,
  ),
  "",
  `**Full changelog:** https://github.com/${REPO}/blob/${version}/CHANGELOG.md`,
].join("\n");

if (section === null) {
  console.warn(
    `::warning::CHANGELOG.md has no "## ${version}" section; the release notes use GitHub's generated notes instead.`,
  );
}

const target = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.cwd(ROOT).text()).trim();
// Prerelease semver (`1.0.0-beta.1`) must not become the repo's "latest".
const latestFlag = version.includes("-") ? "--prerelease" : "--latest";
const generateFlag = section === null ? ["--generate-notes"] : [];

if (dryRun) {
  console.log(
    `[dry run] would create release ${version} on ${target} (${latestFlag}${section === null ? ", generated notes" : ""}):\n`,
  );
  console.log(notes);
  process.exit(0);
}

await $`gh release create ${version} --repo ${REPO} --target ${target} --title ${version} ${latestFlag} ${generateFlag} --notes ${notes}`;
console.log(`Created release ${version}: https://github.com/${REPO}/releases/tag/${version}`);
