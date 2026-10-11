// src/retrieval/search.bury.test.ts
//
// MNE-87 (opción 3): una nota derivada no debe ENTERRAR a sus fuentes. La
// derivada es un resumen de conveniencia; la fuente sigue siendo la verdad y
// debe seguir recuperándose. Realización mínima: una fuente que una derivada
// incluida dejaría fuera del top-k se rescata (se incluye también), sin tocar
// la calibración del ranking ni perder la utilidad de la derivada.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { search, searchExplain } from "./search.js";
import { systemClock } from "../clock.js";

function write(root: string, scope: string, slug: string, desc: string, body: string, sources?: string[]) {
  mkdirSync(join(root, scope), { recursive: true });
  const front = ["---", `name: ${slug}`, `description: ${desc}`, `scope: ${scope}`, "type: reference",
    "created: 2026-06-01T10:00:00", "importance: 5"];
  if (sources) front.push(`sources:`, ...sources.map((s) => `  - ${s}`));
  front.push("---", body, "");
  writeFileSync(join(root, scope, `${slug}.md`), front.join("\n"));
}

async function indexed() {
  const root = mkdtempSync(join(tmpdir(), "mneme-bury-"));
  // The source has the query terms once; the derived repeats them, so with the
  // bag-of-words fake embedder the derived out-ranks its own source.
  write(root, "personal", "riego-guia", "riego de plantas", "riego plantas interior");
  write(root, "personal", "dream-abc123", "riego plantas interior resumen",
    "riego plantas interior riego plantas interior riego plantas interior", ["riego-guia"]);
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
  return { db, root };
}

describe("MNE-87 derived notes must not bury their sources", () => {
  test("a_source_a_derived_hit_would_push_out_of_top-k_is_rescued", async () => {
    const { db, root } = await indexed();
    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "riego plantas interior", k: 1, minCos: -1 },
    );
    const slugs = hits.map((h) => h.slug);
    // The derived summary is useful and stays; its source must not vanish.
    expect(slugs).toContain("dream-abc123");
    expect(slugs).toContain("riego-guia");
  });

  test("the_derived_summary_keeps_its_own_ranking_position", async () => {
    // Option 3 must not kill a useful derived note (cf. c3 in MNE-80): the
    // derived is still allowed to rank #1; the source is added, not swapped.
    const { db, root } = await indexed();
    const res = await searchExplain(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "riego plantas interior", k: 1, minCos: -1 },
    );
    const included = res.candidates.filter((c) => c.included);
    expect(included[0]!.slug).toBe("dream-abc123");
  });

  test("nested_provenance_rescues_the_original_regardless_of_ranking_order", async () => {
    // Regression (Codex P2): a summary can cite another summary. Rescue must not
    // depend on ranking order. Rank a > b > c > original, but provenance is
    // a → c → b → original: a forward-only pass rescues b after b's turn has
    // passed, stranding original. The query-term repetition sets the ranking.
    const root = mkdtempSync(join(tmpdir(), "mneme-bury-nested-"));
    const q = "riego plantas interior";
    // Rank by query-term count: a(×4) > b(×3) > c(×2) > original(×1). Provenance
    // a→c→b→original: the c→b edge points BACKWARD in rank, which strands
    // `original` under a forward-only rescue pass.
    write(root, "personal", "original", "riego de plantas", q);
    write(root, "personal", "dream-c", "resumen c", `${q} ${q}`, ["dream-b"]);
    write(root, "personal", "dream-b", "resumen b", `${q} ${q} ${q}`, ["original"]);
    write(root, "personal", "dream-a", "resumen a", `${q} ${q} ${q} ${q}`, ["dream-c"]);
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: q, k: 1, minCos: -1 },
    );
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toContain("dream-c"); // source of a
    expect(slugs).toContain("dream-b"); // source of c
    expect(slugs).toContain("original"); // source of b — must survive the chain
  });

  test("a_non-source_note_is_not_rescued_just_because_a_derived_is_included", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-bury-neg-"));
    write(root, "personal", "unrelated", "algo distinto", "nada que ver aqui");
    write(root, "personal", "dream-def456", "riego plantas interior resumen",
      "riego plantas interior riego plantas interior", ["missing-source"]);
    const db = openDb(":memory:");
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "riego plantas interior", k: 1, minCos: -1 },
    );
    expect(hits.map((h) => h.slug)).not.toContain("unrelated");
  });
});
