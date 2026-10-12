// src/eval/corpus.test.ts
//
// MNE-26: controlled synthetic corpus generator. N engrams per scope with
// deliberately shared tokens (so relevance is known a priori), varied
// importance, and `created` staggered via an injected clock — no LLM. The
// "conversations" are scripts: add (materialize) → access (get) → advance the
// clock → query (search) → assert. These tests ARE those scripts, and they also
// pin the generator's controlled properties.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Slug } from "../schema.js";
import { parseFrontmatter } from "../frontmatter.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { fixedClock } from "../clock.js";
import { searchExplain } from "../retrieval/search.js";
import { getEngramWithRevision } from "../retrieval/get.js";
import {
  generateControlledCorpus,
  writeControlledCorpus,
  materializeAndIndex,
  type ControlledDoc,
} from "./corpus.js";

function tokensOf(doc: ControlledDoc): Set<string> {
  return new Set(doc.body.toLowerCase().split(/\s+/).filter(Boolean));
}

describe("generateControlledCorpus — controlled properties", () => {
  test("is deterministic", () => {
    expect(generateControlledCorpus({ topics: 3, docsPerTopic: 2 }))
      .toEqual(generateControlledCorpus({ topics: 3, docsPerTopic: 2 }));
  });

  test("produces scopes × topics × docsPerTopic docs and one query per topic", () => {
    const c = generateControlledCorpus({ scopes: ["personal", "work"], topics: 3, docsPerTopic: 4 });
    expect(c.docs).toHaveLength(2 * 3 * 4);
    expect(c.queries).toHaveLength(2 * 3); // one per (scope, topic)
  });

  test("every slug is unique and kebab-valid", () => {
    const c = generateControlledCorpus({ scopes: ["personal", "work"], topics: 4, docsPerTopic: 3 });
    const slugs = c.docs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(Slug.safeParse(s).success).toBe(true);
  });

  test("importance is varied and in range", () => {
    const c = generateControlledCorpus({ topics: 5, docsPerTopic: 4 });
    for (const d of c.docs) {
      expect(d.importance).toBeGreaterThanOrEqual(1);
      expect(d.importance).toBeLessThanOrEqual(10);
    }
    expect(new Set(c.docs.map((d) => d.importance)).size).toBeGreaterThan(1);
  });

  test("created is local ISO (no timezone), staggered and strictly increasing", () => {
    const c = generateControlledCorpus({ topics: 3, docsPerTopic: 3 });
    for (const d of c.docs) expect(d.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    const times = c.docs.map((d) => Date.parse(`${d.created}Z`));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  test("tokens are shared within a topic and disjoint across topics (known relevance)", () => {
    const c = generateControlledCorpus({ scopes: ["personal"], topics: 3, docsPerTopic: 3 });
    const byTopic = new Map<number, ControlledDoc[]>();
    for (const d of c.docs) byTopic.set(d.topic, [...(byTopic.get(d.topic) ?? []), d]);

    // Within a topic: the two docs share at least one distinctive token.
    for (const docs of byTopic.values()) {
      const a = tokensOf(docs[0]!);
      expect([...tokensOf(docs[1]!)].some((t) => a.has(t))).toBe(true);
    }
    // Across topics: topic 0 and topic 1 share no body token.
    const t0 = new Set([...byTopic.get(0)!].flatMap((d) => [...tokensOf(d)]));
    const t1Tokens = [...byTopic.get(1)!].flatMap((d) => [...tokensOf(d)]);
    expect(t1Tokens.some((t) => t0.has(t))).toBe(false);
  });

  test("each query's known-relevant slugs are exactly its topic's docs, in its scope", () => {
    const c = generateControlledCorpus({ scopes: ["personal", "work"], topics: 2, docsPerTopic: 3 });
    for (const q of c.queries) {
      const sameTopic = c.docs.filter((d) => d.scope === q.scope && d.topic === q.topic).map((d) => d.slug).sort();
      expect([...q.relevant].sort()).toEqual(sameTopic);
    }
  });
});

describe("controlled corpus drives the real retrieval path (script: add → query → assert)", () => {
  test("a topic query retrieves its known-relevant docs, not other topics'", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-corpus-"));
    const corpus = generateControlledCorpus({ scopes: ["personal"], topics: 4, docsPerTopic: 3 });
    const { db, deps } = await materializeAndIndex(root, corpus, { embedder: createFakeEmbedder(), nowMs: Date.parse("2026-02-01T00:00:00Z") });
    try {
      for (const q of corpus.queries) {
        const result = await searchExplain(deps, { query: q.text, scopes: [q.scope], k: 20 });
        const top = result.candidates.filter((c) => c.included).slice(0, q.relevant.length).map((c) => c.slug);
        // Every known-relevant doc is retrieved, and the top slots are exactly them.
        expect([...top].sort()).toEqual([...q.relevant].sort());
      }
    } finally {
      db.close();
    }
  });

  test("access (get) reinforces a doc without disturbing the written corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-corpus-"));
    const corpus = generateControlledCorpus({ scopes: ["personal"], topics: 1, docsPerTopic: 2 });
    const { db, deps } = await materializeAndIndex(root, corpus, { embedder: createFakeEmbedder(), nowMs: Date.parse("2026-02-01T00:00:00Z") });
    try {
      const slug = corpus.docs[0]!.slug;
      const before = readFileSync(corpus.docs[0]!.scope === "personal" ? join(root, "personal", `${slug}.md`) : "", "utf8");
      // "access" step: get reinforces hot state (it does not mutate the .md).
      const got = getEngramWithRevision(db, root, slug, fixedClock(Date.parse("2026-02-02T00:00:00Z")), "personal");
      expect(got.slug).toBe(slug);
      const after = readFileSync(join(root, "personal", `${slug}.md`), "utf8");
      expect(after).toBe(before); // retrieval never rewrites the source note
    } finally {
      db.close();
    }
  });
});
