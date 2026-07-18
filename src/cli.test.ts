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
