// src/eval/corpus.ts
//
// Controlled synthetic corpus generator (MNE-26). Produces N engrams per scope
// with DELIBERATELY shared tokens so relevance is known a priori, varied
// importance, and `created` staggered via an injected clock — with NO LLM. It is
// the fixture the ranker/decay/digest scenarios script as
// `add → access → advance clock → query → assert`: this module is the `add`
// (generate + materialize) and the index build; the caller supplies the rest
// with the normal `get`/`search`/`rankContext` surface and a `fixedClock`.
//
// Deterministic by construction: topic, timestamp, importance and every token
// are pure functions of position, so two runs yield byte-identical corpora.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeFrontmatter } from "../frontmatter.js";
import { openDb, type Db } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { fixedClock } from "../clock.js";
import type { EmbeddingClient } from "../embeddings.js";
import type { SearchDeps } from "../retrieval/search.js";

export interface ControlledCorpusOptions {
  scopes?: string[];
  /** Token clusters per scope; each is one query's known-relevant set. */
  topics?: number;
  docsPerTopic?: number;
  /** Distinctive shared tokens per topic. */
  tokensPerTopic?: number;
  /** Epoch ms of the oldest note; the rest are staggered after it. */
  baseTimeMs?: number;
  stepMs?: number;
}

export interface ControlledDoc {
  scope: string;
  slug: string;
  /**
   * `reference` for the durable corpus the generator emits; `snapshot` lets a
   * scenario add ephemeral state notes by hand (MNE-29) to exercise the digest's
   * exclusion of them.
   */
  type: "reference" | "snapshot";
  description: string;
  body: string;
  importance: number;
  created: string;
  /** Which token cluster this doc belongs to — its known-relevance group. */
  topic: number;
}

export interface ControlledQuery {
  id: string;
  scope: string;
  /** The token cluster this query targets. */
  topic: number;
  /** Built from the topic's shared tokens, so it retrieves exactly that topic. */
  text: string;
  /** Slugs known to be relevant a priori: this topic's docs, in this scope. */
  relevant: string[];
}

export interface ControlledCorpus {
  docs: ControlledDoc[];
  queries: ControlledQuery[];
}

const DEFAULTS: Required<ControlledCorpusOptions> = {
  scopes: ["personal"],
  topics: 4,
  docsPerTopic: 3,
  tokensPerTopic: 4,
  baseTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0),
  stepMs: 3_600_000,
};

/**
 * Bijective base-26 word for `n` (0→a, 25→z, 26→aa, …): a distinct, purely
 * alphabetic token per index, so FTS tokenization never splits it and two
 * different indices never collide — the basis for disjoint cross-topic tokens.
 */
function wordFor(n: number): string {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

/** Per-doc unique marker, from a high offset so it never collides with a topic token. */
function uniqueMarker(globalIndex: number): string {
  return wordFor(1_000_000 + globalIndex);
}

function localIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

export function generateControlledCorpus(options: ControlledCorpusOptions = {}): ControlledCorpus {
  const opts = { ...DEFAULTS, ...options };
  const docs: ControlledDoc[] = [];
  const queries: ControlledQuery[] = [];
  let globalIndex = 0;

  for (let s = 0; s < opts.scopes.length; s++) {
    const scope = opts.scopes[s]!;
    for (let topic = 0; topic < opts.topics; topic++) {
      // Each topic owns a disjoint window of the word space; every doc in the
      // topic shares these, and no other topic uses them → known relevance.
      const topicTokens = Array.from({ length: opts.tokensPerTopic }, (_, k) =>
        wordFor(topic * opts.tokensPerTopic + k),
      );
      const topicText = topicTokens.join(" ");
      const relevant: string[] = [];
      for (let d = 0; d < opts.docsPerTopic; d++) {
        const slug = `${scope}-t${topic}-d${d}`;
        relevant.push(slug);
        docs.push({
          scope,
          slug,
          type: "reference",
          description: topicText,
          body: `${topicText} ${uniqueMarker(globalIndex)}`,
          importance: (globalIndex % 10) + 1,
          created: localIso(opts.baseTimeMs + globalIndex * opts.stepMs),
          topic,
        });
        globalIndex++;
      }
      queries.push({ id: `${scope}-q${topic}`, scope, topic, text: topicText, relevant });
    }
  }
  return { docs, queries };
}

/** Write a controlled corpus to `<root>/<scope>/<slug>.md`. */
export function writeControlledCorpus(root: string, docs: readonly ControlledDoc[]): void {
  for (const doc of docs) {
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

export interface IndexedCorpus {
  db: Db;
  deps: SearchDeps;
}

/**
 * Materialize a corpus (`add`) and build the index at a fixed `nowMs`, returning
 * ready-to-query search deps. The caller owns `root` (ephemeral) and must
 * `db.close()`. `access` (`getEngramWithRevision`) and `query`
 * (`search`/`rankContext`) run against `deps` with their own injected clock.
 */
export async function materializeAndIndex(
  root: string,
  corpus: ControlledCorpus,
  opts: { embedder: EmbeddingClient; nowMs: number },
): Promise<IndexedCorpus> {
  writeControlledCorpus(root, corpus.docs);
  const scopes = [...new Set(corpus.docs.map((d) => d.scope))];
  const clock = fixedClock(opts.nowMs);
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: opts.embedder, scopes, clock });
  return { db, deps: { db, root, embedder: opts.embedder, clock } };
}
