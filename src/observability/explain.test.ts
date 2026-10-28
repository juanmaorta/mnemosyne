import { describe, expect, test } from "vitest";
import { formatExplain } from "./explain.js";
import type { ExplainResult } from "../retrieval/search.js";
import { isDerivedSlug } from "../dreaming/derived.js";

function candidate(slug: string, rank: number, score: number, included: boolean, cos: number, accessed = false) {
  return {
    slug, scope: "personal", snippet: `${slug} body`, score, rank, included, threshold: 0.5, isDerived: isDerivedSlug(slug),
    weights: { recency: 0.25, importance: 0.25, relevance: 1 },
    signals: {
      recencyRaw: 0, recencyNorm: 1, importanceRaw: 5, importanceNorm: 0.444,
      relevanceCosine: cos, accessed,
    },
  };
}

const RESULT: ExplainResult = {
  query: "yogurt maker",
  scopes: ["personal"],
  k: 2,
  weights: { recency: 0.25, importance: 0.25, relevance: 1 },
  minCos: null,
  candidates: [
    candidate("fermentor", 0, 0.812345, true, 0.7123, true),
    candidate("router", 1, 0.5, true, 0.3),
    candidate("camara", 2, 0.201, false, 0.1),
  ],
};

describe("formatExplain", () => {
  test("renders one row per candidate with a header", () => {
    const out = formatExplain(RESULT);
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("rank") && l.includes("score") && l.includes("slug"))).toBe(true);
    for (const slug of ["fermentor", "router", "camara"]) {
      expect(out).toContain(slug);
    }
  });

  test("marks included and discarded candidates distinguishably", () => {
    const out = formatExplain(RESULT);
    const rowOf = (slug: string) => out.split("\n").find((l) => l.includes(slug))!;
    expect(rowOf("fermentor")).toContain("✓");
    expect(rowOf("camara")).toContain("✗");
  });

  test("formats signal components to three decimals", () => {
    const out = formatExplain(RESULT);
    expect(out.split("\n").find((l) => l.includes("fermentor"))).toContain("0.712");
    expect(out.split("\n").find((l) => l.includes("camara"))).toContain("0.100");
  });

  test("marks a never-accessed engram so its neutral recency is not misread", () => {
    // The marker distinguishes creation-age decay from access-age decay.
    const out = formatExplain(RESULT);
    expect(out.split("\n").find((l) => l.includes("router"))).toMatch(/1\.000\s*\*/);
    expect(out.split("\n").find((l) => l.includes("fermentor"))).not.toMatch(/1\.000\s*\*/);
    expect(out).toContain("* decay measured from creation (never accessed)");
  });

  test("shows the query context and the cut line", () => {
    const out = formatExplain(RESULT);
    expect(out).toContain("personal");
    expect(out).toContain("k=2");
    expect(out).toContain("3 candidates");
  });

  test("shows_the_raw_cosine_floor_and_rejection_reason", () => {
    const out = formatExplain({ ...RESULT, minCos: 0.7,
      candidates: RESULT.candidates.map((c) => ({ ...c, included: c.signals.relevanceCosine >= 0.7 })) });
    expect(out).toContain("minimum raw cosine: 0.700");
    expect(out.split("\n").find((l) => l.includes("router"))).toContain("below cosine floor");
  });

  test("truncates a long candidate set but never below k", () => {
    const many: ExplainResult = {
      ...RESULT,
      k: 3,
      candidates: Array.from({ length: 50 }, (_, i) => candidate(`slug-${i}`, i, 1 - i / 100, i < 3, 0.5)),
    };

    const out = formatExplain(many, { limit: 5 });

    expect(out).toContain("slug-4");
    expect(out).not.toContain("slug-9");
    expect(out).toContain("45 more below the cut line");
  });

  test("shows every row when the limit is lifted", () => {
    const many: ExplainResult = {
      ...RESULT,
      candidates: Array.from({ length: 50 }, (_, i) => candidate(`slug-${i}`, i, 1 - i / 100, i < 2, 0.5)),
    };

    const out = formatExplain(many, { limit: null });

    expect(out).toContain("slug-49");
    expect(out).not.toContain("more below the cut line");
  });

  test("handles an empty candidate set without a bare table", () => {
    const out = formatExplain({ ...RESULT, candidates: [] });
    expect(out).toContain("no candidates");
  });
});
