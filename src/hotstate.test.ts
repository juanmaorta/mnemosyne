import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "./index/db.js";
import { reindex } from "./index/reindex.js";
import { createFakeEmbedder } from "./embeddings.fake.js";
import { materializeHotState, getHotState, recordAccess } from "./hotstate.js";

function writeEngram(root: string, scope: string, slug: string): void {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(
    join(root, scope, `${slug}.md`),
    [
      "---",
      `name: ${slug}`,
      "description: d",
      `scope: ${scope}`,
      "type: reference",
      "created: 2026-06-01T10:00:00",
      "importance: 5",
      "---",
      "body",
      "",
    ].join("\n"),
  );
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "mneme-hot-"));
  mkdirSync(join(root, ".index"), { recursive: true });
  writeEngram(root, "personal", "yogurtera");
  const db = openDb(join(root, ".index", "store.db"));
  await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
  return { root, db };
}

describe("hot state", () => {
  test("materialize_defaults_to_initial_strength_when_no_events", async () => {
    const { root, db } = await setup();
    materializeHotState(db, root, ["personal"], Date.parse("2026-06-01T10:00:00Z"));
    expect(getHotState(db, "personal", "yogurtera")).toMatchObject({ accessCount: 0, strength: 1 });
  });

  test("recordAccess_reinforces_strength_and_count", async () => {
    const { root, db } = await setup();
    recordAccess(db, root, "personal", "yogurtera", "2026-07-06T10:00:00.000Z");
    const hs = getHotState(db, "personal", "yogurtera")!;
    expect(hs.accessCount).toBe(1);
    expect(hs.strength).toBe(2);
    expect(hs.lastAccess).toBe("2026-07-06T10:00:00.000Z");
  });

  test("materialize_merges_events_from_all_machines", async () => {
    const { root, db } = await setup();
    recordAccess(db, root, "personal", "yogurtera", "2026-07-06T10:00:00.000Z");
    recordAccess(db, root, "personal", "yogurtera", "2026-07-07T10:00:00.000Z");
    expect(getHotState(db, "personal", "yogurtera")!.accessCount).toBe(2);
  });

  test("hot_state_keyed_by_scope_slug_no_cross_scope_collision", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-hot-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    writeEngram(root, "personal", "shared");
    writeEngram(root, "acme", "shared");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal", "acme"] });

    const nowMs = Date.parse("2026-07-06T10:00:00.000Z");
    recordAccess(db, root, "personal", "shared", "2026-07-06T10:00:00.000Z");
    materializeHotState(db, root, ["personal", "acme"], nowMs);

    expect(getHotState(db, "personal", "shared")!.accessCount).toBe(1);
    expect(getHotState(db, "acme", "shared")!.accessCount).toBe(0);
  });
});
