import type { Db } from "../index/db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { scoreBreakdown, blendedScore, normalizeCandidateSignals, type Weights, type ScoreSignals } from "../scoring.js";
import { materializeHotState } from "../hotstate.js";
import { listScopes } from "../index/walk.js";
import { toBlob } from "../index/vecBlob.js";
import type { Clock } from "../clock.js";
import { isDerivedSlug } from "../dreaming/derived.js";

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
  /** True when this is a dreaming-derived note (slug under the `dream-` prefix).
   *  A convenience summary of its sources; the sources stay the authoritative
   *  truth. Purely a marker — it does NOT change the ranking. */
  isDerived: boolean;
}
export interface SearchDeps { db: Db; root: string; embedder: EmbeddingClient | null; clock: Clock }
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

interface CandidateRow {
  slug: string; scope: string; snippet: string; importance: number; relevance: number;
  lastAccess: string | null; accessCount: number | null;
  strength: number | null; retention: number | null;
}

/**
 * Turn a free-text query into an FTS5 MATCH expression. Each alphanumeric token
 * is quoted (so a stray `-`, `*` or `"` is data, not an operator) and the tokens
 * are OR-ed for recall; BM25 then ranks. Returns null when the query has no
 * usable terms, so the caller can return nothing instead of a syntax error.
 */
export function toFtsMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Tier 0 (MNE-19): candidates from BM25 over the FTS5 table, no embedder. SQLite's
 * `bm25()` returns lower = better; we min-max that to a relevance in [0,1] that
 * feeds the same scoring pipeline as cosine. Min-max (not 1/(1+position)) so that
 * EQUAL BM25 yields EQUAL relevance — then the deterministic scope/slug tiebreak
 * in `searchExplain` decides ties instead of the unspecified SQL row order.
 * There is no cosine here, so no cosine floor applies.
 */
function bm25Candidates(db: Db, query: string, scopes: string[]): CandidateRow[] {
  const match = toFtsMatch(query);
  if (match === null) return [];
  const rows = db.prepare(
    `select e.slug as slug, e.scope as scope, e.snippet as snippet, e.importance as importance,
            h.last_access as lastAccess, h.access_count as accessCount,
            h.strength as strength, h.retention as retention,
            bm25(fts_engrams) as bm25
     from fts_engrams
     join engrams e on e.id = fts_engrams.rowid
     left join hot_state h on h.scope = e.scope and h.slug = e.slug
     where fts_engrams match ? and e.scope in (${scopes.map(() => "?").join(",")})
     order by bm25(fts_engrams)`,
  ).all(match, ...scopes) as (Omit<CandidateRow, "relevance"> & { bm25: number })[];
  if (rows.length === 0) return [];
  // bm25() is lower = better, so negate: higher = better, matching cosine.
  const goodness = rows.map((r) => -r.bm25);
  const min = Math.min(...goodness);
  const span = Math.max(...goodness) - min;
  return rows.map(({ bm25: _bm25, ...rest }, i) => ({
    ...rest,
    relevance: span === 0 ? 1 : (goodness[i]! - min) / span,
  }));
}

export async function searchExplain(deps: SearchDeps, opts: SearchOptions): Promise<ExplainResult> {
  const { db, root, embedder, clock } = deps;
  const k = opts.k ?? 10;
  const scopes = opts.scopes ?? listScopes(root);
  const weights = opts.weights ?? SEARCH_WEIGHTS;
  // Tier 0 has no cosine, so nothing to floor; the floor is a vector-path concept.
  const minCos = embedder === null ? null : resolveMinCos(embedder.id, opts.minCos);
  if (scopes.length === 0) return { query: opts.query, scopes, k, weights, minCos, candidates: [] };
  // One clock read for the whole query: hot-state materialization and the
  // recency term must agree on "now", or a slow embed call would skew scoring.
  const now = clock.now();
  materializeHotState(db, root, scopes, now);
  let rows: CandidateRow[];
  if (embedder === null) {
    rows = bm25Candidates(db, opts.query, scopes);
  } else {
    const [q] = await embedder.embed([opts.query], "query");
    rows = db.prepare(
      `select e.slug as slug, e.scope as scope, e.snippet as snippet, e.importance as importance,
              1.0 - vec_distance_cosine(v.embedding, ?) as relevance,
              h.last_access as lastAccess, h.access_count as accessCount,
              h.strength as strength, h.retention as retention
       from vec_engrams v
       join engrams e on e.id = v.rowid
       left join hot_state h on h.scope = e.scope and h.slug = e.slug
       where e.scope in (${scopes.map(() => "?").join(",")})`,
    ).all(toBlob(q!), ...scopes) as CandidateRow[];
  }

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
    return { ...h, rank: i, threshold, included, isDerived: isDerivedSlug(h.slug) };
  });
  return { query: opts.query, scopes, k, weights, minCos, candidates };
}

export async function search(deps: SearchDeps, opts: SearchOptions): Promise<SearchHit[]> {
  const { candidates } = await searchExplain(deps, opts);
  return candidates.filter((c) => c.included);
}
