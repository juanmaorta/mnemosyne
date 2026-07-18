import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "./db.js";
import { reindex } from "./reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";

function note(scope: string, slug: string, body: string): [string, string] {
  const fm = ["---", `name: ${slug}`, `description: ${slug} desc`, `scope: ${scope}`,
    "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n");
  return [`${slug}.md`, fm];
}

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-reindex-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  const [f, c] = note("personal", "yogurtera", "yogurt maker control notes");
  writeFileSync(join(root, "personal", f), c);
  return root;
}

describe("reindex", () => {
  test("reindex_indexes_new_files", async () => {
    const root = store();
    const db = openDb(":memory:");
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.indexed).toBe(1);
    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
  });

  test("reindex_skips_unchanged_files_on_second_run", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats).toMatchObject({ indexed: 0, skipped: 1 });
  });

  test("reindex_prunes_rows_for_deleted_files", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    rmSync(join(root, "personal", "yogurtera.md"));
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.deleted).toBe(1);
    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 0 });
  });

  test("reindex_counts_error_and_continues_on_invalid_frontmatter", async () => {
    const root = store();
    writeFileSync(join(root, "personal", "broken.md"),
      ["---", "name: Broken Slug!!", "---", "x", ""].join("\n")); // invalid slug → schema error
    const db = openDb(":memory:");
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.indexed).toBe(1);
    expect(stats.errors).toBe(1);
  });

  test("reindex_updates_changed_file_without_orphaning_vectors", async () => {
    const root = store();
    // Two more notes, alphabetically before and after "yogurtera", so the row
    // being changed is neither the first nor the last indexed. Deleting a
    // non-max rowid and re-inserting (autoincrement bumps past the current
    // max) yields a NEW id different from the old one — this is what exposes
    // the orphaning bug: with only one file, SQLite's rowid reuse on an
    // otherwise-empty table would coincidentally match the old id and hide it.
    const [af, ac] = note("personal", "apple-notes", "apple orchard notes");
    writeFileSync(join(root, "personal", af), ac);
    const [zf, zc] = note("personal", "zucchini-notes", "zucchini garden notes");
    writeFileSync(join(root, "personal", zf), zc);

    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const path = join(root, "personal", "yogurtera.md");
    const [, updated] = note("personal", "yogurtera", "completely different content about sourdough starters");
    writeFileSync(path, updated);
    // Bump mtime forward so needsReindex triggers regardless of filesystem mtime resolution.
    const future = new Date(statSync(path).mtimeMs + 5000);
    utimesSync(path, future, future);

    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.indexed).toBe(1);

    const engramCount = db.prepare("select count(*) as n from engrams").get();
    const vecCount = db.prepare("select count(*) as n from vec_engrams").get();
    const ftsCount = db.prepare("select count(*) as n from fts_engrams").get();
    expect(vecCount).toEqual(engramCount);
    expect(ftsCount).toEqual(engramCount);

    const row = db.prepare("select snippet from engrams where slug = ?").get("yogurtera") as { snippet: string };
    expect(row.snippet).toContain("sourdough starters");
  });

  test("reindex_rescope_does_not_orphan_old_row", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    // Rewrite the SAME path, changing only the frontmatter slug (`name:`).
    // Identity must be tracked by path, not by (slug, scope) — otherwise the
    // old (slug=yogurtera) row survives as an orphan alongside the new one.
    const path = join(root, "personal", "yogurtera.md");
    const [, renamed] = note("personal", "kefir-notes", "kefir culture notes, renamed from yogurtera");
    writeFileSync(path, renamed);
    const future = new Date(statSync(path).mtimeMs + 5000);
    utimesSync(path, future, future);

    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.indexed).toBe(1);

    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from fts_engrams").get()).toEqual({ n: 1 });

    const row = db.prepare("select slug from engrams").get() as { slug: string };
    expect(row.slug).toBe("kefir-notes");
  });

  test("reindex_scope_change_at_same_path_does_not_orphan_old_row", async () => {
    // Scope is a directory-mapped field (walk.ts assigns EngramFile.scope from
    // the folder), but the ENGRAM ROW's scope column comes from frontmatter
    // (engram.scope), not from the folder. Editing just the frontmatter
    // `scope:` value while leaving the file in place exercises exactly the
    // same path-vs-identity bug as the slug case: the OLD (scope, slug) pair
    // must not survive as an orphan.
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const path = join(root, "personal", "yogurtera.md");
    const [, rescoped] = note("shared", "yogurtera", "yogurt maker notes, now shared scope");
    writeFileSync(path, rescoped);
    const future = new Date(statSync(path).mtimeMs + 5000);
    utimesSync(path, future, future);

    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.indexed).toBe(1);

    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });

    const row = db.prepare("select scope from engrams").get() as { scope: string };
    expect(row.scope).toBe("shared");
  });
});
