import { describe, expect, it } from "vitest";
import {
  assertCalibrationReviewSet, compareCalibrationArms, evaluateCalibration, rankCalibrationCandidates,
  selectEligibleConfigurations,
  type CalibrationCandidate, type CalibrationCase, type CalibrationConfig,
} from "./golden-calibration.js";

const candidate = (slug: string, cosine: number, recency: number, importance = 0): CalibrationCandidate => ({
  slug, cosine, normalized: { relevance: cosine, recency, importance },
});
const config = (recency: number, importance: number, floor: number | null): CalibrationConfig => ({
  weights: { recency, importance, relevance: 1 }, floor,
});

describe("golden calibration", () => {
  it("reproduces production blend ordering and keeps the input untouched", () => {
    const candidates = Object.freeze([
      candidate("relevant", 0.8, 0), candidate("recent", 0.75, 1),
    ]);
    expect(rankCalibrationCandidates(candidates, config(0.25, 0.25, 0.7), 2)).toEqual(["recent", "relevant"]);
    expect(candidates.map((item) => item.slug)).toEqual(["relevant", "recent"]);
  });

  it("applies the raw cosine floor before taking top k", () => {
    const candidates = [candidate("below", 0.69, 1), candidate("above", 0.71, 0)];
    expect(rankCalibrationCandidates(candidates, config(0.25, 0, 0.7), 1)).toEqual(["above"]);
    expect(rankCalibrationCandidates(candidates, config(0.25, 0, null), 1)).toEqual(["below"]);
  });

  it("separates ranking loss from floor loss across four fixed arms", () => {
    const cases: CalibrationCase[] = [
      { id: "ranking", relevance: [{ slug: "relevant", grade: 3 }], candidates: [
        candidate("relevant", 0.8, 0), candidate("recent", 0.75, 1),
      ] },
      { id: "floor", relevance: [{ slug: "relevant", grade: 3 }], candidates: [
        candidate("relevant", 0.69, 0), candidate("distractor", 0.68, 0),
      ] },
    ];
    const arms = compareCalibrationArms(cases, [
      { name: "production", config: config(0.25, 0.25, 0.7) },
      { name: "blend-no-floor", config: config(0.25, 0.25, null) },
      { name: "cosine-with-floor", config: config(0, 0, 0.7) },
      { name: "pure-cosine", config: config(0, 0, null) },
    ], 1);
    expect(arms.map((arm) => [arm.name, arm.result.answerable.meanNdcgAt10])).toEqual([
      ["production", 0], ["blend-no-floor", 0.5],
      ["cosine-with-floor", 0.5], ["pure-cosine", 1],
    ]);
  });

  it("counts an unanswerable result as a false positive without affecting nDCG", () => {
    const cases: CalibrationCase[] = [
      { id: "positive", relevance: [{ slug: "yes", grade: 3 }], candidates: [candidate("yes", 0.8, 0)] },
      { id: "negative", relevance: [], candidates: [candidate("spurious", 0.69, 0)] },
    ];
    const withFloor = evaluateCalibration(cases, config(0, 0, 0.7), 10);
    const withoutFloor = evaluateCalibration(cases, config(0, 0, null), 10);
    expect(withFloor.answerable.meanNdcgAt10).toBe(1);
    expect(withFloor.unanswerable).toEqual({ queries: 1, falsePositives: 0, falsePositiveRate: 0 });
    expect(withoutFloor.unanswerable).toEqual({ queries: 1, falsePositives: 1, falsePositiveRate: 1 });
  });

  it("preserves source order for tied scores", () => {
    const candidates = [candidate("first", 0.8, 0), candidate("second", 0.8, 0)];
    expect(rankCalibrationCandidates(candidates, config(0, 0, null), 2)).toEqual(["first", "second"]);
  });

  it("refuses stale or insufficiently reviewed calibration sets", () => {
    const review = {
      corpus: { sha256: "current-content", rankingSha256: "current-ranking" },
      queries: [
        { id: "q-01", approved: true, anchorSlug: "a", relevance: [{ slug: "a", grade: 3 }] },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `n-${i}`, approved: true, anchorSlug: null, relevance: [],
        })),
      ],
    };
    const current = { contentSha256: "current-content", rankingSha256: "current-ranking", documentSlugs: new Set(["a"]) };
    expect(() => assertCalibrationReviewSet(review, current)).not.toThrow();
    expect(() => assertCalibrationReviewSet(review, { ...current, rankingSha256: "changed" })).toThrow(/ranking metadata changed/);
    expect(() => assertCalibrationReviewSet({ ...review, queries: review.queries.slice(0, 2) }, current)).toThrow(/at least 10/);
    expect(() => assertCalibrationReviewSet({ ...review, queries: [{ ...review.queries[0]!, approved: false }, ...review.queries.slice(1)] }, current)).toThrow(/unapproved/);
  });

  it("rejects quality gains that worsen negatives or the guard scope", () => {
    const rows = [
      { name: "false-positive", scopes: { private: { ndcg: 0.8, falsePositives: 1 }, personal: { ndcg: 0.5, falsePositives: 0 } } },
      { name: "personal-regression", scopes: { private: { ndcg: 0.75, falsePositives: 0 }, personal: { ndcg: 0.4, falsePositives: 0 } } },
      { name: "eligible", scopes: { private: { ndcg: 0.71, falsePositives: 0 }, personal: { ndcg: 0.51, falsePositives: 0 } } },
    ];
    expect(selectEligibleConfigurations(rows, [
      { scope: "private", minNdcg: 0.7, maxFalsePositives: 0 },
      { scope: "personal", minNdcg: 0.47, maxFalsePositives: 0 },
    ])).toEqual(["eligible"]);
  });
});
