// src/cli.scan.test.ts — store-wide re-scan surface (`mneme scan --scope/--all`).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function note(body: string): string {
  return ["---", "name: n", "scope: personal", "type: reference", "---", body, ""].join("\n");
}

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-scan-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "personal", "clean.md"), note("nothing to see here"));
  writeFileSync(join(root, "work", "clean.md"), note("also clean"));
  return root;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return runCli(args, (s) => outLines.push(s), (s) => errLines.push(s)).then((code) => ({
    code,
    out: outLines.join("\n"),
    err: errLines.join("\n"),
  }));
}

describe("mneme scan over a store", () => {
  test("cli_scan_scope_flags_planted_secret_and_exits_nonzero", async () => {
    const root = store();
    writeFileSync(join(root, "personal", "leaky.md"), note(`key ${AWS_KEY}`));
    const r = await run(["scan", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/aws-access-key/);
    expect(r.out).toContain(join(root, "personal", "leaky.md"));
    expect(r.out).toMatch(/:6\b/); // frontmatter is 5 lines, the body starts at 6
    expect(r.out).not.toContain(AWS_KEY); // never echo the full secret
  });

  test("cli_scan_scope_limits_to_that_scope", async () => {
    const root = store();
    writeFileSync(join(root, "work", "leaky.md"), note(`key ${AWS_KEY}`));
    expect((await run(["scan", "--scope", "personal", "--root", root])).code).toBe(0);
    expect((await run(["scan", "--scope", "work", "--root", root])).code).toBe(1);
  });

  test("cli_scan_all_covers_every_scope", async () => {
    const root = store();
    writeFileSync(join(root, "work", "leaky.md"), note(`key ${AWS_KEY}`));
    const r = await run(["scan", "--all", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(join(root, "work", "leaky.md"));
  });

  test("cli_scan_clean_store_exits_zero_with_summary", async () => {
    const root = store();
    const r = await run(["scan", "--all", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 files/);
  });

  test("cli_scan_unknown_scope_exits_nonzero", async () => {
    const root = store();
    const r = await run(["scan", "--scope", "nope", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nope/);
  });

  test("cli_scan_scope_with_text_is_refused", async () => {
    const root = store();
    const r = await run(["scan", "some text", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/usage: mneme scan/);
  });

  test("cli_scan_store_leaves_notes_untouched", async () => {
    const root = store();
    const path = join(root, "personal", "leaky.md");
    const content = note(`key ${AWS_KEY}`);
    writeFileSync(path, content);
    await run(["scan", "--all", "--root", root]);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("cli_scan_warn_only_store_exits_zero", async () => {
    const root = store();
    writeFileSync(join(root, "personal", "warny.md"), note("password: hi"));
    const r = await run(["scan", "--all", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warn/);
  });
});
