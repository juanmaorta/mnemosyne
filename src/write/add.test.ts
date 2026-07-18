// src/write/add.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addMemory, ScopeUnresolvedError, NotOwnerError, SecretDetectedError, NoteExistsError } from "./add.js";

const NOW = "2026-07-09T10:00:00";

function store(owns: string[] | null, scopemap?: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "mneme-add-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  if (owns) writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  const home = mkdtempSync(join(tmpdir(), "mneme-home-"));
  if (scopemap) writeFileSync(join(root, ".scopemap"), scopemap);
  return { root, home };
}

describe("addMemory", () => {
  test("add_feedback_writes_immutable_fact_in_scope", () => {
    const { root, home } = store(["personal"]);
    const res = addMemory({ root, cwd: "/anywhere", home, now: NOW },
      { content: "deploys run at 3am UTC", type: "feedback", scope: "personal", description: "deploy window" });
    expect(res.kind).toBe("fact");
    expect(res.path).toMatch(/\/personal\/facts\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    expect(readFileSync(res.path, "utf8")).toContain("deploys run at 3am UTC");
  });

  test("add_refuses_when_cwd_unmapped_and_no_scope", () => {
    const { root, home } = store(["personal"], "~/Projects/acme = acme\n");
    expect(() => addMemory({ root, cwd: "/somewhere/else", home, now: NOW },
      { content: "x", type: "feedback", description: "d" })).toThrow(ScopeUnresolvedError);
  });

  test("add_refuses_when_machine_not_owner_of_scope", () => {
    const { root, home } = store(["personal"]); // does NOT own acme
    mkdirSync(join(root, "acme"), { recursive: true });
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "client note", type: "feedback", scope: "acme", description: "d" })).toThrow(NotOwnerError);
  });

  test("add_refuses_on_reject_secret", () => {
    const { root, home } = store(["personal"]);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "key is sk-abcdefghij0123456789", type: "feedback", scope: "personal", description: "d" }))
      .toThrow(SecretDetectedError);
  });

  test("add_reference_creates_note_and_refuses_overwrite", () => {
    const { root, home } = store(["personal"]);
    const opts = { content: "how we tag releases", type: "reference" as const, scope: "personal", description: "release tagging", slug: "release-tagging" };
    const res = addMemory({ root, cwd: "/x", home, now: NOW }, opts);
    expect(res.kind).toBe("note");
    expect(res.path).toMatch(/\/personal\/release-tagging\.md$/);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW }, opts)).toThrow(NoteExistsError);
  });

  test("add_refuses_traversal_shaped_scope_and_writes_nothing", () => {
    // Owner policy explicitly "owns" the malicious scope so the owner gate
    // (Gate 2) passes and execution actually reaches the schema/assertSafeScope
    // guard — proving the traversal is blocked there, not incidentally upstream.
    const { root, home } = store(["personal", "../evil"]);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "x", type: "feedback", scope: "../evil", description: "d" })).toThrow();

    // Nothing was materialized outside <root>/personal, and no traversal
    // escaped the root either.
    expect(existsSync(join(root, "..", "evil"))).toBe(false);
    expect(existsSync(join(root, "evil"))).toBe(false);
  });
});
