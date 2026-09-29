export interface GradedDocument { slug: string; grade: number }
export interface QueryMetric { ndcgAtK: number; reciprocalRank: number; relevantReturned: number }
export interface EvaluatedQuery extends QueryMetric { answerable: boolean; returnedCount: number }

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("percentile must be between 0 and 1");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export function queryMetrics(rankedSlugs: string[], relevance: GradedDocument[], topK = 10): QueryMetric {
  const grades = new Map(relevance.map(({ slug, grade }) => [slug, grade]));
  const dcg = rankedSlugs.slice(0, topK).reduce((sum, slug, i) => {
    const grade = grades.get(slug) ?? 0;
    return sum + (2 ** grade - 1) / Math.log2(i + 2);
  }, 0);
  const ideal = relevance.map(({ grade }) => grade).sort((a, b) => b - a).slice(0, topK);
  const idcg = ideal.reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const firstRelevant = rankedSlugs.findIndex((slug) => (grades.get(slug) ?? 0) > 0);
  return {
    ndcgAtK: idcg === 0 ? 0 : dcg / idcg,
    reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
    relevantReturned: rankedSlugs.filter((slug) => (grades.get(slug) ?? 0) > 0).length,
  };
}

export function summarizeQueries(results: QueryMetric[]): { queries: number; meanNdcgAt10: number | null; mrr: number | null } {
  if (results.length === 0) return { queries: 0, meanNdcgAt10: null, mrr: null };
  return {
    queries: results.length,
    meanNdcgAt10: results.reduce((sum, result) => sum + result.ndcgAtK, 0) / results.length,
    mrr: results.reduce((sum, result) => sum + result.reciprocalRank, 0) / results.length,
  };
}

export function summarizeEvaluation(results: EvaluatedQuery[]) {
  const answerable = results.filter((result) => result.answerable);
  const unanswerable = results.filter((result) => !result.answerable);
  const falsePositives = unanswerable.filter((result) => result.returnedCount > 0).length;
  return {
    answerable: summarizeQueries(answerable),
    unanswerable: {
      queries: unanswerable.length,
      falsePositives,
      falsePositiveRate: unanswerable.length ? falsePositives / unanswerable.length : null,
    },
  };
}
