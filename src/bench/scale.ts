/**
 * Scale scenario (g) for the bench (MNE-65). `docs/architecture.md` assumes
 * "personal scale: brute-force cosine <10ms" as a DESIGN ASSUMPTION; this turns
 * it into a measured datum. It populates an EPHEMERAL store with N synthetic
 * engrams (deterministic fake embedder, injected clock), reindexes it — so the
 * lazy-reindex cost is measured, not assumed — and times `search`, reporting
 * p50/p95 latency and candidate-set size against an external <500ms reference.
 *
 * The threshold is "a number to fail against", not a goal: if brute-force cosine
 * clears it with margin, the useful conclusion ("no ANN index needed yet") is
 * written down. A latency regression flips `within` to false exactly as an nDCG
 * regression would fail a quality scorecard.
 *
 * Nothing here touches the real store: the caller passes an ephemeral `root`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeFrontmatter } from "../frontmatter.js";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { searchExplain } from "../retrieval/search.js";
import { percentile } from "../golden-metrics.js";
import { fixedClock } from "../clock.js";
import { ALGO_VERSION } from "../version.js";
import { Scope } from "../schema.js";
import type { EmbeddingClient } from "../embeddings.js";

/**
 * A bench scope maps to a directory joined under the ephemeral root, so an
 * unsafe value (`../victim`, an absolute path) would let the corpus escape the
 * disposable store and clobber real files. Validate against the same kebab-slug
 * schema the store enforces, BEFORE any filesystem write.
 */
function assertSafeScope(scope: string): void {
  if (!Scope.safeParse(scope).success) {
    throw new Error(`unsafe bench scope (must be a kebab-case slug): ${scope}`);
  }
}

/** External reference from the load-test checklist: not a target, a fail line. */
export const DEFAULT_SCALE_THRESHOLD_MS = 500;

/** A deterministic vocabulary; topics draw disjoint-ish windows from it. */
const VOCAB = [
  "memory", "agent", "context", "retrieval", "vector", "cosine", "scope", "note",
  "fact", "index", "search", "embedding", "cluster", "ranking", "recency", "decay",
  "garden", "plant", "soil", "light", "water", "router", "network", "bridge",
  "coffee", "roast", "grind", "kettle", "trip", "flight", "hotel", "city",
  "budget", "invoice", "client", "deadline", "meeting", "decision", "review", "pull",
] as const;

export interface ScaleCorpusOptions {
  scope?: string;
  /** Number of shared-token clusters; fewer topics = denser clusters. */
  topics?: number;
  /** Epoch ms of the oldest note; later notes are staggered after it. */
  baseTimeMs?: number;
  /** Spacing between consecutive `created` timestamps. */
  stepMs?: number;
  /** Distinctive body tokens per note, drawn from the note's topic window. */
  wordsPerNote?: number;
}

export interface SyntheticDoc {
  slug: string;
  scope: string;
  type: "reference";
  description: string;
  body: string;
  importance: number;
  created: string;
  topic: number;
}

const DEFAULT_CORPUS: Required<ScaleCorpusOptions> = {
  scope: "personal",
  topics: 50,
  baseTimeMs: Date.UTC(2024, 0, 1, 0, 0, 0),
  stepMs: 3_600_000, // one hour apart
  wordsPerNote: 8,
};

/** Local ISO datetime without timezone (schema requires `datetime({local:true})`). */
function localIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Build N synthetic notes. Deterministic by construction: topic, timestamp,
 * importance and body words are all pure functions of the index, so two runs
 * with the same arguments produce byte-identical corpora (determinism the bench
 * needs to compare scorecards across `algoVersion`s).
 */
export function generateScaleCorpus(n: number, options: ScaleCorpusOptions = {}): SyntheticDoc[] {
  const opts = { ...DEFAULT_CORPUS, ...options };
  assertSafeScope(opts.scope);
  const docs: SyntheticDoc[] = [];
  for (let i = 0; i < n; i++) {
    const topic = i % opts.topics;
    // Each topic owns a contiguous window of the vocab; notes in one topic draw
    // from the same window, so they share tokens and cluster in cosine space.
    const windowStart = (topic * 3) % VOCAB.length;
    const words: string[] = [];
    for (let w = 0; w < opts.wordsPerNote; w++) {
      words.push(VOCAB[(windowStart + ((i * 7 + w * 13) % 6)) % VOCAB.length]!);
    }
    const body = `${words.join(" ")} entry ${i}`;
    docs.push({
      slug: `scale-${i}`,
      scope: opts.scope,
      type: "reference",
      description: `scale note ${i} topic ${topic}`,
      body,
      importance: (i % 10) + 1,
      created: localIso(opts.baseTimeMs + i * opts.stepMs),
      topic,
    });
  }
  return docs;
}

/** Write a synthetic corpus to `<root>/<scope>/<slug>.md`. */
export function writeCorpus(root: string, docs: readonly SyntheticDoc[]): void {
  for (const doc of docs) {
    assertSafeScope(doc.scope); // defence in depth at the write boundary
    const dir = join(root, doc.scope);
    mkdirSync(dir, { recursive: true });
    const fm = {
      name: doc.slug,
      description: doc.description,
      scope: doc.scope,
      created: doc.created,
      importance: doc.importance,
      type: doc.type,
    };
    writeFileSync(join(dir, `${doc.slug}.md`), serializeFrontmatter(fm, doc.body));
  }
}

export interface ScaleScorecardInput {
  scope: string;
  engrams: number;
  embedderId: string;
  reindexMs: number;
  reindexIndexed: number;
  searchLatenciesMs: number[];
  candidateSetSizes: number[];
  thresholdMs?: number;
}

export interface ScaleScorecard {
  benchmark: string;
  algoVersion: string;
  scope: string;
  engrams: number;
  embedderId: string;
  reindex: { ms: number; indexed: number };
  search: {
    queries: number;
    p50Ms: number | null;
    p95Ms: number | null;
    meanMs: number | null;
    candidateSet: { p50: number | null; p95: number | null; max: number };
  };
  thresholdMs: number;
  /** p95 search latency within the reference threshold — the fail line. */
  within: boolean;
}

/**
 * Assemble the scorecard from measured samples. Pure: separated from the timing
 * so the verdict and percentile wiring are unit-testable without a real clock.
 */
export function buildScaleScorecard(input: ScaleScorecardInput): ScaleScorecard {
  const thresholdMs = input.thresholdMs ?? DEFAULT_SCALE_THRESHOLD_MS;
  const latencies = input.searchLatenciesMs;
  const p95 = percentile(latencies, 0.95);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  return {
    benchmark: "mnemosyne-scale-v1",
    algoVersion: ALGO_VERSION,
    scope: input.scope,
    engrams: input.engrams,
    embedderId: input.embedderId,
    reindex: { ms: input.reindexMs, indexed: input.reindexIndexed },
    search: {
      queries: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: p95,
      meanMs: mean,
      candidateSet: {
        p50: percentile(input.candidateSetSizes, 0.5),
        p95: percentile(input.candidateSetSizes, 0.95),
        max: input.candidateSetSizes.length ? Math.max(...input.candidateSetSizes) : 0,
      },
    },
    thresholdMs,
    // No samples cannot prove the threshold is met — an empty run is not a pass.
    within: p95 !== null && p95 <= thresholdMs,
  };
}

export interface RunScaleOptions {
  n: number;
  root: string;
  scope?: string;
  /** How many queries to time. */
  queries?: number;
  embedder: EmbeddingClient;
  /** Fixed "now" for the ranker; defaults to just after the newest note. */
  nowMs?: number;
  thresholdMs?: number;
  corpus?: ScaleCorpusOptions;
}

/** Derive a query from a doc's body so it shares tokens with the corpus. */
function queryForDoc(doc: SyntheticDoc): string {
  return doc.body.split(/\s+/).slice(0, 4).join(" ");
}

/**
 * End-to-end scale run: generate → write → reindex (timed) → search (timed).
 * Returns the scorecard. Caller owns `root` (an ephemeral directory) and its
 * cleanup; this never writes outside it.
 */
export async function runScaleScenario(options: RunScaleOptions): Promise<ScaleScorecard> {
  const scope = options.scope ?? "personal";
  const corpusOpts = { ...options.corpus, scope };
  const docs = generateScaleCorpus(options.n, corpusOpts);
  writeCorpus(options.root, docs);

  const db = openDb(":memory:");
  try {
    const clock = fixedClock(options.nowMs ?? Date.now());
    const reindexStart = performance.now();
    const stats = await reindex({ root: options.root, db, embedder: options.embedder, scopes: [scope], clock });
    const reindexMs = performance.now() - reindexStart;

    // A load test must measure the full load. If indexing dropped engrams (an
    // embedder regression, a schema change), the benchmark would otherwise
    // "pass" on a shrunken or empty workload — a false green. Fail instead.
    if (stats.errors > 0 || stats.indexed !== options.n) {
      throw new Error(
        `scale bench: expected ${options.n} engrams indexed with no errors, `
        + `got indexed=${stats.indexed} errors=${stats.errors}. A load test must not pass on a reduced workload.`,
      );
    }

    const queryCount = Math.min(options.queries ?? 25, Math.max(docs.length, 1));
    const deps = { db, root: options.root, embedder: options.embedder, clock };
    const latencies: number[] = [];
    const candidateSizes: number[] = [];
    for (let q = 0; q < queryCount && docs.length > 0; q++) {
      // Sample queries spread evenly across the corpus (and its topics).
      const doc = docs[Math.floor((q * docs.length) / queryCount)]!;
      const query = queryForDoc(doc);
      const started = performance.now();
      const result = await searchExplain(deps, { query, scopes: [scope], k: 10 });
      latencies.push(performance.now() - started);
      candidateSizes.push(result.candidates.length);
    }

    return buildScaleScorecard({
      scope,
      engrams: options.n,
      embedderId: options.embedder.id,
      reindexMs,
      reindexIndexed: stats.indexed,
      searchLatenciesMs: latencies,
      candidateSetSizes: candidateSizes,
      ...(options.thresholdMs !== undefined ? { thresholdMs: options.thresholdMs } : {}),
    });
  } finally {
    db.close();
  }
}
