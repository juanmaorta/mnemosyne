import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { getEngramAndRecord } from "./get.js";
import { getHotState } from "../hotstate.js";

describe("getEngramAndRecord", () => {
  test("get_records_an_access_event_reinforcing_strength", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-getrec-"));
    mkdirSync(join(root, "personal"), { recursive: true });
    mkdirSync(join(root, ".index"), { recursive: true });
    writeFileSync(join(root, "personal", "yogurtera.md"),
      ["---", "name: yogurtera", "description: d", "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", ""].join("\n"));
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    getEngramAndRecord(db, root, "yogurtera");

    expect(getHotState(db, "personal", "yogurtera")!.accessCount).toBe(1);
  });
});
