#!/usr/bin/env node
// Release tooling (MNE-112). Two halves, one per side of the merge:
//
//   prepare <patch|minor|major|X.Y.Z> [--dry-run]
//     Run by the maintainer on an up-to-date `main` (`npm run release -- minor`).
//     Bumps package.json and package-lock.json, writes the CHANGELOG section from
//     the commits since the last tag, and opens the release PR on a
//     `release/vX.Y.Z` branch. The PR is opened from here and not from Actions on
//     purpose: a PR opened with the workflow's GITHUB_TOKEN does not trigger CI.
//     Asking for the current version is allowed while it is untagged — that is
//     how the first release (package.json already at 0.1.0) gets its changelog.
//
//   plan --notes-out <file>
//     Run by .github/workflows/release.yml on every push to main. Prints
//     `tag=` and `prerelease=` lines for $GITHUB_OUTPUT. An already-tagged
//     version prints `tag=` (empty) and publishes nothing, so ordinary merges
//     are no-ops; an untagged one writes its CHANGELOG section to the notes file.
//     A version that is not semver, is not higher than the latest tag, or has no
//     CHANGELOG section fails the job instead of publishing something wrong —
//     except before the first release (no tags yet), where a missing section
//     only means "not released yet".
//
// The tag is derived from package.json, never typed by hand, so the two cannot
// disagree — and the update notice (src/release.ts) compares exactly those two.
//
// Changelog groups follow the repo's commit emoji: ✨ Added, 🐛 Fixed, the rest
// Other. Merge commits and release commits are left out, as is the ` (#NN)`
// suffix GitHub appends to merged PR subjects.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const CHANGELOG = "CHANGELOG.md";
const CHANGELOG_HEADER = "# Changelog\n\nAll notable changes to Mnemosyne. Versions follow [semver](https://semver.org/).\n";
const USAGE = "usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]\n"
  + "       node scripts/release.mjs plan --notes-out <file>";

// ------------------------------------------------------------------ semver ---

function parse(v) {
  const m = SEMVER.exec(v);
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

/** Sign of a − b by semver precedence, or null when either is not a version. */
export function compareSemver(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split(".");
  const q = y.pre.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Number(p[i]) > Number(q[i]) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}

/** The next version: a bump kind applied to `current`, or an explicit X.Y.Z (a leading v is dropped). */
export function bumpVersion(current, kind) {
  const c = parse(current);
  if (!c) throw new Error(`current version '${current}' is not a version`);
  const [major, minor, patch] = c.core;
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  // A patch of a pre-release finishes it: 1.0.0-rc.1 → 1.0.0.
  if (kind === "patch") return c.pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  if (parse(kind)) return kind.replace(/^v/, "");
  throw new Error(`'${kind}' is not a version or one of patch, minor, major`);
}

/** The highest semver tag, or null. Tags that are not versions are ignored. */
export function latestTag(tags) {
  let best = null;
  for (const t of tags) {
    if (!t.startsWith("v") || !parse(t)) continue;
    if (best === null || compareSemver(t, best) > 0) best = t;
  }
  return best;
}

// --------------------------------------------------------------- changelog ---

/** Commit subjects grouped for the changelog; null-free, order kept. */
export function groupCommits(subjects) {
  const groups = { added: [], fixed: [], other: [] };
  for (const raw of subjects) {
    const subject = raw.trim().replace(/ \(#\d+\)$/, "");
    if (!subject || /^Merge (pull request|branch) /.test(subject) || subject.startsWith("🔖 release:")) continue;
    if (subject.startsWith("✨")) groups.added.push(subject.replace(/^✨\s*/, ""));
    else if (subject.startsWith("🐛")) groups.fixed.push(subject.replace(/^🐛\s*/, ""));
    else groups.other.push(subject);
  }
  return groups;
}

/** One version's section. `groups` null means the first release: no history dump. */
export function renderSection(version, date, groups) {
  let out = `## v${version} — ${date}\n`;
  if (groups === null) return `${out}\nFirst public release.\n`;
  const titled = [["Added", groups.added], ["Fixed", groups.fixed], ["Other", groups.other]];
  let any = false;
  for (const [title, items] of titled) {
    if (items.length === 0) continue;
    any = true;
    out += `\n### ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
  }
  return any ? out : `${out}\nNo user-facing changes.\n`;
}

/** The changelog with `section` as its newest entry; creates the file's header when there is none. */
export function insertSection(changelog, section) {
  const text = changelog ?? CHANGELOG_HEADER;
  const at = text.search(/^## /m);
  if (at === -1) return `${text.replace(/\n*$/, "\n")}\n${section}`;
  return `${text.slice(0, at)}${section}\n${text.slice(at)}`;
}

/** The body of one version's section (heading excluded, trimmed), or null when it has none. */
export function extractNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## v?${version.replace(/\./g, "\\.")}(\\s|$)`).test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

// ----------------------------------------------------------------- publish ---

/** What a push to main should do for package.json's `version`, given the repo's tags. */
export function planPublish({ version, tags }) {
  const v = parse(version);
  if (!v) return { action: "error", reason: `package.json version '${version}' is not semver` };
  const tag = `v${version}`;
  if (tags.includes(tag)) return { action: "skip", tag };
  const latest = latestTag(tags);
  if (latest && compareSemver(tag, latest) <= 0) {
    return { action: "error", reason: `${tag} is not higher than the latest tag ${latest}` };
  }
  return { action: "publish", tag, prerelease: v.pre !== null };
}

// --------------------------------------------------------------------- cli ---

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tagsOf() {
  const out = git("tag", "--list", "v*");
  return out ? out.split("\n") : [];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

class Refusal extends Error {}

function prepare(args) {
  const dryRun = args.includes("--dry-run");
  const kind = args.find((a) => !a.startsWith("--"));
  if (!kind) throw new Refusal(USAGE);

  if (git("status", "--porcelain") !== "") throw new Refusal("the working tree is not clean; commit or stash first.");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new Refusal(`releases are cut on main, and this is '${branch}'. Switch to main first: the release must be on main.`);
  git("fetch", "--quiet", "--tags", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Refusal("main is not at origin/main; pull (or push) first so the release covers exactly what is merged.");
  }

  const current = readJson("package.json").version;
  const next = bumpVersion(current, kind);
  const tags = tagsOf();
  const tag = `v${next}`;
  if (tags.includes(tag)) throw new Refusal(`${tag} is already tagged.`);
  const latest = latestTag(tags);
  if (latest && compareSemver(tag, latest) <= 0) throw new Refusal(`${tag} is not higher than the latest tag ${latest}.`);
  if (compareSemver(next, current) < 0) throw new Refusal(`${next} is lower than package.json's ${current}.`);

  const subjects = latest ? git("log", "--format=%s", `${latest}..HEAD`).split("\n").filter(Boolean) : null;
  const date = new Date().toISOString().slice(0, 10);
  const section = renderSection(next, date, subjects === null ? null : groupCommits(subjects));
  const changelog = insertSection(existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : null, section);

  const releaseBranch = `release/${tag}`;
  const title = `🔖 release: ${tag}`;
  if (dryRun) {
    stdout.write(`release: ${current} → ${next}${latest ? ` (changes since ${latest})` : " (first release)"}\n\n${section}\n`);
    stdout.write(`would create ${releaseBranch}, commit "${title}", push it and open the PR. Nothing was changed.\n`);
    return 0;
  }

  git("switch", "--quiet", "-c", releaseBranch);
  const files = [CHANGELOG];
  if (next !== current) {
    const pkg = readJson("package.json");
    pkg.version = next;
    writeJson("package.json", pkg);
    const lock = readJson("package-lock.json");
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    writeJson("package-lock.json", lock);
    files.push("package.json", "package-lock.json");
  }
  writeFileSync(CHANGELOG, changelog);
  git("add", "--", ...files);
  git("commit", "--quiet", "-m", title);
  git("push", "--quiet", "-u", "origin", releaseBranch);

  const body = `Release ${tag}. Merging this publishes the \`${tag}\` tag and its GitHub Release `
    + "(`.github/workflows/release.yml`), with the section below as the notes. Edit `CHANGELOG.md` "
    + `on this branch to change them.\n\n${section}`;
  let url;
  try {
    url = execFileSync("gh", ["pr", "create", "--base", "main", "--head", releaseBranch, "--title", title, "--body", body],
      { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${releaseBranch} is pushed, but opening the PR failed. Open it by hand: gh pr create --base main --head ${releaseBranch} --title "${title}"`);
  }
  stdout.write(`release: ${current} → ${next}. PR: ${url}\nMerge it and the workflow publishes ${tag}.\n`);
  return 0;
}

function plan(args) {
  const i = args.indexOf("--notes-out");
  const notesOut = i === -1 ? undefined : args[i + 1];
  if (!notesOut) throw new Refusal(USAGE);

  const version = readJson("package.json").version;
  const tags = tagsOf();
  const decision = planPublish({ version, tags });
  if (decision.action === "error") {
    stdout.write("tag=\n");
    throw new Refusal(decision.reason);
  }
  if (decision.action === "skip") {
    stdout.write("tag=\n");
    stderr.write(`release: ${decision.tag} is already tagged; nothing to publish.\n`);
    return 0;
  }
  const notes = existsSync(CHANGELOG) ? extractNotes(readFileSync(CHANGELOG, "utf8"), version) : null;
  if (notes === null && latestTag(tags) === null) {
    // Nothing was ever released: package.json starts at a version long before
    // its first release PR exists. Merges until then are not failures.
    stdout.write("tag=\n");
    stderr.write(`release: v${version} is not released yet (no tags, no ${CHANGELOG} section); nothing to publish.\n`);
    return 0;
  }
  if (notes === null) {
    stdout.write("tag=\n");
    throw new Refusal(`${CHANGELOG} has no section for v${version}; add one (npm run release does) before publishing.`);
  }
  writeFileSync(notesOut, `${notes}\n`);
  stdout.write(`tag=${decision.tag}\nprerelease=${decision.prerelease}\n`);
  stderr.write(`release: publishing ${decision.tag}.\n`);
  return 0;
}

function main() {
  const [command, ...rest] = argv.slice(2);
  try {
    if (command === "prepare") return prepare(rest);
    if (command === "plan") return plan(rest);
    stderr.write(`${USAGE}\n`);
    return 2;
  } catch (e) {
    stderr.write(`release: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof Refusal ? 1 : 2;
  }
}

// Run only as a script, so the test suite can import the helpers.
if (argv[1] && import.meta.url === pathToFileURL(realpathSync(argv[1])).href) exit(main());
