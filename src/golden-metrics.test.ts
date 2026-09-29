import { describe, expect, it } from "vitest";
import { percentile, queryMetrics, summarizeEvaluation, summarizeQueries } from "./golden-metrics.js";

describe("5b-golden metrics", () => {
  it("gives graded near-duplicate results credit in nDCG and MRR", () => {
    const relevance = [{ slug: "anchor", grade: 3 }, { slug: "near-duplicate", grade: 2 }];
    const first = queryMetrics(["near-duplicate", "anchor"], relevance, 2);
    const missed = queryMetrics(["unrelated", "anchor"], relevance, 2);
    expect(first.ndcgAtK).toBeGreaterThan(missed.ndcgAtK);
    expect(first.reciprocalRank).toBe(1);
    expect(first.relevantReturned).toBe(2);
  });

  it("uses nearest-rank percentiles and handles empty samples", () => {
    expect(percentile([9, 1, 5], 0.5)).toBe(5);
    expect(percentile([9, 1, 5], 0.95)).toBe(9);
    expect(percentile([], 0.95)).toBeNull();
    expect(summarizeQueries([]).queries).toBe(0);
  });

  it("keeps unanswerable queries out of relevance metrics and counts false positives", () => {
    const summary = summarizeEvaluation([
      { ...queryMetrics(["anchor"], [{ slug: "anchor", grade: 3 }]), answerable: true, returnedCount: 1 },
      { ...queryMetrics(["unrelated"], []), answerable: false, returnedCount: 1 },
      { ...queryMetrics([], []), answerable: false, returnedCount: 0 },
    ]);
    expect(summary.answerable.queries).toBe(1);
    expect(summary.answerable.mrr).toBe(1);
    expect(summary.unanswerable).toEqual({ queries: 2, falsePositives: 1, falsePositiveRate: 0.5 });
  });
});
