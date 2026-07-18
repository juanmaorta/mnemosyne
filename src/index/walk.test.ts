// src/index/walk.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listScopes, listEngramFiles } from "./walk.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-walk-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  mkdirSync(join(root, "acme"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  mkdirSync(join(root, ".index"), { recursive: true });
  writeFileSync(join(root, "personal", "yogurtera.md"), "x");
  writeFileSync(join(root, "personal", "facts", "01J000000000000000000000AA.md"), "x");
  writeFileSync(join(root, "personal", "facts", "notes.txt"), "x"); // ignored
  writeFileSync(join(root, "archive", "old.md"), "x"); // ignored
  return root;
}

describe("listScopes", () => {
  test("listScopes_excludes_archive_index_and_dotdirs", () => {
    expect(listScopes(fixture()).sort()).toEqual(["personal", "acme"]);
  });

  test("listScopes_excludes_non_kebab_case_dirs", () => {
    const root = fixture();
    mkdirSync(join(root, "My_Scope"), { recursive: true });
    mkdirSync(join(root, "Personal"), { recursive: true });
    expect(listScopes(root).sort()).toEqual(["personal", "acme"]);
  });
});

describe("listEngramFiles", () => {
  test("listEngramFiles_returns_notes_and_valid_facts", () => {
    const files = listEngramFiles(fixture(), ["personal"]);
    const rels = files
      .map((f) => ({ isFact: f.isFact, base: f.path.split("/").slice(-1)[0] }))
      .sort((a, b) => (a.base ?? "").localeCompare(b.base ?? ""));
    expect(rels).toEqual([
      { isFact: true, base: "01J000000000000000000000AA.md" },
      { isFact: false, base: "yogurtera.md" },
    ]);
  });

  test("listEngramFiles_falls_back_to_all_scopes_when_omitted", () => {
    const root = fixture();
    writeFileSync(join(root, "acme", "acme-note.md"), "x");
    const files = listEngramFiles(root);
    const byScope = new Map(files.map((f) => [f.path.split("/").slice(-1)[0], f.scope]));
    expect(byScope.get("yogurtera.md")).toBe("personal");
    expect(byScope.get("01J000000000000000000000AA.md")).toBe("personal");
    expect(byScope.get("acme-note.md")).toBe("acme");
  });

  test("listEngramFiles_does_not_throw_on_non_kebab_dir_when_scopes_omitted", () => {
    const root = fixture();
    mkdirSync(join(root, "My_Scope"), { recursive: true });
    writeFileSync(join(root, "My_Scope", "orphan.md"), "x");
    expect(() => listEngramFiles(root)).not.toThrow();
    const files = listEngramFiles(root);
    expect(files.some((f) => f.path.includes("My_Scope"))).toBe(false);
  });
});
