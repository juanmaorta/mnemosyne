// src/cli.get.test.ts
//
// `get --json` is the read half of the canonical-memory contract: an agent reads
// a note and gets back the revision it must hand to `update`. Content and
// revision therefore have to describe THE SAME read of the file, and stdout has
// to be exactly one JSON object — anything else and the caller cannot parse it.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { openDb } from "./index/db.js";
import { getHotState } from "./hotstate.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

/** An indexed store with one note whose body deliberately carries trailing structure. */
async function indexedStore(): Promise<{ root: string; path: string }> {
  const root = mkdtempSync(join(tmpdir(), "mneme-cliget-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  const path = join(root, "personal", "yogurtera.md");
  writeFileSync(path, [
    "---", "name: yogurtera", "description: como hacer yogur", "scope: personal",
    "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---",
    "primera linea", "", "  sangrado y acentos: fermentación", "",
  ].join("\n"));
  expect(await runCli(["reindex", "--root", root], () => {}, () => {})).toBe(0);
  return { root, path };
}

describe("runCli get --json", () => {
  test("cli_get_json_prints_one_parseable_object_with_the_on_disk_revision", async () => {
    const { root, path } = await indexedStore();
    const lines: string[] = [];

    const code = await runCli(["get", "yogurtera", "--scope", "personal", "--json", "--root", root], (s) => lines.push(s), () => {});

    expect(code).toBe(0);
    // Exactly one JSON object on stdout — no banner, no warning, nothing else.
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(doc).toEqual({
      slug: "yogurtera",
      scope: "personal",
      path,
      content: readFileSync(path, "utf8"),
      revision: createHash("sha256").update(readFileSync(path)).digest("hex"),
    });
    expect(doc.revision as string).toMatch(/^[0-9a-f]{64}$/);
  });

  test("cli_get_json_keeps_reinforcing_the_memory", async () => {
    const { root } = await indexedStore();

    expect(await runCli(["get", "yogurtera", "--json", "--root", root], () => {}, () => {})).toBe(0);

    // --json is a read like any other: it must not become a way to read a
    // memory without strengthening it.
    const hot = getHotState(openDb(join(root, ".index", "store.db")), "personal", "yogurtera")!;
    expect(hot.accessCount).toBe(1);
  });

  test("cli_get_without_json_is_unchanged_plain_content", async () => {
    const { root, path } = await indexedStore();
    const lines: string[] = [];

    const code = await runCli(["get", "yogurtera", "--root", root], (s) => lines.push(s), () => {});

    expect(code).toBe(0);
    expect(lines).toEqual([readFileSync(path, "utf8")]);
  });

  test("cli_get_json_reports_a_missing_slug_on_stderr_only", async () => {
    const { root } = await indexedStore();
    const lines: string[] = [];
    const errs: string[] = [];

    const code = await runCli(["get", "inexistente", "--json", "--root", root], (s) => lines.push(s), (s) => errs.push(s));

    expect(code).toBe(1);
    expect(lines).toEqual([]); // never a half-written JSON object
    expect(errs.join("\n")).toMatch(/inexistente/);
  });
});
