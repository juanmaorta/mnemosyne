import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { search } from "./search.js";
import { fixedClock, systemClock } from "../clock.js";
import { getHotState, recordAccess } from "../hotstate.js";

function note(root: string, slug: string, importance: number, body: string) {
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", `importance: ${importance}`, "---", body, ""].join("\n"));
}

describe("blended search", () => {
  test("search_boosts_higher_importance_when_relevance_ties", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-blend-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "low", 1, "yogurt maker control"); // same tokens → equal relevance
    note(root, "high", 10, "yogurt maker control");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "yogurt maker control", weights: { recency: 0, importance: 1, relevance: 1 } });

    expect(hits[0]!.slug).toBe("high");
  });

  test("search_default_ranks_relevant_over_recently_created_irrelevant", async () => {
    // Dates are relative to "now" (not hardcoded calendar dates) so the
    // recency gap this test relies on doesn't shrink/invert as real time
    // passes: yogurtera is old (~0 recency), router is fresh (~1 recency).
    const DAY_MS = 24 * 3600 * 1000;
    const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 19);
    const root = mkdtempSync(join(tmpdir(), "mneme-blend-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "yogurtera.md"),
      ["---", "name: yogurtera", "description: yogurtera", "scope: personal", "type: reference",
        `created: ${isoDaysAgo(200)}`, "importance: 5", "---",
        "yogurt maker control fermentation temperature", ""].join("\n"));
    writeFileSync(join(root, "personal", "router.md"),
      ["---", "name: router", "description: router", "scope: personal", "type: reference",
        `created: ${isoDaysAgo(1)}`, "importance: 5", "---",
        "omada wifi router vlan network", ""].join("\n"));
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    // never-accessed → hot_state.last_access is seeded from `created`. Old
    // default weights {1,1,1} + created-seeded recency let the freshly
    // "created" but off-topic router note outrank the older, on-topic one.
    const hits = await search({ db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "yogurt maker control" });

    expect(hits[0]!.slug).toBe("yogurtera");
  });

  test("search_uses_persisted_retention_so_repeated_reads_win_at_equal_cosine", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-blend-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "one", 5, "yogurt maker control");
    note(root, "many", 5, "yogurt maker control");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const accessAt = "2026-07-01T10:00:00.000Z";
    recordAccess(db, root, "personal", "one", accessAt);
    recordAccess(db, root, "personal", "many", accessAt);
    recordAccess(db, root, "personal", "many", accessAt);
    const before = getHotState(db, "personal", "many")!.accessCount;

    // The search default is cosine-only; this test is about the blend, so it
    // asks for recency weight explicitly (the old shared default).
    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: fixedClock(Date.parse("2026-07-31T10:00:00.000Z")) },
      { query: "yogurt maker control", weights: { recency: 0.25, importance: 0.25, relevance: 1 } },
    );

    expect(hits[0]!.slug).toBe("many");
    expect(hits[0]!.signals.relevanceCosine).toBeCloseTo(hits[1]!.signals.relevanceCosine, 10);
    expect(hits[0]!.signals.recencyNorm).toBeGreaterThan(hits[1]!.signals.recencyNorm);
    expect(getHotState(db, "personal", "many")!.accessCount).toBe(before);
  });

  test("search_breaks_equal_cosine_ties_by_slug_not_recency_or_importance", async () => {
    // Equal tokens → equal cosine. "bbb" has higher importance and real,
    // recent reads; "aaa" has neither. The cosine-only default must ignore both
    // and fall back to a deterministic scope→slug tiebreak, so "aaa" leads.
    const root = mkdtempSync(join(tmpdir(), "mneme-blend-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "aaa", 1, "yogurt maker control");
    note(root, "bbb", 10, "yogurt maker control");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const accessAt = "2026-07-30T10:00:00.000Z";
    recordAccess(db, root, "personal", "bbb", accessAt);
    recordAccess(db, root, "personal", "bbb", accessAt);

    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: fixedClock(Date.parse("2026-07-31T10:00:00.000Z")) },
      { query: "yogurt maker control" },
    );

    expect(hits.map((h) => h.slug)).toEqual(["aaa", "bbb"]);
    expect(hits[0]!.signals.relevanceCosine).toBeCloseTo(hits[1]!.signals.relevanceCosine, 10);
    expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 10);
  });
});
