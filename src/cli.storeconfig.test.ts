// src/cli.storeconfig.test.ts
//
// MNE-97: the embedding model, the cosine floor and the lexical rescue floor
// live in the store's `.config.json`, so a process that does not inherit the
// shell's env (a hook, an agent's non-interactive shell) still uses the model
// the index was built with. Env vars keep working and WIN over the config; a
// flag wins over both.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { storePaths } from "./store.js";

const ENV_KEYS = ["HOME", "OLLAMA_HOST", "OLLAMA_MODEL", "OLLAMA_EMBEDDING_DIM", "MNEMOSYNE_EMBEDDER", "MNEMOSYNE_FAKE_EMBED", "MNEMOSYNE_ROOT", "MNEMOSYNE_MIN_COS", "MNEMOSYNE_LEXICAL_FLOOR"] as const;
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = mkdtempSync(join(tmpdir(), "mneme-cfg-home-"));
  process.env.OLLAMA_HOST = "http://127.0.0.1:1"; // never a real Ollama
  root = mkdtempSync(join(tmpdir(), "mneme-cfg-root-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", "fermentor.md"),
    ["---", "name: fermentor", "description: yogurt maker", "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", "yogurt maker body", ""].join("\n"));
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const writeConfig = (cfg: Record<string, unknown>) => writeFileSync(storePaths(root).config, `${JSON.stringify(cfg)}\n`);

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(args, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("store config (.config.json) at runtime", () => {
  test("search_uses_the_model_persisted_in_the_config_without_OLLAMA_MODEL", async () => {
    // An unknown model fails before any network call, naming the model it was
    // asked for: proof that the config, not the built-in default, chose it.
    writeConfig({ embedder: "ollama", model: "persisted-model-xyz" });
    const r = await run(["search", "yogurt", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown embedding model "persisted-model-xyz"');
  });

  test("OLLAMA_MODEL_env_wins_over_the_config_model", async () => {
    writeConfig({ embedder: "ollama", model: "persisted-model-xyz" });
    process.env.OLLAMA_MODEL = "env-model-abc";
    const r = await run(["search", "yogurt", "--root", root]);
    expect(r.err).toContain('Unknown embedding model "env-model-abc"');
    expect(r.err).not.toContain("persisted-model-xyz");
  });

  test("explain_uses_the_cosine_and_lexical_floors_from_the_config", async () => {
    process.env.MNEMOSYNE_FAKE_EMBED = "1";
    writeConfig({ minCos: 0.42, lexicalFloor: 12 });
    const r = await run(["explain", "yogurt", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("minimum raw cosine: 0.420");
    expect(r.out).toContain("lexical rescue floor (raw BM25): 12.000");
  });

  test("env_floors_win_over_the_config_and_flags_win_over_env", async () => {
    process.env.MNEMOSYNE_FAKE_EMBED = "1";
    writeConfig({ minCos: 0.42, lexicalFloor: 12 });
    process.env.MNEMOSYNE_MIN_COS = "0.5";
    process.env.MNEMOSYNE_LEXICAL_FLOOR = "7";
    const fromEnv = await run(["explain", "yogurt", "--root", root]);
    expect(fromEnv.out).toContain("minimum raw cosine: 0.500");
    expect(fromEnv.out).toContain("lexical rescue floor (raw BM25): 7.000");
    const fromFlag = await run(["explain", "yogurt", "--root", root, "--min-cos", "0.6", "--lexical-floor", "3"]);
    expect(fromFlag.out).toContain("minimum raw cosine: 0.600");
    expect(fromFlag.out).toContain("lexical rescue floor (raw BM25): 3.000");
  });

  test("search_honours_the_config_cosine_floor", async () => {
    process.env.MNEMOSYNE_FAKE_EMBED = "1";
    writeConfig({ minCos: 0.99 });
    const r = await run(["search", "yogurt", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("(minimum 0.990)");
  });

  test("an_invalid_floor_in_the_config_is_an_error_naming_the_file", async () => {
    process.env.MNEMOSYNE_FAKE_EMBED = "1";
    writeConfig({ lexicalFloor: "lots" });
    const r = await run(["search", "yogurt", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(".config.json");
    expect(r.err).toContain("lexicalFloor");
  });
});
