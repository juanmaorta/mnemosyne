// src/privacy-check.script.test.ts
//
// MNE-107: `scripts/privacy-check.mjs` — fails when a tracked file contains a
// term from a denylist that is never committed. Every case builds a throwaway
// git repository and runs the script there with a scrubbed environment, so a
// MNEMOSYNE_PRIVACY_DENYLIST set on this machine (or in CI) can never leak in,
// and no case reads this checkout's own `.privacy-denylist.local`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts", "privacy-check.mjs");

// Synthetic terms only: the real denylist must never appear in the repository.
const SECRET_TERM = "Initech";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A git repo whose `tracked` files are added to the index; `untracked` ones are only written. */
function fixtureRepo(tracked: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-privacy-"));
  git(dir, "init", "-q");
  for (const [path, body] of Object.entries({ ...tracked, ...untracked })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  if (Object.keys(tracked).length > 0) git(dir, "add", "--", ...Object.keys(tracked));
  return dir;
}

function check(cwd: string, env: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("privacy-check", () => {
  test("no_denylist_warns_and_passes", () => {
    const dir = fixtureRepo({ "README.md": `${SECRET_TERM} everywhere\n` });
    const r = check(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no denylist available/);
  });

  test("no_denylist_under_github_actions_emits_a_warning_annotation", () => {
    const dir = fixtureRepo({ "README.md": "x\n" });
    const r = check(dir, { GITHUB_ACTIONS: "true" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^::warning::no denylist available/m);
  });

  test("env_denylist_finding_fails_with_path_line_and_entry_but_never_the_term", () => {
    const dir = fixtureRepo({ "src/a.ts": "const ok = 1;\n// works for initech\n" });
    const r = check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: `# comment\n\n${SECRET_TERM}\n` });
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/a.ts:2: matches denylist entry #3");
    // CI logs are public: neither the term nor the offending line may be echoed.
    expect(r.out.toLowerCase()).not.toContain(SECRET_TERM.toLowerCase());
    expect(r.out).not.toContain("works for");
  });

  test("entries_are_case_insensitive_regular_expressions", () => {
    const dir = fixtureRepo({ "notes.txt": "host 198.51.100.7 is up\n" });
    const r = check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: "198\\.51\\.100\\.\\d+\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("notes.txt:1: matches denylist entry #1");
  });

  test("a_term_in_a_file_path_is_reported_at_line_zero_with_the_term_masked", () => {
    const dir = fixtureRepo({ "fixtures/initech-notes.md": "nothing here\n" });
    const r = check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: SECRET_TERM });
    expect(r.code).toBe(1);
    expect(r.out).toContain("fixtures/***-notes.md:0: matches denylist entry #1");
    // A file name is echoed too, so the term must be masked there as well.
    expect(r.out.toLowerCase()).not.toContain(SECRET_TERM.toLowerCase());
  });

  test("local_denylist_file_is_used_when_the_env_var_is_absent_and_untracked_files_are_not_scanned", () => {
    const dir = fixtureRepo(
      { "README.md": "clean\n" },
      { ".privacy-denylist.local": `${SECRET_TERM}\n`, "scratch.txt": `${SECRET_TERM}\n` },
    );
    const r = check(dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/clean — 1 file\(s\), 1 denylist entries \(\.privacy-denylist\.local\)/);
  });

  test("the_env_var_wins_over_the_local_file_and_--denylist_wins_over_both", () => {
    const dir = fixtureRepo({ "README.md": "alpha beta\n" }, { ".privacy-denylist.local": "alpha\n", "other.list": "gamma\n" });
    expect(check(dir).code).toBe(1);
    expect(check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: "delta" }).code).toBe(0);
    expect(check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: "alpha" }, ["--denylist", join(dir, "other.list")]).code).toBe(0);
  });

  test("internal_docs_removed_at_publication_are_excluded", () => {
    const dir = fixtureRepo({
      "docs/plan.md": `${SECRET_TERM}\n`,
      "docs/tasks.md": `${SECRET_TERM}\n`,
      "docs/superpowers/plans/x.md": `${SECRET_TERM}\n`,
      "docs/estado-2026-01-01.md": `${SECRET_TERM}\n`,
      "docs/guide/plan.md": `${SECRET_TERM}\n`, // same basename, not excluded
    });
    const r = check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: SECRET_TERM });
    expect(r.code).toBe(1);
    expect(r.out).toContain("docs/guide/plan.md:1:");
    expect(r.out).not.toMatch(/^docs\/(plan|tasks|superpowers|estado)/m);
  });

  test("binary_files_are_skipped", () => {
    const dir = fixtureRepo({ "img.bin": `\0${SECRET_TERM}\0` });
    expect(check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: SECRET_TERM }).code).toBe(0);
  });

  test("an_invalid_entry_is_a_config_error_named_by_line_not_content", () => {
    const dir = fixtureRepo({ "README.md": "x\n" });
    const r = check(dir, { MNEMOSYNE_PRIVACY_DENYLIST: "fine\nbro(ken\n" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("denylist line 2 is not a valid regular expression");
    expect(r.out).not.toContain("bro(ken");
  });

  test("this_repository_ignores_the_local_denylist_file", () => {
    const r = spawnSync("git", ["check-ignore", "-q", ".privacy-denylist.local"], { cwd: repo });
    expect(r.status).toBe(0);
  });
});
