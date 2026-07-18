// src/retrieval/search.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { search } from "./search.js";
import { createFakeEmbedder } from "../embeddings.fake.js";

function note(root: string, scope: string, slug: string, desc: string, body: string) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${desc}`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
}

async function indexed() {
  const root = mkdtempSync(join(tmpdir(), "mneme-search-"));
  note(root, "personal", "yogurtera", "yogurt maker", "yogurt maker control fermentation");
  note(root, "personal", "router", "network router", "omada router network wifi");
  note(root, "acme", "policy", "policy search", "insurance policy claim status");
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: createFakeEmbedder() });
  return { db, root };
}

describe("search", () => {
  test("search_ranks_relevant_engram_first", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder() }, { query: "yogurt maker control" });
    expect(hits[0]!.slug).toBe("yogurtera");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("search_returns_snippet_not_full_doc", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder() }, { query: "yogurt" });
    expect(hits[0]).toMatchObject({ slug: "yogurtera", scope: "personal" });
    expect(typeof hits[0]!.snippet).toBe("string");
  });

  test("search_respects_scope_filter", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder() }, { query: "policy", scopes: ["personal"] });
    expect(hits.every((h) => h.scope === "personal")).toBe(true);
  });

  test("search_honors_k_limit", async () => {
    const { db, root } = await indexed();
    const hits = await search({ db, root, embedder: createFakeEmbedder() }, { query: "router", k: 1 });
    expect(hits).toHaveLength(1);
  });
});
