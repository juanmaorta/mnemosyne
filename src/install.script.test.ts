// src/install.script.test.ts
//
// MNE-97: `install.sh` — the one-step installer, its update and its uninstall.
// Every run gets a throwaway HOME and a scrubbed environment: these tests must
// never read or write the real `~/.claude`, `~/memory` or shell files. They run
// the script from this checkout in place with `--no-build` (the suite's
// globalSetup already built `dist`), so no clone, no `npm ci`, no network.
// `detached: true` puts the script in a new session with no controlling
// terminal, so it can never stop to prompt — exactly like `curl … | sh` in CI.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { describe, expect, test, vi } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "install.sh");

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mneme-install-home-"));
}

/**
 * Run a command in a NEW SESSION (`detached` → setsid), so it has no
 * controlling terminal and `/dev/tty` cannot be opened: a prompt is impossible
 * even when the suite runs from an interactive shell. `spawnSync` has no such
 * option, hence the async spawn.
 */
function spawnDetached(cmd: string, args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; out: string; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`timed out:\n${stdout}${stderr}`)); }, 60_000);
    child.on("error", fail);
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? -1, out: `${stdout}${stderr}`, stdout }); });
    child.stdin.end(input ?? "");
  });
}

/**
 * This machine's PATH as one directory of symlinks, minus `exclude`. Agents are
 * always left out (MNE-113: the installer wires whichever of claude, codex and
 * opencode it finds, so a test decides which ones "exist").
 */
function pathExcluding(exclude: string[]): string {
  const bin = mkdtempSync(join(tmpdir(), "mneme-path-"));
  const skip = new Set([...exclude, ...AGENTS]);
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (skip.has(name) || existsSync(join(bin, name))) continue;
      try { symlinkSync(join(dir, name), join(bin, name)); } catch { /* unreadable entry */ }
    }
  }
  return bin;
}
const AGENTS = ["claude", "codex", "opencode"];
const AGENTLESS_PATH = pathExcluding([]);

/** AGENTLESS_PATH plus do-nothing stand-ins for the named agents. */
function withAgents(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-agents-"));
  for (const n of names) {
    writeFileSync(join(dir, n), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, n), 0o755);
  }
  return `${dir}:${AGENTLESS_PATH}`;
}

function baseEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: AGENTLESS_PATH,
    // Never a real Ollama, whatever this machine runs.
    OLLAMA_HOST: "http://127.0.0.1:1",
  };
}

function run(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnDetached("sh", [script, ...args], { ...baseEnv(home), ...extraEnv });
}

const install = (home: string, ...more: string[]) => run(home, ["install", "--yes", "--no-build", "--no-ollama-pull", ...more]);

function listTree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

function sessionStartCommands(home: string): string[] {
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  return (settings.hooks?.SessionStart ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
}

/**
 * A throwaway "Mnemosyne" repo for the clone and release-channel paths (MNE-111):
 * this checkout's install.sh and the CLAUDE.md block source, plus a stub
 * `dist/bin/mneme.js` that only logs its arguments, so `--no-build` installs
 * work without npm or the network. Each step is one commit, tagged if asked.
 */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixtureCommit(dir: string, step: { tag?: string; version?: string }): void {
  const version = step.version ?? step.tag?.replace(/^v/, "") ?? "0.0.0-dev";
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "mnemosyne", version }, null, 2)}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", `step ${version}`);
  if (step.tag) git(dir, "tag", step.tag);
}

function fixtureRepo(steps: { tag?: string; version?: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-fixture-repo-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "install.sh"), readFileSync(script, "utf8"));
  mkdirSync(join(dir, "docs", "integrations"), { recursive: true });
  writeFileSync(join(dir, "docs", "integrations", "memory-instructions.md"), readFileSync(join(repo, "docs", "integrations", "memory-instructions.md"), "utf8"));
  mkdirSync(join(dir, "dist", "bin"), { recursive: true });
  writeFileSync(join(dir, "dist", "bin", "mneme.js"), "const { appendFileSync } = require('node:fs');\nappendFileSync(process.env.HOME + '/mneme-calls.log', process.argv.slice(2).join(' ') + '\\n');\n");
  writeFileSync(join(dir, ".gitignore"), ".mnemosyne-installer\n.update-check.json\n");
  for (const step of steps) fixtureCommit(dir, step);
  return dir;
}

const pipedInstall = (home: string, repoUrl: string, args: string[], extraEnv: Record<string, string> = {}) =>
  spawnDetached("sh", ["-s", "--", ...args], { ...baseEnv(home), MNEMOSYNE_REPO_URL: repoUrl, ...extraEnv }, readFileSync(script, "utf8"));

const installedVersion = (home: string) => JSON.parse(readFileSync(join(home, ".mnemosyne", "package.json"), "utf8")).version as string;

// Each case spawns the script (and `mneme`) a few times.
vi.setConfig({ testTimeout: 60_000 });

describe("install.sh --dry-run", () => {
  test("explains_every_change_and_writes_nothing", async () => {
    const home = freshHome();
    const r = await run(home, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(listTree(home)).toEqual([]);
    expect(r.out).toContain(join(home, ".claude", "settings.json"));
    expect(r.out).toContain(join(home, ".claude", "CLAUDE.md"));
    expect(r.out).toContain(join(home, "memory"));
    expect(r.out).toContain(join(home, ".local", "bin", "mneme"));
    expect(r.out).toMatch(/mneme context --root/);
    expect(r.out).toMatch(/dry run/i);
  });

  test("piped_through_sh_plans_a_clone_into_the_install_dir", async () => {
    // `curl … | sh` has no script path: the code must come from a clone.
    const home = freshHome();
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const r = await spawnDetached("sh", ["-s", "--", "--dry-run"], { ...baseEnv(home), MNEMOSYNE_REPO_URL: repoUrl }, readFileSync(script, "utf8"));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/git clone/);
    expect(r.stdout).toContain(join(home, ".mnemosyne"));
    expect(listTree(home)).toEqual([]);
  });

  test("an_old_node_is_reported_with_the_command_that_fixes_it", async () => {
    const home = freshHome();
    const fakeBin = mkdtempSync(join(tmpdir(), "mneme-fake-bin-"));
    writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 18.19.0\n");
    chmodSync(join(fakeBin, "node"), 0o755);
    const r = await run(home, ["--dry-run"], { PATH: `${fakeBin}:${AGENTLESS_PATH}` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Node\.js.*18\.19\.0/);
    expect(r.out).toMatch(/>= ?20/);
    expect(r.out).toMatch(/nvm install|brew install node|nodejs\.org/);
    expect(listTree(home)).toEqual([]);
  });

  test("on_macos_the_node_fix_is_the_nodejs_org_installer_not_a_keg_only_formula", async () => {
    // MNE-102 F6: `brew install node@22` is keg-only — it does not put `node` on
    // the PATH — and a clean Mac has no Homebrew at all.
    const home = freshHome();
    const fakeBin = mkdtempSync(join(tmpdir(), "mneme-fake-bin-"));
    writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 18.19.0\n");
    writeFileSync(join(fakeBin, "uname"), "#!/bin/sh\necho Darwin\n");
    chmodSync(join(fakeBin, "node"), 0o755);
    chmodSync(join(fakeBin, "uname"), 0o755);
    const r = await run(home, ["--dry-run"], { PATH: `${fakeBin}:${AGENTLESS_PATH}` });
    const fixLine = r.out.split("\n").find((l) => /fix:/.test(l) && /node/i.test(l)) ?? "";
    expect(fixLine).toMatch(/nodejs\.org/);
    expect(fixLine).not.toMatch(/node@/);
  });

  test.each([["--root"], ["--dir"], ["--bin-dir"]])("%s_refuses_a_value_that_looks_like_a_flag", async (option) => {
    // MNE-106: `--root --help` used to install a store at `./--help`.
    const home = freshHome();
    const r = await run(home, ["--dry-run", option, "--help"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain(`${option} expects a directory`);
    expect(listTree(home)).toEqual([]);
  });

  test("without_ollama_it_explains_tier_0_and_what_is_lost", async () => {
    const home = freshHome();
    const r = await run(home, ["--dry-run"]);
    // OLLAMA_HOST is unreachable in every test, so Ollama is never usable here.
    expect(r.out).toMatch(/tier 0/i);
    expect(r.out).toMatch(/ollama pull nomic-embed-text-v2-moe/);
  });
});

describe("install.sh install / update / uninstall", () => {
  test("refuses_to_proceed_without_a_terminal_or_yes", async () => {
    const home = freshHome();
    const r = await run(home, ["install", "--no-build", "--no-ollama-pull"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--yes/);
    expect(listTree(home)).toEqual([]);
  });

  test("install_wires_the_hook_the_commands_the_store_and_the_CLAUDE_md_block", async () => {
    const home = freshHome();
    const r = await install(home);
    expect(r.code, r.out).toBe(0);
    expect(sessionStartCommands(home)).toEqual([`mneme context --root '${join(home, "memory")}'`]);
    for (const name of ["mneme", "mem"]) {
      const bin = join(home, ".local", "bin", name);
      expect(lstatSync(bin).isFile()).toBe(true);
      const v = spawnSync(bin, ["scan", "hello"], { encoding: "utf8", env: { HOME: home, PATH: AGENTLESS_PATH } });
      expect(v.status, v.stderr).toBe(0);
    }
    const cfg = JSON.parse(readFileSync(join(home, "memory", ".config.json"), "utf8"));
    expect(cfg.embedder).toBe("none");
    expect(readFileSync(join(home, "memory", ".scopemap"), "utf8")).toMatch(/^~\s*=\s*personal\s*$/m);
    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd.match(/<!-- mnemosyne:begin/g)).toHaveLength(1);
    expect(claudeMd).toContain("mneme search");
  });

  test("update_is_idempotent_and_preserves_config_hook_scopemap_and_data", async () => {
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    // Things the user owns after installing.
    writeFileSync(join(home, "memory", ".config.json"), `${JSON.stringify({ embedder: "none", model: "nomic-embed-text-v2-moe", lexicalFloor: 12 }, null, 2)}\n`);
    writeFileSync(join(home, "memory", ".scopemap"), "~/work = work\n~ = personal\n");
    mkdirSync(join(home, "memory", "personal"), { recursive: true });
    writeFileSync(join(home, "memory", "personal", "note.md"), "my note\n");
    const snapshot = () => ["memory/.config.json", "memory/.scopemap", "memory/personal/note.md", ".claude/settings.json", ".claude/CLAUDE.md"]
      .map((p) => readFileSync(join(home, p), "utf8"));
    const before = snapshot();
    for (let i = 0; i < 2; i++) {
      const r = await run(home, ["update", "--yes", "--no-build"]);
      expect(r.code, r.out).toBe(0);
    }
    expect(snapshot()).toEqual(before);
  });

  test("an_existing_CLAUDE_md_survives_install_and_uninstall_byte_for_byte", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = "# My rules\n\nBe brief.\n";
    writeFileSync(join(home, ".claude", "CLAUDE.md"), original);
    expect((await install(home)).code).toBe(0);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("Be brief.");
    expect((await run(home, ["uninstall", "--yes"])).code).toBe(0);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(original);
  });

  test("a_CLAUDE_md_that_already_talks_about_mneme_is_left_alone", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = "Use `mneme search` for memory.\n";
    writeFileSync(join(home, ".claude", "CLAUDE.md"), original);
    const r = await install(home);
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(original);
    expect(r.out).toMatch(/already mentions mneme/i);
  });

  test("uninstall_keeps_the_data_by_default_and_removes_the_rest", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ model: "opus" })}\n`);
    expect((await install(home)).code).toBe(0);
    mkdirSync(join(home, "memory", "personal"), { recursive: true });
    writeFileSync(join(home, "memory", "personal", "note.md"), "my note\n");
    const r = await run(home, ["uninstall", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({ model: "opus" });
    expect(existsSync(join(home, ".local", "bin", "mneme"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "mem"))).toBe(false);
    expect(readFileSync(join(home, "memory", "personal", "note.md"), "utf8")).toBe("my note\n");
    expect(r.out).toMatch(/kept/i);
    // The in-place checkout is the user's, never the installer's to delete.
    expect(existsSync(join(repo, "package.json"))).toBe(true);
  });

  test("uninstall_with_delete_data_removes_the_store", async () => {
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    mkdirSync(join(home, "memory", "personal"), { recursive: true });
    writeFileSync(join(home, "memory", "personal", "note.md"), "my note\n");
    const r = await run(home, ["uninstall", "--yes", "--delete-data"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, "memory"))).toBe(false);
  });

  test("uninstall_dry_run_changes_nothing", async () => {
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    const before = listTree(home).map((p) => [p, lstatSync(join(home, p)).isFile() ? readFileSync(join(home, p), "utf8") : ""]);
    const r = await run(home, ["uninstall", "--dry-run", "--delete-data"]);
    expect(r.code).toBe(0);
    expect(listTree(home).map((p) => [p, lstatSync(join(home, p)).isFile() ? readFileSync(join(home, p), "utf8") : ""])).toEqual(before);
  });

  // Codex review: a stand-in Ollama that serves the installer's default model.
  async function fakeOllama(): Promise<{ url: string; server: Server }> {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "nomic-embed-text-v2-moe:latest" }, { name: "bge-m3:latest" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server };
  }

  test("a_fresh_install_with_ollama_serving_the_model_persists_it", async () => {
    const home = freshHome();
    const { url, server } = await fakeOllama();
    try {
      const r = await run(home, ["install", "--yes", "--no-build"], { OLLAMA_HOST: url });
      expect(r.code, r.out).toBe(0);
      expect(JSON.parse(readFileSync(join(home, "memory", ".config.json"), "utf8"))).toMatchObject({ embedder: "ollama", model: "nomic-embed-text-v2-moe" });
    } finally { server.close(); }
  });

  test("update_never_replaces_the_model_a_store_already_uses", async () => {
    // Overwriting it would leave an embedded index that mneme refuses to use.
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    const cfg = `${JSON.stringify({ embedder: "ollama", model: "bge-m3" }, null, 2)}\n`;
    writeFileSync(join(home, "memory", ".config.json"), cfg);
    const { url, server } = await fakeOllama();
    try {
      const r = await run(home, ["update", "--yes", "--no-build"], { OLLAMA_HOST: url });
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toMatch(/ollama pull/);
    } finally { server.close(); }
    expect(readFileSync(join(home, "memory", ".config.json"), "utf8")).toBe(cfg);
  });

  test("a_custom_root_reaches_ordinary_commands_not_only_the_hook", async () => {
    const home = freshHome();
    const custom = join(home, "custom-store");
    expect((await install(home, "--root", custom)).code).toBe(0);
    const v = spawnSync(join(home, ".local", "bin", "mneme"), ["reindex"], { encoding: "utf8", env: { HOME: home, PATH: AGENTLESS_PATH, MNEMOSYNE_EMBEDDER: "none" } });
    expect(v.status, v.stderr).toBe(0);
    expect(existsSync(join(custom, ".index"))).toBe(true);
    expect(existsSync(join(home, "memory"))).toBe(false);
  });

  // ------------------------------------------- MNE-102 smoke-test findings ---

  test("done_repeats_the_PATH_note_when_the_commands_are_not_on_this_terminals_PATH", async () => {
    // Ubuntu's ~/.profile adds ~/.local/bin only if it existed at login, so the
    // "Try: mneme add …" right after a first install failed with "not found".
    const home = freshHome();
    const r = await install(home);
    expect(r.code, r.out).toBe(0);
    const done = r.out.slice(r.out.indexOf("== Done"));
    expect(done).toMatch(/not on this terminal's PATH/);
    expect(done).toContain(`export PATH="${join(home, ".local", "bin")}:$PATH"`);
  });

  test("done_has_no_PATH_note_when_the_commands_are_already_on_it", async () => {
    const home = freshHome();
    const r = await install(home, ...[]).then(() => run(home, ["update", "--yes", "--no-build"],
      { PATH: `${join(home, ".local", "bin")}:${AGENTLESS_PATH}` }));
    expect(r.code, r.out).toBe(0);
    expect(r.out.slice(r.out.indexOf("== Done"))).not.toMatch(/PATH/);
  });

  test("uninstall_removes_the_hook_even_when_node_is_not_usable_from_PATH", async () => {
    // A shell without nvm loaded: the wrappers were deleted but the hook stayed,
    // so every Claude Code session started with "mneme: command not found".
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    const fake = join(home, "fakebin");
    mkdirSync(fake);
    writeFileSync(join(fake, "node"), "#!/bin/sh\necho 'node: not this one' >&2\nexit 127\n");
    chmodSync(join(fake, "node"), 0o755);
    const r = await run(home, ["uninstall", "--yes"], { PATH: `${fake}:${AGENTLESS_PATH}` });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/remove the 'mneme context' SessionStart hook from it by hand/);
    expect(existsSync(join(home, ".local", "bin", "mneme"))).toBe(false);
    // settings.json was created by the install, so it goes with the hook.
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("uninstall_deletes_a_settings_json_it_created_but_keeps_one_the_user_had", async () => {
    const created = freshHome();
    expect((await install(created)).code).toBe(0);
    expect((await run(created, ["uninstall", "--yes"])).code).toBe(0);
    expect(existsSync(join(created, ".claude", "settings.json"))).toBe(false);

    const had = freshHome();
    mkdirSync(join(had, ".claude"), { recursive: true });
    writeFileSync(join(had, ".claude", "settings.json"), "{}\n");
    expect((await install(had)).code).toBe(0);
    expect((await run(had, ["uninstall", "--yes"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(had, ".claude", "settings.json"), "utf8"))).toEqual({});
  });

  /** A PATH that has everything this machine has EXCEPT git. */
  function pathWithoutGit(_home: string): string {
    return pathExcluding(["git"]);
  }

  test("an_empty_settings_json_the_user_had_survives_an_uninstall_that_removed_no_hook", async () => {
    // No backup (e.g. an install older than backups, or a deleted one) and no hook to remove:
    // the "{}" is the user's, not something this uninstall emptied.
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    const r = await run(home, ["uninstall", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
  });

  test("without_git_an_update_plan_has_no_blanks_either", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".mnemosyne", ".git"), { recursive: true });
    const r = await pipedInstall(home, "https://example.invalid/repo.git", ["update", "--dry-run"], { PATH: pathWithoutGit(home) });
    expect(r.out).toMatch(/\[MISSING\] git/);
    expect(r.out).not.toMatch(/tip of ''/);
    expect(r.out).not.toMatch(/\(\)/);
    expect(r.out).toMatch(/resolved once git is installed/);
  });

  test("without_git_the_plan_says_the_release_is_resolved_later_instead_of_blanks", async () => {
    const home = freshHome();
    const r = await pipedInstall(home, "https://example.invalid/repo.git", ["install", "--dry-run"], { PATH: pathWithoutGit(home) });
    expect(r.out).toMatch(/\[MISSING\] git/);
    expect(r.out).not.toMatch(/--branch  /);
    expect(r.out).not.toMatch(/\(\)/);
    expect(r.out).toMatch(/latest release \(resolved once git is installed\)/);
  });
});

describe("install.sh agents (MNE-113)", () => {
  const BEGIN = "<!-- mnemosyne:begin";
  const read = (p: string) => readFileSync(p, "utf8");
  const codexHooks = (home: string) => join(home, ".codex", "hooks.json");
  const codexMd = (home: string) => join(home, ".codex", "AGENTS.md");
  const opencodeMd = (home: string) => join(home, ".config", "opencode", "AGENTS.md");
  const claudeMd = (home: string) => join(home, ".claude", "CLAUDE.md");
  const settings = (home: string) => join(home, ".claude", "settings.json");
  const installWith = (home: string, agents: string[], more: string[] = [], env: Record<string, string> = {}) =>
    run(home, ["install", "--yes", "--no-build", "--no-ollama-pull", ...more], { PATH: withAgents(...agents), ...env });

  /** The installer's questions answered as if typed, one line each. */
  function tty(...answers: string[]): string {
    const f = join(mkdtempSync(join(tmpdir(), "mneme-tty-")), "tty");
    writeFileSync(f, answers.map((a) => `${a}\n`).join(""));
    return f;
  }

  test("the_plan_lists_every_agent_found_and_writes_nothing", async () => {
    const home = freshHome();
    const r = await run(home, ["--dry-run"], { PATH: withAgents("claude", "codex", "opencode") });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Claude Code \(claude\)/);
    expect(r.out).toMatch(/Codex CLI \(codex\)/);
    expect(r.out).toMatch(/OpenCode \(opencode\)/);
    expect(r.out).toContain(codexHooks(home));
    expect(listTree(home)).toEqual([]);
  });

  test("codex_alone_gets_its_hook_and_block_and_claude_is_left_alone", async () => {
    const home = freshHome();
    const r = await installWith(home, ["codex"]);
    expect(r.code, r.out).toBe(0);
    expect(read(codexHooks(home))).toMatch(/mneme context --emit codex-session-start/);
    expect(read(codexMd(home))).toContain(BEGIN);
    expect(existsSync(settings(home))).toBe(false);
    expect(existsSync(claudeMd(home))).toBe(false);
    expect(r.out).toMatch(/\/hooks/);
  });

  test("codex_reads_a_non_empty_override_instead_so_the_block_goes_there", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "AGENTS.override.md"), "# my rules\n");
    expect((await installWith(home, ["codex"])).code).toBe(0);
    expect(read(join(home, ".codex", "AGENTS.override.md"))).toMatch(/^# my rules\n[\s\S]*<!-- mnemosyne:begin/);
    expect(existsSync(codexMd(home))).toBe(false);
  });

  test("codex_follows_CODEX_HOME", async () => {
    const home = freshHome();
    const codexHome = join(home, "elsewhere");
    expect((await installWith(home, ["codex"], [], { CODEX_HOME: codexHome })).code).toBe(0);
    expect(read(join(codexHome, "hooks.json"))).toMatch(/mneme context/);
    expect(read(join(codexHome, "AGENTS.md"))).toContain(BEGIN);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  test("codex_hook_reads_the_store_this_install_uses", async () => {
    const home = freshHome();
    const custom = join(home, "custom-store");
    mkdirSync(join(home, ".codex"));
    writeFileSync(codexHooks(home), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context --emit codex-session-start --root '/old-memory'" }] }] } }));
    expect((await installWith(home, ["codex"], ["--root", custom])).code).toBe(0);
    expect(read(codexHooks(home))).toContain(`--root '${custom}'`);
    expect(read(codexHooks(home))).not.toContain("/old-memory");
  });

  test("opencode_alone_gets_its_own_AGENTS_md", async () => {
    const home = freshHome();
    const r = await installWith(home, ["opencode"]);
    expect(r.code, r.out).toBe(0);
    expect(read(opencodeMd(home))).toContain(BEGIN);
    expect(existsSync(settings(home))).toBe(false);
  });

  test("opencode_with_claude_reads_the_block_from_CLAUDE_md_and_gets_no_AGENTS_md", async () => {
    // OpenCode falls back to ~/.claude/CLAUDE.md only while it has no global
    // AGENTS.md: creating one would cut everything else in CLAUDE.md off.
    const home = freshHome();
    const r = await installWith(home, ["claude", "opencode"]);
    expect(r.code, r.out).toBe(0);
    expect(read(claudeMd(home))).toContain(BEGIN);
    expect(existsSync(opencodeMd(home))).toBe(false);
    expect(r.out).toMatch(/OpenCode.*CLAUDE\.md/);
  });

  test("opencode_with_its_claude_compatibility_off_gets_its_own_AGENTS_md", async () => {
    const home = freshHome();
    expect((await installWith(home, ["claude", "opencode"], [], { OPENCODE_DISABLE_CLAUDE_CODE: "1" })).code).toBe(0);
    expect(read(opencodeMd(home))).toContain(BEGIN);
  });

  test("an_AGENTS_md_opencode_already_has_gets_the_block", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeMd(home), "# mine\n");
    expect((await installWith(home, ["claude", "opencode"])).code).toBe(0);
    expect(read(opencodeMd(home))).toMatch(/^# mine\n[\s\S]*<!-- mnemosyne:begin/);
  });

  test("opencode_is_not_given_an_AGENTS_md_that_would_hide_the_users_CLAUDE_md", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"));
    writeFileSync(claudeMd(home), "# my claude rules\n");
    const r = await installWith(home, ["claude", "opencode"], ["--no-claude"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(opencodeMd(home))).toBe(false);
    expect(read(claudeMd(home))).toBe("# my claude rules\n");
    expect(r.out).toMatch(/memory-instructions\.md/);
  });

  test("with_no_agent_found_it_wires_claude_code_and_names_all_three", async () => {
    const home = freshHome();
    const r = await installWith(home, []);
    expect(r.code, r.out).toBe(0);
    expect(sessionStartCommands(home).some((c) => c.includes("mneme context"))).toBe(true);
    expect(r.out).toMatch(/Claude Code[\s\S]*Codex[\s\S]*OpenCode/);
  });

  test("no_codex_and_no_claude_flags_skip_those_agents", async () => {
    const home = freshHome();
    const r = await installWith(home, ["claude", "codex", "opencode"], ["--no-codex", "--no-claude"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(settings(home))).toBe(false);
    expect(read(opencodeMd(home))).toContain(BEGIN);
  });

  test("uninstall_removes_every_agents_wiring_and_keeps_what_the_user_wrote", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeMd(home), "# mine\n");
    expect((await installWith(home, ["claude", "codex", "opencode"])).code).toBe(0);
    // Uninstall finds the wiring by its markers, whatever is on the PATH now.
    const r = await run(home, ["uninstall", "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(codexHooks(home))).toBe(false);
    expect(existsSync(codexMd(home))).toBe(false);
    expect(read(opencodeMd(home))).toBe("# mine\n");
    expect(existsSync(settings(home))).toBe(false);
  });

  test("update_refreshes_the_agents_already_wired_and_only_mentions_new_ones", async () => {
    const home = freshHome();
    expect((await installWith(home, ["codex"])).code).toBe(0);
    writeFileSync(codexMd(home), read(codexMd(home)).replace("mneme search", "mneme STALE"));
    const r = await run(home, ["update", "--yes", "--no-build"], { PATH: withAgents("claude", "codex") });
    expect(r.code, r.out).toBe(0);
    expect(read(codexMd(home))).not.toMatch(/mneme STALE/);
    expect(existsSync(settings(home))).toBe(false);
    expect(r.out).toMatch(/Claude Code.*not wired/);
  });

  test("asked_with_a_terminal_each_agent_can_be_declined", async () => {
    const home = freshHome();
    // codex? no — opencode? yes — Go ahead? yes
    const r = await run(home, ["install", "--no-build", "--no-ollama-pull"], { PATH: withAgents("codex", "opencode"), MNEMOSYNE_INSTALL_TTY: tty("n", "y", "y") });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(read(opencodeMd(home))).toContain(BEGIN);
  });

  async function ollamaWithoutTheModel(): Promise<{ url: string; server: Server }> {
    const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ models: [] })); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server };
  }

  /** A PATH with a stand-in `ollama` that logs its arguments to $HOME/ollama-calls.log. */
  function withOllama(): string {
    const p = withAgents("claude");
    const dir = p.slice(0, p.indexOf(":"));
    writeFileSync(join(dir, "ollama"), '#!/bin/sh\necho "$*" >> "$HOME/ollama-calls.log"\n');
    chmodSync(join(dir, "ollama"), 0o755);
    return p;
  }

  test("asked_with_a_terminal_the_model_download_can_be_declined", async () => {
    const home = freshHome();
    const { url, server } = await ollamaWithoutTheModel();
    try {
      // claude? yes — download the model? no — Go ahead? yes
      const r = await run(home, ["install", "--no-build"], { PATH: withOllama(), OLLAMA_HOST: url, MNEMOSYNE_INSTALL_TTY: tty("y", "n", "y") });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/960 MB/);
      expect(existsSync(join(home, "ollama-calls.log"))).toBe(false);
    } finally { server.close(); }
  });

  test("with_yes_the_model_is_downloaded_without_asking", async () => {
    const home = freshHome();
    const { url, server } = await ollamaWithoutTheModel();
    try {
      const r = await run(home, ["install", "--yes", "--no-build"], { PATH: withOllama(), OLLAMA_HOST: url });
      expect(r.code, r.out).toBe(0);
      expect(read(join(home, "ollama-calls.log"))).toMatch(/pull nomic-embed-text-v2-moe/);
    } finally { server.close(); }
  });
});

describe("install.sh build (MNE-102)", () => {
  // A fake `npm` stands in for `npm ci` / `npm run build`: what is under test is
  // the check that runs after them, not npm.
  function fakeNpm(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mneme-fake-npm-"));
    writeFileSync(join(dir, "npm"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "npm"), 0o755);
    return `${dir}:${AGENTLESS_PATH}`;
  }

  test("package_json_lets_npm_run_the_better_sqlite3_install_script", () => {
    // F7: npm 12 blocks dependency install scripts unless allowScripts covers
    // them, and without its script better-sqlite3 has no native binary.
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.allowScripts?.["better-sqlite3"]).toBe(true);
  });

  test("a_native_module_that_does_not_load_stops_the_install_with_a_fix", async () => {
    // npm ci "succeeds" but leaves no better-sqlite3 binary (blocked script).
    const home = freshHome();
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const r = await pipedInstall(home, repoUrl, ["--yes", "--no-ollama-pull"], { PATH: fakeNpm("exit 0") });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/better-sqlite3/);
    expect(r.out).toMatch(/xcode-select --install|build-essential/);
    expect(existsSync(join(home, ".local", "bin", "mneme"))).toBe(false);
  });

  test("a_missing_native_binary_is_fetched_once_and_the_install_finishes", async () => {
    // npm 12 skipped the script (no binary); running its install step by hand —
    // prebuild-install, via npx — supplies it, whatever npm's policy.
    const home = freshHome();
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const broken = 'if [ "$1" = ci ]; then mkdir -p node_modules/better-sqlite3 && echo "throw new Error(\\"no binding\\");" > node_modules/better-sqlite3/index.js; fi; exit 0';
    const path = fakeNpm(broken);
    const npxDir = path.slice(0, path.indexOf(":"));
    writeFileSync(join(npxDir, "npx"), '#!/bin/sh\necho "$*" >> "$HOME/npx-calls.log"\necho "module.exports = class { close() {} };" > index.js\n');
    chmodSync(join(npxDir, "npx"), 0o755);
    const r = await pipedInstall(home, repoUrl, ["--yes", "--no-ollama-pull"], { PATH: path });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(home, "npx-calls.log"), "utf8")).toMatch(/prebuild-install/);
    expect(existsSync(join(home, ".local", "bin", "mneme"))).toBe(true);
  });

  test("with_no_prebuilt_binary_it_compiles_with_npms_own_node_gyp", async () => {
    // Codex review: `npx --no node-gyp` fails on a clean machine (node-gyp is not
    // a dependency). npm ships one under `$(npm prefix -g)/lib/node_modules/npm`.
    const home = freshHome();
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const prefix = mkdtempSync(join(tmpdir(), "mneme-npm-prefix-"));
    const gypDir = join(prefix, "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin");
    mkdirSync(gypDir, { recursive: true });
    writeFileSync(join(gypDir, "node-gyp.js"), 'require("node:fs").appendFileSync(process.env.HOME + "/gyp-calls.log", process.argv.slice(2).join(" ") + "\\n");\nrequire("node:fs").writeFileSync("index.js", "module.exports = class { close() {} };");\n');
    const broken = `if [ "$1" = prefix ]; then echo '${prefix}'; exit 0; fi; if [ "$1" = ci ]; then mkdir -p node_modules/better-sqlite3 && echo "throw new Error(\\"no binding\\");" > node_modules/better-sqlite3/index.js; fi; exit 0`;
    const path = fakeNpm(broken);
    const npxDir = path.slice(0, path.indexOf(":"));
    writeFileSync(join(npxDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(npxDir, "npx"), 0o755);
    const r = await pipedInstall(home, repoUrl, ["--yes", "--no-ollama-pull"], { PATH: path });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(home, "gyp-calls.log"), "utf8")).toMatch(/rebuild --release/);
  });

  test("a_native_module_that_loads_lets_the_install_finish", async () => {
    const home = freshHome();
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const stub = 'if [ "$1" = ci ]; then mkdir -p node_modules/better-sqlite3 && echo "module.exports = class { prepare() { return { get: () => ({}) }; } close() {} };" > node_modules/better-sqlite3/index.js; fi; exit 0';
    const r = await pipedInstall(home, repoUrl, ["--yes", "--no-ollama-pull"], { PATH: fakeNpm(stub) });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "mneme"))).toBe(true);
  });
});

describe("install.sh upgrade hands over to the target's installer (MNE-114)", () => {
  /** Tag a release whose install.sh announces itself, as a newer installer would. */
  function releaseWithMarkedInstaller(repo: string, tag: string): void {
    const src = readFileSync(join(repo, "install.sh"), "utf8").replace("set -eu\n", 'set -eu\necho "HANDOFF-MARK $*"\n');
    writeFileSync(join(repo, "install.sh"), src);
    fixtureCommit(repo, { tag });
  }

  async function installedAt010(): Promise<{ home: string; repo: string; installer: string }> {
    const home = freshHome();
    const repo = fixtureRepo([{ tag: "v0.1.0" }]);
    expect((await pipedInstall(home, repo, ["--yes", "--no-build", "--no-ollama-pull"])).code).toBe(0);
    return { home, repo, installer: join(home, ".mnemosyne", "install.sh") };
  }

  test("upgrade_runs_the_new_versions_installer_with_the_same_arguments_once", async () => {
    const { home, repo, installer } = await installedAt010();
    releaseWithMarkedInstaller(repo, "v0.1.1");
    const r = await spawnDetached("sh", [installer, "upgrade", "--yes", "--no-build"], baseEnv(home));
    expect(r.code, r.out).toBe(0);
    expect(r.out.match(/HANDOFF-MARK/g)).toHaveLength(1);
    expect(r.out).toContain("HANDOFF-MARK upgrade --yes --no-build");
    expect(installedVersion(home)).toBe("0.1.1");
  });

  test("a_dry_run_shows_the_new_installers_plan_and_moves_nothing", async () => {
    const { home, repo, installer } = await installedAt010();
    releaseWithMarkedInstaller(repo, "v0.1.1");
    const r = await spawnDetached("sh", [installer, "upgrade", "--dry-run", "--no-build"], baseEnv(home));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("HANDOFF-MARK");
    expect(installedVersion(home)).toBe("0.1.0");
    expect(git(join(home, ".mnemosyne"), "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  test("an_install_in_a_custom_dir_is_upgraded_in_that_dir", async () => {
    // The old installer finds its clone from its own path; the copy it hands
    // over to lives in a temp file and has to be told.
    const home = freshHome();
    const repo = fixtureRepo([{ tag: "v0.1.0" }]);
    const dir = join(home, "elsewhere");
    expect((await pipedInstall(home, repo, ["--yes", "--no-build", "--no-ollama-pull", "--dir", dir])).code).toBe(0);
    releaseWithMarkedInstaller(repo, "v0.1.1");
    const r = await spawnDetached("sh", [join(dir, "install.sh"), "upgrade", "--yes", "--no-build"], baseEnv(home));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("HANDOFF-MARK");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.1.1");
    expect(existsSync(join(home, ".mnemosyne"))).toBe(false);
  });

  test("arguments_with_quotes_survive_the_handoff", async () => {
    const { home, repo, installer } = await installedAt010();
    releaseWithMarkedInstaller(repo, "v0.1.1");
    const root = join(home, "it's memory");
    const r = await spawnDetached("sh", [installer, "upgrade", "--dry-run", "--no-build", "--root", root], baseEnv(home));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`HANDOFF-MARK upgrade --dry-run --no-build --root ${root}`);
  });

  test("an_unreachable_repo_keeps_the_running_installer", async () => {
    const { home, installer } = await installedAt010();
    git(join(home, ".mnemosyne"), "remote", "set-url", "origin", join(home, "gone"));
    const r = await spawnDetached("sh", [installer, "upgrade", "--yes", "--no-build"], baseEnv(home));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/could not list the releases/);
    expect(installedVersion(home)).toBe("0.1.0");
  });

  test("it_is_called_upgrade_and_update_still_works", async () => {
    const { home, repo, installer } = await installedAt010();
    fixtureCommit(repo, { tag: "v0.1.1" });
    const up = await spawnDetached("sh", [installer, "upgrade", "--dry-run", "--no-build"], baseEnv(home));
    expect(up.code, up.out).toBe(0);
    expect(up.out).toMatch(/Mnemosyne — upgrade/);
    expect(up.out).toMatch(/What upgrade will change/);
    expect(up.out).not.toMatch(/update will change/);
    const old = await spawnDetached("sh", [installer, "update", "--yes", "--no-build"], baseEnv(home));
    expect(old.code, old.out).toBe(0);
    expect(installedVersion(home)).toBe("0.1.1");
  });
});

describe("install.sh release channel (MNE-111)", () => {
  test("installs_the_newest_semver_tag_ordered_numerically_ignoring_pre_releases_and_other_tags", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.2.0" }, { tag: "v0.10.0" }, { tag: "v0.9.0" }, { tag: "v0.11.0-rc.1" }, { tag: "nightly" }, { version: "0.12.0-dev" }]);
    const home = freshHome();
    const r = await pipedInstall(home, repoUrl, ["--dry-run"]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/git clone --branch v0\.10\.0 /);
    expect(r.stdout).toMatch(/latest release/);
    expect(listTree(home)).toEqual([]);
  });

  test("only_pre_releases_means_the_newest_pre_release", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0-rc.2" }, { tag: "v0.1.0-rc.10" }, { tag: "v0.0.9-beta" }]);
    const r = await pipedInstall(freshHome(), repoUrl, ["--dry-run"]);
    expect(r.stdout).toMatch(/git clone --branch v0\.1\.0-rc\.10 /);
    // Identifier by identifier, as semver says: beta.1 is newer than alpha.9, and a
    // longer list of equal identifiers is newer than its prefix.
    const ids = fixtureRepo([{ tag: "v1.0.0-alpha.9" }, { tag: "v1.0.0-beta.1" }, { tag: "v1.0.0-alpha" }, { tag: "v0.9.0-rc.1" }]);
    expect((await pipedInstall(freshHome(), ids, ["--dry-run"])).stdout).toMatch(/git clone --branch v1\.0\.0-beta\.1 /);
    const prefix = fixtureRepo([{ tag: "v1.0.0-rc" }, { tag: "v1.0.0-rc.1" }]);
    expect((await pipedInstall(freshHome(), prefix, ["--dry-run"])).stdout).toMatch(/git clone --branch v1\.0\.0-rc\.1 /);
  });

  test("no_tags_falls_back_to_main_and_says_so", async () => {
    const repoUrl = fixtureRepo([{ version: "0.1.0" }]);
    const r = await pipedInstall(freshHome(), repoUrl, ["--dry-run"]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/git clone --branch main /);
    expect(r.stdout).toMatch(/no release tags/i);
  });

  test("an_explicit_branch_is_the_development_channel", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    git(repoUrl, "branch", "dev");
    const r = await pipedInstall(freshHome(), repoUrl, ["--dry-run"], { MNEMOSYNE_BRANCH: "dev" });
    expect(r.stdout).toMatch(/git clone --branch dev /);
    expect(r.stdout).toMatch(/MNEMOSYNE_BRANCH/);
  });

  test("an_unreachable_repo_is_reported_in_the_plan_and_stops_a_real_install", async () => {
    const home = freshHome();
    const missing = join(home, "no-such-repo");
    const dry = await pipedInstall(home, missing, ["--dry-run"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.stdout).toMatch(/could not list the releases/);
    const real = await pipedInstall(home, missing, ["--yes", "--no-build", "--no-ollama-pull"]);
    expect(real.code).not.toBe(0);
    expect(existsSync(join(home, ".mnemosyne"))).toBe(false);
  });

  test("the_plan_mentions_the_daily_update_check_and_how_to_turn_it_off", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const r = await pipedInstall(freshHome(), repoUrl, ["--dry-run"]);
    expect(r.stdout).toMatch(/api\.github\.com/);
    expect(r.stdout).toMatch(/MNEMOSYNE_NO_UPDATE_CHECK=1/);
  });

  test("update_moves_from_v0_1_0_to_v0_2_0_never_to_unreleased_main_and_is_idempotent", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const home = freshHome();
    const first = await pipedInstall(home, repoUrl, ["--yes", "--no-build", "--no-ollama-pull"]);
    expect(first.code, first.out).toBe(0);
    expect(installedVersion(home)).toBe("0.1.0");
    expect(existsSync(join(home, ".mnemosyne", ".mnemosyne-installer"))).toBe(true);

    fixtureCommit(repoUrl, { tag: "v0.2.0" });
    fixtureCommit(repoUrl, { version: "0.3.0-dev" }); // on main, not released
    const updater = join(home, ".mnemosyne", "install.sh");

    const dry = await spawnDetached("sh", [updater, "update", "--dry-run", "--no-build"], baseEnv(home));
    expect(dry.code, dry.out).toBe(0);
    expect(dry.stdout).toMatch(/v0\.1\.0 to v0\.2\.0/);
    expect(installedVersion(home)).toBe("0.1.0");

    for (let i = 0; i < 2; i++) {
      const r = await spawnDetached("sh", [updater, "update", "--yes", "--no-build"], baseEnv(home));
      expect(r.code, r.out).toBe(0);
      expect(installedVersion(home)).toBe("0.2.0");
    }
    expect(git(join(home, ".mnemosyne"), "describe", "--tags")).toBe("v0.2.0");
    // Post-update: the index is brought up to date right away.
    expect(readFileSync(join(home, "mneme-calls.log"), "utf8")).toMatch(/^reindex --root /m);
  });

  test("update_refuses_when_the_install_dir_has_local_changes", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const home = freshHome();
    expect((await pipedInstall(home, repoUrl, ["--yes", "--no-build", "--no-ollama-pull"])).code).toBe(0);
    fixtureCommit(repoUrl, { tag: "v0.2.0" });
    writeFileSync(join(home, ".mnemosyne", "install.sh"), `${readFileSync(join(home, ".mnemosyne", "install.sh"), "utf8")}\n# local edit\n`);
    const r = await spawnDetached("sh", [join(home, ".mnemosyne", "install.sh"), "update", "--yes", "--no-build"], baseEnv(home));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/local changes/);
    expect(installedVersion(home)).toBe("0.1.0");
  });

  test("an_explicit_branch_update_follows_the_branch_tip", async () => {
    const repoUrl = fixtureRepo([{ tag: "v0.1.0" }]);
    const home = freshHome();
    expect((await pipedInstall(home, repoUrl, ["--yes", "--no-build", "--no-ollama-pull"])).code).toBe(0);
    fixtureCommit(repoUrl, { version: "0.2.0-dev" });
    const r = await spawnDetached("sh", [join(home, ".mnemosyne", "install.sh"), "update", "--yes", "--no-build"], { ...baseEnv(home), MNEMOSYNE_BRANCH: "main" });
    expect(r.code, r.out).toBe(0);
    expect(installedVersion(home)).toBe("0.2.0-dev");
  });

  test("your_own_checkout_is_never_moved", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const home = freshHome();
    expect((await install(home)).code).toBe(0);
    const r = await run(home, ["update", "--yes", "--no-build"]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/not pulled: it is your checkout/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });
});
