// Sweep recency policy/weight on the same labeled Nomic corpus as
// calibrate-cosine.mjs. Requires `npm run build` first (the npm script does it).
import { blendedScore, DEFAULT_WEIGHTS, importanceNorm, normalizeCandidateSignals, retention } from "../dist/scoring.js";
import { ALGO_VERSION } from "../dist/version.js";
import { documents, positives, negatives } from "./retrieval-bench-fixtures.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVAL_AT = Date.parse("2026-09-28T12:00:00.000Z");
const TOP_K = 5;
const COSINE_FLOOR = Number(process.env.MNEMOSYNE_MIN_COS ?? "0.70");
const RECENCY_WEIGHTS = [0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6];
const UNREAD_POLICIES = ["creation-age", "neutral-prior"];
const NEUTRAL_UNREAD_PRIOR = Math.exp(-1);
const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const model = process.env.OLLAMA_MODEL ?? "nomic-embed-text";

async function embed(inputs) {
  const response = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  return (await response.json()).embeddings;
}

function cosine(a, b) {
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  return dot / Math.sqrt(a2 * b2);
}

function round(value) {
  return Number(value.toFixed(6));
}

function rankByCosine(queryVector, documentVectors) {
  return documents.map(([slug], i) => ({
    slug,
    cosine: cosine(queryVector, documentVectors[i]),
  })).sort((a, b) => b.cosine - a.cosine || a.slug.localeCompare(b.slug));
}

function rankBlended(queryVector, documentVectors, recencyWeight, unreadPolicy) {
  const candidates = documents.map(([slug, , profile], i) => {
    const accessed = profile.lastAccessAgeDays !== null;
    const ageDays = accessed ? profile.lastAccessAgeDays : profile.createdAgeDays;
    const timestamp = EVAL_AT - ageDays * DAY_MS;
    const rawRecency = !accessed && unreadPolicy === "neutral-prior"
      ? NEUTRAL_UNREAD_PRIOR
      : retention(EVAL_AT, timestamp, profile.strength);
    return {
      slug,
      recency: rawRecency,
      importance: importanceNorm(profile.importance),
      relevance: cosine(queryVector, documentVectors[i]),
    };
  });
  const normalized = normalizeCandidateSignals(candidates);
  return candidates.map((candidate, i) => {
    const parts = normalized[i];
    const score = blendedScore(parts, {
      recency: recencyWeight,
      importance: DEFAULT_WEIGHTS.importance,
      relevance: DEFAULT_WEIGHTS.relevance,
    });
    return { slug: candidate.slug, cosine: candidate.relevance, score };
  }).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

function ndcgAtK(rank) {
  return rank <= TOP_K ? 1 / Math.log2(rank + 1) : 0;
}

function positiveMetrics(results) {
  const count = results.length;
  return {
    recallAt5: round(results.filter((result) => result.rank <= TOP_K).length / count),
    ndcgAt5: round(results.reduce((sum, result) => sum + ndcgAtK(result.rank), 0) / count),
    mrr: round(results.reduce((sum, result) => sum + 1 / result.rank, 0) / count),
    meanTargetRank: round(results.reduce((sum, result) => sum + result.rank, 0) / count),
    meanTop5OverlapWithCosine: round(results.reduce((sum, result) => sum + result.top5OverlapWithCosine, 0) / count),
    meanTop5OverlapWithNoRecencyBlend: round(results.reduce((sum, result) => sum + result.top5OverlapWithNoRecencyBlend, 0) / count),
    targetRankChangedFromCosine: results.filter((result) => result.rank !== result.cosineRank).length,
    targetRankChangedFromNoRecencyBlend: results.filter((result) => result.rank !== result.noRecencyRank).length,
  };
}

function evaluatePositiveQueries(queryVectors, documentVectors) {
  const cosineRuns = positives.map(([target, query], i) => {
    const ranked = rankByCosine(queryVectors[i], documentVectors);
    return {
      query,
      target,
      rank: ranked.findIndex((candidate) => candidate.slug === target) + 1,
      top5: ranked.slice(0, TOP_K).map((candidate) => candidate.slug),
    };
  });
  const noRecencyRuns = positives.map(([target, query], i) => {
    const ranked = rankBlended(queryVectors[i], documentVectors, 0, "creation-age");
    return {
      target,
      rank: ranked.findIndex((candidate) => candidate.slug === target) + 1,
      top5: ranked.slice(0, TOP_K).map((candidate) => candidate.slug),
    };
  });
  const cosineBaseline = positiveMetrics(cosineRuns.map((run) => ({
    rank: run.rank,
    top5OverlapWithCosine: 1,
    top5OverlapWithNoRecencyBlend: 1,
    cosineRank: run.rank,
    noRecencyRank: run.rank,
  })));
  const noRecencyBlendBaseline = positiveMetrics(noRecencyRuns.map((run, i) => ({
    rank: run.rank,
    top5OverlapWithCosine: run.top5.filter((slug) => cosineRuns[i].top5.includes(slug)).length / TOP_K,
    top5OverlapWithNoRecencyBlend: 1,
    cosineRank: cosineRuns[i].rank,
    noRecencyRank: run.rank,
  })));
  const experiments = [];
  for (const unreadPolicy of UNREAD_POLICIES) {
    for (const recencyWeight of RECENCY_WEIGHTS) {
      const queryResults = positives.map(([target, query], i) => {
        const ranked = rankBlended(queryVectors[i], documentVectors, recencyWeight, unreadPolicy);
        const top5 = ranked.slice(0, TOP_K).map((candidate) => candidate.slug);
        const baseline = cosineRuns[i];
        const cosineTop5 = new Set(baseline.top5);
        const noRecency = noRecencyRuns[i];
        const noRecencyTop5 = new Set(noRecency.top5);
        return {
          query,
          target,
          rank: ranked.findIndex((candidate) => candidate.slug === target) + 1,
          cosineRank: baseline.rank,
          noRecencyRank: noRecency.rank,
          top5OverlapWithCosine: top5.filter((slug) => cosineTop5.has(slug)).length / TOP_K,
          top5OverlapWithNoRecencyBlend: top5.filter((slug) => noRecencyTop5.has(slug)).length / TOP_K,
        };
      });
      experiments.push({
        unreadPolicy,
        recencyWeight,
        importanceWeight: DEFAULT_WEIGHTS.importance,
        relevanceWeight: DEFAULT_WEIGHTS.relevance,
        metrics: positiveMetrics(queryResults),
        queries: queryResults.map(({ query, target, rank, cosineRank }) => ({ query, target, rank, cosineRank })),
      });
    }
  }
  return { cosineBaseline, noRecencyBlendBaseline, experiments };
}

const documentVectors = await embed(documents.map(([, body]) => `search_document: ${body}`));
const allQueries = [...positives.map(([, query]) => query), ...negatives];
const queryVectors = await embed(allQueries.map((query) => `search_query: ${query}`));
const { cosineBaseline, noRecencyBlendBaseline, experiments } = evaluatePositiveQueries(queryVectors, documentVectors);
const negativeResults = negatives.map((query, i) => {
  const ranked = rankByCosine(queryVectors[positives.length + i], documentVectors);
  return { query, bestCosine: ranked[0].cosine, bestSlug: ranked[0].slug };
});
const negativeSummary = {
  queries: negatives.length,
  maxBestCosine: round(Math.max(...negativeResults.map((result) => result.bestCosine))),
  falsePositivesAtCosineFloor: negativeResults.filter((result) => result.bestCosine >= COSINE_FLOOR).length,
};

// For each policy, find the strongest tested recency weight whose labeled
// relevance metrics do not fall below raw cosine. Prefer the existing
// creation-age policy as the recommendation; show neutral-prior separately.
function strongestWithoutRegression(unreadPolicy) {
  return experiments.filter((experiment) =>
    experiment.unreadPolicy === unreadPolicy
    && experiment.metrics.recallAt5 >= cosineBaseline.recallAt5
    && experiment.metrics.ndcgAt5 >= cosineBaseline.ndcgAt5,
  ).sort((a, b) => b.recencyWeight - a.recencyWeight
    || b.metrics.ndcgAt5 - a.metrics.ndcgAt5)[0] ?? null;
}
const recommendationsByPolicy = Object.fromEntries(UNREAD_POLICIES.map((policy) => {
  const result = strongestWithoutRegression(policy);
  return [policy, result ? { recencyWeight: result.recencyWeight, metrics: result.metrics } : null];
}));
const selectedRecommendation = recommendationsByPolicy["creation-age"];
const recommendation = selectedRecommendation ? {
  unreadPolicy: "creation-age",
  recencyWeight: selectedRecommendation.recencyWeight,
  alternatives: recommendationsByPolicy,
  rule: "for each unread policy, highest tested recency weight with Recall@5 and nDCG@5 at least equal to the cosine-only baseline; selected policy matches current creation-age behavior",
} : null;

const scorecard = {
  benchmark: "mnemosyne-retrieval-calibration-v1",
  algoVersion: ALGO_VERSION,
  embeddingModel: model,
  evaluationTime: new Date(EVAL_AT).toISOString(),
  dataset: {
    documents: documents.length,
    positiveQueries: positives.length,
    negativeQueries: negatives.length,
    topK: TOP_K,
    cosineFloor: COSINE_FLOOR,
    temporalProfiles: {
      unread: documents.filter(([, , profile]) => profile.lastAccessAgeDays === null).length,
      readFreshWithin7Days: documents.filter(([, , profile]) => profile.lastAccessAgeDays !== null && profile.lastAccessAgeDays <= 7).length,
      readOlderThan30Days: documents.filter(([, , profile]) => profile.lastAccessAgeDays !== null && profile.lastAccessAgeDays > 30).length,
    },
  },
  cosineBaseline,
  noRecencyBlendBaseline,
  negativeQueries: negativeSummary,
  recencySweep: experiments,
  recommendation,
  limitations: [
    "Small controlled corpus; use results as a calibration signal, not as a quality claim for a user's private store.",
    "The positive labels identify one expected document per query; negative queries have no relevant document.",
    "Temporal and importance profiles are synthetic and fixed for reproducibility.",
    "No production defaults are changed automatically; review the scorecard before adopting its recommendation.",
  ],
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(scorecard, null, 2));
} else {
  console.log(`retrieval calibration | model=${model} algoVersion=${ALGO_VERSION} eval=${scorecard.evaluationTime}`);
  console.log(`corpus=${documents.length} positive=${positives.length} negative=${negatives.length} topK=${TOP_K}`);
  console.log(`cosine-only: Recall@5=${cosineBaseline.recallAt5} nDCG@5=${cosineBaseline.ndcgAt5} MRR=${cosineBaseline.mrr}`);
  console.log(`no-recency blend: Recall@5=${noRecencyBlendBaseline.recallAt5} nDCG@5=${noRecencyBlendBaseline.ndcgAt5} MRR=${noRecencyBlendBaseline.mrr}`);
  console.log(`negative max cosine=${negativeSummary.maxBestCosine}; false positives at ${COSINE_FLOOR.toFixed(2)}=${negativeSummary.falsePositivesAtCosineFloor}/${negativeSummary.queries}`);
  console.log("policy         w_recency  Recall@5  nDCG@5    MRR  top5/cos  top5/no-recency");
  for (const experiment of experiments) {
    const m = experiment.metrics;
    console.log(`${experiment.unreadPolicy.padEnd(15)} ${experiment.recencyWeight.toFixed(2).padStart(9)} ${m.recallAt5.toFixed(3).padStart(9)} ${m.ndcgAt5.toFixed(3).padStart(7)} ${m.mrr.toFixed(3).padStart(6)} ${m.meanTop5OverlapWithCosine.toFixed(3).padStart(9)} ${m.meanTop5OverlapWithNoRecencyBlend.toFixed(3).padStart(16)}`);
  }
  console.log(`recommendation: ${recommendation ? `${recommendation.unreadPolicy}, recency weight ${recommendation.recencyWeight}; neutral-prior alternative ${recommendationsByPolicy["neutral-prior"]?.recencyWeight ?? "none"}` : "none meets the cosine-only relevance baseline"}`);
  console.log("Use --json for the complete versioned scorecard. The recommendation is not applied automatically.");
}
