import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { fixedClock, systemClock } from "../clock.js";
import { recordAccess } from "../hotstate.js";
import { rankForArm } from "./arm.js";

function note(root: string, slug: string, importance: number, body: string) {
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug}`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", `importance: ${importance}`, "---", body, ""].join("\n"));
}

async function corpus() {
  const root = mkdtempSync(join(tmpdir(), "mne78-arm-"));
  mkdirSync(join(root, ".index"), { recursive: true });
  return root;
}

describe("rankForArm", () => {
  test("P_blends_recency_while_S_ignores_it_at_equal_cosine", async () => {
    // Equal tokens → equal cosine. 'bbb' is read twice (higher retention); 'aaa'
    // is never read. P (blended) must put the reinforced note first; S (cosine,
    // deterministic scope→slug tiebreak) must ignore recency and lead with 'aaa'.
    const root = await corpus();
    note(root, "aaa", 5, "yogurt maker control");
    note(root, "bbb", 5, "yogurt maker control");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    recordAccess(db, root, "personal", "bbb", "2026-07-30T10:00:00.000Z");
    recordAccess(db, root, "personal", "bbb", "2026-07-30T10:00:00.000Z");
    const deps = { db, root, embedder: createFakeEmbedder(), clock: fixedClock(Date.parse("2026-07-31T10:00:00.000Z")) };
    const opts = { query: "yogurt maker control", scopes: ["personal"] };

    const p = await rankForArm(deps, opts, "P");
    const s = await rankForArm(deps, opts, "S");

    expect(p.primary[0]!.slug).toBe("bbb");
    expect(s.primary[0]!.slug).toBe("aaa");
  });

  test("E_explores_below_the_floor_when_S_returns_nothing", async () => {
    // A floor that nothing clears: S's primary is empty, but E runs a second,
    // floorless search and surfaces candidates below the cut.
    const root = await corpus();
    note(root, "one", 5, "yogurt maker control");
    note(root, "two", 5, "router network wifi");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
    const deps = { db, root, embedder: createFakeEmbedder(), clock: systemClock };
    const opts = { query: "unrelated absent tokens", scopes: ["personal"], minCos: 0.5 };

    const s = await rankForArm(deps, opts, "S");
    const e = await rankForArm(deps, opts, "E");

    expect(s.primary).toHaveLength(0);
    expect(e.primary).toHaveLength(0);
    expect(e.fallback.length).toBeGreaterThan(0);
    // The fallback is exploratory: it never repeats what the primary already returned.
    expect(e.fallback.every((f) => !e.primary.some((p) => p.slug === f.slug && p.scope === f.scope))).toBe(true);
  });
});
