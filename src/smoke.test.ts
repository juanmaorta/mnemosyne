// src/smoke.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "./index/db.js";
import { reindex } from "./index/reindex.js";
import { search } from "./retrieval/search.js";
import { createOllamaClient } from "./embeddings.js";

const run = process.env.MNEMOSYNE_SMOKE === "1" ? describe : describe.skip;

run("real Ollama smoke", () => {
  test("real_embeddings_rank_relevant_note_first", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-smoke-"));
    mkdirSync(join(root, "personal"), { recursive: true });
    const mk = (slug: string, body: string) =>
      writeFileSync(join(root, "personal", `${slug}.md`),
        ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
          "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
    mk("yogurt", "how to control a yogurt maker fermentation temperature");
    mk("router", "configuring an omada wifi router and vlans");

    const embedder = createOllamaClient();
    const db = openDb(":memory:");
    await reindex({ root, db, embedder });
    const hits = await search({ db, root, embedder }, { query: "yogurt fermentation" });

    expect(hits[0]!.slug).toBe("yogurt");
  }, 30_000);
});
