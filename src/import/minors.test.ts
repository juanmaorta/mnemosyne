// src/import/minors.test.ts — MNE-40: minor importer cleanups.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fingerprintOf, normalizeSourceFile } from "./plan.js";
import { importClaudeMemory, type ImportFileResult, type ImportReport } from "./claude.js";

function sourceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-native-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-import-"));
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  return root;
}
function native(front: string[], body: string): string {
  return ["---", ...front, "---", "", body, ""].join("\n");
}
function byName(report: ImportReport): Record<string, ImportFileResult> {
  return Object.fromEntries(report.files.map((f) => [f.filename, f]));
}
const input = { sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00" };

describe("MNE-40: fingerprint is unambiguous across the field boundary", () => {
  test("a (description, body) pair cannot collide by shifting a newline across the join", () => {
    // Under a naive `[type, description, body].join("\n")`, these two produce the
    // same string — the newline just moves from body into description.
    const a = fingerprintOf({ type: "reference", description: "x", body: "a\nb" });
    const b = fingerprintOf({ type: "reference", description: "x\na", body: "b" });
    expect(a).not.toBe(b);
  });

  test("identical content still fingerprints identically (dedupe intact)", () => {
    const one = fingerprintOf({ type: "reference", description: "same", body: "body\ntext" });
    const two = fingerprintOf({ type: "reference", description: "same", body: "body\ntext" });
    expect(one).toBe(two);
  });
});

describe("MNE-40: .md extension is matched case-insensitively", () => {
  test("an uppercase .MD file is treated as markdown, not silently ignored", () => {
    const src = sourceDir({ "NOTE.MD": native(["type: reference", "description: d"], "cuerpo") });
    const report = importClaudeMemory({ root: store(), home: "/tmp" }, { source: src, sourceId: "repo-a", scope: "personal", apply: false });
    const file = byName(report)["NOTE.MD"]!;
    expect(file.status).not.toBe("ignored");
    expect(file.reason).not.toBe("not markdown");
  });

  test("an uppercase native index file is still ignored as an index", () => {
    const src = sourceDir({ "MEMORY.MD": native(["type: reference", "description: d"], "x") });
    const report = importClaudeMemory({ root: store(), home: "/tmp" }, { source: src, sourceId: "repo-a", scope: "personal", apply: false });
    expect(byName(report)["MEMORY.MD"]!.status).toBe("ignored");
  });

  test("a genuinely non-markdown file is still ignored", () => {
    const src = sourceDir({ "notes.txt": "plain text" });
    const report = importClaudeMemory({ root: store(), home: "/tmp" }, { source: src, sourceId: "repo-a", scope: "personal", apply: false });
    const file = byName(report)["notes.txt"]!;
    expect(file.status).toBe("ignored");
    expect(file.reason).toBe("not markdown");
  });
});

describe("MNE-40: native-path warning is not triggered by any .md mention", () => {
  test("a plain mention of some README.md does NOT warn about native memory", () => {
    const r = normalizeSourceFile({ ...input, filename: "a.md", raw: native(["type: reference", "description: d"], "see README.md for setup") });
    const warnings = (r.ok ? r.candidate.warnings : []).join(" ");
    expect(warnings).not.toMatch(/native memory/i);
  });

  test("a real native reference still warns", () => {
    const viaPath = normalizeSourceFile({ ...input, filename: "a.md", raw: native(["type: reference", "description: d"], "from ~/.claude/projects/x/memory") });
    const viaIndex = normalizeSourceFile({ ...input, filename: "b.md", raw: native(["type: reference", "description: d"], "listed in MEMORY.md") });
    expect((viaPath.ok ? viaPath.candidate.warnings : []).join(" ")).toMatch(/native memory/i);
    expect((viaIndex.ok ? viaIndex.candidate.warnings : []).join(" ")).toMatch(/native memory/i);
  });
});
