import type { Db } from "../index/db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { scoreBreakdown, DEFAULT_WEIGHTS, type Weights, type ScoreSignals } from "../scoring.js";
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
export interface SearchOptions { query: string; scopes?: string[]; k?: number; weights?: Weights }

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
  candidates: SearchHit[];
}

export async function searchExplain(deps: SearchDeps, opts: SearchOptions): Promise<ExplainResult> {
  const { db, root, embedder, clock } = deps;
  const k = opts.k ?? 10;
  const scopes = opts.scopes ?? listScopes(root);
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  if (scopes.length === 0) return { query: opts.query, scopes, k, weights, candidates: [] };
  // One clock read for the whole query: hot-state materialization and the
  // recency term must agree on "now", or a slow embed call would skew scoring.
  const now = clock.now();
  materializeHotState(db, root, scopes, now);
  const [q] = await embedder.embed([opts.query], "query");
  const rows = db.prepare(
    `select e.slug as slug, e.scope as scope, e.snippet as snippet, e.importance as importance,
            1.0 - vec_distance_cosine(v.embedding, ?) as relevance,
            h.last_access as lastAccess, h.access_count as accessCount
     from vec_engrams v
     join engrams e on e.id = v.rowid
     left join hot_state h on h.scope = e.scope and h.slug = e.slug
     where e.scope in (${scopes.map(() => "?").join(",")})`,
  ).all(toBlob(q!), ...scopes) as
    { slug: string; scope: string; snippet: string; importance: number; relevance: number;
      lastAccess: string | null; accessCount: number | null }[];

  const scored = rows.map((r) => {
    const { score, signals } = scoreBreakdown({
      nowMs: now,
      lastAccessMs: r.lastAccess ? Date.parse(r.lastAccess) : null,
      accessCount: r.accessCount ?? 0,
      importance: r.importance,
      relevanceCosine: r.relevance,
    }, weights);
    return { slug: r.slug, scope: r.scope, snippet: r.snippet, score, signals, weights };
  });
  scored.sort((a, b) => b.score - a.score);
  // The cut line is the score of the last engram that made the top-k. With
  // fewer candidates than k nothing is cut, so it is the lowest score present.
  const threshold = scored.length >= k ? scored[k - 1]!.score : (scored.at(-1)?.score ?? 0);
  const candidates = scored.map((h, i) => ({ ...h, rank: i, threshold, included: i < k }));
  return { query: opts.query, scopes, k, weights, candidates };
}

export async function search(deps: SearchDeps, opts: SearchOptions): Promise<SearchHit[]> {
  const { candidates } = await searchExplain(deps, opts);
  return candidates.filter((c) => c.included);
}
