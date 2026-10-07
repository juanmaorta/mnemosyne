import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { search } from "./search.js";
import { systemClock } from "../clock.js";

/** A note whose slug carries the reserved `dream-` prefix is a dreaming
 *  derivative; search must flag it WITHOUT moving it in the ranking. */
function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-derived-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  const note = (slug: string): string =>
    ["---", `name: ${slug}`, "description: riego y plantas de interior", "scope: personal",
      "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---",
      "cuerpo sobre riego y plantas con texto suficiente para embeber", ""].join("\n");
  writeFileSync(join(root, "personal", "yogurtera.md"), note("yogurtera"));
  writeFileSync(join(root, "personal", "dream-abc123def456.md"), note("dream-abc123def456"));
  return root;
}

describe("search derived-origin marker", () => {
  test("flags_a_dream_prefixed_hit_as_derived_and_a_normal_one_as_not", async () => {
    const root = store();
    mkdirSync(join(root, ".index"), { recursive: true });
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: systemClock },
      { query: "riego plantas", minCos: -1, k: 10 },
    );

    const bySlug = new Map(hits.map((h) => [h.slug, h.isDerived]));
    expect(bySlug.get("dream-abc123def456")).toBe(true);
    expect(bySlug.get("yogurtera")).toBe(false);
  });
});
