// src/write/validation.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertNoSecrets,
  assertOwnsScope,
  NotOwnerError,
  resolveWriteScope,
  ScopeUnresolvedError,
  SecretDetectedError,
} from "./validation.js";

function store(owns: string[] | null, scopemap?: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "mneme-val-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  if (owns) writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  if (scopemap) writeFileSync(join(root, ".scopemap"), scopemap);
  return { root, home: mkdtempSync(join(tmpdir(), "mneme-home-")) };
}

describe("resolveWriteScope", () => {
  test("explicit_scope_wins_over_the_scopemap", () => {
    const { root, home } = store(["personal"], "/repo = work\n");
    expect(resolveWriteScope({ root, cwd: "/repo", home }, "personal")).toBe("personal");
  });

  test("cwd_resolves_through_the_scopemap", () => {
    const { root, home } = store(["personal"], "/repo = work\n");
    expect(resolveWriteScope({ root, cwd: "/repo/src", home })).toBe("work");
  });

  test("unmapped_cwd_is_fail_closed", () => {
    const { root, home } = store(["personal"], "/repo = work\n");
    expect(() => resolveWriteScope({ root, cwd: "/somewhere/else", home })).toThrow(ScopeUnresolvedError);
  });
});

describe("assertOwnsScope", () => {
  test("owned_scope_passes", () => {
    const { root } = store(["personal", "work"]);
    expect(() => assertOwnsScope(root, "work")).not.toThrow();
  });

  test("unowned_scope_throws_naming_the_scope", () => {
    const { root } = store(["personal"]);
    try {
      assertOwnsScope(root, "work");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotOwnerError);
      expect((e as NotOwnerError).scope).toBe("work");
    }
  });
});

describe("assertNoSecrets", () => {
  test("clean_text_returns_no_findings", () => {
    expect(assertNoSecrets("nothing to see here")).toEqual([]);
  });

  test("reject_finding_throws_with_the_secret_masked", () => {
    try {
      assertNoSecrets("key is sk-abcdefghij0123456789");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretDetectedError);
      const findings = (e as SecretDetectedError).findings;
      expect(findings).toHaveLength(1);
      expect(findings.every((f) => f.severity === "reject")).toBe(true);
      expect(JSON.stringify(findings)).not.toContain("sk-abcdefghij0123456789");
    }
  });

  test("warn_findings_are_returned_without_throwing", () => {
    const findings = assertNoSecrets("token candidate aGVsbG93b3JsZGhlbGxvd29ybGQxMjM0NTY3ODkw");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === "warn")).toBe(true);
  });

  test("scans_the_whole_document_not_just_the_body", () => {
    // The caller hands over frontmatter + body, so a secret hidden in
    // `description` is caught too — the bypass `add` used to have.
    const doc = [
      "---",
      "name: d",
      "description: token sk-abcdefghij0123456789",
      "---",
      "innocent body",
      "",
    ].join("\n");
    expect(() => assertNoSecrets(doc)).toThrow(SecretDetectedError);
  });
});
