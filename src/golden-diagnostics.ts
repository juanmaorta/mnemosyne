import { createHash } from "node:crypto";
import { queryMetrics, summarizeQueries, type GradedDocument } from "./golden-metrics.js";

interface Candidate {
  slug: string;
  signals: {
    relevanceCosine: number;
    recencyNorm: number;
    importanceNorm: number;
    normalized?: { relevance: number; recency: number; importance: number };
  };
}

export interface QueryDiagnosis {
  id: string;
  cause: "ranker" | "cosine-floor" | "embedder-or-label" | "unanswerable" | "none";
  cosineFailure: "missing-top10" | "weak-top10" | null;
  blendedNdcgAt10: number;
  cosineNdcgAt10: number;
  blendedMrr: number;
  cosineMrr: number;
  firstRelevantRank: number | null;
  cosineFirstRelevantRank: number | null;
  bestRelevantCosine: number | null;
  blendWinnerCosine: number | null;
  bestRelevantSignals: Candidate["signals"] | null;
  blendWinnerSignals: Candidate["signals"] | null;
  blendedReturned: boolean;
  cosineReturned: boolean;
}

export function rankingMetadataDigest(documents: readonly {
  scope: string; slug: string; created: string; type: string; status: string; importance: number;
}[]): string {
  const hash = createHash("sha256");
  for (const doc of documents) {
    hash.update(JSON.stringify([doc.scope, doc.slug, doc.created, doc.type, doc.status, doc.importance]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function diagnosticTime(reviewedTimeMs: number, corpusChanged: boolean, currentTimeMs: number): number {
  return corpusChanged ? currentTimeMs : reviewedTimeMs;
}

function firstRelevantRank(candidates: Candidate[], relevant: Set<string>): number | null {
  const index = candidates.findIndex((candidate) => relevant.has(candidate.slug));
  return index === -1 ? null : index + 1;
}

export function diagnoseQuery(id: string, relevance: GradedDocument[], blended: Candidate[], cosine: Candidate[], floor: number | null = null): QueryDiagnosis {
  const relevant = new Set(relevance.filter((item) => item.grade > 0).map((item) => item.slug));
  const blendMetric = queryMetrics(blended.map((candidate) => candidate.slug), relevance, 10);
  const cosineMetric = queryMetrics(cosine.map((candidate) => candidate.slug), relevance, 10);
  const blendedRank = firstRelevantRank(blended, relevant);
  const cosineRank = firstRelevantRank(cosine, relevant);
  const bestRelevant = [...cosine].filter((candidate) => relevant.has(candidate.slug))
    .sort((a, b) => b.signals.relevanceCosine - a.signals.relevanceCosine)[0];
  const cosineFailure = !relevant.size || cosineMetric.ndcgAtK >= 0.5 ? null
    : cosineRank === null || cosineRank > 10 ? "missing-top10" : "weak-top10";
  let cause: QueryDiagnosis["cause"] = "none";
  if (!relevant.size) cause = "unanswerable";
  else if (blendMetric.ndcgAtK < 0.5) {
    if (cosineRank === null || cosineRank > 10) cause = "embedder-or-label";
    else if (floor !== null && bestRelevant && bestRelevant.signals.relevanceCosine < floor) cause = "cosine-floor";
    else cause = cosineMetric.ndcgAtK > blendMetric.ndcgAtK + 1e-9 ? "ranker" : "embedder-or-label";
  }
  else if (blendMetric.ndcgAtK < cosineMetric.ndcgAtK - 1e-9) cause = "ranker";
  return {
    id, cause, cosineFailure,
    blendedNdcgAt10: blendMetric.ndcgAtK, cosineNdcgAt10: cosineMetric.ndcgAtK,
    blendedMrr: blendMetric.reciprocalRank, cosineMrr: cosineMetric.reciprocalRank,
    firstRelevantRank: blendedRank, cosineFirstRelevantRank: cosineRank,
    bestRelevantCosine: bestRelevant?.signals.relevanceCosine ?? null,
    blendWinnerCosine: blended[0]?.signals.relevanceCosine ?? null,
    bestRelevantSignals: bestRelevant?.signals ?? null,
    blendWinnerSignals: blended[0]?.signals ?? null,
    blendedReturned: blended.length > 0, cosineReturned: cosine.length > 0,
  };
}

export function summarizeDiagnostics(results: QueryDiagnosis[]) {
  const answerable = results.filter((result) => result.cause !== "unanswerable");
  const metric = (kind: "blended" | "cosine") => summarizeQueries(answerable.map((result) => ({
    ndcgAtK: result[`${kind}NdcgAt10`], reciprocalRank: result[`${kind}Mrr`], relevantReturned: 0,
  })));
  return {
    blended: metric("blended"), cosine: metric("cosine"),
    unanswerable: {
      queries: results.length - answerable.length,
      blendedFalsePositives: results.filter((result) => result.cause === "unanswerable" && result.blendedReturned).length,
      cosineFalsePositives: results.filter((result) => result.cause === "unanswerable" && result.cosineReturned).length,
    },
    causes: {
      ranker: results.filter((result) => result.cause === "ranker").length,
      cosineFloor: results.filter((result) => result.cause === "cosine-floor").length,
      embedderOrLabel: results.filter((result) => result.cause === "embedder-or-label").length,
      unanswerable: results.filter((result) => result.cause === "unanswerable").length,
      none: results.filter((result) => result.cause === "none").length,
    },
    cosineFailures: {
      missingTop10: results.filter((result) => result.cosineFailure === "missing-top10").length,
      weakTop10: results.filter((result) => result.cosineFailure === "weak-top10").length,
    },
  };
}
