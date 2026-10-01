import { describe, expect, it } from "vitest";
import { diagnoseQuery, diagnosticTime, rankingMetadataDigest, summarizeDiagnostics } from "./golden-diagnostics.js";

const hit = (slug: string, cosine: number, recency = 0.5) => ({
  slug,
  signals: { relevanceCosine: cosine, recencyNorm: recency, importanceNorm: 0.5,
    normalized: { relevance: cosine, recency, importance: 0.5 } },
});

describe("golden retrieval diagnosis", () => {
  it("uses current time when a changed corpus contains notes newer than review", () => {
    expect(diagnosticTime(100, true, 200)).toBe(200);
    expect(diagnosticTime(100, false, 200)).toBe(100);
  });

  it("detects an importance edit even when note content is unchanged", () => {
    const doc = { scope: "personal", slug: "a", created: "2026-01-01", type: "reference", status: "active" };
    expect(rankingMetadataDigest([{ ...doc, importance: 3 }]))
      .not.toBe(rankingMetadataDigest([{ ...doc, importance: 8 }]));
  });
  it("attributes a relevant cosine top-10 hit displaced by the blend to the ranker", () => {
    const distractors = Array.from({ length: 10 }, (_, i) => hit(`d${i}`, 0.9 - i * 0.01));
    const cosine = [hit("relevant", 0.95), ...distractors];
    const blended = [...distractors, hit("relevant", 0.95)];
    const result = diagnoseQuery("q-01", [{ slug: "relevant", grade: 3 }], blended, cosine);
    expect(result.cause).toBe("ranker");
    expect(result.firstRelevantRank).toBe(11);
    expect(result.cosineFirstRelevantRank).toBe(1);
    expect(result.bestRelevantCosine).toBe(0.95);
    expect(result.blendWinnerCosine).toBe(0.9);
  });

  it("identifies a relevant item absent from the cosine top-10 as an embedding or label question", () => {
    const distractors = Array.from({ length: 10 }, (_, i) => hit(`d${i}`, 0.95 - i * 0.01));
    const ranked = [...distractors, hit("relevant", 0.7)];
    const result = diagnoseQuery("q-02", [{ slug: "relevant", grade: 3 }], ranked, ranked);
    expect(result.cause).toBe("embedder-or-label");
    expect(result.cosineFirstRelevantRank).toBe(11);
    expect(result.cosineFailure).toBe("missing-top10");
  });

  it("distinguishes weak cosine placement within top ten from a missing hit", () => {
    const distractors = Array.from({ length: 8 }, (_, i) => hit(`d${i}`, 0.9 - i * 0.01));
    const ranked = [...distractors, hit("relevant", 0.7)];
    const result = diagnoseQuery("q-weak", [{ slug: "relevant", grade: 3 }], ranked, ranked);
    expect(result.cause).toBe("embedder-or-label");
    expect(result.cosineFailure).toBe("weak-top10");
    expect(result.cosineFirstRelevantRank).toBe(9);
  });

  it("separates the cosine floor from embedding quality", () => {
    const result = diagnoseQuery("q-floor", [{ slug: "relevant", grade: 3 }],
      [hit("d", 0.8)], [hit("relevant", 0.69), hit("d", 0.6)], 0.7);
    expect(result.cause).toBe("cosine-floor");
    expect(result.bestRelevantCosine).toBe(0.69);
  });

  it("uses graded nDCG to compare cosine and blended ranking", () => {
    const relevance = [{ slug: "best", grade: 3 }, { slug: "sibling", grade: 2 }];
    const result = diagnoseQuery("q-03", relevance,
      [hit("sibling", 0.8), hit("best", 0.9)],
      [hit("best", 0.9), hit("sibling", 0.8)]);
    expect(result.cause).toBe("ranker");
    expect(result.cosineNdcgAt10).toBe(1);
    expect(result.blendedNdcgAt10).toBeLessThan(1);
    expect(summarizeDiagnostics([result]).cosine.meanNdcgAt10).toBe(1);
  });

  it("excludes unanswerable questions from nDCG and marks them for separate review", () => {
    const result = diagnoseQuery("q-04", [], [hit("d", 0.8)], [hit("d", 0.8)]);
    expect(result.cause).toBe("unanswerable");
    expect(summarizeDiagnostics([result]).blended.meanNdcgAt10).toBeNull();
    expect(summarizeDiagnostics([result]).unanswerable).toEqual({
      queries: 1, blendedFalsePositives: 1, cosineFalsePositives: 1,
    });
  });
});
