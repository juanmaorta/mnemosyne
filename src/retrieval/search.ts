import type { Db } from "../index/db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { scoreBreakdown, blendedScore, normalizeCandidateSignals, type Weights, type ScoreSignals } from "../scoring.js";
import { materializeHotState } from "../hotstate.js";
import { listScopes } from "../index/walk.js";
import { toBlob } from "../index/vecBlob.js";
import type { Clock } from "../clock.js";

export interface SearchHit {
  slug: string; scope: string; score: number; snippet: string;
  /** Per-signal breakdown; the score is recomputable from these plus `weights`. */
  signals: ScoreSignals;
  weights: Weights;
  /** 0-based position after sorting, across ALL candidates (not just the top-k). */
  rank: number;
  /** Score of the last included hit — the top-k cut line. */
  threshold: number;
  /** True when the candidate made the top-k. `search` only returns these; `searchExplain` returns both. */
  included: boolean;
}
export interface SearchDeps { db: Db; root: string; embedder: EmbeddingClient; clock: Clock }
export interface SearchOptions { query: string; scopes?: string[]; k?: number; weights?: Weights; minCos?: number }

/**
 * Search ranks by cosine relevance alone. Recency and importance keep their
 * role in the `context` digest (`CONTEXT_WEIGHTS`), not in the search
 * candidate: an old or never-read note must not lose its place for that reason.
 * This is search-local on purpose — the shared `DEFAULT_WEIGHTS` is untouched.
 * Callers can still pass `SearchOptions.weights` to request a blend.
 */
export const SEARCH_WEIGHTS: Weights = { recency: 0, importance: 0, relevance: 1 };

/** Calibrated for nomic-embed-text with search_query/search_document prefixes. */
export const NOMIC_MIN_COS = 0.70;

export function resolveMinCos(embedderId: string, configured?: number): number | null {
  if (configured !== undefined) {
    if (!Number.isFinite(configured) || configured < -1 || configured > 1) {
      throw new Error("--min-cos must be a number between -1 and 1.");
    }
    return configured;
  }
  // Other models, including Nomic v2, have different cosine distributions.
  return /^nomic-embed-text(?::latest)?\/dim768\/task-prefix-v1$/.test(embedderId) ? NOMIC_MIN_COS : null;
}

/**
 * Full ranking result: every candidate considered, included and discarded
 * alike, each with its signals, rank and the cut line it was measured against.
 * A retrieval decision must be reconstructable from this object alone — it is
 * what the `retrieval.candidate` event log (PR 3) and `--explain` (PR 5) read.
 */
export interface ExplainResult {
  query: string;
  scopes: string[];
  k: number;
  weights: Weights;
  minCos: number | null;
  candidates: SearchHit[];
}

export async function searchExplain(deps: SearchDeps, opts: SearchOptions): Promise<ExplainResult> {
  const { db, root, embedder, clock } = deps;
  const k = opts.k ?? 10;
  const scopes = opts.scopes ?? listScopes(root);
  const weights = opts.weights ?? SEARCH_WEIGHTS;
  const minCos = resolveMinCos(embedder.id, opts.minCos);
  if (scopes.length === 0) return { query: opts.query, scopes, k, weights, minCos, candidates: [] };
  // One clock read for the whole query: hot-state materialization and the
  // recency term must agree on "now", or a slow embed call would skew scoring.
  const now = clock.now();
  materializeHotState(db, root, scopes, now);
  const [q] = await embedder.embed([opts.query], "query");
  const rows = db.prepare(
    `select e.slug as slug, e.scope as scope, e.snippet as snippet, e.importance as importance,
            1.0 - vec_distance_cosine(v.embedding, ?) as relevance,
            h.last_access as lastAccess, h.access_count as accessCount,
            h.strength as strength, h.retention as retention
     from vec_engrams v
     join engrams e on e.id = v.rowid
     left join hot_state h on h.scope = e.scope and h.slug = e.slug
     where e.scope in (${scopes.map(() => "?").join(",")})`,
  ).all(toBlob(q!), ...scopes) as
    { slug: string; scope: string; snippet: string; importance: number; relevance: number;
      lastAccess: string | null; accessCount: number | null;
      strength: number | null; retention: number | null }[];

  const raw = rows.map((r) => {
    const { signals } = scoreBreakdown({
      nowMs: now,
      lastAccessMs: r.lastAccess ? Date.parse(r.lastAccess) : null,
      accessCount: r.accessCount ?? 0,
      strength: r.strength ?? 1,
      retentionNorm: r.retention,
      importance: r.importance,
      relevanceCosine: r.relevance,
    }, weights);
    return { slug: r.slug, scope: r.scope, snippet: r.snippet, signals };
  });
  const normalized = normalizeCandidateSignals(raw.map(({ signals }) => ({
    recency: signals.recencyNorm,
    importance: signals.importanceNorm,
    relevance: signals.relevanceCosine,
  })));
  const scored = raw.map((candidate, i) => {
    const blend = normalized[i]!;
    return {
      ...candidate,
      score: blendedScore(blend, weights),
      signals: { ...candidate.signals, normalized: blend },
      weights,
    };
  });
  // Deterministic order: score desc, then scope then slug. The tiebreak makes
  // equal-cosine results stable and reproducible instead of leaning on the row
  // order the DB happened to return.
  scored.sort((a, b) =>
    b.score - a.score || a.scope.localeCompare(b.scope) || a.slug.localeCompare(b.slug));
  // The cut line is the score of the last engram that made the top-k. With
  // fewer candidates than k nothing is cut, so it is the lowest score present.
  const eligible = scored.filter((h) => minCos === null || h.signals.relevanceCosine >= minCos);
  const threshold = eligible.length >= k ? eligible[k - 1]!.score : (eligible.at(-1)?.score ?? 0);
  let includedCount = 0;
  const candidates = scored.map((h, i) => {
    const included = (minCos === null || h.signals.relevanceCosine >= minCos) && includedCount < k;
    if (included) includedCount++;
    return { ...h, rank: i, threshold, included };
  });
  return { query: opts.query, scopes, k, weights, minCos, candidates };
}

export async function search(deps: SearchDeps, opts: SearchOptions): Promise<SearchHit[]> {
  const { candidates } = await searchExplain(deps, opts);
  return candidates.filter((c) => c.included);
}
