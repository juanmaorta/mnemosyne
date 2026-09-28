import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function storeWith(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} desc`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `body of ${slug}`, ""].join("\n"));
  return root;
}

describe("runCli", () => {
  test("search_with_no_relevant_hit_reports_the_best_cosine_and_exits_two", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const code = await runCli(["search", "unrelated query", "--root", root, "--min-cos", "1"], (s) => lines.push(s));
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/No relevant results; best candidate: yogurtera.*cos .*minimum 1\.000/);
  });

  test("search_rejects_an_invalid_cosine_floor", async () => {
    const root = storeWith("yogurtera");
    const errors: string[] = [];
    expect(await runCli(["search", "test", "--root", root, "--min-cos", "2"], () => {}, (s) => errors.push(s))).toBe(1);
    expect(errors.join("\n")).toMatch(/min-cos/);
  });

  test("cli_reindex_then_search_prints_hit", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await runCli(["reindex", "--root", root], out)).toBe(0);
    expect(await runCli(["search", "yogurtera", "--root", root], out)).toBe(0);
    expect(lines.join("\n")).toMatch(/yogurtera/);
  });

  test("cli_get_prints_full_content", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    await runCli(["reindex", "--root", root], () => {});
    expect(await runCli(["get", "yogurtera", "--root", root], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toContain("body of yogurtera");
  });

  test("cli_get_missing_slug_exits_nonzero", async () => {
    const root = storeWith("yogurtera");
    await runCli(["reindex", "--root", root], () => {});
    const errs: string[] = [];
    expect(await runCli(["get", "nope", "--root", root], () => {}, (s) => errs.push(s))).toBe(1);
    expect(errs.join("\n")).toMatch(/No engram named 'nope'/);
  });

  test("cli_unknown_command_exits_nonzero", async () => {
    expect(await runCli(["frobnicate"], () => {}, () => {})).toBe(1);
  });

  test("cli_scan_clean_text_exits_zero", async () => {
    const lines: string[] = [];
    expect(await runCli(["scan", "just normal notes here"], (s) => lines.push(s))).toBe(0);
  });

  test("cli_scan_planted_secret_exits_nonzero_and_masks", async () => {
    const lines: string[] = [];
    const secret = "AKIAIOSFODNN7EXAMPLE";
    expect(await runCli(["scan", `key ${secret}`], (s) => lines.push(s))).toBe(1);
    const output = lines.join("\n");
    expect(output).toMatch(/aws-access-key/);
    expect(output).not.toContain(secret); // never echo the full secret
  });

  test("cli_scan_file_reads_and_flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-scan-"));
    const file = join(root, "note.md");
    writeFileSync(file, "password = supersecretvalue123");
    const lines: string[] = [];
    expect(await runCli(["scan", "--file", file], (s) => lines.push(s))).toBe(1);
    expect(lines.join("\n")).toMatch(/assignment:password/);
  });

  test("cli_scan_missing_input_exits_nonzero", async () => {
    const errs: string[] = [];
    expect(await runCli(["scan"], () => {}, (s) => errs.push(s))).toBe(1);
    expect(errs.join("\n")).toMatch(/usage: mneme scan/);
  });

  test("cli_scope_reports_mapped_scope_and_ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-scope-"));
    writeFileSync(join(root, ".scopemap"), "/work/acme = acme\n");
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal", "acme"] }));
    const lines: string[] = [];
    expect(await runCli(["scope", "/work/acme/repo", "--root", root], (s) => lines.push(s))).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/acme/);
    expect(out).toMatch(/owned/);
  });

  test("cli_scope_reports_unmapped_path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-scope-"));
    writeFileSync(join(root, ".scopemap"), "/work/acme = acme\n");
    const lines: string[] = [];
    expect(await runCli(["scope", "/tmp/elsewhere", "--root", root], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toMatch(/unmapped/);
  });

  test("cli_scope_reports_not_owned_when_policy_excludes_scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-scope-"));
    writeFileSync(join(root, ".scopemap"), "/work/acme = acme\n");
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
    const lines: string[] = [];
    expect(await runCli(["scope", "/work/acme/repo", "--root", root], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toMatch(/not owned/i);
  });
});

describe("a changed embedder from the CLI", () => {
  /** Stamps the index as built by someone else, without needing another model. */
  async function indexStampedBy(root: string, id: string): Promise<void> {
    expect(await runCli(["reindex", "--root", root], () => {})).toBe(0);
    const { openDb, setMeta } = await import("./index/db.js");
    const db = openDb(join(root, ".index", "store.db"));
    setMeta(db, "embedding_id", id);
    db.close();
  }

  test("cli_reindex_refuses_an_index_built_by_another_embedder", async () => {
    const root = storeWith("yogurtera");
    await indexStampedBy(root, "other-model/dim768");
    const errs: string[] = [];

    const code = await runCli(["reindex", "--root", root], () => {}, (s) => errs.push(s));

    expect(code).toBe(1);
    // The message has to carry the way out, or the user's only move is to guess.
    expect(errs.join("\n")).toMatch(/--force-embedder/);
    expect(errs.join("\n")).toMatch(/other-model/);
  });

  test("cli_reindex_rebuilds_when_force_embedder_is_passed", async () => {
    const root = storeWith("yogurtera");
    await indexStampedBy(root, "other-model/dim768");
    const lines: string[] = [];

    const code = await runCli(["reindex", "--force-embedder", "--root", root], (s) => lines.push(s), () => {});

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/indexed 1/);
  });

  test("cli_context_still_serves_the_old_digest_instead_of_breaking", async () => {
    // Session start must never fail. With the embedder disagreeing, the lazy
    // reindex refuses — and the digest is served from the index already there,
    // degraded but present, which is the whole point of not rebuilding unasked.
    const root = storeWith("yogurtera");
    await indexStampedBy(root, "other-model/dim768");
    const lines: string[] = [];
    const errs: string[] = [];

    const code = await runCli(["context", "--root", root, "--scope", "personal"], (s) => lines.push(s), (s) => errs.push(s));

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/yogurtera/);
    expect(errs.join("\n")).toMatch(/degraded/);
  });
});
