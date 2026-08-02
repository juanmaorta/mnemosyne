// src/retrieval/search.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { search } from "./search.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { fixedClock, systemClock } from "../clock.js";
import { recordAccess } from "../hotstate.js";

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

    // Same engram wins either way; only its recency term decays with the clock.
    expect(fresh[0]!.slug).toBe("yogurtera");
    expect(stale[0]!.slug).toBe("yogurtera");
    expect(fresh[0]!.score).toBeGreaterThan(stale[0]!.score);
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
