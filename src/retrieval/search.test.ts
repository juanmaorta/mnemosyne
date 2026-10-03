// src/retrieval/search.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { search, searchExplain, resolveMinCos, NOMIC_MIN_COS } from "./search.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { fixedClock, systemClock } from "../clock.js";
import { recordAccess } from "../hotstate.js";
import type { EmbeddingClient } from "../embeddings.js";

function note(root: string, scope: string, slug: string, desc: string, body: string) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${desc}`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
}

async function indexed() {
  const root = mkdtempSync(join(tmpdir(), "mneme-search-"));
  note(root, "personal", "yogurtera", "yogurt maker", "yogurt maker control fermentation");
  note(root, "personal", "router", "network router", "omada router network wifi");
  note(root, "acme", "policy", "policy search", "insurance policy claim status");
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: createFakeEmbedder() });
  return { db, root };
}

describe("search", () => {
  test("defaults_the_floor_only_for_calibrated_nomic_embeddings", () => {
    expect(resolveMinCos("nomic-embed-text/dim768/task-prefix-v1")).toBe(NOMIC_MIN_COS);
    expect(resolveMinCos("nomic-embed-text:latest/dim768/task-prefix-v1")).toBe(NOMIC_MIN_COS);
    expect(resolveMinCos("nomic-embed-text-v2-moe/dim768/task-prefix-v1")).toBeNull();
    expect(resolveMinCos("other/dim768")).toBeNull();
    expect(resolveMinCos("other/dim768", 0.6)).toBe(0.6);
    expect(() => resolveMinCos("other/dim768", Number.NaN)).toThrow(/min-cos/);
  });

  test("search_default_weights_are_cosine_only", async () => {
    // Tarea A: search ranks by cosine. Recency and importance keep their role
    // in the `context` digest, not in the search candidate. The default must be
    // {recency:0, importance:0, relevance:1}, not the shared blended default.
    const { db, root } = await indexed();
    const res = await searchExplain(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "yogurt maker control" },
    );
    expect(res.weights).toEqual({ recency: 0, importance: 0, relevance: 1 });
  });

  test("filters_on_raw_cosine_before_the_blended_top-k_cut", async () => {
    const { db, root } = await indexed();
    const deps = { db, root, embedder: createFakeEmbedder(), clock: systemClock };
    const query = "yogurt maker control";
    const baseline = await searchExplain(deps, { query, k: 3 });
    const byCos = [...baseline.candidates].sort((a, b) => b.signals.relevanceCosine - a.signals.relevanceCosine);
    const floor = (byCos[0]!.signals.relevanceCosine + byCos[1]!.signals.relevanceCosine) / 2;
    const result = await searchExplain(deps, { query, k: 3, minCos: floor });
    expect(result.candidates.filter((c) => c.included).map((c) => c.slug)).toEqual([byCos[0]!.slug]);
    expect(result.candidates.filter((c) => !c.included).every((c) => c.signals.relevanceCosine < floor)).toBe(true);
    expect(result.candidates).toHaveLength(3); // diagnostics retain discarded candidates
  });

  test("search_embeds_the_query_with_the_query_role", async () => {
    const { db, root } = await indexed();
    const fake = createFakeEmbedder();
    const roles: string[] = [];
    const embedder: EmbeddingClient = {
      ...fake,
      async embed(texts, role) {
        roles.push(role ?? "missing");
        return fake.embed(texts, role);
      },
    };
    await search({ db, root, embedder, clock: systemClock }, { query: "yogurt" });
    expect(roles).toEqual(["query"]);
  });
  test("search_ranks_relevant_engram_first", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock }, { query: "yogurt maker control" });
    expect(hits[0]!.slug).toBe("yogurtera");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("search_returns_snippet_not_full_doc", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock }, { query: "yogurt" });
    expect(hits[0]).toMatchObject({ slug: "yogurtera", scope: "personal" });
    expect(typeof hits[0]!.snippet).toBe("string");
  });

  test("search_respects_scope_filter", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock }, { query: "policy", scopes: ["personal"] });
    expect(hits.every((h) => h.scope === "personal")).toBe(true);
  });

  test("search_honors_k_limit", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock }, { query: "router", k: 1 });
    expect(hits).toHaveLength(1);
  });

  test("search_reads_recency_from_the_injected_clock", async () => {
    const { db, root } = await indexed();
    // Recency only participates once an engram has a real access event —
    // never-accessed notes are pinned to neutral (see search.ts). Seed one so
    // the clock actually reaches the score.
    const accessedAt = "2026-06-02T10:00:00.000Z";
    recordAccess(db, root, "personal", "yogurtera", accessedAt);
    const embedder = createFakeEmbedder();
    const t0 = Date.parse(accessedAt);
    const q = { query: "yogurt maker control" };

    const fresh = await search({ db, root, embedder, clock: fixedClock(t0) }, q);
    const stale = await search({ db, root, embedder, clock: fixedClock(t0 + 90 * 24 * 3600 * 1000) }, q);

    // Same engram wins either way. Relative ranking scores may stay equal when
    // every candidate's axis moves together, but the raw decay must change.
    expect(fresh[0]!.slug).toBe("yogurtera");
    expect(stale[0]!.slug).toBe("yogurtera");
    expect(fresh[0]!.signals.recencyNorm).toBeGreaterThan(stale[0]!.signals.recencyNorm);
  });

  test("each_hit_carries_its_signal_breakdown_rank_and_threshold", async () => {
    const { db, root } = await indexed();
    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: fixedClock(1_700_000_000_000) },
      { query: "yogurt maker control", k: 3 },
    );

    expect(hits.map((h) => h.rank)).toEqual([0, 1, 2]);
    expect(hits[0]!.signals.relevanceCosine).toBeGreaterThanOrEqual(0);
    // Threshold is the cut line: the score of the last included hit.
    expect(hits.at(-1)!.threshold).toBeCloseTo(hits.at(-1)!.score, 10);
    expect(hits.every((h) => h.threshold === hits[0]!.threshold)).toBe(true);
    expect(hits.every((h) => h.included)).toBe(true);

    // The score must be recomputable from the candidate-relative signals.
    const w = hits[0]!.weights, s = hits[0]!.signals.normalized!, total = w.recency + w.importance + w.relevance;
    expect(hits[0]!.score).toBeCloseTo(
      (w.recency * s.recency + w.importance * s.importance + w.relevance * s.relevance) / total,
      10,
    );
  });

  test("searchExplain_returns_all_candidates_flagged_included_or_discarded", async () => {
    const { db, root } = await indexed(); // 3 engrams across two scopes
    const res = await searchExplain(
      { db, root, embedder: createFakeEmbedder(), clock: fixedClock(1_700_000_000_000) },
      { query: "yogurt maker control", k: 2 },
    );

    expect(res.candidates.length).toBeGreaterThan(2); // discarded ones are kept
    expect(res.candidates.filter((c) => c.included)).toHaveLength(2);
    expect(res.candidates.every((c, i) => c.rank === i)).toBe(true);
    expect(res.query).toBe("yogurt maker control");
    expect(res.k).toBe(2);

    // Everything below the cut line is flagged out, and the cut line is real:
    // no discarded candidate outscores an included one.
    const discarded = res.candidates.filter((c) => !c.included);
    expect(discarded.length).toBeGreaterThan(0);
    for (const d of discarded) expect(d.score).toBeLessThanOrEqual(res.candidates[1]!.score);
  });

  test("search_returns_exactly_the_included_candidates_of_searchExplain", async () => {
    const { db, root } = await indexed();
    const deps = { db, root, embedder: createFakeEmbedder(), clock: fixedClock(1_700_000_000_000) };
    const opts = { query: "yogurt maker control", k: 2 };

    const hits = await search(deps, opts);
    const res = await searchExplain(deps, opts);

    expect(hits).toEqual(res.candidates.filter((c) => c.included));
  });

  test("search_is_deterministic_under_a_frozen_clock", async () => {
    const { db, root } = await indexed();
    recordAccess(db, root, "personal", "yogurtera", "2026-06-02T10:00:00.000Z");
    const embedder = createFakeEmbedder();
    const clock = fixedClock(Date.parse("2026-07-01T00:00:00.000Z"));
    const q = { query: "yogurt maker control" };

    const a = await search({ db, root, embedder, clock }, q);
    const b = await search({ db, root, embedder, clock }, q);

    expect(a[0]!.score).toBe(b[0]!.score);
  });
});
