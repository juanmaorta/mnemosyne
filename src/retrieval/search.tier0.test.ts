// src/retrieval/search.tier0.test.ts
//
// Tier 0 (MNE-19): `search` and `context` must work with NO embedder, ranking
// by BM25 over the FTS5 table that every upsert already fills. This is a new,
// additive path — it only runs when `embedder` is null — so it must not touch
// the calibrated vector path (MNE-77 cosine-only) at all.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { searchExplain } from "./search.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { systemClock } from "../clock.js";

function note(root: string, scope: string, slug: string, desc: string, body: string) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${desc}`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
}

async function indexedTier0() {
  const root = mkdtempSync(join(tmpdir(), "mneme-tier0-"));
  note(root, "personal", "fermentor", "yogurt maker", "yogurt maker control fermentation temperature");
  note(root, "personal", "router", "network router", "omada router network wifi mesh");
  note(root, "work", "policy", "policy search", "retention policy review status deadline");
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: null });
  return { db, root };
}

describe("tier 0 — no embedder", () => {
  test("reindex_without_embedder_populates_fts_and_leaves_vectors_empty", async () => {
    const { db } = await indexedTier0();
    const engrams = (db.prepare("select count(*) as n from engrams").get() as { n: number }).n;
    const fts = (db.prepare("select count(*) as n from fts_engrams").get() as { n: number }).n;
    const vec = (db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n;
    expect(engrams).toBe(3);
    expect(fts).toBe(3); // BM25 has something to rank
    expect(vec).toBe(0); // no vectors without an embedder
  });

  test("search_without_embedder_finds_the_lexically_matching_note", async () => {
    const { db, root } = await indexedTier0();
    const res = await searchExplain(
      { db, root, embedder: null, clock: systemClock },
      { query: "yogurt maker" },
    );
    const included = res.candidates.filter((c) => c.included).map((c) => c.slug);
    expect(included[0]).toBe("fermentor");
  });

  test("search_without_embedder_disables_the_cosine_floor", async () => {
    const { db, root } = await indexedTier0();
    const res = await searchExplain(
      { db, root, embedder: null, clock: systemClock },
      { query: "yogurt maker" },
    );
    // There is no cosine in tier 0, so there is nothing to floor.
    expect(res.minCos).toBeNull();
  });

  test("search_without_embedder_ranks_a_stronger_lexical_match_higher", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-tier0-rank-"));
    note(root, "personal", "strong", "router guide", "router router router network router config");
    note(root, "personal", "weak", "misc note", "a passing mention of a router once");
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: null });
    const res = await searchExplain(
      { db, root, embedder: null, clock: systemClock },
      { query: "router" },
    );
    const order = res.candidates.map((c) => c.slug);
    expect(order.indexOf("strong")).toBeLessThan(order.indexOf("weak"));
  });

  test("enabling_an_embedder_after_tier0_backfills_the_missing_vectors", async () => {
    // Regression (Codex P1): tier 0 writes file_state but no vectors. When an
    // embedder is enabled later, unchanged notes must not stay invisible to
    // vector search — a reindex with an embedder has to backfill them.
    const { db, root } = await indexedTier0();
    expect((db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n).toBe(0);
    await reindex({ root, db, embedder: createFakeEmbedder() });
    const engrams = (db.prepare("select count(*) as n from engrams").get() as { n: number }).n;
    const vec = (db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n;
    expect(vec).toBe(engrams); // every note now has a vector
    const res = await searchExplain(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "yogurt maker" },
    );
    expect(res.candidates.some((c) => c.slug === "fermentor")).toBe(true);
  });

  test("scoped_backfill_after_tier0_does_not_wipe_other_scopes_vectors", async () => {
    // Regression (Codex P1): backfilling missing vectors must not reset the
    // whole vector table — a scoped reindex (as `context` runs every session)
    // for one scope would otherwise strip another scope's vectors and re-embed
    // unchanged notes forever.
    const { db, root } = await indexedTier0(); // personal (2) + work (1)
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["work"] });
    const engrams = (db.prepare("select count(*) as n from engrams").get() as { n: number }).n;
    const vec = (db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n;
    expect(vec).toBe(engrams); // every scope keeps its vectors
    const res = await searchExplain(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "yogurt maker", scopes: ["personal"] },
    );
    expect(res.candidates.some((c) => c.slug === "fermentor")).toBe(true);
  });

  test("enabling_a_non_default_dim_embedder_after_tier0_initializes_without_force", async () => {
    // Regression (Codex): a tier-0 index has engram rows but an empty, default-
    // width vector table and no model stamp. Enabling a non-768-dim model must
    // be treated as first-time vector init, not a model change — there are no
    // vectors to protect, so it must NOT demand --force-embedder.
    const { db, root } = await indexedTier0();
    await expect(reindex({ root, db, embedder: createFakeEmbedder(1024) })).resolves.toBeDefined();
    const engrams = (db.prepare("select count(*) as n from engrams").get() as { n: number }).n;
    const vec = (db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n;
    expect(vec).toBe(engrams);
  });

  test("a_note_deleted_during_tier0_is_pruned_once_an_embedder_is_enabled", async () => {
    // Regression (Codex P2): the backfill must not clear file_state before
    // pruning, or a note deleted during the tier-0 window survives forever.
    const { rmSync } = await import("node:fs");
    const { db, root } = await indexedTier0();
    rmSync(join(root, "personal", "router.md"));
    await reindex({ root, db, embedder: createFakeEmbedder() });
    const left = db.prepare("select slug from engrams where slug = 'router'").all();
    expect(left).toHaveLength(0); // pruned, not stranded
  });

  test("a_note_deleted_during_tier0_is_pruned_when_promoting_to_a_non_default_embedder", async () => {
    // Regression (Codex): promoting tier 0 to a non-default-dim model goes
    // through the rebuild path, which must still prune a note deleted during the
    // tier-0 window rather than stranding it in engrams/fts forever.
    const { rmSync } = await import("node:fs");
    const { db, root } = await indexedTier0();
    rmSync(join(root, "personal", "router.md"));
    await reindex({ root, db, embedder: createFakeEmbedder(1024) });
    expect(db.prepare("select slug from engrams where slug = 'router'").all()).toHaveLength(0);
  });

  test("bm25_ties_get_equal_relevance_so_the_scope_slug_tiebreak_decides", async () => {
    // Regression (Codex): two notes with identical matching text get equal BM25.
    // Positional relevance would give them DIFFERENT scores and bypass the
    // scope/slug tiebreak, making the winner depend on DB row order. Equal BM25
    // must mean equal relevance, with the deterministic tiebreak deciding order.
    const root = mkdtempSync(join(tmpdir(), "mneme-tier0-tie-"));
    note(root, "personal", "bbb", "router note", "router router router");
    note(root, "personal", "aaa", "router note", "router router router");
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: null });
    const res = await searchExplain(
      { db, root, embedder: null, clock: systemClock },
      { query: "router" },
    );
    const rels = res.candidates.map((c) => c.signals.relevanceCosine.toFixed(6));
    expect(new Set(rels).size).toBe(1); // equal BM25 → equal relevance
    expect(res.candidates.map((c) => c.slug)).toEqual(["aaa", "bbb"]); // tiebreak, not row order
  });

  test("search_without_embedder_returns_nothing_for_a_query_with_no_terms", async () => {
    const { db, root } = await indexedTier0();
    const res = await searchExplain(
      { db, root, embedder: null, clock: systemClock },
      { query: "   " },
    );
    expect(res.candidates).toHaveLength(0);
  });
});
