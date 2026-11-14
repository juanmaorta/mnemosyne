// src/cli.help.test.ts
//
// MNE-106: `--help` once created a store at `./--help/personal/facts/`. The
// migration CLI read any second argument as the destination root and created
// its scope directories before anything else, and `--root=--help` reached the
// store the same way through `mneme`. Asking for help must never write: every
// subcommand answers `--help`/`-h` with its usage and exit 0, and a path option
// handed something that looks like a flag is refused before any directory
// exists. Each run is a real child process in a throwaway HOME, cwd and
// MNEMOSYNE_ROOT, and the assertion is on what appeared on disk.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { COMMAND_USAGE } from "./cli.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built once by the `globalSetup` in vitest.config.ts, before any test file runs.
const mneme = join(repoRoot, "dist", "bin", "mneme.js");
const migrate = join(repoRoot, "dist", "bin", "migrate.js");

interface Run { code: number | string; stdout: string; stderr: string; created: string[] }

/** Every path under `dir`, relative to it. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((p) => String(p)).sort();
}

/**
 * Run `bin args` in a sandbox of its own and report what it left on disk. HOME,
 * cwd, MNEMOSYNE_ROOT and CODEX_HOME all live under one empty directory, so
 * anything the run writes — wherever a bad path sends it — shows up in `created`.
 */
function sandboxed(bin: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const box = mkdtempSync(join(tmpdir(), "mneme-help-"));
  const home = join(box, "home");
  const cwd = join(box, "cwd");
  mkdirSync(home); mkdirSync(cwd);
  return new Promise((done) => {
    execFile(process.execPath, [bin, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        MNEMOSYNE_ROOT: join(box, "root"),
        CODEX_HOME: join(box, "codex"),
        MNEMOSYNE_EMBEDDER: "none",
        OLLAMA_HOST: "http://127.0.0.1:1", // never a real Ollama
        ...env,
      },
      timeout: 20_000,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : String(error.code ?? error.signal);
      const created = tree(box).filter((p) => p !== "home" && p !== "cwd");
      done({ code, stdout, stderr, created });
    });
  });
}

const COMMANDS = Object.keys(COMMAND_USAGE);

describe("mneme <command> --help (MNE-106)", () => {
  test("every_command_the_dispatcher_knows_has_a_usage", () => {
    // The unknown-command message lists the commands; each must answer --help.
    expect(COMMANDS.length).toBeGreaterThan(15);
    for (const c of ["context", "search", "add", "update", "init", "import-claude", "consolidate", "compliance-lint", "upgrade"]) {
      expect(COMMANDS).toContain(c);
    }
  });

  test.each(COMMANDS.flatMap((c) => [[c, "--help"], [c, "-h"]]))("%s %s prints usage, exits 0 and writes nothing", async (command, flag) => {
    const r = await sandboxed(mneme, [command, flag]);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`usage: mneme ${command}`);
  });

  test("help_after_other_flags_still_wins_and_writes_nothing", async () => {
    const r = await sandboxed(mneme, ["add", "--type", "feedback", "some content", "--help"]);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: mneme add");
  });

  test("a_help_flag_after_double_dash_is_content_not_a_request_for_help", async () => {
    // `--` ends the options: what follows is a body, exactly as a bulleted list is.
    const r = await sandboxed(mneme, ["scan", "--", "--help"]);
    expect(r.stdout).not.toContain("usage:");
  });

  test.each([["--help"], ["-h"], ["help"]])("mneme %s lists the commands and exits 0", async (flag) => {
    const r = await sandboxed(mneme, [flag]);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: mneme <command>");
    expect(r.stdout).toContain("import-claude");
  });

  test("help_followed_by_a_command_prints_that_commands_usage", async () => {
    const r = await sandboxed(mneme, ["help", "init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: mneme init");
  });
});

describe("a path option given a flag-looking value is refused (MNE-106)", () => {
  test.each([
    [["add", "--type", "feedback", "body", "--root=--help"], "--root"],
    [["add", "--type", "feedback", "body", "--root", "--help"], "--root"],
    [["add", "--type", "feedback", "body", "--cwd=-h"], "--cwd"],
    [["add", "--type", "feedback", "--file=--help"], "--file"],
    [["init", "--write", "--root=--help"], "--root"],
    [["import-claude", "--source=--help", "--source-id", "x", "--scope", "personal"], "--source"],
    [["context", "--cwd=--help"], "--cwd"],
  ])("%j", async (args, option) => {
    const r = await sandboxed(mneme, args);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${option} expects a path`);
  });

  test("compliance_lint_keeps_its_error_exit_code", async () => {
    const r = await sandboxed(mneme, ["compliance-lint", "--config=--help"]);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config expects a path");
  });

  test("a_flag_looking_MNEMOSYNE_ROOT_is_refused_too", async () => {
    const r = await sandboxed(mneme, ["add", "--type", "feedback", "body", "--scope", "personal"], { MNEMOSYNE_ROOT: "--help" });
    expect(r.created).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MNEMOSYNE_ROOT");
  });
});

describe("migrate --help (MNE-106)", () => {
  test.each([[["--help"]], [["-h"]], [["some-source", "--help"]], [["some-source", "-h"]], [["some-source", "dest", "--help"]]])("migrate %j prints usage, exits 0 and writes nothing", async (args) => {
    const r = await sandboxed(migrate, args);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: migrate");
  });

  test("a_flag_looking_destination_is_refused_before_any_directory_exists", async () => {
    const r = await sandboxed(migrate, ["some-source", "--root"]);
    expect(r.created).toEqual([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: migrate");
  });
});
