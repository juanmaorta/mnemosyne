/**
 * Dreaming link-gen (MNE-90, option 1): propose ASSOCIATIVE links between notes
 * of the SAME scope, from the cosine similarity of the vectors ALREADY in the
 * index. Deterministic by construction — it reuses stored embeddings instead of
 * calling a model, so a re-run on an unchanged index proposes the same links in
 * the same order (the stability MNE-81 asks of dreaming).
 *
 * Two guards keep the graph from turning dense and noisy: a similarity THRESHOLD
 * (only genuinely-close notes link) and a per-note CAP (no hub links to
 * everything). The scope boundary is structural: `proposeLinks` only ever loads
 * one scope's vectors, so a cross-scope link cannot be formed here.
 *
 * This module only GENERATES proposals; folding them into a dry-run plan is
 * `buildPlan`'s job (MNE-42) and applying them is MNE-46's. Nothing here writes.
 */
import type { Db } from "../index/db.js";
import { fromBlob } from "../index/vecBlob.js";
import { parseFrontmatter } from "../frontmatter.js";
import { NOTE_TYPES } from "../schema.js";
import { readFileSync } from "node:fs";

/** A note and the vector the index already holds for it. */
export interface LinkItem {
  slug: string;
  vector: readonly number[];
}

/**
 * A proposed associative link between two notes of one scope. Undirected: the
 * endpoints are stored SORTED so the pair has a single canonical identity
 * regardless of discovery order (and so re-runs never flip a→b into b→a).
 */
export interface ProposedLink {
  slugs: [string, string];
  /** Cosine similarity that cleared the threshold. For the report, not identity. */
  similarity: number;
}

export interface LinkParams {
  /** Minimum cosine similarity for two notes to be linked. */
  threshold: number;
  /** Max links any single note may take part in (graph degree cap). */
  maxPerNote: number;
}

/**
 * Conservative defaults, tunable per run. A high threshold and a small cap keep
 * the first iteration sparse: better to miss a weak association than to drown the
 * graph in near-random edges. Values are a starting point, not a calibration.
 */
export const DEFAULT_LINK_PARAMS: LinkParams = { threshold: 0.82, maxPerNote: 5 };

/** Cosine similarity, or 0 for a zero vector (relation undefined → no link). */
function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Select links from a set of same-scope notes. Pure and deterministic: every
 * above-threshold pair is scored, pairs already linked (`existing`, checked in
 * either direction) are dropped, and the rest are added greedily strongest-first
 * — ties broken by the canonical slug pair — while neither endpoint has reached
 * the per-note cap. Greedy on a sorted list yields a stable, degree-bounded set.
 */
export function selectLinks(
  items: readonly LinkItem[],
  existing: ReadonlyMap<string, ReadonlySet<string>>,
  params: LinkParams = DEFAULT_LINK_PARAMS,
): ProposedLink[] {
  const { threshold, maxPerNote } = params;
  const candidates: ProposedLink[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (existing.get(a.slug)?.has(b.slug) || existing.get(b.slug)?.has(a.slug)) continue;
      const similarity = cosine(a.vector, b.vector);
      if (similarity < threshold) continue;
      const slugs: [string, string] = a.slug < b.slug ? [a.slug, b.slug] : [b.slug, a.slug];
      candidates.push({ slugs, similarity });
    }
  }
  // Strongest first; the canonical pair key makes ties (and the whole order)
  // deterministic across runs and platforms.
  candidates.sort((x, y) =>
    y.similarity - x.similarity || pairKey(...x.slugs).localeCompare(pairKey(...y.slugs)),
  );
  // The cap bounds a note's TOTAL degree, so seed it with the edges it already
  // has. Counting each existing undirected edge once (dedup by canonical pair, so
  // an a→b/b→a double entry is one edge) means a note already at its cap gets no
  // new links — otherwise repeated runs would grow the graph past the cap.
  const degree = new Map<string, number>();
  const countedEdges = new Set<string>();
  for (const [s, neighbours] of existing) {
    for (const t of neighbours) {
      if (s === t) continue;
      const key = pairKey(s, t);
      if (countedEdges.has(key)) continue;
      countedEdges.add(key);
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(t, (degree.get(t) ?? 0) + 1);
    }
  }
  const chosen: ProposedLink[] = [];
  for (const link of candidates) {
    const [a, b] = link.slugs;
    if ((degree.get(a) ?? 0) >= maxPerNote || (degree.get(b) ?? 0) >= maxPerNote) continue;
    chosen.push(link);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  return chosen;
}

interface NoteVecRow {
  slug: string;
  embedding: Buffer;
}

/** The `links` already recorded in a note's frontmatter, best-effort. */
function readExistingLinks(path: string): string[] {
  try {
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    const links = data["links"];
    return Array.isArray(links) ? links.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Load one scope's active NOTES (facts are excluded — the append-only stream is
 * not part of the associative graph) together with their indexed vectors, and
 * propose links among them. A scope with no vectors (tier 0, no embedder)
 * yields no links, which is correct: link-gen is a semantic operation. The
 * single-scope query is the scope boundary — a cross-scope link cannot form.
 */
export function proposeLinks(db: Db, scope: string, params: LinkParams = DEFAULT_LINK_PARAMS): ProposedLink[] {
  const typePlaceholders = NOTE_TYPES.map(() => "?").join(",");

  // The existing graph is read from EVERY active note in the scope, not only the
  // embedded ones: a note without a vector (a partially-built or tier-0 index)
  // can still hold a link that counts toward another note's degree cap. Omitting
  // it would let the cap be exceeded after application.
  const noteRows = db
    .prepare(
      `select e.slug as slug, e.path as path from engrams e
        where e.scope = ? and e.status = 'active' and e.type in (${typePlaceholders})`,
    )
    .all(scope, ...NOTE_TYPES) as { slug: string; path: string }[];
  const existing = new Map<string, ReadonlySet<string>>();
  for (const r of noteRows) existing.set(r.slug, new Set(readExistingLinks(r.path)));

  // Candidates for NEW links are only the embedded notes — cosine needs a vector.
  const vecRows = db
    .prepare(
      `select e.slug as slug, v.embedding as embedding
         from vec_engrams v
         join engrams e on e.id = v.rowid
        where e.scope = ? and e.status = 'active' and e.type in (${typePlaceholders})`,
    )
    .all(scope, ...NOTE_TYPES) as NoteVecRow[];
  const items: LinkItem[] = vecRows.map((r) => ({ slug: r.slug, vector: fromBlob(r.embedding) }));

  return selectLinks(items, existing, params);
}
