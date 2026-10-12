import type { Db } from "../index/db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { scoreBreakdown, blendedScore, normalizeCandidateSignals, type Weights, type ScoreSignals } from "../scoring.js";
import { materializeHotState } from "../hotstate.js";
import { listScopes } from "../index/walk.js";
import { toBlob } from "../index/vecBlob.js";
import type { Clock } from "../clock.js";
import { isDerivedSlug } from "../dreaming/derived.js";
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.js";

/**
 * Read a derived note's `sources` (provenance slugs) from its frontmatter on
 * disk. Used only to keep a derived note from burying its sources (MNE-87);
 * best-effort, so a missing or malformed file yields no sources rather than
 * breaking the search.
 */
function readDerivedSources(path: string): string[] {
  try {
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    const sources = (data as { sources?: unknown }).sources;
    return Array.isArray(sources) ? sources.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

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
export interface SearchOptions {
  query: string; scopes?: string[]; k?: number; weights?: Weights; minCos?: number;
  /**
   * Opt-in ranking mode (MNE-96). Default (undefined) keeps the pure-cosine order
   * calibrated in MNE-77. `"rrf"` re-orders the vector candidates by Reciprocal
   * Rank Fusion of the cosine and BM25 rankings; the cosine floor still gates
   * eligibility, so fusion only reorders notes that already clear it.
   */
  fusion?: "rrf";
}

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

/**
 * Calibrated for nomic-embed-text-v2-moe (search_query/search_document prefixes).
 *
 * v2-moe has a markedly different cosine distribution from v1: relevant pairs sit
 * lower, so v1's 0.70 would reject nearly everything. 0.45 is the highest floor
 * that still cleared every unanswerable query (0 false positives) while keeping
 * the answerable ranking, measured on the 5b-golden `personal` set (2026-10-12,
 * MNE-32: nDCG@10 0.742, MRR 0.783, 0/14 false positives; vs nomic 0.279/0.304).
 *
 * The knee is sharp (0.50 collapses answerable quality), and the set is small, so
 * this is a conservative starting floor to REVALIDATE on a larger golden before
 * treating it as final — same caveat the bench itself flags for small-set tuning.
 */
export const NOMIC_V2MOE_MIN_COS = 0.45;

export function resolveMinCos(embedderId: string, configured?: number): number | null {
  if (configured !== undefined) {
    if (!Number.isFinite(configured) || configured < -1 || configured > 1) {
      throw new Error("--min-cos must be a number between -1 and 1.");
    }
    return configured;
  }
  // Each model carries its OWN calibrated floor: cosine distributions are not
  // comparable across models, so a shared constant would reject or admit the
  // wrong candidates. A model without a calibrated floor gets none (null).
  if (/^nomic-embed-text(?::latest)?\/dim768\/task-prefix-v1$/.test(embedderId)) return NOMIC_MIN_COS;
  if (/^nomic-embed-text-v2-moe(?::latest)?\/dim768\/task-prefix-v1$/.test(embedderId)) return NOMIC_V2MOE_MIN_COS;
  return null;
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
  /**
   * The ranking mode actually used. Absent for the default cosine order; "rrf"
   * when fusion reordered the candidates. Carried so telemetry and `--explain`
   * describe the real ranking: under fusion the `score` is the fused RRF value,
   * NOT reconstructable from `signals`+`weights` (which still describe cosine).
   */
  fusion?: "rrf";
  candidates: SearchHit[];
}

interface CandidateRow {
  slug: string; scope: string; snippet: string; importance: number; relevance: number;
  /** On disk. Internal only (to read a derived note's `sources`); never surfaced. */
  path: string;
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
 * Reciprocal Rank Fusion constant (MNE-96). 60 is the value from the original RRF
 * paper (Cormack et al. 2009) and the de-facto default; it damps the influence of
 * the exact rank so that merely appearing in a list matters more than its position.
 */
export const RRF_K = 60;

/**
 * Fuse several ranked lists into one score per key: `Σ 1/(k + rank)` over the
 * lists a key appears in, with rank 1-based. A key in two lists outscores one in
 * a single list, which is the whole point of hybrid retrieval — a note both the
 * vector and the lexical ranker surface is more trustworthy than either alone.
 * Keys are opaque (callers use `scope\u0000slug`); duplicates within a list keep
 * their first (best) rank; empty lists contribute nothing.
 */
export function reciprocalRankFusion(rankedLists: readonly (readonly string[])[], k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of rankedLists) {
    const seen = new Set<string>();
    let rank = 0; // compacted: a duplicate key does not leave a gap for later keys
    for (const key of list) {
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + rank));
    }
  }
  return fused;
}

/**
 * Tier 0 (MNE-19): candidates from BM25 over the FTS5 table, no embedder. SQLite's
 * `bm25()` returns lower = better; we min-max that to a relevance in [0,1] that
 * feeds the same scoring pipeline as cosine. Min-max (not 1/(1+position)) so that
 * EQUAL BM25 yields EQUAL relevance — then the deterministic scope/slug tiebreak
 * in `searchExplain` decides ties instead of the unspecified SQL row order.
 * The SQL `order by` also breaks ties by scope then slug, so the returned LIST
 * ORDER is deterministic too — RRF (MNE-96) ranks straight off it, and equal BM25
 * must not hand tied notes different ranks by accident of insertion order.
 * There is no cosine here, so no cosine floor applies.
 */
function bm25Candidates(db: Db, query: string, scopes: string[]): CandidateRow[] {
  const match = toFtsMatch(query);
  if (match === null) return [];
  const rows = db.prepare(
    `select e.slug as slug, e.scope as scope, e.snippet as snippet, e.importance as importance,
            e.path as path,
            h.last_access as lastAccess, h.access_count as accessCount,
            h.strength as strength, h.retention as retention,
            bm25(fts_engrams) as bm25
     from fts_engrams
     join engrams e on e.id = fts_engrams.rowid
     left join hot_state h on h.scope = e.scope and h.slug = e.slug
     where fts_engrams match ? and e.scope in (${scopes.map(() => "?").join(",")})
     order by bm25(fts_engrams), e.scope, e.slug`,
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
  if (scopes.length === 0) return { query: opts.query, scopes, k, weights, minCos, ...(opts.fusion ? { fusion: opts.fusion } : {}), candidates: [] };
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
              e.path as path,
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
    return { slug: r.slug, scope: r.scope, snippet: r.snippet, path: r.path, signals };
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
  // MNE-96 (opt-in): replace the ranking score with Reciprocal Rank Fusion of the
  // cosine ranking and the BM25 ranking. Only the `score` (the order) changes —
  // the cosine floor still gates eligibility below, so fusion reorders the
  // floor-eligible set rather than smuggling lexical-only hits past the floor.
  // Production (no `fusion`) is untouched and stays pure cosine (MNE-77).
  const fusionApplied = opts.fusion === "rrf" && embedder !== null;
  if (fusionApplied) {
    const key = (c: { scope: string; slug: string }): string => `${c.scope}\u0000${c.slug}`;
    const byCosine = [...scored]
      .sort((a, b) => b.signals.relevanceCosine - a.signals.relevanceCosine
        || a.scope.localeCompare(b.scope) || a.slug.localeCompare(b.slug))
      .map(key);
    const byBm25 = bm25Candidates(db, opts.query, scopes).map(key);
    const fused = reciprocalRankFusion([byCosine, byBm25]);
    for (const c of scored) c.score = fused.get(key(c)) ?? 0;
  }
  // Deterministic order: score desc, then scope then slug. The tiebreak makes
  // equal-cosine results stable and reproducible instead of leaning on the row
  // order the DB happened to return.
  scored.sort((a, b) =>
    b.score - a.score || a.scope.localeCompare(b.scope) || a.slug.localeCompare(b.slug));
  // The cut line is the score of the last engram that made the top-k. With
  // fewer candidates than k nothing is cut, so it is the lowest score present.
  const eligible = scored.filter((h) => minCos === null || h.signals.relevanceCosine >= minCos);
  const threshold = eligible.length >= k ? eligible[k - 1]!.score : (eligible.at(-1)?.score ?? 0);
  const passesFloor = (h: (typeof scored)[number]): boolean =>
    minCos === null || h.signals.relevanceCosine >= minCos;
  const included = scored.map(() => false);
  let includedCount = 0;
  scored.forEach((h, i) => {
    if (passesFloor(h) && includedCount < k) { included[i] = true; includedCount++; }
  });
  // MNE-87 (opción 3): a derived note is a convenience summary; it must not bury
  // its own sources. If an included derived note pushed a source out of the
  // top-k, rescue that source (same scope, passes the floor) so the
  // authoritative note stays retrievable. The derived keeps its position — the
  // source is ADDED, not swapped, so a useful derived #1 is preserved.
  //
  // A worklist (not a single forward pass): a summary can cite another summary,
  // so rescuing a derived source must in turn rescue ITS sources, regardless of
  // their ranking order. The visited set bounds the walk and tolerates cycles.
  const indexBySlug = new Map(scored.map((h, i) => [`${h.scope}\u0000${h.slug}`, i]));
  const worklist = scored.flatMap((h, i) => (included[i] && isDerivedSlug(h.slug) ? [i] : []));
  const visited = new Set<number>();
  while (worklist.length > 0) {
    const i = worklist.pop()!;
    if (visited.has(i)) continue;
    visited.add(i);
    for (const srcSlug of readDerivedSources(scored[i]!.path)) {
      const j = indexBySlug.get(`${scored[i]!.scope}\u0000${srcSlug}`);
      if (j === undefined || !passesFloor(scored[j]!)) continue;
      included[j] = true;
      if (isDerivedSlug(scored[j]!.slug) && !visited.has(j)) worklist.push(j);
    }
  }
  const candidates = scored.map(({ path: _path, ...h }, i) =>
    ({ ...h, rank: i, threshold, included: included[i]!, isDerived: isDerivedSlug(h.slug) }));
  return { query: opts.query, scopes, k, weights, minCos, ...(fusionApplied ? { fusion: "rrf" as const } : {}), candidates };
}

export async function search(deps: SearchDeps, opts: SearchOptions): Promise<SearchHit[]> {
  const { candidates } = await searchExplain(deps, opts);
  return candidates.filter((c) => c.included);
}
