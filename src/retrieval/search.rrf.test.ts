// src/retrieval/search.rrf.test.ts
//
// MNE-96: optional Reciprocal Rank Fusion (vector + BM25) as an opt-in search
// mode. Production order stays pure cosine (MNE-77) — `fusion: "rrf"` is the only
// way to get the hybrid order, and the cosine floor keeps its role as the
// eligibility filter. A controlled embedder makes the cosine vs BM25 disagreement
// exact, so the fused order is asserted, not hoped for.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { search, searchExplain, reciprocalRankFusion, RRF_K } from "./search.js";
import { systemClock } from "../clock.js";
import type { EmbeddingClient } from "../embeddings.js";

describe("reciprocalRankFusion", () => {
  test("sums 1/(k+rank) across lists, rank 1-based", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["b"]]);
    expect(fused.get("a")).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused.get("b")).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
    expect(fused.get("c")).toBeCloseTo(1 / (RRF_K + 3), 10);
  });

  test("a key ranked by both lists beats one ranked by a single list", () => {
    // vector: a,b,c ; bm25 matches only b -> b should overtake a.
    const fused = reciprocalRankFusion([["a", "b", "c"], ["b"]]);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("a")!);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
  });

  test("ignores empty lists and dedupes within a list (first occurrence wins)", () => {
    const fused = reciprocalRankFusion([[], ["a", "a", "b"]]);
    expect(fused.get("a")).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused.get("b")).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  test("custom k changes the weighting", () => {
    expect(reciprocalRankFusion([["a"]], 10).get("a")).toBeCloseTo(1 / 11, 10);
  });
});

// A deterministic 3-dim embedder: markers in the text pick a fixed vector, so
// cosine order is known. The query embeds to [1,0,0]; n1=[1,0,0] (cos 1),
// n2=[0.8,0.6,0] (cos 0.8), n3=[0,1,0] (cos 0).
function controlledEmbedder(): EmbeddingClient {
  const vec = (t: string): number[] => {
    if (t.includes("ALPHAQ")) return [1, 0, 0];
    if (t.includes("MARKN1")) return [1, 0, 0];
    if (t.includes("MARKN2")) return [0.8, 0.6, 0];
    if (t.includes("MARKN3")) return [0, 1, 0];
    return [0, 0, 1];
  };
  return { id: "ctrl/dim3", dim: 3, embed: async (texts) => texts.map(vec) };
}

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-rrf-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  const note = (slug: string, body: string): void =>
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
  // Vector order (cosine): n1 > n2 > n3. BM25: only n2 contains the query term "alpha".
  note("n1", "MARKN1 beta terms without the query token");
  note("n2", "MARKN2 alpha delta");
  note("n3", "MARKN3 gamma terms without the query token");
  return root;
}

async function run(root: string, opts: Record<string, unknown>): Promise<string[]> {
  const db = openDb(join(root, ".index", "store.db"));
  const emb = controlledEmbedder();
  await reindex({ root, db, embedder: emb, scopes: ["personal"] });
  const hits = await search({ db, root, embedder: emb, clock: systemClock },
    { query: "ALPHAQ alpha", scopes: ["personal"], k: 10, ...opts });
  db.close();
  return hits.map((h) => h.slug);
}

describe("search fusion: rrf", () => {
  test("pure cosine (no fusion) ranks by cosine: n1 first", async () => {
    const order = await run(store(), { minCos: -1 });
    expect(order[0]).toBe("n1");
    expect(order).toEqual(["n1", "n2", "n3"]);
  });

  test("fusion rrf promotes the BM25-matched note: n2 first", async () => {
    const order = await run(store(), { minCos: -1, fusion: "rrf" });
    // n2 is ranked by BOTH vector (2nd) and bm25 (1st) -> overtakes n1.
    expect(order[0]).toBe("n2");
    expect(order).toEqual(["n2", "n1", "n3"]);
  });

  test("the cosine floor stays an eligibility filter under rrf", async () => {
    // floor 0.5 excludes n3 (cosine 0) even though rrf reorders the rest.
    const order = await run(store(), { minCos: 0.5, fusion: "rrf" });
    expect(order).not.toContain("n3");
    expect(order).toContain("n2");
  });

  test("echoes the ranking mode: fusion present only when rrf was applied", async () => {
    const root = store();
    const db = openDb(join(root, ".index", "store.db"));
    const emb = controlledEmbedder();
    await reindex({ root, db, embedder: emb, scopes: ["personal"] });
    const deps = { db, root, embedder: emb, clock: systemClock };
    const cosine = await searchExplain(deps, { query: "ALPHAQ alpha", scopes: ["personal"], k: 10, minCos: -1 });
    const rrf = await searchExplain(deps, { query: "ALPHAQ alpha", scopes: ["personal"], k: 10, minCos: -1, fusion: "rrf" });
    db.close();
    expect(cosine.fusion).toBeUndefined();
    expect(rrf.fusion).toBe("rrf");
  });

  test("rrf order is deterministic when cosine and BM25 both tie", async () => {
    // Two notes with identical vectors (equal cosine) and both containing the
    // query term (equal BM25): the fused order must fall back to scope/slug,
    // never to SQL/insertion order. "aaa" precedes "zzz".
    const root = mkdtempSync(join(tmpdir(), "mneme-rrf-tie-"));
    mkdirSync(join(root, "personal"), { recursive: true });
    for (const slug of ["zzz", "aaa"]) { // written zzz-first on purpose
      writeFileSync(join(root, "personal", `${slug}.md`),
        ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
          "created: 2026-06-01T10:00:00", "importance: 5", "---", "MARKEQ alpha identical body", ""].join("\n"));
    }
    const db = openDb(join(root, ".index", "store.db"));
    const emb: EmbeddingClient = { id: "ctrl/dim3", dim: 3, embed: async (t) => t.map(() => [1, 0, 0]) };
    await reindex({ root, db, embedder: emb, scopes: ["personal"] });
    const hits = await search({ db, root, embedder: emb, clock: systemClock },
      { query: "ALPHAQ alpha", scopes: ["personal"], k: 10, minCos: -1, fusion: "rrf" });
    db.close();
    expect(hits.map((h) => h.slug)).toEqual(["aaa", "zzz"]);
  });
});
