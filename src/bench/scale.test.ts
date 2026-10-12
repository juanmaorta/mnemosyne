// src/bench/scale.test.ts
//
// MNE-65: scale scenario (g) for the bench. Turns the design assumption
// "personal scale: brute-force cosine <10ms" into a measured datum: populate an
// EPHEMERAL store with N synthetic engrams (fake embedder, injected clock),
// reindex it, and time `search` — reporting p50/p95 latency, candidate-set size
// and the lazy-reindex cost against an external <500ms reference threshold.
//
// Timings are non-deterministic, so the structure and the verdict logic are
// tested with injected samples; the end-to-end run is asserted on shape and on
// the corpus actually indexing and retrieving, never on absolute milliseconds.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Slug } from "../schema.js";
import { ALGO_VERSION } from "../version.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import type { EmbeddingClient } from "../embeddings.js";
import {
  generateScaleCorpus,
  buildScaleScorecard,
  runScaleScenario,
  DEFAULT_SCALE_THRESHOLD_MS,
} from "./scale.js";

describe("generateScaleCorpus", () => {
  test("returns exactly n synthetic docs", () => {
    expect(generateScaleCorpus(0)).toHaveLength(0);
    expect(generateScaleCorpus(37)).toHaveLength(37);
  });

  test("is deterministic: same n and options yield identical docs", () => {
    expect(generateScaleCorpus(50)).toEqual(generateScaleCorpus(50));
  });

  test("every slug is unique and kebab-valid", () => {
    const docs = generateScaleCorpus(200);
    const slugs = docs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(Slug.safeParse(slug).success).toBe(true);
  });

  test("importance stays in range and varies across the corpus", () => {
    const docs = generateScaleCorpus(100);
    for (const d of docs) {
      expect(Number.isInteger(d.importance)).toBe(true);
      expect(d.importance).toBeGreaterThanOrEqual(1);
      expect(d.importance).toBeLessThanOrEqual(10);
    }
    expect(new Set(docs.map((d) => d.importance)).size).toBeGreaterThan(1);
  });

  test("created is a local ISO datetime without timezone, staggered and increasing", () => {
    const docs = generateScaleCorpus(10);
    for (const d of docs) {
      expect(d.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(d.created).not.toContain("Z");
    }
    const times = docs.map((d) => Date.parse(`${d.created}Z`));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  test("rejects a non-kebab scope before it can escape the store", () => {
    expect(() => generateScaleCorpus(1, { scope: "../victim" })).toThrow(/scope/i);
  });

  test("docs in the same topic share body tokens (realistic clusters)", () => {
    // With a modest topic count, many docs collide into the same topic; two of
    // them must share at least one distinctive body token.
    const docs = generateScaleCorpus(40, { topics: 4 });
    const byTopic = new Map<number, string[]>();
    for (const d of docs) {
      const tokens = d.body.toLowerCase().split(/\s+/).filter(Boolean);
      byTopic.set(d.topic, [...(byTopic.get(d.topic) ?? []), ...tokens]);
    }
    const crowded = [...byTopic.values()].find((t) => t.length > 0)!;
    expect(crowded.length).toBeGreaterThan(0);
    // A specific pair in topic 0 shares tokens:
    const topic0 = docs.filter((d) => d.topic === 0);
    expect(topic0.length).toBeGreaterThanOrEqual(2);
    const a = new Set(topic0[0]!.body.toLowerCase().split(/\s+/));
    const shared = topic0[1]!.body.toLowerCase().split(/\s+/).some((t) => a.has(t));
    expect(shared).toBe(true);
  });
});

describe("buildScaleScorecard", () => {
  const base = {
    scope: "personal",
    engrams: 10_000,
    embedderId: "fake-bow/dim768",
    reindexMs: 1234,
    reindexIndexed: 10_000,
    candidateSetSizes: [100, 120, 140],
  };

  test("computes p50/p95 from the latency samples", () => {
    const card = buildScaleScorecard({ ...base, searchLatenciesMs: [10, 20, 30, 40, 50] });
    expect(card.search.p50Ms).toBe(30);
    expect(card.search.p95Ms).toBe(50);
    expect(card.search.queries).toBe(5);
  });

  test("passes when p95 is within the threshold and fails when it is over", () => {
    const within = buildScaleScorecard({ ...base, searchLatenciesMs: [100, 200, 499] });
    expect(within.thresholdMs).toBe(DEFAULT_SCALE_THRESHOLD_MS);
    expect(within.within).toBe(true);

    const over = buildScaleScorecard({ ...base, searchLatenciesMs: [100, 200, 501] });
    expect(over.within).toBe(false);
  });

  test("honours a custom threshold", () => {
    const card = buildScaleScorecard({ ...base, searchLatenciesMs: [5, 6, 7], thresholdMs: 6 });
    expect(card.within).toBe(false); // p95 = 7 > 6
  });

  test("stamps the scorecard with algoVersion and the corpus size", () => {
    const card = buildScaleScorecard({ ...base, searchLatenciesMs: [1, 2, 3] });
    expect(card.algoVersion).toBe(ALGO_VERSION);
    expect(card.benchmark).toMatch(/scale/);
    expect(card.engrams).toBe(10_000);
    expect(card.reindex).toEqual({ ms: 1234, indexed: 10_000 });
    expect(card.search.candidateSet.max).toBe(140);
  });
});

describe("runScaleScenario — end to end", () => {
  test("populates an ephemeral store, reindexes it and retrieves", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-scale-"));
    const card = await runScaleScenario({
      n: 40,
      root,
      queries: 8,
      embedder: createFakeEmbedder(),
    });
    expect(card.engrams).toBe(40);
    expect(card.reindex.indexed).toBe(40); // all synthetic notes indexed, none skipped
    expect(card.search.queries).toBe(8);
    expect(card.search.candidateSet.max).toBeGreaterThan(0); // searches actually retrieve
    expect(typeof card.within).toBe("boolean");
    expect(card.algoVersion).toBe(ALGO_VERSION);
  });

  test("refuses an unsafe scope instead of writing outside the ephemeral root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mne-scale-"));
    const victim = join(parent, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "scale-0.md"), "original");
    await expect(
      runScaleScenario({ n: 1, root: join(parent, "root"), scope: "../victim", embedder: createFakeEmbedder() }),
    ).rejects.toThrow(/scope/i);
    expect(readFileSync(join(victim, "scale-0.md"), "utf8")).toBe("original"); // untouched
  });

  test("fails loudly when not every synthetic engram indexes (no zero-workload pass)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-scale-"));
    const fake = createFakeEmbedder();
    // A regressed embedder that returns wrong-width document vectors: every
    // insert fails, reindex counts errors and indexes nothing.
    const broken: EmbeddingClient = {
      ...fake,
      async embed(texts, role) {
        return role === "query" ? fake.embed(texts, role) : texts.map(() => [1]);
      },
    };
    await expect(runScaleScenario({ n: 10, root, embedder: broken })).rejects.toThrow(/index/i);
  });
});
