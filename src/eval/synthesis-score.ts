/**
 * Deterministic scorer for the dreaming synthesis golden set (MNE-84).
 *
 * Pure functions, no IO and no LLM: given a proposal's body (and, for retrieval,
 * already-collected rankings) they return a scorecard comparable across models.
 * This is the instrument that turns "did a model get better?" from a hand-written
 * narrative (MNE-80) into numbers you can rerun on 7b vs 14b vs 32b vs cloud.
 *
 * Fidelity is measured by a PROXY: required substrings that a faithful note must
 * contain and forbidden ones it must not. A proxy, not a proof — a datum can sit
 * in the wrong context and still match — so a human spot-check stays in the loop.
 * But it is cheap, reproducible and needs no LLM judge (which MNE-80 ruled out),
 * and it catches exactly the failures the evaluation found: dropped required data
 * and invented/garbled identifiers.
 */

export interface CaseSpec {
  id: string;
  /** Substrings a faithful body MUST contain (required data points). */
  required: string[];
  /** Substrings that MUST NOT appear (fabrications or wrong claims). */
  forbidden: string[];
  /** Soft cap on body length for conciseness; omitted = no cap. */
  maxChars?: number;
}

export interface CoverageScore {
  requiredTotal: number;
  requiredHit: number;
  missing: string[];
  forbiddenPresent: string[];
}

export interface ConcisenessScore {
  chars: number;
  maxChars?: number;
  within: boolean;
}

export interface RetrievalScore {
  /** 1-based rank of the synthetic note in the +synthesis ranking; null if absent. */
  synthRank: number | null;
  sourceRanks: { slug: string; baseRank: number | null; plusRank: number | null }[];
  /** Sources retrievable in base but pushed out of the +synthesis ranking. */
  buriedSources: string[];
}

export interface CaseScore {
  id: string;
  coverage: CoverageScore;
  conciseness: ConcisenessScore;
  applicable: boolean;
  passed: boolean;
  /** Present only when the case measured retrieval/duplication. */
  retrieval?: RetrievalScore;
  /** Present only when a second, same-seed pass was run. */
  stableWithRerun?: boolean;
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function scoreCoverage(body: string, spec: Pick<CaseSpec, "required" | "forbidden">): CoverageScore {
  const missing = spec.required.filter((r) => !contains(body, r));
  const forbiddenPresent = spec.forbidden.filter((f) => contains(body, f));
  return {
    requiredTotal: spec.required.length,
    requiredHit: spec.required.length - missing.length,
    missing,
    forbiddenPresent,
  };
}

export function scoreConciseness(body: string, maxChars?: number): ConcisenessScore {
  const chars = body.length;
  return {
    chars,
    ...(maxChars !== undefined ? { maxChars } : {}),
    within: maxChars === undefined ? true : chars <= maxChars,
  };
}

export function scoreStability(bodyA: string, bodyB: string): { identical: boolean } {
  return { identical: bodyA === bodyB };
}

/** 1-based rank of `slug` in `ranked`, or null if absent. */
function rankOf(ranked: string[], slug: string): number | null {
  const i = ranked.indexOf(slug);
  return i === -1 ? null : i + 1;
}

export function scoreRetrieval(
  baseRanked: string[],
  plusRanked: string[],
  opts: { synthSlug: string; sources: string[] },
): RetrievalScore {
  const sourceRanks = opts.sources.map((slug) => ({
    slug,
    baseRank: rankOf(baseRanked, slug),
    plusRank: rankOf(plusRanked, slug),
  }));
  // A source is "buried" when it was retrievable before the synthetic note was
  // added and is no longer in the result set after — the duplication regression
  // MNE-80 warned about (a derived note must not evict its own source).
  const buriedSources = sourceRanks
    .filter((s) => s.baseRank !== null && s.plusRank === null)
    .map((s) => s.slug);
  return { synthRank: rankOf(plusRanked, opts.synthSlug), sourceRanks, buriedSources };
}

/** A case passes only if every required datum is present, no forbidden string
 *  appears, the body is within its size cap, and the proposal was applicable. */
export function casePassed(coverage: CoverageScore, conciseness: ConcisenessScore, applicable: boolean): boolean {
  return (
    applicable &&
    coverage.requiredHit === coverage.requiredTotal &&
    coverage.forbiddenPresent.length === 0 &&
    conciseness.within
  );
}

/** A compact, model-labelled text scorecard — the comparable artifact per model. */
export function renderScorecard(modelId: string, rows: CaseScore[]): string {
  const passedCount = rows.filter((r) => r.passed).length;
  const lines: string[] = [];
  lines.push(`Synthesis scorecard — model ${modelId}`);
  lines.push(`passed ${passedCount}/${rows.length}`);
  for (const r of rows) {
    const cov = `${r.coverage.requiredHit}/${r.coverage.requiredTotal} req`;
    const bad = r.coverage.forbiddenPresent.length > 0 ? ` forbidden:${r.coverage.forbiddenPresent.join(",")}` : "";
    const miss = r.coverage.missing.length > 0 ? ` missing:${r.coverage.missing.join("|")}` : "";
    const size = `${r.conciseness.chars}c${r.conciseness.within ? "" : "!"}`;
    const buried = r.retrieval && r.retrieval.buriedSources.length > 0 ? ` buries:${r.retrieval.buriedSources.join(",")}` : "";
    const stab = r.stableWithRerun === false ? " UNSTABLE" : "";
    lines.push(`  [${r.passed ? "PASS" : "FAIL"}] ${r.id}  ${cov} ${size}${miss}${bad}${buried}${stab}`);
  }
  return lines.join("\n");
}
