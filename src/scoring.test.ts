import { describe, expect, test } from "vitest";
import { recencyScore, importanceNorm, blendedScore, retention, reinforce, DEFAULT_TAU_MS, INITIAL_STRENGTH, DEFAULT_WEIGHTS } from "./scoring.js";

describe("recencyScore", () => {
  test("recencyScore_is_1_at_zero_age", () => {
    expect(recencyScore(1000, 1000)).toBeCloseTo(1, 6);
  });
  test("recencyScore_decays_with_age", () => {
    const now = 10 * DEFAULT_TAU_MS;
    expect(recencyScore(now, now - DEFAULT_TAU_MS)).toBeCloseTo(Math.exp(-1), 6);
  });
  test("recencyScore_clamps_future_access_to_1", () => {
    expect(recencyScore(1000, 2000)).toBeCloseTo(1, 6);
  });
});

describe("importanceNorm", () => {
  test("importanceNorm_maps_1_to_0_and_10_to_1", () => {
    expect(importanceNorm(1)).toBe(0);
    expect(importanceNorm(10)).toBe(1);
  });
});

describe("blendedScore", () => {
  test("blendedScore_averages_equal_weights", () => {
    expect(blendedScore({ recency: 0, importance: 0.5, relevance: 1 }, { recency: 1, importance: 1, relevance: 1 })).toBeCloseTo(0.5, 6);
  });
  test("blendedScore_respects_weights", () => {
    expect(blendedScore({ recency: 0, importance: 0, relevance: 1 }, { recency: 0, importance: 0, relevance: 1 })).toBeCloseTo(1, 6);
  });
  test("blendedScore_defaults_to_relevance_primary_weights", () => {
    // relevance-primary default: relevance weighs 4x recency/importance (1 vs 0.25 each)
    expect(DEFAULT_WEIGHTS).toEqual({ recency: 0.25, importance: 0.25, relevance: 1 });
    expect(blendedScore({ recency: 0, importance: 0, relevance: 1 })).toBeCloseTo(1 / 1.5, 6);
  });
});

describe("retention / reinforce", () => {
  test("reinforce_increments_strength_and_count", () => {
    expect(reinforce({ strength: INITIAL_STRENGTH, accessCount: 0 })).toEqual({ strength: 2, accessCount: 1 });
  });
  test("retention_higher_strength_decays_slower", () => {
    const now = 100 * 24 * 3600 * 1000;
    const t = now - 10 * 24 * 3600 * 1000;
    expect(retention(now, t, 20)).toBeGreaterThan(retention(now, t, 1));
  });
});
