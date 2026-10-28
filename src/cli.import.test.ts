// src/cli.import.test.ts
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

function store(owns: string[] = ["personal"]): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cliimp-"));
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  return root;
}

function native(front: string[], body: string): string {
  return ["---", ...front, "---", "", body, ""].join("\n");
}

function sourceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-clinative-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const NOTE = native(["type: reference", "description: como regar"], "regar cada dos dias");

interface Captured { code: number; out: string; err: string }

async function cli(args: string[]): Promise<Captured> {
  const o: string[] = [];
  const e: string[] = [];
  const code = await runCli(args, (s) => o.push(s), (s) => e.push(s));
  return { code, out: o.join("\n"), err: e.join("\n") };
}

describe("runCli import-claude", () => {
  test("cli_import_usage_errors_exit_nonzero", async () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE });

    const noSource = await cli(["import-claude", "--source-id", "repo-a", "--scope", "personal", "--root", root]);
    expect(noSource.code).toBe(1);
    expect(noSource.err).toMatch(/usage: mneme import-claude/);

    const noId = await cli(["import-claude", "--source", src, "--scope", "personal", "--root", root]);
    expect(noId.code).toBe(1);
    expect(noId.err).toMatch(/source-id/);

    // Explicit scope or nothing: never inferred, never defaulted to personal.
    const noScope = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--root", root]);
    expect(noScope.code).toBe(1);
    expect(noScope.err).toMatch(/--scope/);

    const badId = await cli(["import-claude", "--source", src, "--source-id", "Repo A", "--scope", "personal", "--root", root]);
    expect(badId.code).toBe(1);
    expect(badId.err).toMatch(/kebab/);

    const missingDir = await cli(["import-claude", "--source", join(src, "nope"), "--source-id", "repo-a", "--scope", "personal", "--root", root]);
    expect(missingDir.code).toBe(1);
    expect(missingDir.err).toMatch(/source/);
  });

  test("cli_import_dry_run_reports_and_writes_nothing", async () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE, "MEMORY.md": "indice\n" });

    const r = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", "--root", root]);

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^importable\s+riego\.md/m);
    expect(r.out).toMatch(/^ignored\s+MEMORY\.md/m);
    expect(r.out).toContain("DRY RUN — nothing written. Re-run with --apply to import.");
    expect(r.out).not.toContain("mneme reindex"); // nothing was written to index

    expect(r.out).toMatch(/not copied from the source: .*modified/);
    expect(existsSync(join(root, "personal"))).toBe(false);
    expect(existsSync(join(root, ".telemetry"))).toBe(false);
  });

  test("cli_import_apply_writes_and_reports_destinations", async () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE });

    const r = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", "--apply", "--root", root]);

    expect(r.code).toBe(0);
    expect(r.out).not.toContain("DRY RUN");
    expect(r.out).toMatch(/^imported\s+riego\.md\s+→ .*claude-repo-a-riego-228878a4046f\.md/m);
    expect(readdirSync(join(root, "personal")).filter((f) => f.endsWith(".md")))
      .toEqual(["claude-repo-a-riego-228878a4046f.md"]);
    // On disk is not retrievable: the importer never touches the index.
    expect(r.out).toContain("run `mneme reindex` to make the imported memories retrievable.");

    // Re-running is safe and says so.
    const again = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", "--apply", "--root", root]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^skipped-identical\s+riego\.md/m);
  });

  test("cli_import_relative_source_is_resolved_and_echoed_absolute", async () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE });

    const r = await cli(["import-claude", "--source", relative(process.cwd(), src), "--source-id", "repo-a", "--scope", "personal", "--root", root]);

    expect(r.code).toBe(0);
    expect(r.out).toContain(`source ${src}`);
  });

  test("cli_import_exits_nonzero_on_conflict", async () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE });
    expect((await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", "--apply", "--root", root])).code).toBe(0);

    writeFileSync(join(src, "riego.md"), native(["type: reference", "description: como regar"], "regar cada TRES dias"));
    const r = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", "--apply", "--root", root]);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^conflict\s+riego\.md/m);
  });

  test("cli_import_not_owner_exits_nonzero_in_dry_run", async () => {
    const root = store(["personal"]);
    const src = sourceDir({ "riego.md": NOTE });

    const r = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "work", "--root", root]);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^failed\s+riego\.md\s+\[not-owner\]/m);
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  test("cli_import_report_never_echoes_bodies_or_secrets", async () => {
    const root = store();
    const src = sourceDir({
      "secreto.md": native(["type: reference", "description: claves"], "token sk-abcdefghij0123456789"),
      "riego.md": native(["type: reference", "description: como regar"], "CUERPO-UNICO-NO-IMPRIMIBLE"),
    });

    for (const extra of [[], ["--apply"]]) {
      const r = await cli(["import-claude", "--source", src, "--source-id", "repo-a", "--scope", "personal", ...extra, "--root", root]);
      expect(r.code).toBe(1); // the secret file failed
      const all = `${r.out}\n${r.err}`;
      expect(all).toMatch(/^failed\s+secreto\.md\s+\[secret-detected\]/m);
      expect(all).not.toContain("sk-abcdefghij0123456789");
      expect(all).not.toContain("CUERPO-UNICO-NO-IMPRIMIBLE");
    }
  });
});
