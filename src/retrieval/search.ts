import type { Db } from "../index/db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { blendedScore, recencyScore, importanceNorm, type Weights } from "../scoring.js";
import { materializeHotState } from "../hotstate.js";
import { listScopes } from "../index/walk.js";
import { toBlob } from "../index/vecBlob.js";

export interface SearchHit { slug: string; scope: string; score: number; snippet: string }
export interface SearchDeps { db: Db; root: string; embedder: EmbeddingClient }
export interface SearchOptions { query: string; scopes?: string[]; k?: number; weights?: Weights }

export async function search(deps: SearchDeps, opts: SearchOptions): Promise<SearchHit[]> {
  const { db, root, embedder } = deps;
  const k = opts.k ?? 10;
  const scopes = opts.scopes ?? listScopes(root);
  if (scopes.length === 0) return [];
  materializeHotState(db, root, scopes, Date.now());
  const [q] = await embedder.embed([opts.query]);
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

  const now = Date.now();
  return rows
    .map((r) => ({
      slug: r.slug, scope: r.scope, snippet: r.snippet,
      score: blendedScore({
        // Never-accessed notes have last_access seeded from `created` — recency
        // must stay neutral for them, or a stale-but-relevant note loses to a
        // recently-created-but-irrelevant one. Only actual accesses earn recency.
        recency: r.accessCount && r.accessCount > 0 ? recencyScore(now, Date.parse(r.lastAccess!)) : 1,
        importance: importanceNorm(r.importance),
        relevance: Math.max(0, Math.min(1, r.relevance)),
      }, opts.weights),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
