// src/eval/digest-scenario.test.ts
//
// MNE-29 — the digest scenario, scripted on the controlled corpus (MNE-26).
// The ambient digest (`rankContext` → `selectWithinBudget` → `formatContextDigest`)
// must NOT be "a feed of new untouched notes": it stays a top-few view of durable
// memory. Two guards make that true, and this is their end-to-end script:
//   · ephemeral `snapshot` notes are left out of the digest (recalled via search);
//   · a hard cap on the number of lines stops any scope from flooding it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { searchExplain } from "../retrieval/search.js";
import { rankContext, selectWithinBudget, formatContextDigest } from "../retrieval/context.js";
import {
  generateControlledCorpus,
  materializeAndIndex,
  type ControlledDoc,
} from "./corpus.js";

const NOW = Date.parse("2026-04-01T00:00:00Z");

function snapshotDoc(scope: string, slug: string, token: string, created: string): ControlledDoc {
  return {
    scope, slug, type: "snapshot",
    description: `${token} estado efimero`,
    body: `${token} estado efimero`,
    importance: 9, // deliberately high: importance must NOT drag it into the digest
    created,
    topic: -1,
  };
}

describe("MNE-29 digest scenario (add → query → assert, controlled corpus)", () => {
  test("snapshots stay out of the digest but remain findable by search", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-digest-"));
    const corpus = generateControlledCorpus({ scopes: ["personal"], topics: 3, docsPerTopic: 2 });
    const durableSlugs = corpus.docs.map((d) => d.slug);
    // Add fresh, high-importance state snapshots — the "new untouched notes" that
    // used to dominate. They are newer than every durable note.
    corpus.docs.push(
      snapshotDoc("personal", "estado-2026-03-01", "zprojalpha", "2026-03-01T00:00:00"),
      snapshotDoc("personal", "estado-2026-03-15", "zprojbeta", "2026-03-15T00:00:00"),
    );
    const { db, deps } = await materializeAndIndex(root, corpus, { embedder: createFakeEmbedder(), nowMs: NOW });
    try {
      const ranked = rankContext(db, deps.root, "personal", NOW);
      const { included } = selectWithinBudget(ranked, 100_000);
      const shown = included.map((e) => e.slug);

      // The digest is durable memory only — no snapshot, despite them being newer
      // and importance 9.
      expect(shown).not.toContain("estado-2026-03-01");
      expect(shown).not.toContain("estado-2026-03-15");
      expect(shown.length).toBeGreaterThan(0);
      for (const s of shown) expect(durableSlugs).toContain(s);

      // But a snapshot is not lost: search still serves it (recalled on demand).
      const hit = await searchExplain(deps, { query: "zprojbeta", scopes: ["personal"], k: 10 });
      expect(hit.candidates.filter((c) => c.included).map((c) => c.slug)).toContain("estado-2026-03-15");
    } finally {
      db.close();
    }
  });

  test("the selectivity guard caps the digest so no scope floods it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mne-digest-cap-"));
    // 12 short durable notes, each cheap in tokens; under the token budget alone
    // they would all be injected (the 78%-of-scope failure).
    const corpus = generateControlledCorpus({ scopes: ["personal"], topics: 6, docsPerTopic: 2 });
    const { db, deps } = await materializeAndIndex(root, corpus, { embedder: createFakeEmbedder(), nowMs: NOW });
    try {
      const ranked = rankContext(db, deps.root, "personal", NOW);
      expect(ranked.length).toBe(12); // all durable notes rank

      const cap = 5;
      const { included, omitted } = selectWithinBudget(ranked, 100_000, cap);
      expect(included).toHaveLength(cap);
      expect(omitted).toBe(ranked.length - cap);

      const digest = formatContextDigest(included, "personal", omitted);
      expect(digest).toContain(`… +${omitted} more`);
    } finally {
      db.close();
    }
  });
});
