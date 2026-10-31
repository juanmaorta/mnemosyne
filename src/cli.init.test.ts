// src/cli.init.test.ts
//
// MNE-20: `mneme init` — instalador/configurador idempotente. Absorbe
// `install-hook`, escribe el `.scopemap` con catch-all, y elige tier (tier 0
// cuando no hay Ollama alcanzable). Dry-run por defecto; `--write` aplica.
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { storePaths } from "./store.js";
import { openDb } from "./index/db.js";

let home: string;
let root: string;
let prevHome: string | undefined;
let prevOllamaHost: string | undefined;
let prevEmbedder: string | undefined;
let prevFake: string | undefined;
let prevEnvRoot: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME; prevOllamaHost = process.env.OLLAMA_HOST;
  prevEmbedder = process.env.MNEMOSYNE_EMBEDDER; prevFake = process.env.MNEMOSYNE_FAKE_EMBED;
  prevEnvRoot = process.env.MNEMOSYNE_ROOT;
  home = mkdtempSync(join(tmpdir(), "mneme-init-home-"));
  root = mkdtempSync(join(tmpdir(), "mneme-init-root-"));
  process.env.HOME = home;
  // Force the Ollama probe to fail fast → tier 0, deterministically.
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";
  delete process.env.MNEMOSYNE_EMBEDDER;
  delete process.env.MNEMOSYNE_FAKE_EMBED;
  // Isolate MNEMOSYNE_ROOT: an ambient value would make a no-`--root` init
  // target that external store (reading/writing it, and failing the
  // default-store assertion). Tests that need it set it explicitly.
  delete process.env.MNEMOSYNE_ROOT;
});
afterEach(() => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("HOME", prevHome); restore("OLLAMA_HOST", prevOllamaHost);
  restore("MNEMOSYNE_EMBEDDER", prevEmbedder); restore("MNEMOSYNE_FAKE_EMBED", prevFake);
  restore("MNEMOSYNE_ROOT", prevEnvRoot);
});

const settingsPath = () => join(home, ".claude", "settings.json");

describe("mneme init", () => {
  test("dry_run_writes_nothing", async () => {
    const code = await runCli(["init", "--root", root], () => {});
    expect(code).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(storePaths(root).scopeMap)).toBe(false);
  });

  test("write_installs_hook_scopemap_and_tier0_config", async () => {
    const code = await runCli(["init", "--root", root, "--write"], () => {});
    expect(code).toBe(0);
    // Hook
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const cmds = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.some((c: string) => c.includes("mneme context"))).toBe(true);
    // Scopemap catch-all
    expect(readFileSync(storePaths(root).scopeMap, "utf8")).toMatch(/^~\s*=\s*personal\s*$/m);
    // Tier 0 persisted (Ollama unreachable)
    const cfg = JSON.parse(readFileSync(join(root, ".config.json"), "utf8"));
    expect(cfg.embedder).toBe("none");
  });

  test("is_idempotent", async () => {
    await runCli(["init", "--root", root, "--write"], () => {});
    const firstSettings = readFileSync(settingsPath(), "utf8");
    const firstScopemap = readFileSync(storePaths(root).scopeMap, "utf8");
    const code = await runCli(["init", "--root", root, "--write"], () => {});
    expect(code).toBe(0);
    // No duplicate hook, scopemap untouched.
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const cmds = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.filter((c: string) => c.includes("mneme context"))).toHaveLength(1);
    expect(readFileSync(storePaths(root).scopeMap, "utf8")).toBe(firstScopemap);
    expect(readFileSync(settingsPath(), "utf8")).toBe(firstSettings);
  });

  test("persisted_tier0_makes_search_work_without_an_embedder_env", async () => {
    // The whole point of persisting the tier: a later `mneme search` with NO
    // env var still runs in tier 0 because init wrote .config.json at this root.
    await runCli(["init", "--root", root, "--write"], () => {});
    mkdirSync(join(root, "personal"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "personal", "fermentor.md"),
      ["---", "name: fermentor", "description: yogurt maker", "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", "yogurt maker body", ""].join("\n"));
    const lines: string[] = [];
    // BM25 is lexical: query terms that actually appear in the note.
    expect(await runCli(["search", "yogurt maker", "--root", root], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toMatch(/fermentor/);
    // Tier 0 → no vectors were written.
    const db = openDb(storePaths(root).indexDb);
    expect((db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("bakes_a_custom_root_into_the_installed_hook_command", async () => {
    // Regression (Codex): a hook of plain `mneme context` reads the default
    // store, ignoring a store initialized under a custom --root. The root must
    // travel in the hook command so sessions target the initialized store.
    await runCli(["init", "--root", root, "--write"], () => {});
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const cmds: string[] = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.some((c) => c.includes("--root") && c.includes(root))).toBe(true);
  });

  test("resolves_a_relative_root_to_absolute_in_the_hook", async () => {
    // Regression (Codex): a relative --root baked verbatim would resolve against
    // each future session's cwd. Dry-run so nothing is written to the repo.
    const lines: string[] = [];
    await runCli(["init", "--root", "some-relative-store"], (s) => lines.push(s));
    const hookLine = lines.join("\n").split("\n").find((l) => l.includes("--root")) ?? "";
    expect(hookLine).toMatch(/--root '\/.*some-relative-store'/);
  });

  test("bakes_the_root_from_MNEMOSYNE_ROOT_when_no_flag_is_given", async () => {
    // Regression (Codex): with MNEMOSYNE_ROOT set and no --root, the hook used to
    // bake no root and lose the store once the env var was gone.
    const prevRoot = process.env.MNEMOSYNE_ROOT;
    process.env.MNEMOSYNE_ROOT = root;
    try {
      await runCli(["init", "--write"], () => {});
      const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
      const cmds: string[] = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
      expect(cmds.some((c) => c.includes(`--root '${root}'`))).toBe(true);
    } finally {
      if (prevRoot === undefined) delete process.env.MNEMOSYNE_ROOT; else process.env.MNEMOSYNE_ROOT = prevRoot;
    }
  });

  test("always_bakes_an_absolute_root_even_for_the_default_store", async () => {
    // Regression (Codex): pin the store even for the default location, so a hook
    // does not follow MNEMOSYNE_ROOT to a different store in a later session.
    await runCli(["init", "--write"], () => {}); // no --root → default <HOME>/memory
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const cmds: string[] = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.some((c) => c.includes("--root") && c.includes(join(home, "memory")))).toBe(true);
  });

  test("reconciles_a_prior_hook_instead_of_accumulating", async () => {
    // Regression (Codex): install-hook then init (or re-init with another root)
    // must leave ONE Mnemosyne hook, not several that inject from two stores.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    // A prior bare install plus an unrelated hook that must survive.
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context" }, { type: "command", command: "echo keep-me" }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const cmds: string[] = settings.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.startsWith("mneme context"))).toHaveLength(1);
    expect(cmds.some((c) => c.includes("--root"))).toBe(true);
    expect(cmds).toContain("echo keep-me"); // unrelated hook preserved
  });

  test("reinstalling_an_identical_hook_preserves_its_matcher_and_timeout", async () => {
    // Regression (Codex): an idempotent reinstall must not strip a user's matcher
    // or custom timeout from an already-correct Mnemosyne hook.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "mneme context", timeout: 120 }] }] },
    }));
    expect(await runCli(["install-hook", "--write"], () => {})).toBe(0);
    const g = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart[0];
    expect(g.matcher).toBe("startup");
    expect(g.hooks[0].timeout).toBe(120);
  });

  test("migrating_the_command_preserves_matcher_and_timeout", async () => {
    // Regression (Codex): when init changes the command (adds --root), the user's
    // matcher/timeout on the old Mnemosyne hook must carry over, not be dropped.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "mneme context", timeout: 120 }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const groups = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart;
    const g = groups.find((grp: { hooks: { command: string }[] }) => grp.hooks.some((h) => h.command.startsWith("mneme context --root")));
    expect(g.matcher).toBe("startup");
    expect(g.hooks.find((h: { command: string }) => h.command.startsWith("mneme context --root")).timeout).toBe(120);
  });

  test("migrating_preserves_every_matcher_group", async () => {
    // Regression (Codex): separate startup and resume Mnemosyne hooks must both
    // survive a command migration, or resumed sessions silently lose memory.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "mneme context" }] },
        { matcher: "resume", hooks: [{ type: "command", command: "mneme context" }] },
      ] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const groups = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart;
    const matchersWithMnemo = groups
      .filter((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.startsWith("mneme context --root")))
      .map((g: { matcher?: string }) => g.matcher);
    expect(matchersWithMnemo).toContain("startup");
    expect(matchersWithMnemo).toContain("resume");
  });

  test("init_preserves_custom_context_args_while_setting_root", async () => {
    // Regression (Codex): a user's --scope/--budget on the hook must survive an
    // init that sets --root (only the root changes).
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context --scope work --budget 500" }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.find((c) => c.startsWith("mneme context"))!;
    expect(mnemo).toContain("--scope work");
    expect(mnemo).toContain("--budget 500");
    expect(mnemo).toContain(`--root '${root}'`);
  });

  test("install_hook_after_init_does_not_drop_the_configured_root", async () => {
    // Regression (Codex): install-hook (no root) must not redirect sessions off
    // the store init configured — it leaves an existing command untouched.
    await runCli(["init", "--root", root, "--write"], () => {});
    const before = readFileSync(settingsPath(), "utf8");
    await runCli(["install-hook", "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.startsWith("mneme context"))).toHaveLength(1);
    expect(cmds.some((c) => c.includes(`--root '${root}'`))).toBe(true);
    expect(readFileSync(settingsPath(), "utf8")).toBe(before); // genuinely a no-op
  });

  test("codex_install_upgrades_a_plain_hook_to_the_emit_envelope", async () => {
    // Regression (Codex): a plain `mneme context` in hooks.json must gain
    // --emit codex-session-start, or Codex drops the digest silently.
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "mneme-codex-"));
    process.env.CODEX_HOME = codexHome;
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context" }] }] },
      }));
      await runCli(["install-hook", "--harness", "codex", "--write"], () => {});
      const cmds: string[] = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks.SessionStart
        .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
      expect(cmds.some((c) => c.includes("--emit codex-session-start"))).toBe(true);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  test("reinstalling_with_an_apostrophe_in_the_root_stays_runnable", async () => {
    // Regression (Codex): a root path with an apostrophe must survive a re-init
    // without corrupting the stored command.
    const apo = join(tmpdir(), `mneme-apos-${Date.now()}-o'brien`);
    await runCli(["init", "--root", apo, "--write"], () => {});
    await runCli(["init", "--root", apo, "--write"], () => {}); // re-run strips & re-adds
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.filter((c) => c.startsWith("mneme context"));
    expect(mnemo).toHaveLength(1);
    // Exactly one --root, and the command still begins cleanly with the base.
    expect(mnemo[0]!.match(/--root/g)).toHaveLength(1);
    expect(mnemo[0]!.startsWith("mneme context --root ")).toBe(true);
  });

  test("leaves_a_compound_command_untouched_rather_than_corrupting_it", async () => {
    // Regression (Codex): appending --root to `mneme context || true` would land
    // on `true`. A compound command is user-managed; leave it as is, no dup.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context || true" }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.filter((c) => c.startsWith("mneme context"));
    expect(mnemo).toEqual(["mneme context || true"]); // untouched, not duplicated
  });

  test("migrates_a_root_path_that_contains_a_shell_metacharacter", async () => {
    // Regression (Codex): a quoted root with `&` is installer-generated and valid;
    // a later re-init to a different store must still migrate it, not freeze it.
    const first = join(tmpdir(), `mneme-amp-${Date.now()}-Research & Notes`);
    const second = join(tmpdir(), `mneme-amp2-${Date.now()}-store`);
    await runCli(["init", "--root", first, "--write"], () => {});
    await runCli(["init", "--root", second, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.filter((c) => c.startsWith("mneme context"));
    expect(mnemo).toHaveLength(1);
    expect(mnemo[0]).toContain(`--root '${second}'`);
    expect(mnemo[0]).not.toContain(first);
  });

  test("migrates_a_double_quoted_root_with_an_escaped_quote_to_valid_shell", async () => {
    // Regression (Codex): a hand-edited hook using a double-quoted root with an
    // escaped quote (`"/tmp/my\"notes"`) used to be half-consumed by the root
    // matcher, leaving an unmatched quote — broken shell that disables memory.
    // Migrating to a new root must yield a runnable command.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const before = 'mneme context --root "/tmp/my\\"notes" --budget 500';
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: before }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.filter((c) => c.startsWith("mneme context"));
    expect(mnemo).toHaveLength(1);
    expect(mnemo[0]!.match(/--root/g)).toHaveLength(1);
    expect(mnemo[0]).toContain(`--root '${root}'`);
    expect(mnemo[0]).toContain("--budget 500"); // other args survive
    // The decisive proof: the rewritten command is valid shell syntax.
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync("/bin/sh", ["-n", "-c", mnemo[0]!]).status).toBe(0);
  });

  test("does_not_mistake_root_inside_a_quoted_value_for_the_option", async () => {
    // Regression (Codex): a quoted --cwd value that literally contains "--root"
    // must not be rewritten; only a real --root option gets replaced, or scope
    // resolution silently shifts.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const before = "mneme context --cwd '/tmp/project --root old' --budget 500";
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: before }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const mnemo = cmds.find((c) => c.startsWith("mneme context"))!;
    expect(mnemo).toContain("--cwd '/tmp/project --root old'"); // quoted value intact
    expect(mnemo).toContain(`--root '${root}'`); // a real --root appended
    expect(mnemo.match(/--root '/g)).toHaveLength(1); // only the real option
  });

  test("codex_upgrade_detects_emit_as_an_option_not_a_substring", async () => {
    // Regression (Codex): a root path that contains "--emit" must not fool the
    // codex upgrade into thinking the envelope flag is already there.
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "mneme-codex-"));
    process.env.CODEX_HOME = codexHome;
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context --root '/tmp/--emit-memory'" }] }] },
      }));
      await runCli(["install-hook", "--harness", "codex", "--write"], () => {});
      const cmds: string[] = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks.SessionStart
        .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
      expect(cmds.some((c) => c.includes("--emit codex-session-start"))).toBe(true);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  test("leaves_a_command_with_a_shell_comment_untouched", async () => {
    // Regression (Codex): appending --root after a `#` comment would be inert.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mneme context # ambient memory" }] }] },
    }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const cmds: string[] = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart
      .flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.startsWith("mneme context"))).toEqual(["mneme context # ambient memory"]);
  });

  test("tolerates_a_null_group_in_existing_settings", async () => {
    // Regression (Codex): a null group in SessionStart must not crash the install.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { SessionStart: [null] } }));
    expect(await runCli(["install-hook", "--write"], () => {})).toBe(0);
    const groups = JSON.parse(readFileSync(settingsPath(), "utf8")).hooks.SessionStart;
    const cmds = groups.filter((g: unknown) => g).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("mneme context");
  });

  test("preserves_existing_settings_keys", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(settingsPath(), JSON.stringify({ model: "opus" }));
    await runCli(["init", "--root", root, "--write"], () => {});
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.model).toBe("opus");
  });
});

// MNE-97: init persists the embedding settings into `.config.json` so nothing
// has to live in `~/.zshenv`, and re-running it (the installer's `update`)
// preserves what is already there instead of re-deciding it.
describe("mneme init — persisted embedding settings (MNE-97)", () => {
  const SCRUB = ["OLLAMA_MODEL", "MNEMOSYNE_MIN_COS", "MNEMOSYNE_LEXICAL_FLOOR"] as const;
  let scrubbed: Record<string, string | undefined>;
  beforeEach(() => {
    scrubbed = Object.fromEntries(SCRUB.map((k) => [k, process.env[k]]));
    for (const k of SCRUB) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SCRUB) { if (scrubbed[k] === undefined) delete process.env[k]; else process.env[k] = scrubbed[k]; }
  });

  const config = () => JSON.parse(readFileSync(join(root, ".config.json"), "utf8")) as Record<string, unknown>;
  const writeConfig = async (cfg: Record<string, unknown>) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".config.json"), `${JSON.stringify(cfg)}\n`);
  };

  test("persists_model_and_floors_given_as_flags", async () => {
    const code = await runCli(["init", "--root", root, "--write", "--model", "nomic-embed-text-v2-moe", "--lexical-floor", "12", "--min-cos", "0.35"], () => {});
    expect(code).toBe(0);
    expect(config()).toMatchObject({ model: "nomic-embed-text-v2-moe", lexicalFloor: 12, minCos: 0.35 });
  });

  test("captures_the_env_vars_present_at_init_into_the_config", async () => {
    // Someone who configured Mnemosyne through ~/.zshenv runs init (or the
    // installer's update) once, and can then drop the variables.
    process.env.OLLAMA_MODEL = "nomic-embed-text-v2-moe";
    process.env.MNEMOSYNE_LEXICAL_FLOOR = "12";
    process.env.MNEMOSYNE_MIN_COS = "0.4";
    await runCli(["init", "--root", root, "--write"], () => {});
    expect(config()).toMatchObject({ model: "nomic-embed-text-v2-moe", lexicalFloor: 12, minCos: 0.4 });
  });

  test("rerun_preserves_existing_settings_and_the_embedder_tier", async () => {
    // Ollama unreachable during an update must not silently demote a working
    // embedder store to tier 0, nor drop its model or floors.
    await writeConfig({ embedder: "ollama", model: "nomic-embed-text-v2-moe", lexicalFloor: 12, extra: "kept" });
    const err: string[] = [];
    const code = await runCli(["init", "--root", root, "--write"], () => {}, (s) => err.push(s));
    expect(code).toBe(0);
    expect(config()).toEqual({ embedder: "ollama", model: "nomic-embed-text-v2-moe", lexicalFloor: 12, extra: "kept" });
    expect(err.join("\n")).toMatch(/ollama pull nomic-embed-text-v2-moe/);
  });

  test("an_explicit_embedder_flag_switches_the_tier", async () => {
    await writeConfig({ embedder: "ollama", model: "nomic-embed-text-v2-moe" });
    await runCli(["init", "--root", root, "--write", "--embedder", "none"], () => {});
    expect(config()).toMatchObject({ embedder: "none", model: "nomic-embed-text-v2-moe" });
  });

  test("rejects_invalid_values_before_writing_anything", async () => {
    const err: string[] = [];
    expect(await runCli(["init", "--root", root, "--write", "--lexical-floor", "-3"], () => {}, (s) => err.push(s))).toBe(1);
    expect(await runCli(["init", "--root", root, "--write", "--embedder", "gpu"], () => {}, (s) => err.push(s))).toBe(1);
    expect(await runCli(["init", "--root", root, "--write", "--model", "mystery-model"], () => {}, (s) => err.push(s))).toBe(1);
    expect(err.join("\n")).toMatch(/lexical-floor/);
    expect(err.join("\n")).toMatch(/embedder/);
    expect(err.join("\n")).toMatch(/Unknown embedding model "mystery-model"/);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(join(root, ".config.json"))).toBe(false);
  });

  test("dry_run_shows_the_config_it_would_write_and_writes_nothing", async () => {
    const lines: string[] = [];
    await runCli(["init", "--root", root, "--model", "nomic-embed-text-v2-moe", "--lexical-floor", "12"], (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain(join(root, ".config.json"));
    expect(out).toContain('"model": "nomic-embed-text-v2-moe"');
    expect(out).toContain('"lexicalFloor": 12');
    expect(existsSync(join(root, ".config.json"))).toBe(false);
  });

  // MNE-97 decision: v2-moe's cosine bands overlap, so without the lexical
  // rescue it loses literal matches. The calibrated floor ships as the default
  // for that model only, written once by init so the store says what it uses.
  describe("default lexicalFloor for nomic-embed-text-v2-moe", () => {
    test("v2_moe_on_the_embedder_tier_writes_lexicalFloor_12", async () => {
      expect(await runCli(["init", "--root", root, "--write", "--embedder", "ollama", "--model", "nomic-embed-text-v2-moe"], () => {}, () => {})).toBe(0);
      expect(config()).toMatchObject({ embedder: "ollama", model: "nomic-embed-text-v2-moe", lexicalFloor: 12 });
    });

    test("the_latest_tag_counts_as_v2_moe", async () => {
      await runCli(["init", "--root", root, "--write", "--embedder", "ollama", "--model", "nomic-embed-text-v2-moe:latest"], () => {}, () => {});
      expect(config()).toMatchObject({ lexicalFloor: 12 });
    });

    test("the_dry_run_shows_the_default_it_would_write", async () => {
      const lines: string[] = [];
      await runCli(["init", "--root", root, "--embedder", "ollama", "--model", "nomic-embed-text-v2-moe"], (s) => lines.push(s));
      expect(lines.join("\n")).toContain('"lexicalFloor": 12');
    });

    test("an_explicit_flag_or_env_wins_over_the_default", async () => {
      await runCli(["init", "--root", root, "--write", "--embedder", "ollama", "--model", "nomic-embed-text-v2-moe", "--lexical-floor", "7"], () => {}, () => {});
      expect(config()).toMatchObject({ lexicalFloor: 7 });
      process.env.MNEMOSYNE_LEXICAL_FLOOR = "9";
      await runCli(["init", "--root", root, "--write"], () => {}, () => {});
      expect(config()).toMatchObject({ lexicalFloor: 9 });
    });

    test("a_rerun_keeps_an_existing_lexicalFloor", async () => {
      await writeConfig({ embedder: "ollama", model: "nomic-embed-text-v2-moe", lexicalFloor: 14.5 });
      await runCli(["init", "--root", root, "--write"], () => {}, () => {});
      expect(config()).toMatchObject({ lexicalFloor: 14.5 });
    });

    test("other_models_get_no_lexicalFloor", async () => {
      await runCli(["init", "--root", root, "--write", "--embedder", "ollama", "--model", "nomic-embed-text"], () => {}, () => {});
      expect(config()).not.toHaveProperty("lexicalFloor");
    });

    test("tier_0_gets_no_lexicalFloor_even_with_v2_moe", async () => {
      await runCli(["init", "--root", root, "--write", "--embedder", "none", "--model", "nomic-embed-text-v2-moe"], () => {}, () => {});
      expect(config()).toMatchObject({ embedder: "none", model: "nomic-embed-text-v2-moe" });
      expect(config()).not.toHaveProperty("lexicalFloor");
    });
  });
});
