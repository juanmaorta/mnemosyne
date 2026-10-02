import { queryMetrics, summarizeEvaluation, type GradedDocument } from "./golden-metrics.js";
import { blendedScore, type Weights } from "./scoring.js";

export interface CalibrationCandidate {
  slug: string;
  cosine: number;
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

export function rankCalibrationCandidates(
  candidates: readonly CalibrationCandidate[], config: CalibrationConfig, k: number,
): string[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: blendedScore(candidate.normalized, config.weights) }))
    .filter(({ candidate }) => config.floor === null || candidate.cosine >= config.floor)
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
