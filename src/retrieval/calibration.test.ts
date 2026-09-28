import { describe, expect, test } from "vitest";
import { blendedScore, normalizeCandidateSignals, recencyScore } from "../scoring.js";

describe("candidate signal calibration (MNE-27)", () => {
  test.each([
    ["unread relevant versus recently read distractor", recencyScore(100, 100 - 14 * 24 * 3600 * 1000), 0.941],
    ["older read relevant versus newly created distractor", 0.08, 1],
  ])("%s: recency cannot displace the better cosine at the top-k boundary", (_case, relevantRecency, distractorRecency) => {
    const candidates = [
      { slug: "compas", recency: relevantRecency, importance: 4 / 9, relevance: 0.615 },
      { slug: "speakers", recency: distractorRecency, importance: 4 / 9, relevance: 0.557 },
      { slug: "other-a", recency: 0.50, importance: 4 / 9, relevance: 0.620 },
      { slug: "other-b", recency: 0.50, importance: 4 / 9, relevance: 0.580 },
      { slug: "other-c", recency: 0.50, importance: 4 / 9, relevance: 0.540 },
      { slug: "other-d", recency: 0.50, importance: 4 / 9, relevance: 0.480 },
    ];
    const normalized = normalizeCandidateSignals(candidates);
    const scored = candidates.map((candidate, i) => ({
      slug: candidate.slug,
      score: blendedScore(normalized[i]!),
    })).sort((a, b) => b.score - a.score);

    expect(scored.slice(0, 5).map((candidate) => candidate.slug)).toContain("compas");
    expect(scored.findIndex((candidate) => candidate.slug === "compas"))
      .toBeLessThan(scored.findIndex((candidate) => candidate.slug === "speakers"));
    const cosineOnly = [...candidates].sort((a, b) => b.relevance - a.relevance).slice(0, 5);
    const blendedTopK = new Set(scored.slice(0, 5).map((candidate) => candidate.slug));
    expect(cosineOnly.filter((candidate) => blendedTopK.has(candidate.slug))).toHaveLength(5);
  });

  test("a constant signal cannot affect ranking", () => {
    const normalized = normalizeCandidateSignals([
      { recency: 0.3, importance: 4 / 9, relevance: 0.48 },
      { recency: 0.3, importance: 4 / 9, relevance: 0.62 },
    ]);
    expect(normalized[0]!.recency).toBe(normalized[1]!.recency);
    expect(normalized[0]!.importance).toBe(normalized[1]!.importance);
    expect(blendedScore(normalized[1]!)).toBeGreaterThan(blendedScore(normalized[0]!));
  });
});
