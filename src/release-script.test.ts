// src/release-script.test.ts
//
// MNE-112: `scripts/release.mjs` — `prepare` opens the version-bump PR and
// `plan` tells the release workflow whether a merge to main publishes a tag.
// The integration cases run the script in a throwaway repository with a bare
// "origin" next to it and a fake `gh` that records its arguments, so nothing
// here can reach GitHub or touch this checkout.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import * as release from "../scripts/release.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts", "release.mjs");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

interface Fixture { dir: string; origin: string; ghLog: string; bin: string }

/** A clone of a bare origin on `main`, with package.json/lock at `version`, the given commits and tags. */
function fixture(version: string, commits: string[] = [], tags: string[] = []): Fixture {
  const base = mkdtempSync(join(tmpdir(), "mneme-release-"));
  const origin = join(base, "origin.git");
  const dir = join(base, "work");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, dir);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "mnemosyne", version }, null, 2)}\n`);
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify({
    name: "mnemosyne", version, lockfileVersion: 3, requires: true,
    packages: { "": { name: "mnemosyne", version } },
  }, null, 2)}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "✨ base");
  for (const t of tags) git(dir, "tag", t);
  for (const [i, subject] of commits.entries()) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", subject);
  }
  git(dir, "push", "-q", "--tags", "-u", "origin", "main");
  // A fake gh: records its argv, one call per line, and pretends to succeed.
  const bin = join(base, "bin");
  const ghLog = join(base, "gh.log");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\necho https://example.com/pr/1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { dir, origin, ghLog, bin };
}

function run(f: Fixture, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: f.dir,
    encoding: "utf8",
    env: { PATH: `${f.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: f.dir, ...env },
  });
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

describe("release helpers", () => {
  test.each([
    ["0.1.0", "patch", "0.1.1"],
    ["0.1.0", "minor", "0.2.0"],
    ["0.1.9", "major", "1.0.0"],
    ["0.1.0", "0.3.0", "0.3.0"],
    ["0.1.0", "v0.3.0", "0.3.0"],
    ["1.0.0-rc.1", "patch", "1.0.0"],
  ])("bumpVersion(%s, %s) is %s", (current, kind, next) => {
    expect(release.bumpVersion(current, kind)).toBe(next);
  });

  test("bumpVersion_rejects_what_is_not_a_bump_or_a_version", () => {
    expect(() => release.bumpVersion("0.1.0", "huge")).toThrow(/not a version/);
    expect(() => release.bumpVersion("0.1.0", "1.2")).toThrow(/not a version/);
  });

  test("compareSemver_orders_by_precedence_including_pre_releases", () => {
    expect(release.compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(release.compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(release.compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(release.compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(release.compareSemver("nope", "1.0.0")).toBeNull();
  });

  test("latestTag_is_the_highest_semver_tag_and_ignores_the_rest", () => {
    expect(release.latestTag(["v0.2.0", "v0.10.0", "v0.9.1", "nightly", "v1.0"])).toBe("v0.10.0");
    expect(release.latestTag(["nightly"])).toBeNull();
    expect(release.latestTag([])).toBeNull();
  });

  test("groupCommits_sorts_by_emoji_and_drops_merges_release_commits_and_pr_suffixes", () => {
    const groups = release.groupCommits([
      "✨ search: rescate léxico (MNE-98) (#92)",
      "🐛 cli: --help nunca escribe en disco (MNE-106)",
      "Merge pull request #2 from someone/feat/x",
      "🔖 release: v0.1.0",
      "📝 docs: guía de usuario (MNE-100) (#94)",
      "plain subject without emoji",
    ]);
    expect(groups).toEqual({
      added: ["search: rescate léxico (MNE-98)"],
      fixed: ["cli: --help nunca escribe en disco (MNE-106)"],
      other: ["📝 docs: guía de usuario (MNE-100)", "plain subject without emoji"],
    });
  });

  test("renderSection_writes_only_the_groups_that_have_entries", () => {
    const s = release.renderSection("0.2.0", "2026-11-01", { added: ["a"], fixed: [], other: ["o"] });
    expect(s).toBe("## v0.2.0 — 2026-11-01\n\n### Added\n\n- a\n\n### Other\n\n- o\n");
  });

  test("renderSection_of_the_first_release_says_so_instead_of_dumping_history", () => {
    const s = release.renderSection("0.1.0", "2026-11-01", null);
    expect(s).toBe("## v0.1.0 — 2026-11-01\n\nFirst public release.\n");
  });

  test("insertSection_creates_the_changelog_or_puts_the_new_section_on_top", () => {
    const first = release.insertSection(null, "## v0.1.0 — d\n\nFirst.\n");
    expect(first).toMatch(/^# Changelog\n/);
    expect(first).toContain("## v0.1.0 — d\n\nFirst.\n");
    const second = release.insertSection(first, "## v0.2.0 — e\n\nNext.\n");
    expect(second.indexOf("## v0.2.0")).toBeLessThan(second.indexOf("## v0.1.0"));
    expect(second.startsWith("# Changelog\n")).toBe(true);
  });

  test("extractNotes_returns_one_section_body_without_its_heading", () => {
    const log = "# Changelog\n\n## v0.2.0 — e\n\n### Added\n\n- x\n\n## v0.1.0 — d\n\nFirst.\n";
    expect(release.extractNotes(log, "0.2.0")).toBe("### Added\n\n- x");
    expect(release.extractNotes(log, "0.1.0")).toBe("First.");
    expect(release.extractNotes(log, "0.3.0")).toBeNull();
  });

  test("planPublish_skips_a_version_that_is_already_tagged", () => {
    expect(release.planPublish({ version: "0.1.0", tags: ["v0.1.0"] })).toEqual({ action: "skip", tag: "v0.1.0" });
  });

  test("planPublish_publishes_a_new_higher_version_and_flags_pre_releases", () => {
    expect(release.planPublish({ version: "0.2.0", tags: ["v0.1.0"] })).toEqual({ action: "publish", tag: "v0.2.0", prerelease: false });
    expect(release.planPublish({ version: "0.1.0", tags: [] })).toEqual({ action: "publish", tag: "v0.1.0", prerelease: false });
    expect(release.planPublish({ version: "1.0.0-rc.1", tags: ["v0.2.0"] })).toEqual({ action: "publish", tag: "v1.0.0-rc.1", prerelease: true });
  });

  test("planPublish_refuses_a_version_lower_than_the_latest_tag_or_not_semver", () => {
    expect(release.planPublish({ version: "0.1.5", tags: ["v0.2.0"] }).action).toBe("error");
    expect(release.planPublish({ version: "banana", tags: [] }).action).toBe("error");
  });
});

describe("release prepare", () => {
  test("bumps_package_and_lock_writes_the_changelog_commits_pushes_and_opens_the_pr", () => {
    const f = fixture("0.1.0", ["✨ feature one (MNE-1) (#3)", "🐛 fix two (MNE-2)", "📝 docs three"], ["v0.1.0"]);
    // the tag sits on the base commit, before the three commits above
    git(f.dir, "tag", "-d", "v0.1.0");
    git(f.dir, "tag", "v0.1.0", "HEAD~3");
    git(f.dir, "push", "-q", "-f", "--tags", "origin");
    const r = run(f, ["prepare", "minor"]);
    expect(r.out).toContain("v0.2.0");
    expect(r.code).toBe(0);

    expect(git(f.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release/v0.2.0");
    expect(json(join(f.dir, "package.json")).version).toBe("0.2.0");
    const lock = json(join(f.dir, "package-lock.json")) as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""]!.version).toBe("0.2.0");

    const log = readFileSync(join(f.dir, "CHANGELOG.md"), "utf8");
    expect(log).toMatch(/## v0\.2\.0 — \d{4}-\d{2}-\d{2}/);
    expect(log).toContain("### Added\n\n- feature one (MNE-1)\n");
    expect(log).toContain("### Fixed\n\n- fix two (MNE-2)\n");
    expect(log).toContain("### Other\n\n- 📝 docs three\n");
    expect(log).not.toContain("✨ base");

    expect(git(f.dir, "log", "-1", "--format=%s")).toBe("🔖 release: v0.2.0");
    expect(git(f.dir, "status", "--porcelain")).toBe("");
    expect(git(f.origin, "rev-parse", "release/v0.2.0")).toBe(git(f.dir, "rev-parse", "HEAD"));
    const gh = readFileSync(f.ghLog, "utf8");
    expect(gh).toContain("pr create");
    expect(gh).toContain("🔖 release: v0.2.0");
    expect(gh).toContain("--base main");
  });

  test("the_first_release_at_the_current_version_writes_only_the_changelog", () => {
    const f = fixture("0.1.0", ["✨ something"]);
    const r = run(f, ["prepare", "0.1.0"]);
    expect(r.code).toBe(0);
    expect(json(join(f.dir, "package.json")).version).toBe("0.1.0");
    const log = readFileSync(join(f.dir, "CHANGELOG.md"), "utf8");
    expect(log).toContain("## v0.1.0");
    expect(log).toContain("First public release.");
    expect(git(f.dir, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(["CHANGELOG.md"]);
  });

  test("dry_run_prints_the_section_and_changes_nothing", () => {
    const f = fixture("0.1.0", ["✨ feature"], ["v0.1.0"]);
    const head = git(f.dir, "rev-parse", "HEAD");
    const r = run(f, ["prepare", "patch", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("## v0.1.1");
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(f.dir, "CHANGELOG.md"))).toBe(false);
    expect(existsSync(f.ghLog)).toBe(false);
  });

  test.each([
    ["a_dirty_tree", (f: Fixture) => writeFileSync(join(f.dir, "package.json"), "{}\n"), ["prepare", "minor"], /not clean/],
    ["a_branch_other_than_main", (f: Fixture) => git(f.dir, "checkout", "-q", "-b", "other"), ["prepare", "minor"], /on main/],
    ["main_behind_origin", (f: Fixture) => {
      git(f.dir, "commit", "-q", "--allow-empty", "-m", "ahead");
      git(f.dir, "push", "-q", "origin", "main");
      git(f.dir, "reset", "-q", "--hard", "HEAD~1");
    }, ["prepare", "minor"], /origin\/main/],
    ["a_version_already_tagged", () => {}, ["prepare", "0.1.0"], /already tagged/],
    ["a_version_lower_than_the_latest_tag", () => {}, ["prepare", "0.0.9"], /not higher/],
    ["no_bump_argument", () => {}, ["prepare"], /usage/],
  ])("refuses %s and changes nothing", (_name, setup, args, message) => {
    const f = fixture("0.1.0", ["✨ feature"], ["v0.1.0"]);
    setup(f);
    const head = git(f.dir, "rev-parse", "HEAD");
    const r = run(f, args);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(message);
    expect(git(f.dir, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(f.dir, "CHANGELOG.md"))).toBe(false);
    expect(existsSync(f.ghLog)).toBe(false);
  });
});

describe("release plan (the workflow's half)", () => {
  test("an_untagged_version_with_notes_is_published", () => {
    const f = fixture("0.2.0", [], ["v0.1.0"]);
    writeFileSync(join(f.dir, "CHANGELOG.md"), "# Changelog\n\n## v0.2.0 — d\n\n### Added\n\n- x\n");
    const notes = join(f.dir, "..", "notes.md");
    const r = run(f, ["plan", "--notes-out", notes]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tag=v0.2.0\n");
    expect(r.stdout).toContain("prerelease=false\n");
    expect(readFileSync(notes, "utf8")).toBe("### Added\n\n- x\n");
  });

  test("a_version_already_tagged_publishes_nothing", () => {
    const f = fixture("0.1.0", ["✨ later work"], ["v0.1.0"]);
    const r = run(f, ["plan", "--notes-out", join(f.dir, "..", "notes.md")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tag=\n");
    expect(r.out).toMatch(/already tagged/);
  });

  test("a_new_version_without_a_changelog_section_fails", () => {
    const f = fixture("0.2.0", [], ["v0.1.0"]);
    const r = run(f, ["plan", "--notes-out", join(f.dir, "..", "notes.md")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/CHANGELOG/);
  });

  test("before_the_first_release_an_untagged_version_without_a_section_is_not_released_yet", () => {
    // No tag at all and no CHANGELOG section: merges to main before v0.1.0 must stay green.
    const f = fixture("0.1.0", ["✨ work"]);
    const r = run(f, ["plan", "--notes-out", join(f.dir, "..", "notes.md")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tag=\n");
    expect(r.out).toMatch(/not released yet/);
  });

  test("a_version_below_the_latest_tag_fails", () => {
    const f = fixture("0.1.0", [], ["v0.2.0"]);
    writeFileSync(join(f.dir, "CHANGELOG.md"), "# Changelog\n\n## v0.1.0 — d\n\nx\n");
    const r = run(f, ["plan", "--notes-out", join(f.dir, "..", "notes.md")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not higher/);
  });
});
