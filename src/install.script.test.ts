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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function baseEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
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
    const r = await run(home, ["--dry-run"], { PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Node\.js.*18\.19\.0/);
    expect(r.out).toMatch(/>= ?20/);
    expect(r.out).toMatch(/nvm install|brew install node|nodejs\.org/);
    expect(listTree(home)).toEqual([]);
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
      const v = spawnSync(bin, ["scan", "hello"], { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH ?? "" } });
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
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({ model: "opus", hooks: {} });
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
    const v = spawnSync(join(home, ".local", "bin", "mneme"), ["reindex"], { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH ?? "", MNEMOSYNE_EMBEDDER: "none" } });
    expect(v.status, v.stderr).toBe(0);
    expect(existsSync(join(custom, ".index"))).toBe(true);
    expect(existsSync(join(home, "memory"))).toBe(false);
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
