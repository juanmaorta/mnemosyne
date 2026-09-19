// src/cli.codexhook.test.ts
//
// The Codex half of the SessionStart integration, at the CLI boundary.
//
// Codex drops a hook's output unless it is one JSON object carrying
// `additionalContext` — no error, no warning, just a session that quietly has
// no memory. So the contract under test is narrower than Claude Code's: stdout
// must be a valid envelope even when everything upstream of it failed.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(repoRoot, "dist", "bin", "mneme.js");

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

/** A store root whose scope map sends `cwd` to `scope`. */
function storeFor(cwd: string, scope: string): string {
  const root = temp("mneme-codex-root-");
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, ".scopemap"), `${cwd} = ${scope}\n`);
  return root;
}

function envelopeOf(stdout: string): { hookEventName: string; additionalContext: string } {
  const parsed = JSON.parse(stdout.trim()) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  return parsed.hookSpecificOutput;
}

describe("context --emit codex-session-start", () => {
  test("codex_emit_wraps_the_digest_in_the_envelope", async () => {
    const cwd = temp("mneme-codex-cwd-");
    const root = storeFor(cwd, "trabajo");
    const lines: string[] = [];
    const code = await runCli(
      ["context", "--emit", "codex-session-start", "--root", root, "--cwd", cwd],
      (s) => lines.push(s),
      () => {},
    );
    expect(code).toBe(0);
    const envelope = envelopeOf(lines.join("\n"));
    expect(envelope.hookEventName).toBe("SessionStart");
    expect(envelope.additionalContext).toContain("trabajo");
  });

  test("codex_emit_prints_nothing_but_the_envelope", async () => {
    const cwd = temp("mneme-codex-cwd-");
    const root = storeFor(cwd, "trabajo");
    const lines: string[] = [];
    await runCli(["context", "--emit", "codex-session-start", "--root", root, "--cwd", cwd], (s) => lines.push(s), () => {});
    // One object. A second line of plain digest would be read by Codex as noise
    // and thrown away along with the envelope.
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  test("codex_emit_still_emits_an_envelope_when_the_command_line_is_wrong", async () => {
    // `context` swallows its own errors to never break session start; under
    // --emit that guarantee has to produce JSON, not a bare digest. An unknown
    // flag is the cheapest way to reach the fatal path on purpose.
    const lines: string[] = [];
    const code = await runCli(
      ["context", "--emit", "codex-session-start", "--bogus"],
      (s) => lines.push(s),
      () => {},
    );
    expect(code).toBe(0);
    expect(() => envelopeOf(lines.join("\n"))).not.toThrow();
    expect(envelopeOf(lines.join("\n")).hookEventName).toBe("SessionStart");
  });

  test("codex_emit_takes_the_cwd_from_the_hook_payload_on_stdin", async () => {
    // The real wiring: Codex runs the command with no --cwd and reports the
    // session's directory on stdin. Spawned for real, because an in-process
    // call proves nothing about reading fd 0.
    const cwd = temp("mneme-codex-cwd-");
    const root = storeFor(cwd, "desdestdin");
    const child = execFileAsync(process.execPath, [binary, "context", "--emit", "codex-session-start", "--root", root], {
      env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" },
    });
    child.child.stdin!.end(JSON.stringify({ hook_event_name: "SessionStart", cwd, source: "startup" }));
    const { stdout } = await child;
    expect(envelopeOf(stdout).additionalContext).toContain("desdestdin");
  });
});

describe("install-hook --harness codex", () => {
  let realHome: string | undefined;
  let realCodexHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    realCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "mneme-codexhook-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function hooksPath(): string { return join(fakeHome, ".codex", "hooks.json"); }

  test("codex_install_hook_without_write_prints_the_snippet_and_writes_nothing", async () => {
    const lines: string[] = [];
    const code = await runCli(["install-hook", "--harness", "codex"], (s) => lines.push(s));
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain(join(".codex", "hooks.json"));
    expect(output).toContain("codex-session-start");
    expect(existsSync(hooksPath())).toBe(false);
  });

  test("codex_install_hook_tells_the_user_the_hook_must_be_trusted", async () => {
    // Without this step the hook is inert and Codex says nothing about it, so
    // omitting the reminder ships an install that looks done and is not.
    const lines: string[] = [];
    await runCli(["install-hook", "--harness", "codex"], (s) => lines.push(s));
    expect(lines.join("\n")).toMatch(/\/hooks/);
  });

  test("codex_install_hook_write_creates_hooks_json", async () => {
    const code = await runCli(["install-hook", "--harness", "codex", "--write"], () => {});
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(hooksPath(), "utf8")) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(parsed.hooks.SessionStart[0]!.hooks[0]!.command).toContain("codex-session-start");
  });

  test("codex_install_hook_write_honours_CODEX_HOME", async () => {
    const codexHome = temp("mneme-codexhome-");
    process.env.CODEX_HOME = codexHome;
    await runCli(["install-hook", "--harness", "codex", "--write"], () => {});
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
    expect(existsSync(hooksPath())).toBe(false);
  });

  test("codex_install_hook_write_preserves_other_hooks", async () => {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify({ description: "mío", hooks: { PreToolUse: [{ hooks: [] }] } }));
    await runCli(["install-hook", "--harness", "codex", "--write"], () => {});
    const parsed = JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<string, any>;
    expect(parsed.description).toBe("mío");
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  test("codex_install_hook_write_aborts_on_corrupt_json", async () => {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const corrupt = "{ not valid json";
    writeFileSync(hooksPath(), corrupt);
    const errs: string[] = [];
    const code = await runCli(["install-hook", "--harness", "codex", "--write"], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    expect(readFileSync(hooksPath(), "utf8")).toBe(corrupt);
    expect(errs.join("\n")).toMatch(/[Cc]ould not parse/);
  });

  test("install_hook_rejects_an_unknown_harness", async () => {
    const errs: string[] = [];
    const code = await runCli(["install-hook", "--harness", "emacs"], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/emacs/);
  });
});
