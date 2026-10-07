// 5a-lite (MNE-22): a synthetic guard that fails if the recency signal reorders
// the top-k above cosine. Not the full bench (that is v0.2) — one fixture where
// recency and relevance disagree the hardest.
//
// Coverage note: `search.blended.test.ts` already guards the CREATION-recency
// angle (search_default_ranks_relevant_over_recently_created_irrelevant) and
// search.test.ts pins the default weights to cosine-only. This closes the
// remaining gap: ACCESS-driven recency (a freshly, repeatedly READ note) must
// not lift a lower-cosine hit above a higher-cosine one under the default.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { search } from "./search.js";
import { fixedClock } from "../clock.js";
import { recordAccess } from "../hotstate.js";

const DAY_MS = 24 * 3600 * 1000;

function note(root: string, slug: string, body: string, createdIso: string): void {
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
      `created: ${createdIso}`, "importance: 5", "---", body, ""].join("\n"));
}

describe("recency calibration (5a-lite)", () => {
  test("default_search_keeps_cosine_order_despite_fresh_repeated_access_of_a_weaker_hit", async () => {
    const now = Date.parse("2026-07-31T10:00:00.000Z");
    const oldIso = new Date(now - 200 * DAY_MS).toISOString().slice(0, 19);
    const root = mkdtempSync(join(tmpdir(), "mneme-5alite-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    mkdirSync(join(root, "personal"), { recursive: true });
    // Both created long ago, so creation-seeded recency is equal: the only
    // recency difference is the access below, isolating the access signal.
    note(root, "yogurtera", "yogurt maker control fermentation temperature", oldIso); // on-topic → high cosine
    note(root, "router", "omada wifi router vlan network", oldIso);                     // off-topic → low cosine
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    // The weaker hit is read hard and recently — the strongest pull recency could
    // exert. Under a recency-weighted ranker this would lift it; under the
    // cosine-only default it must not.
    const accessAt = new Date(now).toISOString();
    recordAccess(db, root, "personal", "router", accessAt);
    recordAccess(db, root, "personal", "router", accessAt);
    recordAccess(db, root, "personal", "router", accessAt);

    const hits = await search(
      { db, root, embedder: createFakeEmbedder(), clock: fixedClock(now) },
      { query: "yogurt maker control" },
    );

    // Cosine wins: the on-topic note leads and the off-topic fresh read trails.
    expect(hits[0]!.slug).toBe("yogurtera");
    expect(hits.map((h) => h.slug)).toContain("router");
    expect(hits.findIndex((h) => h.slug === "yogurtera"))
      .toBeLessThan(hits.findIndex((h) => h.slug === "router"));
  });
});
