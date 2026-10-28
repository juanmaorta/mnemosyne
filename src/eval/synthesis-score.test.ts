// src/eval/synthesis-score.test.ts
import { describe, expect, test } from "vitest";
import {
  scoreCoverage,
  scoreConciseness,
  scoreStability,
  scoreRetrieval,
  casePassed,
  renderScorecard,
  type CaseScore,
} from "./synthesis-score.js";

describe("scoreCoverage", () => {
  test("counts required hits and lists what is missing", () => {
    const body = "El LedStrip tiene 90 LEDs WS2812B, IP 192.0.2.41.";
    const s = scoreCoverage(body, { required: ["90 LEDs", "192.0.2.41", "GRB"], forbidden: [] });
    expect(s.requiredTotal).toBe(3);
    expect(s.requiredHit).toBe(2);
    expect(s.missing).toEqual(["GRB"]);
  });

  test("matching is case-insensitive", () => {
    const s = scoreCoverage("nimbus-relay es MIT", { required: ["Nimbus-Relay", "mit"], forbidden: [] });
    expect(s.requiredHit).toBe(2);
    expect(s.missing).toEqual([]);
  });

  test("flags forbidden strings that appear", () => {
    const s = scoreCoverage("el proyecto nimbo-relay", { required: [], forbidden: ["nimbo-relay", "se publica en npm"] });
    expect(s.forbiddenPresent).toEqual(["nimbo-relay"]);
  });
});

describe("scoreConciseness", () => {
  test("reports chars and whether within the cap", () => {
    expect(scoreConciseness("abcde", 10)).toEqual({ chars: 5, maxChars: 10, within: true });
    expect(scoreConciseness("abcdefghijk", 10).within).toBe(false);
  });

  test("no cap means always within", () => {
    const s = scoreConciseness("x".repeat(9999));
    expect(s.within).toBe(true);
    expect(s.maxChars).toBeUndefined();
  });
});

describe("scoreStability", () => {
  test("identical bodies are stable", () => {
    expect(scoreStability("misma nota", "misma nota").identical).toBe(true);
  });
  test("different bodies are not", () => {
    expect(scoreStability("a", "b").identical).toBe(false);
  });
});

describe("scoreRetrieval", () => {
  const opts = { synthSlug: "dream-x", sources: ["src-a", "src-b"] };

  test("reports 1-based ranks of the synthetic note and its sources", () => {
    const base = ["src-a", "src-b", "other"];
    const plus = ["dream-x", "src-a", "src-b"];
    const s = scoreRetrieval(base, plus, opts);
    expect(s.synthRank).toBe(1);
    expect(s.sourceRanks).toEqual([
      { slug: "src-a", baseRank: 1, plusRank: 2 },
      { slug: "src-b", baseRank: 2, plusRank: 3 },
    ]);
    expect(s.buriedSources).toEqual([]);
  });

  test("a source present in base but gone from plus is buried", () => {
    const base = ["src-a", "src-b"];
    const plus = ["dream-x", "src-a"]; // src-b pushed out
    const s = scoreRetrieval(base, plus, opts);
    expect(s.buriedSources).toEqual(["src-b"]);
  });

  test("synthRank is null when the note did not surface", () => {
    const s = scoreRetrieval(["src-a"], ["src-a"], opts);
    expect(s.synthRank).toBeNull();
  });
});

describe("casePassed", () => {
  test("passes only with full coverage, no forbidden, within size, and applicable", () => {
    const ok = casePassed(
      { requiredTotal: 2, requiredHit: 2, missing: [], forbiddenPresent: [] },
      { chars: 10, maxChars: 100, within: true },
      true,
    );
    expect(ok).toBe(true);
  });

  test("fails on a missing required datum", () => {
    expect(casePassed(
      { requiredTotal: 2, requiredHit: 1, missing: ["GRB"], forbiddenPresent: [] },
      { chars: 10, within: true },
      true,
    )).toBe(false);
  });

  test("fails on a forbidden string or when not applicable", () => {
    expect(casePassed(
      { requiredTotal: 0, requiredHit: 0, missing: [], forbiddenPresent: ["nimbo-relay"] },
      { chars: 10, within: true },
      true,
    )).toBe(false);
    expect(casePassed(
      { requiredTotal: 0, requiredHit: 0, missing: [], forbiddenPresent: [] },
      { chars: 10, within: true },
      false,
    )).toBe(false);
  });
});

describe("renderScorecard", () => {
  test("names the model and marks each case PASS/FAIL", () => {
    const rows: CaseScore[] = [
      { id: "c1", coverage: { requiredTotal: 2, requiredHit: 2, missing: [], forbiddenPresent: [] }, conciseness: { chars: 50, within: true }, applicable: true, passed: true },
      { id: "c2", coverage: { requiredTotal: 3, requiredHit: 1, missing: ["x", "y"], forbiddenPresent: [] }, conciseness: { chars: 50, within: true }, applicable: true, passed: false },
    ];
    const text = renderScorecard("qwen2.5:14b", rows);
    expect(text).toContain("qwen2.5:14b");
    expect(text).toContain("c1");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("1/2"); // passed cases
  });
});
