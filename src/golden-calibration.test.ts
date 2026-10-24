import { describe, expect, it } from "vitest";
import {
  assertCalibrationReviewSet, compareCalibrationArms, evaluateCalibration, rankCalibrationCandidates,
  selectEligibleConfigurations, sweepFloorGrid, selectFloorPair, floorSeparation,
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

// MNE-98: two-signal gate (cosine OR raw BM25), calibrated jointly.
const lexical = (slug: string, cosine: number, bm25: number | null): CalibrationCandidate => ({
  slug, cosine, bm25, normalized: { relevance: cosine, recency: 0, importance: 0 },
});
const cosineOnly = { recency: 0, importance: 0, relevance: 1 };

describe("golden calibration: lexical rescue (MNE-98)", () => {
  it("admits a below-floor candidate whose raw BM25 clears the lexical floor", () => {
    const candidates = [lexical("cos", 0.5, null), lexical("lex", 0.3, 10), lexical("weak", 0.3, 2)];
    expect(rankCalibrationCandidates(candidates, { weights: cosineOnly, floor: 0.4 }, 10)).toEqual(["cos"]);
    expect(rankCalibrationCandidates(candidates, { weights: cosineOnly, floor: 0.4, lexicalFloor: 9 }, 10)).toEqual(["cos", "lex"]);
  });

  // Overlapping cosine bands, separable BM25: the shape measured live on v2-moe.
  const cases: CalibrationCase[] = [
    { id: "kw", relevance: [{ slug: "aroides", grade: 3 }], candidates: [lexical("aroides", 0.36, 10.7), lexical("x", 0.2, null)] },
    { id: "nat", relevance: [{ slug: "leca", grade: 3 }], candidates: [lexical("leca", 0.50, 3), lexical("x", 0.2, null)] },
    { id: "neg-1", relevance: [], candidates: [lexical("kube", 0.40, 5.4)] },
    { id: "neg-2", relevance: [], candidates: [lexical("barca", 0.30, 2.4)] },
  ];

  it("sweeps every (cosine, lexical) pair and counts recall and false positives", () => {
    const grid = sweepFloorGrid(cases, { cosineFloors: [0.35, 0.45], lexicalFloors: [null, 9] });
    expect(grid.map((row) => [row.cosineFloor, row.lexicalFloor])).toEqual([[0.35, null], [0.35, 9], [0.45, null], [0.45, 9]]);
    const at = (c: number, l: number | null) => grid.find((row) => row.cosineFloor === c && row.lexicalFloor === l)!;
    // A single cosine floor cannot win: 0.35 leaks neg-1, 0.45 loses the keyword positive.
    expect(at(0.35, null)).toMatchObject({ falsePositives: 1, unanswerable: 2, recall: 1 });
    expect(at(0.45, null)).toMatchObject({ falsePositives: 0, recall: 0.5 });
    // Raising cosine and rescuing lexically keeps both positives with no leak.
    expect(at(0.45, 9)).toMatchObject({ falsePositives: 0, recall: 1, answerable: 2, lexicalOnly: 1 });
    expect(at(0.45, 9).ndcg).toBeCloseTo(1, 10);
  });

  it("counts relevant notes that only the lexical rescue let in", () => {
    const grid = sweepFloorGrid(cases, { cosineFloors: [0.45], lexicalFloors: [null, 9] });
    expect(grid.map((row) => row.lexicalOnly)).toEqual([0, 1]); // kw's aroides at cos 0.36
  });

  it("breaks quality ties by lexical reliance, then the stricter lexical floor, then the median cosine floor", () => {
    // Every pair below has recall 1 and nDCG 1: rescue reliance and margin decide.
    const flat = (cosineFloor: number, lexicalFloor: number | null, lexicalOnly: number) =>
      ({ cosineFloor, lexicalFloor, lexicalOnly, answerable: 2, recall: 1, ndcg: 1, mrr: 1, unanswerable: 2, falsePositives: 0 });
    const rows = [flat(0.40, 9, 1), flat(0.41, 9, 1), flat(0.42, 9, 1), flat(0.50, 9, 2), flat(0.41, 8, 1)];
    // 0.50 relies on the rescue twice → out; lexical 9 beats 8; median of 0.40/0.41/0.42 is 0.41.
    expect(selectFloorPair(rows, { maxFalsePositives: 0 })).toMatchObject({ cosineFloor: 0.41, lexicalFloor: 9 });
  });

  it("picks the best-recall pair within the false-positive budget, preferring the simpler gate on ties", () => {
    const grid = sweepFloorGrid(cases, { cosineFloors: [0.35, 0.45, 0.6], lexicalFloors: [null, 9, 11] });
    expect(selectFloorPair(grid, { maxFalsePositives: 0 })).toMatchObject({ cosineFloor: 0.45, lexicalFloor: 9 });
    // With leaks allowed, the cosine-only 0.35 ties on quality and wins as simpler.
    expect(selectFloorPair(grid, { maxFalsePositives: 1 })).toMatchObject({ cosineFloor: 0.35, lexicalFloor: null });
    expect(selectFloorPair(grid.filter((row) => row.falsePositives > 0), { maxFalsePositives: 0 })).toBeNull();
  });

  it("reports how the positive and negative bands separate on each signal", () => {
    const sep = floorSeparation(cases);
    expect(sep.cosine).toEqual({ positiveMin: 0.36, negativeMax: 0.40, overlap: true });
    // nat's relevant note has bm25 3 < neg-1's 5.4: the overlap is reported, not hidden.
    expect(sep.bm25).toEqual({ positiveMin: 3, negativeMax: 5.4, overlap: true, positivesWithoutMatch: 0 });
    expect(sep).toMatchObject({ answerable: 2, unanswerable: 2 });
  });
});

