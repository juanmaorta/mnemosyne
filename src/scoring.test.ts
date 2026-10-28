import { describe, expect, test } from "vitest";
import { recencyScore, importanceNorm, blendedScore, retention, reinforce, scoreBreakdown, DEFAULT_TAU_MS, INITIAL_STRENGTH, DEFAULT_WEIGHTS } from "./scoring.js";

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

describe("recency inversion (regression: retrieval diagnosis, 2026-09-03)", () => {
  // The old code gave a never-accessed engram recencyNorm 1 — the MAXIMUM of
  // the axis, not a neutral value. Reading an engram therefore PENALISED it:
  // measured in the field, accessed engrams reached the top-k 4-8x less often
  // than ones never touched.
  const base = { importance: 5, relevanceCosine: 0.5 };
  const DAY = 24 * 3600 * 1000;
  const now = Date.parse("2026-09-03T10:00:00.000Z");

  test("an engram accessed yesterday outranks one never accessed", () => {
    const fresh = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - DAY, accessCount: 1 });
    const never = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - 400 * DAY, accessCount: 0 });
    expect(fresh.score).toBeGreaterThan(never.score);
  });

  test("reading an engram never lowers its own score", () => {
    // Same engram, same instant: the only difference is that it has been read.
    const unread = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - 30 * DAY, accessCount: 0 });
    const read = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now, accessCount: 1 });
    expect(read.score).toBeGreaterThanOrEqual(unread.score);
  });

  test("an unread note's recency is measured from its creation", () => {
    const never = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - DEFAULT_TAU_MS, accessCount: 0 });
    expect(never.signals.accessed).toBe(false);
    expect(never.signals.recencyNorm).toBeCloseTo(Math.exp(-1), 10);
  });

  test("unread notes of different ages no longer share a fixed prior", () => {
    const old = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - 60 * DAY, accessCount: 0 });
    const newNote = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - DAY, accessCount: 0 });
    expect(newNote.signals.recencyNorm).toBeGreaterThan(old.signals.recencyNorm);
  });

  test("more accesses outrank fewer at the same age and relevance", () => {
    const one = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - 30 * DAY, accessCount: 1, strength: 2 });
    const many = scoreBreakdown({ ...base, nowMs: now, lastAccessMs: now - 30 * DAY, accessCount: 4, strength: 5 });
    expect(many.signals.recencyNorm).toBeGreaterThan(one.signals.recencyNorm);
    expect(many.score).toBeGreaterThan(one.score);
  });
});

describe("scoreBreakdown", () => {
  test("never_accessed_note_uses_its_creation_age_and_exposes_each_signal", () => {
    const { score, signals } = scoreBreakdown({
      nowMs: 1000 + DEFAULT_TAU_MS, lastAccessMs: 1000, accessCount: 0, importance: 10, relevanceCosine: 0.5,
    });
    expect(signals.accessed).toBe(false);
    expect(signals.recencyNorm).toBeCloseTo(Math.exp(-1), 10);
    expect(signals.recencyRaw).toBe(DEFAULT_TAU_MS);
    expect(signals.importanceRaw).toBe(10);
    expect(signals.importanceNorm).toBe(1);
    expect(signals.relevanceCosine).toBe(0.5);
    const w = DEFAULT_WEIGHTS, total = w.recency + w.importance + w.relevance;
    expect(score).toBeCloseTo((w.recency * Math.exp(-1) + w.importance * 1 + w.relevance * 0.5) / total, 10);
  });

  test("accessed_note_uses_recencyScore_for_recencyNorm", () => {
    const { signals } = scoreBreakdown({
      nowMs: 1000 + DEFAULT_TAU_MS, lastAccessMs: 1000, accessCount: 3, importance: 1, relevanceCosine: 0,
    });
    expect(signals.accessed).toBe(true);
    expect(signals.recencyNorm).toBeCloseTo(Math.exp(-1), 6); // dt == tau → e^-1
    expect(signals.recencyRaw).toBe(DEFAULT_TAU_MS);
  });

  test("never_accessed_note_still_reports_age_from_its_seeded_last_access", () => {
    // hot_state seeds last_access from `created`, so an unaccessed engram DOES
    // have a timestamp — it just must not earn recency. Reporting recencyRaw:0
    // here would read as "accessed 0ms ago"; `accessed` is what disambiguates.
    const { signals } = scoreBreakdown({
      nowMs: 1000 + DEFAULT_TAU_MS, lastAccessMs: 1000, accessCount: 0, importance: 5, relevanceCosine: 0.5,
    });
    expect(signals.accessed).toBe(false);
    expect(signals.recencyNorm).toBeCloseTo(Math.exp(-1), 10);
    expect(signals.recencyRaw).toBe(DEFAULT_TAU_MS); // but the real age survives
  });

  test("score_is_recomputable_from_the_exposed_signals", () => {
    const w = { recency: 0.5, importance: 0.5, relevance: 2 };
    const { score, signals } = scoreBreakdown({
      nowMs: 5_000_000, lastAccessMs: 1_000_000, accessCount: 2, importance: 7, relevanceCosine: 0.8,
    }, w);
    const total = w.recency + w.importance + w.relevance;
    expect(score).toBeCloseTo(
      (w.recency * signals.recencyNorm + w.importance * signals.importanceNorm + w.relevance * signals.relevanceCosine) / total,
      10,
    );
  });

  test("relevance_cosine_is_clamped_to_unit_range", () => {
    expect(scoreBreakdown({ nowMs: 0, lastAccessMs: null, accessCount: 0, importance: 5, relevanceCosine: 1.4 }).signals.relevanceCosine).toBe(1);
    expect(scoreBreakdown({ nowMs: 0, lastAccessMs: null, accessCount: 0, importance: 5, relevanceCosine: -0.3 }).signals.relevanceCosine).toBe(0);
  });
});

describe("retention / reinforce", () => {
  test("the 30-day base interval keeps a monthly recall measurable", () => {
    const now = 60 * 24 * 3600 * 1000;
    const monthAgo = now - 30 * 24 * 3600 * 1000;
    expect(retention(now, monthAgo, 1)).toBeCloseTo(Math.exp(-1), 10);
    expect(retention(now, monthAgo, 2)).toBeCloseTo(Math.exp(-0.5), 10);
  });
  test("calibration separates a monthly recalled note from an untouched one", () => {
    const day = 24 * 3600 * 1000;
    const now = 90 * day;
    const monthAgo = now - 30 * day;
    const separates = (tauDays: number) =>
      retention(now, monthAgo, 2, tauDays * day) > 0.5
      && retention(now, monthAgo, 1, tauDays * day) < 0.5;
    expect(separates(14)).toBe(false); // a monthly recall decays too quickly
    expect(separates(30)).toBe(true);
    expect(separates(60)).toBe(false); // an unread note stays too fresh
  });
  test("reinforce_increments_strength_and_count", () => {
    expect(reinforce({ strength: INITIAL_STRENGTH, accessCount: 0 })).toEqual({ strength: 2, accessCount: 1 });
  });
  test("retention_higher_strength_decays_slower", () => {
    const now = 100 * 24 * 3600 * 1000;
    const t = now - 10 * 24 * 3600 * 1000;
    expect(retention(now, t, 20)).toBeGreaterThan(retention(now, t, 1));
  });
});
