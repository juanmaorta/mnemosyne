import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { writeSnapshot, snapshotsDir } from "./snapshot.js";
import { fixedClock } from "../clock.js";
import { clearTelemetryConfigCache } from "../telemetry/config.js";
import { purgeTelemetryScope } from "../telemetry/purge.js";

const CLOCK = fixedClock(Date.parse("2026-10-08T03:00:00.000Z"));

async function storeWithScopeMap(map: string, telemetry?: object): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mneme-snapcatch-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  mkdirSync(join(root, ".index"), { recursive: true });
  writeFileSync(join(root, "personal", "n.md"),
    ["---", "name: n", "description: d", "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", ""].join("\n"));
  writeFileSync(join(root, ".scopemap"), map);
  if (telemetry) writeFileSync(join(root, ".telemetry.json"), JSON.stringify(telemetry));
  clearTelemetryConfigCache();
  const db = openDb(join(root, ".index", "store.db"));
  await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });
  return root;
}

function readSnapshot(root: string): { catchAll?: string } {
  const dir = snapshotsDir(root);
  const name = readdirSync(dir).find((n) => n.startsWith("stats-"))!;
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("snapshot catch-all privacy (MNE-59)", () => {
  beforeEach(() => clearTelemetryConfigCache());

  test("records the catch-all scope when it is not excluded", async () => {
    const root = await storeWithScopeMap("~ = personal\n");
    const db = openDb(join(root, ".index", "store.db"));
    writeSnapshot(db, root, CLOCK);
    expect(readSnapshot(root).catchAll).toBe("personal");
  });

  test("does NOT persist a catch-all that points at an excluded scope", async () => {
    const root = await storeWithScopeMap("~ = acme\n", { enabled: true, excludeScopes: ["acme"] });
    const db = openDb(join(root, ".index", "store.db"));
    writeSnapshot(db, root, CLOCK);
    expect(readSnapshot(root).catchAll).toBeUndefined();
  });

  test("purge redacts a catch-all recorded before the scope was excluded", async () => {
    const root = await storeWithScopeMap("~ = personal\n");
    const db = openDb(join(root, ".index", "store.db"));
    writeSnapshot(db, root, CLOCK); // records catchAll: "personal" (not yet excluded)
    expect(readSnapshot(root).catchAll).toBe("personal");

    const report = purgeTelemetryScope(root, "personal");
    expect(report.snapshotsRedacted).toBeGreaterThanOrEqual(1);
    expect(readSnapshot(root).catchAll).toBeUndefined();
  });
});
