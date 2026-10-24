import { queryMetrics, summarizeEvaluation, type GradedDocument } from "./golden-metrics.js";
import { blendedScore, type Weights } from "./scoring.js";

export interface CalibrationCandidate {
  slug: string;
  cosine: number;
  /** Raw BM25 goodness (`-bm25()`); null/absent when the note has no lexical match. */
  bm25?: number | null;
  normalized: { recency: number; importance: number; relevance: number };
}

export interface CalibrationCase {
  id: string;
  relevance: GradedDocument[];
  candidates: CalibrationCandidate[];
}

export interface CalibrationConfig {
  weights: Weights;
  floor: number | null;
  /** Lexical rescue floor on raw BM25 (MNE-98); null/absent = cosine-only gate. */
  lexicalFloor?: number | null;
}

export function assertCalibrationReviewSet(
  review: {
    corpus: { sha256: string; rankingSha256?: string };
    queries: readonly { id: string; approved: boolean; anchorSlug: string | null; relevance: readonly GradedDocument[] }[];
  },
  current: { contentSha256: string; rankingSha256: string; documentSlugs: ReadonlySet<string> },
): void {
  if (review.corpus.sha256 !== current.contentSha256) throw new Error("reviewed corpus content changed");
  if (!review.corpus.rankingSha256 || review.corpus.rankingSha256 !== current.rankingSha256) {
    throw new Error("reviewed corpus ranking metadata changed or was never captured");
  }
  if (review.queries.some((query) => query.approved !== true)) throw new Error("review set has unapproved queries");
  if (review.queries.filter((query) => query.relevance.length === 0).length < 10) {
    throw new Error("calibration needs at least 10 reviewed unanswerable queries per scope");
  }
  const ids = new Set<string>();
  for (const query of review.queries) {
    if (!query.id || ids.has(query.id)) throw new Error("review set has missing or duplicate query IDs");
    ids.add(query.id);
    if (query.anchorSlug !== null && !current.documentSlugs.has(query.anchorSlug)) {
      throw new Error(`reviewed query ${query.id} has a missing anchor`);
    }
    if (query.anchorSlug === null && query.relevance.length > 0) {
      throw new Error(`reviewed query ${query.id} has labels without an anchor`);
    }
    for (const item of query.relevance) {
      if (!current.documentSlugs.has(item.slug)) throw new Error(`reviewed query ${query.id} has a missing labeled document`);
    }
  }
}

/** Mirrors `searchExplain`'s eligibility: cosine floor OR lexical rescue. */
function passesCalibrationGate(candidate: CalibrationCandidate, config: CalibrationConfig): boolean {
  if (config.floor === null || candidate.cosine >= config.floor) return true;
  const lexicalFloor = config.lexicalFloor ?? null;
  return lexicalFloor !== null && candidate.bm25 != null && candidate.bm25 >= lexicalFloor;
}

export function rankCalibrationCandidates(
  candidates: readonly CalibrationCandidate[], config: CalibrationConfig, k: number,
): string[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: blendedScore(candidate.normalized, config.weights) }))
    .filter(({ candidate }) => passesCalibrationGate(candidate, config))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map(({ candidate }) => candidate.slug);
}

export function evaluateCalibration(cases: readonly CalibrationCase[], config: CalibrationConfig, k = 10) {
  const perQuery = cases.map((item) => {
    const ranked = rankCalibrationCandidates(item.candidates, config, k);
    const metric = queryMetrics(ranked, item.relevance, k);
    return {
      id: item.id,
      answerable: item.relevance.some(({ grade }) => grade > 0),
      ndcgAtK: metric.ndcgAtK,
      reciprocalRank: metric.reciprocalRank,
      relevantReturned: metric.relevantReturned,
      returnedCount: ranked.length,
    };
  });
  return { ...summarizeEvaluation(perQuery), perQuery };
}

export function compareCalibrationArms(
  cases: readonly CalibrationCase[], configurations: readonly { name: string; config: CalibrationConfig }[], k = 10,
) {
  return configurations.map(({ name, config }) => ({ name, config, result: evaluateCalibration(cases, config, k) }));
}

export function selectEligibleConfigurations(
  rows: readonly { name: string; scopes: Record<string, { ndcg: number | null; falsePositives: number }> }[],
  constraints: readonly { scope: string; minNdcg: number; maxFalsePositives: number }[],
): string[] {
  return rows.filter((row) => constraints.every(({ scope, minNdcg, maxFalsePositives }) => {
    const summary = row.scopes[scope];
    return summary && summary.ndcg !== null && summary.ndcg >= minNdcg - 1e-9
      && summary.falsePositives <= maxFalsePositives;
  })).map((row) => row.name);
}

export interface FloorGridRow {
  cosineFloor: number;
  lexicalFloor: number | null;
  answerable: number;
  /** Share of answerable queries that return at least one relevant note. */
  recall: number | null;
  /** Relevant notes returned that are below the cosine floor: let in only by lexical rescue. */
  lexicalOnly: number;
  ndcg: number | null;
  mrr: number | null;
  unanswerable: number;
  falsePositives: number;
}

/**
 * MNE-98: evaluate the two-signal gate over every (cosine floor, lexical floor)
 * pair. Ranking stays cosine-only (`weights` default to relevance alone, as in
 * production search); only eligibility varies, which is what the floors decide.
 */
export function sweepFloorGrid(
  cases: readonly CalibrationCase[],
  grid: { cosineFloors: readonly number[]; lexicalFloors: readonly (number | null)[]; weights?: Weights },
  k = 10,
): FloorGridRow[] {
  const weights = grid.weights ?? { recency: 0, importance: 0, relevance: 1 };
  return grid.cosineFloors.flatMap((cosineFloor) => grid.lexicalFloors.map((lexicalFloor) => {
    const config = { weights, floor: cosineFloor, lexicalFloor };
    const result = evaluateCalibration(cases, config, k);
    const answerable = result.perQuery.filter((query) => query.answerable);
    const lexicalOnly = cases.reduce((sum, item) => {
      const relevant = new Set(item.relevance.filter(({ grade }) => grade > 0).map(({ slug }) => slug));
      const returned = new Set(rankCalibrationCandidates(item.candidates, config, k));
      return sum + item.candidates.filter((c) => relevant.has(c.slug) && returned.has(c.slug) && c.cosine < cosineFloor).length;
    }, 0);
    return {
      cosineFloor,
      lexicalFloor,
      answerable: answerable.length,
      recall: answerable.length ? answerable.filter((query) => query.relevantReturned > 0).length / answerable.length : null,
      lexicalOnly,
      ndcg: result.answerable.meanNdcgAt10,
      mrr: result.answerable.mrr,
      unanswerable: result.unanswerable.queries,
      falsePositives: result.unanswerable.falsePositives,
    };
  }));
}

/**
 * Best pair within the false-positive budget: recall first (the floor exists to
 * cut noise, not answers), then nDCG. Quality ties are common — whole plateaus of
 * pairs score the same on a small golden — and the tie-break decides robustness:
 *  1. the simpler gate (no lexical rescue);
 *  2. the least reliance on rescue (`lexicalOnly`): the golden's positives may all
 *     share vocabulary with their notes, real paraphrases will not, so a pair that
 *     only works because BM25 carries the positives is overfitted to the golden;
 *  3. the stricter lexical floor (more margin against lexical near-misses);
 *  4. the MEDIAN cosine floor of what is still tied — margin on both sides, not
 *     the edge of the plateau next to a leak or next to a lost positive.
 * Null when no pair meets the budget.
 */
export function selectFloorPair(rows: readonly FloorGridRow[], constraint: { maxFalsePositives: number }): FloorGridRow | null {
  const by = (value: number | null): number => value ?? -Infinity;
  const ranked = rows.filter((row) => row.falsePositives <= constraint.maxFalsePositives).sort((a, b) =>
    by(b.recall) - by(a.recall)
    || by(b.ndcg) - by(a.ndcg)
    || Number(a.lexicalFloor !== null) - Number(b.lexicalFloor !== null)
    || a.lexicalOnly - b.lexicalOnly
    || by(b.lexicalFloor) - by(a.lexicalFloor)
    || a.cosineFloor - b.cosineFloor);
  const best = ranked[0];
  if (!best) return null;
  const plateau = ranked.filter((row) => row.recall === best.recall && row.ndcg === best.ndcg
    && row.lexicalOnly === best.lexicalOnly && row.lexicalFloor === best.lexicalFloor);
  return plateau[Math.floor((plateau.length - 1) / 2)]!;
}

/**
 * How far apart the bands are on each signal: the weakest positive (best
 * relevant note per answerable query, minimum over queries) against the strongest
 * negative (best candidate per unanswerable query, maximum over queries).
 * `overlap` means no single floor on that signal separates them.
 */
export function floorSeparation(cases: readonly CalibrationCase[]) {
  const answerable = cases.filter((item) => item.relevance.some(({ grade }) => grade > 0));
  const unanswerable = cases.filter((item) => !item.relevance.some(({ grade }) => grade > 0));
  const bestRelevant = (item: CalibrationCase, signal: (c: CalibrationCandidate) => number | null | undefined): number | null => {
    const relevant = new Set(item.relevance.filter(({ grade }) => grade > 0).map(({ slug }) => slug));
    const values = item.candidates.filter((c) => relevant.has(c.slug)).map(signal).filter((v): v is number => v != null);
    return values.length ? Math.max(...values) : null;
  };
  const bestAny = (item: CalibrationCase, signal: (c: CalibrationCandidate) => number | null | undefined): number | null => {
    const values = item.candidates.map(signal).filter((v): v is number => v != null);
    return values.length ? Math.max(...values) : null;
  };
  const band = (signal: (c: CalibrationCandidate) => number | null | undefined) => {
    const positives = answerable.map((item) => bestRelevant(item, signal));
    const present = positives.filter((v): v is number => v !== null);
    const negatives = unanswerable.map((item) => bestAny(item, signal)).filter((v): v is number => v !== null);
    const positiveMin = present.length ? Math.min(...present) : null;
    const negativeMax = negatives.length ? Math.max(...negatives) : null;
    return {
      positiveMin,
      negativeMax,
      overlap: positiveMin !== null && negativeMax !== null && positiveMin <= negativeMax,
      positivesWithoutMatch: positives.length - present.length,
    };
  };
  const { positivesWithoutMatch: _cosineAlwaysPresent, ...cosine } = band((c) => c.cosine);
  return { answerable: answerable.length, unanswerable: unanswerable.length, cosine, bm25: band((c) => c.bm25) };
}
