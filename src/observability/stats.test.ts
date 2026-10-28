import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { computeStats, percentile } from "./stats.js";
import { emitEvents } from "../telemetry/events.js";
import { fixedClock } from "../clock.js";
import { recordAccess } from "../hotstate.js";

const CLOCK = fixedClock(Date.parse("2026-08-07T10:00:00.000Z"));

function note(root: string, scope: string, slug: string, type: string, importance: number) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug}`, `scope: ${scope}`, `type: ${type}`,
      "created: 2026-06-01T10:00:00", `importance: ${importance}`, "---", `body of ${slug}`, ""].join("\n"));
}

async function seeded() {
  const root = mkdtempSync(join(tmpdir(), "mneme-stats-"));
  note(root, "personal", "fermentor", "reference", 5);
  note(root, "personal", "router", "project", 8);
  note(root, "work", "policy", "reference", 3);
  const db = openDb(join(root, ".index", "store.db"));
  await reindex({ root, db, embedder: createFakeEmbedder(), clock: CLOCK });
  return { db, root };
}

describe("percentile", () => {
  test("interpolates deterministically and handles the edges", () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(40);
    expect(percentile(xs, 50)).toBe(25);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("computeStats", () => {
  test("counts engrams by scope and by type from the index", async () => {
    const { db, root } = await seeded();
    const s = computeStats(db, root);
    expect(s.countsByScope).toEqual({ personal: 2, work: 1 });
    expect(s.countsByType).toEqual({ reference: 2, project: 1 });
  });

  test("returns null rates rather than zeros when there is no telemetry", async () => {
    const { db, root } = await seeded();
    const s = computeStats(db, root);
    // A rate of 0 would read as "measured, and it is zero". These were never
    // measured — the distinction matters when reading a scorecard.
    expect(s.searchLatencyMs).toBeNull();
    expect(s.emptyResultRate).toBeNull();
    expect(s.avgCandidateSetSize).toBeNull();
    expect(s.reinforcementRate).toBeNull();
    expect(s.degradedInjectionRate).toBeNull();
  });

  test("derives latency percentiles and rates from the telemetry log", async () => {
    const { db, root } = await seeded();
    emitEvents(root, CLOCK, [
      { kind: "retrieval.query", corrId: "a", durationMs: 10, candidateSetSize: 3, resultCount: 2 },
      { kind: "retrieval.query", corrId: "b", durationMs: 20, candidateSetSize: 5, resultCount: 0 },
      { kind: "retrieval.query", corrId: "c", durationMs: 30, candidateSetSize: 4, resultCount: 1 },
      { kind: "retrieval.query", corrId: "d", durationMs: 40, candidateSetSize: 4, resultCount: 1 },
    ]);

    const s = computeStats(db, root);

    expect(s.searchLatencyMs).toEqual({ p50: 25, p95: 38.5 });
    expect(s.avgCandidateSetSize).toBe(4);
    expect(s.emptyResultRate).toBe(0.25); // one of four returned nothing
  });

  test("averages the cosine of included candidates only", async () => {
    const { db, root } = await seeded();
    emitEvents(root, CLOCK, [
      { kind: "retrieval.candidate", corrId: "a", included: true, signals: { relevanceCosine: 0.8 } },
      { kind: "retrieval.candidate", corrId: "a", included: true, signals: { relevanceCosine: 0.6 } },
      // Discarded ones would drag the average toward the tail of the ranking.
      { kind: "retrieval.candidate", corrId: "a", included: false, signals: { relevanceCosine: 0.1 } },
    ]);

    expect(computeStats(db, root).avgTopKCosine).toBeCloseTo(0.7, 10);
  });

  test("reports injection budget utilisation and reinforcement rate", async () => {
    const { db, root } = await seeded();
    emitEvents(root, CLOCK, [
      { kind: "retrieval.query", corrId: "a", durationMs: 5, candidateSetSize: 2, resultCount: 2 },
      { kind: "retrieval.query", corrId: "b", durationMs: 5, candidateSetSize: 2, resultCount: 2 },
      { kind: "retrieval.injected", corrId: "a", injectedSlugs: ["x", "y", "z"], droppedForBudget: 1 },
      { kind: "access.reinforced", scope: "personal", slug: "x", strengthBefore: 1, strengthAfter: 2 },
    ]);

    const s = computeStats(db, root);

    expect(s.injectionBudgetUtil).toBe(0.75); // 3 of 4 candidates fit
    expect(s.reinforcementRate).toBe(0.5);    // 1 reinforcement per 2 queries
  });

  test("reports the share of injections that were degraded", async () => {
    const { db, root } = await seeded();
    emitEvents(root, CLOCK, [
      // Healthy: served everything it ranked.
      { kind: "retrieval.injected", corrId: "a", injectedSlugs: ["x"], droppedForBudget: 0 },
      // Starved by a deliberate budget — configured, not broken.
      { kind: "retrieval.injected", corrId: "b", injectedSlugs: [], droppedForBudget: 7 },
      // Actually broken: the index could not be refreshed.
      { kind: "retrieval.injected", corrId: "c", injectedSlugs: ["x"], droppedForBudget: 0, degraded: ["reindex-failed"] },
      // Broken outright: the session began with no memory at all.
      { kind: "retrieval.injected", corrId: "d", injectedSlugs: [], droppedForBudget: 0, degraded: ["fatal"] },
    ]);

    // 2 of 4. The budget-starved one must NOT count, or a tight budget would
    // read as a broken system and the metric would stop meaning anything.
    expect(computeStats(db, root).degradedInjectionRate).toBe(0.5);
  });

  test("buckets hot-state strength and counts the access-event stream", async () => {
    const { db, root } = await seeded();
    recordAccess(db, root, "personal", "fermentor", "2026-08-01T10:00:00.000Z");
    recordAccess(db, root, "personal", "fermentor", "2026-08-02T10:00:00.000Z");

    const s = computeStats(db, root);

    expect(s.factStreamSize).toBe(2);
    // Two reinforcements take fermentor from strength 1 to 3; router, untouched
    // but in the same materialized scope, stays in the first bucket. The work
    // engram has no hot_state row at all — recordAccess only materializes the
    // scope it touched, so the histogram covers 2 of the 3 engrams.
    expect(s.strengthHistogram["3-4"]).toBe(1);
    expect(s.strengthHistogram["1-2"]).toBe(1);
    expect(Object.values(s.strengthHistogram).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("flags engrams present in the index but missing a vector", async () => {
    const { db, root } = await seeded();
    expect(computeStats(db, root).staleCount).toBe(0);
    db.prepare("delete from vec_engrams where rowid = (select min(id) from engrams)").run();
    expect(computeStats(db, root).staleCount).toBe(1);
  });
});
