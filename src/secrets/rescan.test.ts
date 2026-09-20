// src/secrets/rescan.test.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { rescanStore, type StoreFinding } from "./rescan.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

function note(body: string): string {
  return ["---", "name: n", "scope: personal", "type: reference", "---", body, ""].join("\n");
}

/** A store with two scopes, one note per scope plus one fact under `personal`. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-rescan-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  mkdirSync(join(root, "acme"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  writeFileSync(join(root, "personal", "clean.md"), note("nothing to see here"));
  writeFileSync(join(root, "personal", "facts", "01J000000000000000000000AA.md"), note("plain fact"));
  writeFileSync(join(root, "acme", "clean.md"), note("also clean"));
  return root;
}

function collect(root: string, opts?: { scopes?: string[] }): { findings: StoreFinding[]; summary: ReturnType<typeof rescanStore> } {
  const findings: StoreFinding[] = [];
  const summary = rescanStore(root, (f) => findings.push(f), opts);
  return { findings, summary };
}

describe("rescanStore", () => {
  test("rescan_reports_path_line_pattern_and_masked_value", () => {
    const root = fixture();
    const path = join(root, "personal", "leaky.md");
    writeFileSync(path, note(`line one\nkey ${AWS_KEY}`));
    const { findings } = collect(root);
    const hit = findings.find((f) => f.pattern === "aws-access-key");
    expect(hit).toBeDefined();
    expect(hit?.path).toBe(path);
    expect(hit?.scope).toBe("personal");
    expect(hit?.severity).toBe("reject");
    expect(hit?.line).toBe(7); // 5 frontmatter lines + "line one"
    expect(hit?.masked).not.toContain(AWS_KEY);
  });

  test("rescan_never_emits_the_full_secret", () => {
    const root = fixture();
    writeFileSync(join(root, "personal", "leaky.md"), note(`token ${OPENAI_KEY}`));
    const { findings } = collect(root);
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(OPENAI_KEY);
  });

  test("rescan_covers_authored_notes_and_facts", () => {
    const root = fixture();
    writeFileSync(join(root, "personal", "facts", "01J000000000000000000000AB.md"), note(`key ${AWS_KEY}`));
    const { findings } = collect(root, { scopes: ["personal"] });
    expect(findings.map((f) => f.path)).toContain(join(root, "personal", "facts", "01J000000000000000000000AB.md"));
  });

  test("rescan_defaults_to_every_scope", () => {
    const root = fixture();
    writeFileSync(join(root, "acme", "leaky.md"), note(`key ${AWS_KEY}`));
    const { findings, summary } = collect(root);
    expect(findings.map((f) => f.scope)).toContain("acme");
    expect(summary.scopes).toEqual(["personal", "acme"]);
  });

  test("rescan_limited_to_requested_scope", () => {
    const root = fixture();
    writeFileSync(join(root, "acme", "leaky.md"), note(`key ${AWS_KEY}`));
    const { findings, summary } = collect(root, { scopes: ["personal"] });
    expect(findings).toEqual([]);
    expect(summary.scopes).toEqual(["personal"]);
    expect(summary.filesScanned).toBe(2);
  });

  test("rescan_counts_files_and_reject_findings", () => {
    const root = fixture();
    writeFileSync(join(root, "personal", "leaky.md"), note(`key ${AWS_KEY}`));
    const { summary } = collect(root);
    expect(summary.filesScanned).toBe(4);
    expect(summary.filesWithFindings).toBe(1);
    expect(summary.rejectCount).toBe(1);
    expect(summary.warnCount).toBe(0);
  });

  test("rescan_is_read_only", () => {
    const root = fixture();
    const path = join(root, "personal", "leaky.md");
    const content = note(`key ${AWS_KEY}`);
    writeFileSync(path, content);
    const before = statSync(path).mtimeMs;
    collect(root);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("rescan_records_unreadable_files_without_throwing", () => {
    if (process.getuid?.() === 0) return; // root reads anything; nothing to assert
    const root = fixture();
    const path = join(root, "personal", "locked.md");
    writeFileSync(path, note("whatever"));
    chmodSync(path, 0o000);
    try {
      const { summary } = collect(root);
      expect(summary.unreadable).toEqual([path]);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("rescan_output_is_ordered_by_path_then_line", () => {
    const root = fixture();
    writeFileSync(join(root, "personal", "a-leak.md"), note(`key ${AWS_KEY}`));
    writeFileSync(join(root, "personal", "z-leak.md"), note(`key ${AWS_KEY}`));
    const { findings } = collect(root, { scopes: ["personal"] });
    expect(findings.map((f) => f.path)).toEqual([
      join(root, "personal", "a-leak.md"),
      join(root, "personal", "z-leak.md"),
    ]);
  });
});
