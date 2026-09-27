import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb, getMeta, vectorIndexDim } from "./db.js";
import { EmbedderMismatchError, reindex } from "./reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import type { EmbeddingClient } from "../embeddings.js";
import { readTelemetry } from "../telemetry/events.js";
import { fixedClock } from "../clock.js";

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

  test("reindex_embeds_notes_with_the_document_role", async () => {
    const root = store();
    const fake = createFakeEmbedder();
    const roles: string[] = [];
    const embedder: EmbeddingClient = {
      ...fake,
      async embed(texts, role) {
        roles.push(role ?? "missing");
        return fake.embed(texts, role);
      },
    };
    await reindex({ root, db: openDb(":memory:"), embedder, scopes: ["personal"] });
    expect(roles).toEqual(["document"]);
  });

  test("reindex_skips_unchanged_files_on_second_run", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats).toMatchObject({ indexed: 0, skipped: 1 });
  });

  test("reindex_stamps_the_embedding_model_id", async () => {
    const root = store();
    const db = openDb(":memory:");
    const embedder = createFakeEmbedder();

    const stats = await reindex({ root, db, embedder, scopes: ["personal"] });

    expect(stats.embeddingMismatch).toBe(false);
    expect(getMeta(db, "embedding_id")).toBe(embedder.id);
  });

  test("reindex_reembeds_everything_when_the_embedding_model_changes", async () => {
    // Vectors from two models are not comparable — a silent mix would corrupt
    // every cosine distance without any error surfacing. That rebuild still
    // happens — since MNE-70 it happens when asked, because rebuilding unasked
    // at session start is its own kind of failure.
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(getMeta(db, "embedding_id")).toBe("fake-bow/dim768");

    const otherModel: EmbeddingClient = { ...createFakeEmbedder(), id: "other-model/dim768" };
    const stats = await reindex({ root, db, embedder: otherModel, scopes: ["personal"], forceEmbedder: true });

    expect(stats.embeddingMismatch).toBe(true);
    expect(stats.indexed).toBe(1); // re-embedded, not skipped as unchanged
    expect(stats.skipped).toBe(0);
    expect(getMeta(db, "embedding_id")).toBe("other-model/dim768");
    // Exactly one vector: the stale one was dropped, not left orphaned.
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
  });

  test("reindex_does_not_report_mismatch_on_a_fresh_index", async () => {
    // No previous stamp is not a mismatch — it is a first run.
    const root = store();
    const stats = await reindex({ root, db: openDb(":memory:"), embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.embeddingMismatch).toBe(false);
  });

  test("reindex_emits_engram_indexed_with_the_reason", async () => {
    const root = store();
    const db = openDb(":memory:");
    const clock = fixedClock(Date.parse("2026-08-07T10:00:00.000Z"));

    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"], clock });

    const first = readTelemetry(root).filter((e) => e.kind === "engram.indexed");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      scope: "personal", slug: "yogurtera", embeddingId: "fake-bow/dim768", dim: 768, reason: "new",
    });

    // Rewrite with different bytes → the reason becomes `hash`, not `new`.
    const path = join(root, "personal", "yogurtera.md");
    const [, changed] = note("personal", "yogurtera", "completely different sourdough content");
    writeFileSync(path, changed);
    const future = new Date(statSync(path).mtimeMs + 5000);
    utimesSync(path, future, future);
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"], clock });

    const all = readTelemetry(root).filter((e) => e.kind === "engram.indexed");
    expect(all).toHaveLength(2);
    expect(all[1]!.reason).toBe("hash");
  });

  test("reindex_emits_nothing_for_skipped_files", async () => {
    const root = store();
    const db = openDb(":memory:");
    const embedder = createFakeEmbedder();
    await reindex({ root, db, embedder, scopes: ["personal"] });
    await reindex({ root, db, embedder, scopes: ["personal"] }); // all skipped

    expect(readTelemetry(root).filter((e) => e.kind === "engram.indexed")).toHaveLength(1);
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

  test("reindex_scoped_does_not_prune_other_scopes", async () => {
    // A scoped reindex walks only the given scope, so `seen` never contains
    // other scopes' paths. The prune phase must NOT treat those unseen paths
    // as deleted files — otherwise a scoped reindex (e.g. the SessionStart
    // `mneme context` hook) wipes every other scope from the index.
    const root = store(); // personal/yogurtera
    mkdirSync(join(root, "acme"), { recursive: true });
    const [tf, tc] = note("acme", "backend", "auth gateway notes");
    writeFileSync(join(root, "acme", tf), tc);

    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder() }); // full: both scopes
    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 2 });

    // Scoped reindex of personal only — acme must survive untouched.
    const stats = await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    expect(stats.deleted).toBe(0);
    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 2 });
    expect(db.prepare("select count(*) as n from engrams where scope = ?").get("acme")).toEqual({ n: 1 });
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

describe("reindex vector width", () => {
  test("reindex_fits_a_fresh_index_to_a_non_default_dimension", async () => {
    // A store created at the default width and first indexed with a 1024-dim
    // model must end up with a 1024-dim table, not with per-file insert errors.
    const root = store();
    const db = openDb(":memory:");

    const stats = await reindex({ root, db, embedder: createFakeEmbedder(1024), scopes: ["personal"] });

    expect(stats).toMatchObject({ indexed: 1, errors: 0 });
    expect(vectorIndexDim(db)).toBe(1024);
  });

  test("reindex_rebuilds_the_vector_index_when_the_dimension_changes", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const stats = await reindex({ root, db, embedder: createFakeEmbedder(1024), scopes: ["personal"], forceEmbedder: true });

    expect(stats).toMatchObject({ embeddingMismatch: true, indexed: 1, skipped: 0, errors: 0 });
    expect(vectorIndexDim(db)).toBe(1024);
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
  });

  test("reindex_records_the_dimension_the_embedder_actually_produced", async () => {
    const root = store();
    const db = openDb(":memory:");

    await reindex({ root, db, embedder: createFakeEmbedder(1024), scopes: ["personal"] });

    const events = readTelemetry(root).filter((e) => e.kind === "engram.indexed");
    expect(events[0]).toMatchObject({ embeddingId: "fake-bow/dim1024", dim: 1024 });
  });
});

describe("reindex and a changed embedder", () => {
  /** The same fake vectors under a different model name. */
  function otherModel(dim?: number): EmbeddingClient {
    const inner = createFakeEmbedder(dim);
    return { ...inner, id: `other-model/dim${inner.dim}` };
  }

  test("reindex_refuses_to_rebuild_an_index_built_by_another_embedder", async () => {
    // Rebuilding is not free and it is not silent-safe: it costs one embedder
    // call per engram, it happens at session start because that is when the
    // lazy reindex runs, and there is no search until it finishes. An
    // environment variable that disagrees with the index is a mistake far more
    // often than an intention, so it has to be said out loud.
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    await expect(reindex({ root, db, embedder: otherModel(), scopes: ["personal"] }))
      .rejects.toThrow(EmbedderMismatchError);
    // And the index it refused to touch is still there, still serving.
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
  });

  test("reindex_says_both_sides_and_how_to_proceed", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    await expect(reindex({ root, db, embedder: otherModel(), scopes: ["personal"] }))
      .rejects.toThrow(/fake-bow.*other-model|other-model.*fake-bow/s);
  });

  test("reindex_rebuilds_when_the_change_is_asked_for", async () => {
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const stats = await reindex({ root, db, embedder: otherModel(), scopes: ["personal"], forceEmbedder: true });

    expect(stats.embeddingMismatch).toBe(true);
    expect(stats.indexed).toBe(1);
    expect(getMeta(db, "embedding_id")).toBe("other-model/dim768");
  });

  test("reindex_builds_a_fresh_index_at_any_width_without_being_asked_twice", async () => {
    // Nothing to lose and nothing to surprise: an empty index adopts whatever
    // embedder shows up first. Refusing here would make the very first run of a
    // non-default model an error, which is absurd.
    const root = store();
    const db = openDb(":memory:");

    const stats = await reindex({ root, db, embedder: otherModel(1024), scopes: ["personal"] });

    expect(stats.indexed).toBe(1);
    expect(vectorIndexDim(db)).toBe(1024);
  });
});

describe("a rebuild that fails", () => {
  /** An embedder that agrees to exist and then refuses to work. */
  function brokenEmbedder(): EmbeddingClient {
    return {
      id: "broken-model/dim768",
      dim: 768,
      async embed() { throw new Error("Cannot reach Ollama at http://localhost:11434"); },
    };
  }

  test("reindex_leaves_the_old_index_serving_when_the_new_embedder_fails", async () => {
    // The failure this guards is mundane: you ask for the rebuild, and Ollama
    // is down or the model was never pulled. Destroying the index first and
    // finding that out second leaves the store with no retrieval at all, which
    // is strictly worse than not having tried.
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    await expect(reindex({ root, db, embedder: brokenEmbedder(), scopes: ["personal"], forceEmbedder: true }))
      .rejects.toThrow(/Cannot reach Ollama/);

    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from engrams").get()).toEqual({ n: 1 });
    // And the stamp still names the embedder whose vectors are actually in there.
    expect(getMeta(db, "embedding_id")).toBe("fake-bow/dim768");
  });

  test("reindex_reembeds_files_that_did_not_change_when_rebuilding", async () => {
    // The old code got this for free by wiping file_state up front. Deferring
    // that wipe would silently turn a rebuild into "drop every vector and
    // re-insert none", because untouched files look unchanged.
    const root = store();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const other: EmbeddingClient = { ...createFakeEmbedder(), id: "other-model/dim768" };
    const stats = await reindex({ root, db, embedder: other, scopes: ["personal"], forceEmbedder: true });

    expect(stats).toMatchObject({ indexed: 1, skipped: 0 });
    expect(db.prepare("select count(*) as n from vec_engrams").get()).toEqual({ n: 1 });
  });
});
