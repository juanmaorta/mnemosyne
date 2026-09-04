// src/observability/format.test.ts
import { describe, expect, test } from "vitest";
import { formatStats } from "./format.js";
import type { Stats } from "./stats.js";

/** A measured-but-healthy store; each test overrides only what it is about. */
function stats(over: Partial<Stats> = {}): Stats {
  return {
    countsByScope: { personal: 2 },
    countsByType: { reference: 2 },
    factStreamSize: 0,
    staleCount: 0,
    searchLatencyMs: { p50: 4, p95: 9 },
    avgCandidateSetSize: 2,
    avgTopKCosine: 0.7,
    emptyResultRate: 0,
    injectionBudgetUtil: 1,
    strengthHistogram: {},
    reinforcementRate: 0.5,
    degradedInjectionRate: 0,
    ...over,
  };
}

describe("formatStats", () => {
  test("renders the degraded-injection rate as a percentage", () => {
    // The whole point of the metric is to be readable at a glance next to the
    // budget row it must not be confused with.
    expect(formatStats(stats({ degradedInjectionRate: 0.25 }))).toMatch(/degraded injections\s+25\.0%/);
  });

  test("renders an unmeasured degraded rate as a dash, not as zero", () => {
    // A 0% would read as "measured, and nothing was degraded" — the opposite
    // conclusion from "never measured", which is what null means here.
    expect(formatStats(stats({ degradedInjectionRate: null }))).toMatch(/degraded injections\s+—/);
  });
});
