// src/retrieval/search.lexical.test.ts
//
// MNE-98: lexical rescue. On v2-moe the cosine distributions of true positives and
// off-topic queries overlap (~0.30–0.42), so no single cosine floor separates them,
// while raw BM25 does. A note whose raw BM25 clears `lexicalFloor` is eligible even
// below the cosine floor. Off by default (no calibrated value yet): production keeps
// the cosine-only gate until the golden fixes the number.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { searchExplain, resolveLexicalFloor } from "./search.js";
import { searchExplainInstrumented } from "./instrumented.js";
import { formatExplain } from "../observability/explain.js";
import { readTelemetry } from "../telemetry/events.js";
import { systemClock } from "../clock.js";
import type { EmbeddingClient } from "../embeddings.js";

// Query embeds to [1,0,0]. cosine: hi=1, lex=0, miss=0. Only `lex` contains the
// query's lexical term, so cosine and BM25 disagree on purpose.
function controlledEmbedder(): EmbeddingClient {
  const vec = (t: string): number[] => {
    if (t.includes("QVEC")) return [1, 0, 0];
    if (t.includes("MARKHI")) return [1, 0, 0];
    return [0, 1, 0];
  };
  return { id: "ctrl/dim3", dim: 3, embed: async (texts) => texts.map(vec) };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mneme-lex-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  const note = (slug: string, body: string): void =>
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
  note("hi", "MARKHI beta terms without the token");
  note("lex", "aroides sustrato mezcla");
  note("miss", "gamma terms without the token");
  const db = openDb(join(root, ".index", "store.db"));
  const embedder = controlledEmbedder();
  await reindex({ root, db, embedder, scopes: ["personal"] });
  return { root, deps: { db, root, embedder, clock: systemClock } };
}

const QUERY = "QVEC aroides";
const included = (res: Awaited<ReturnType<typeof searchExplain>>): string[] =>
  res.candidates.filter((c) => c.included).map((c) => c.slug);

describe("search lexical rescue", () => {
  test("is off by default: below the cosine floor stays out regardless of BM25", async () => {
    const { deps } = await fixture();
    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5 });
    expect(included(res)).toEqual(["hi"]);
    expect(res.lexicalFloor).toBeUndefined();
    expect(res.candidates.every((c) => c.lexicalRescue === undefined && c.bm25 === undefined)).toBe(true);
  });

  test("admits a below-floor note whose raw BM25 clears the lexical floor, and marks it", async () => {
    const { deps } = await fixture();
    const probe = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: 0 });
    const lexBm25 = probe.candidates.find((c) => c.slug === "lex")!.bm25!;
    expect(lexBm25).toBeGreaterThan(0); // raw goodness: -bm25(), higher = better

    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: lexBm25 });
    expect(included(res)).toEqual(["hi", "lex"]);
    expect(res.lexicalFloor).toBe(lexBm25);
    const lex = res.candidates.find((c) => c.slug === "lex")!;
    expect(lex.lexicalRescue).toBe(true);
    expect(lex.signals.relevanceCosine).toBeLessThan(0.5);
    // Passing on cosine is not a rescue, even with no lexical match.
    expect(res.candidates.find((c) => c.slug === "hi")!.lexicalRescue).toBeUndefined();
  });

  test("does not rescue below the lexical floor, nor a note with no lexical match", async () => {
    const { deps } = await fixture();
    const probe = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: 0 });
    const lexBm25 = probe.candidates.find((c) => c.slug === "lex")!.bm25!;
    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: lexBm25 + 1 });
    expect(included(res)).toEqual(["hi"]);
    // No FTS match → no BM25 at all (null), so a floor of 0 cannot admit it.
    expect(probe.candidates.find((c) => c.slug === "miss")!.bm25).toBeNull();
    expect(included(probe)).toEqual(["hi", "lex"]);
  });

  test("rescued notes still compete for the k slots in cosine order", async () => {
    const { deps } = await fixture();
    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], k: 1, minCos: 0.5, lexicalFloor: 0 });
    expect(included(res)).toEqual(["hi"]);
  });

  test("the cut line counts rescued notes as eligible", async () => {
    const { deps } = await fixture();
    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], k: 10, minCos: 0.5, lexicalFloor: 0 });
    const lex = res.candidates.find((c) => c.slug === "lex")!;
    expect(res.candidates[0]!.threshold).toBe(lex.score);
  });

  test("tier 0 (no embedder) ignores the lexical floor: BM25 already is the ranker", async () => {
    const { deps } = await fixture();
    const res = await searchExplain({ ...deps, embedder: null }, { query: "aroides", scopes: ["personal"], lexicalFloor: 1e9 });
    expect(included(res)).toEqual(["lex"]);
    expect(res.lexicalFloor).toBeUndefined();
  });

  test("validates the lexical floor", () => {
    expect(resolveLexicalFloor(undefined)).toBeNull();
    expect(resolveLexicalFloor(4.5)).toBe(4.5);
    expect(() => resolveLexicalFloor(Number.NaN)).toThrow(/lexical-floor/);
    expect(() => resolveLexicalFloor(-1)).toThrow(/lexical-floor/);
  });

  test("explain shows the lexical floor and marks the rescued row", async () => {
    const { deps } = await fixture();
    const res = await searchExplain(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: 0 });
    const out = formatExplain(res);
    expect(out).toMatch(/lexical rescue floor \(raw BM25\): 0\.000/);
    expect(out).toMatch(/lex \[personal\] \(lexical rescue, bm25 \d+\.\d{3}\)/);
    expect(out).not.toMatch(/lex \[personal\] \(below cosine floor\)/);
  });

  test("telemetry records the lexical floor and each candidate's BM25 and rescue", async () => {
    const { root, deps } = await fixture();
    await searchExplainInstrumented(deps, { query: QUERY, scopes: ["personal"], minCos: 0.5, lexicalFloor: 0 }, "c-lex");
    const events = readTelemetry(root).filter((e) => e.corrId === "c-lex");
    expect(events.find((e) => e.kind === "retrieval.query")!.lexicalFloor).toBe(0);
    const lex = events.find((e) => e.kind === "retrieval.candidate" && e.slug === "lex")!;
    expect(lex.lexicalRescue).toBe(true);
    expect(typeof lex.bm25).toBe("number");
    expect(events.find((e) => e.kind === "retrieval.candidate" && e.slug === "miss")!.bm25).toBeNull();
  });
});
