import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "mneme-hook-"));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

function settingsPath(): string {
  return join(fakeHome, ".claude", "settings.json");
}

describe("install-hook", () => {
  test("install_hook_without_write_prints_snippet", async () => {
    const lines: string[] = [];
    const code = await runCli(["install-hook"], (s) => lines.push(s));
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("mneme context");
    expect(output).toContain(join(".claude", "settings.json"));
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("install_hook_write_creates_settings_when_absent", async () => {
    const code = await runCli(["install-hook", "--write"], () => {});
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
      hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] };
    };
    expect(parsed.hooks.SessionStart.length).toBeGreaterThan(0);
    expect(parsed.hooks.SessionStart[0]!.hooks[0]!.command).toBe("mneme context");
  });

  test("install_hook_write_preserves_existing_keys", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ model: "opus" }));
    const code = await runCli(["install-hook", "--write"], () => {});
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
      model: string;
      hooks: { SessionStart: unknown[] };
    };
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.SessionStart).toBeInstanceOf(Array);
  });

  test("install_hook_write_aborts_on_corrupt_json", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const corrupt = "{ not valid json";
    writeFileSync(settingsPath(), corrupt);
    const errs: string[] = [];
    const code = await runCli(["install-hook", "--write"], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    expect(readFileSync(settingsPath(), "utf8")).toBe(corrupt);
    expect(errs.join("\n")).toMatch(/[Cc]ould not parse/);
  });
});
