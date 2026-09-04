import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { writeSnapshot, readSnapshots, snapshotsDir } from "./snapshot.js";
import { computeStats } from "./stats.js";
import { clearTelemetryConfigCache } from "../telemetry/config.js";
import { fixedClock } from "../clock.js";
import { ALGO_VERSION } from "../version.js";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-08-08T09:00:00.000Z");

async function seeded() {
  const root = mkdtempSync(join(tmpdir(), "mneme-snap-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", "yogurtera.md"),
    ["---", "name: yogurtera", "description: d", "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", ""].join("\n"));
  const db = openDb(join(root, ".index", "store.db"));
  await reindex({ root, db, embedder: createFakeEmbedder(), clock: fixedClock(T0) });
  return { db, root };
}

describe("writeSnapshot", () => {
  test("writes a dated file stamped with the clock and algo version", async () => {
    const { db, root } = await seeded();

    const path = writeSnapshot(db, root, fixedClock(T0));

    expect(path).toBe(join(snapshotsDir(root), "stats-2026-08-08.json"));
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.ts).toBe("2026-08-08T09:00:00.000Z");
    // Without the algo version a metric shift cannot be attributed to a code
    // change vs. a change in how the store is being used.
    expect(saved.algoVersion).toBe(ALGO_VERSION);
    expect(saved.stats.countsByScope).toEqual({ personal: 1 });
  });

  test("overwrites within the same day rather than piling up files", async () => {
    const { db, root } = await seeded();

    writeSnapshot(db, root, fixedClock(T0));
    writeSnapshot(db, root, fixedClock(T0 + 3600_000));

    // A weekly cron that fires twice (wake-from-sleep catch-up) must not turn
    // one day into two data points.
    expect(readdirSync(snapshotsDir(root))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(snapshotsDir(root), "stats-2026-08-08.json"), "utf8")).ts)
      .toBe("2026-08-08T10:00:00.000Z");
  });

  test("lives under the durable telemetry dir, not the disposable index", async () => {
    const { root } = await seeded();
    expect(snapshotsDir(root)).toContain(".telemetry");
    expect(snapshotsDir(root)).not.toContain(".index");
  });

  test("still records store counts when telemetry is disabled", async () => {
    const { db, root } = await seeded();
    writeFileSync(join(root, ".telemetry.json"), JSON.stringify({ enabled: false }));

    const saved = JSON.parse(readFileSync(writeSnapshot(db, root, fixedClock(T0)), "utf8"));

    // Counts and strength come from the index, not the event log — they stay
    // meaningful on a machine that records nothing.
    expect(saved.stats.countsByScope).toEqual({ personal: 1 });
    expect(saved.stats.searchLatencyMs).toBeNull();
  });
});

describe("readSnapshots", () => {
  test("returns the series oldest first", async () => {
    const { db, root } = await seeded();
    writeSnapshot(db, root, fixedClock(T0 + 2 * DAY));
    writeSnapshot(db, root, fixedClock(T0));
    writeSnapshot(db, root, fixedClock(T0 + DAY));

    expect(readSnapshots(root).map((s) => s.ts.slice(0, 10)))
      .toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  });

  test("is empty, not an error, before the first snapshot", async () => {
    const { root } = await seeded();
    expect(readSnapshots(root)).toEqual([]);
  });

  test("skips a corrupt file instead of losing the whole series", async () => {
    const { db, root } = await seeded();
    writeSnapshot(db, root, fixedClock(T0));
    writeFileSync(join(snapshotsDir(root), "stats-2026-01-01.json"), "{ truncated");

    expect(readSnapshots(root)).toHaveLength(1);
  });
});

describe("scope exclusions", () => {
  test("a snapshot omits every trace of an excluded scope", async () => {
    // excludeScopes stops the event log from recording a client scope, but
    // computeStats reads the `engrams` table by SQL and never went through
    // that gate — so snapshots would still name the client and its size, one
    // file a day, outside the directory the offboarding runbook deletes.
    const { db, root } = await seeded();
    mkdirSync(join(root, "acme"), { recursive: true });
    writeFileSync(join(root, "acme", "client-contract.md"),
      ["---", "name: client-contract", "description: d", "scope: acme", "type: project",
        "created: 2026-06-01T10:00:00", "importance: 8", "---", "body", ""].join("\n"));
    await reindex({ root, db, embedder: createFakeEmbedder(), clock: fixedClock(T0) });
    writeFileSync(join(root, ".telemetry.json"), JSON.stringify({ excludeScopes: ["acme"] }));
    clearTelemetryConfigCache();

    const saved = JSON.parse(readFileSync(writeSnapshot(db, root, fixedClock(T0)), "utf8"));

    expect(saved.stats.countsByScope).toEqual({ personal: 1 });
    expect(JSON.stringify(saved)).not.toContain("acme");
    expect(JSON.stringify(saved)).not.toContain("client-contract");
  });

  test("mneme stats still shows the excluded scope on screen", async () => {
    // Filtering is about what gets PERSISTED. Hiding a scope from the user on
    // their own machine would just push them to turn exclusions off entirely.
    const { db, root } = await seeded();
    writeFileSync(join(root, ".telemetry.json"), JSON.stringify({ excludeScopes: ["personal"] }));
    clearTelemetryConfigCache();

    expect(computeStats(db, root).countsByScope).toEqual({ personal: 1 });
  });
});
