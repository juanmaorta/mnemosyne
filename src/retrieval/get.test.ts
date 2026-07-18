import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { getEngram, NotFoundError, AmbiguousSlugError } from "./get.js";
import { createFakeEmbedder } from "../embeddings.fake.js";

function note(root: string, scope: string, slug: string) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} d`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `body of ${slug} in ${scope}`, ""].join("\n"));
}

async function db(setup: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "mneme-get-"));
  setup(root);
  const d = openDb(":memory:");
  await reindex({ root, db: d, embedder: createFakeEmbedder() });
  return d;
}

describe("getEngram", () => {
  test("getEngram_returns_full_content", async () => {
    const d = await db((r) => note(r, "personal", "yogurtera"));
    expect(getEngram(d, "yogurtera").content).toContain("body of yogurtera in personal");
  });
  test("getEngram_throws_NotFound_for_missing_slug", async () => {
    const d = await db((r) => note(r, "personal", "yogurtera"));
    expect(() => getEngram(d, "nope")).toThrow(NotFoundError);
  });
  test("getEngram_throws_Ambiguous_when_slug_in_multiple_scopes", async () => {
    const d = await db((r) => { note(r, "personal", "shared"); note(r, "acme", "shared"); });
    expect(() => getEngram(d, "shared")).toThrow(AmbiguousSlugError);
  });
  test("getEngram_disambiguates_with_scope", async () => {
    const d = await db((r) => { note(r, "personal", "shared"); note(r, "acme", "shared"); });
    expect(getEngram(d, "shared", "acme").content).toContain("in acme");
  });
});
