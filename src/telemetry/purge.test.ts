import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeTelemetryScope } from "./purge.js";
import { emitEvents, readTelemetry } from "./events.js";
import { clearTelemetryConfigCache } from "./config.js";
import { storePaths } from "../store.js";
import { fixedClock } from "../clock.js";

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const DAY = 24 * 3600 * 1000;

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "mneme-purge-"));
  emitEvents(root, fixedClock(T0), [
    { kind: "retrieval.query", corrId: "a", scopes: ["personal", "acme"], k: 5 },
    { kind: "retrieval.candidate", corrId: "a", scope: "personal", slug: "mia" },
    { kind: "retrieval.candidate", corrId: "a", scope: "acme", slug: "contrato-cliente" },
  ]);
  emitEvents(root, fixedClock(T0 + DAY), [
    { kind: "retrieval.query", corrId: "b", scopes: ["acme"], k: 5 },
    { kind: "access.reinforced", scope: "acme", slug: "nomina-cliente", strengthBefore: 1, strengthAfter: 2 },
  ]);
  emitEvents(root, fixedClock(T0 + 2 * DAY), [
    { kind: "engram.created", scope: "personal", type: "reference" },
  ]);
  return root;
}

function snapshot(root: string, day: string, counts: Record<string, number>) {
  const dir = join(storePaths(root).telemetryDir, "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `stats-${day}.json`), JSON.stringify({
    ts: `${day}T09:00:00.000Z`, algoVersion: "1.1.0",
    stats: { countsByScope: counts, countsByType: { reference: 3 }, strengthHistogram: { "1-2": 3 } },
  }, null, 2));
}

beforeEach(() => clearTelemetryConfigCache());

describe("purgeTelemetryScope", () => {
  test("removes every event naming the scope and leaves the rest untouched", () => {
    const root = seeded();

    const report = purgeTelemetryScope(root, "acme");

    const left = readTelemetry(root);
    expect(JSON.stringify(left)).not.toContain("acme");
    expect(JSON.stringify(left)).not.toContain("contrato-cliente");
    expect(JSON.stringify(left)).not.toContain("nomina-cliente");
    // personal survives intact, including the engram.created two days later
    expect(left.filter((e) => e.scope === "personal")).toHaveLength(2);
    expect(report.eventsRemoved).toBe(3);
  });

  test("narrows a multi-scope event instead of deleting it", () => {
    // A query over personal+acme is still a real personal query; dropping it
    // whole would silently lose history that belongs to the scope we keep.
    const root = seeded();

    purgeTelemetryScope(root, "acme");

    const q = readTelemetry(root).find((e) => e.kind === "retrieval.query" && e.corrId === "a");
    expect(q).toBeDefined();
    expect(q!.scopes).toEqual(["personal"]);
    // …while the acme-only query is gone entirely
    expect(readTelemetry(root).find((e) => e.corrId === "b")).toBeUndefined();
  });

  test("redacts the scope from snapshot counts", () => {
    const root = seeded();
    snapshot(root, "2026-09-01", { personal: 120, acme: 36 });

    const report = purgeTelemetryScope(root, "acme");

    const dir = join(storePaths(root).telemetryDir, "snapshots");
    const saved = JSON.parse(readFileSync(join(dir, "stats-2026-09-01.json"), "utf8"));
    expect(saved.stats.countsByScope).toEqual({ personal: 120 });
    expect(report.snapshotsRedacted).toBe(1);
  });

  test("dry run reports exactly what it would do and writes nothing", () => {
    const root = seeded();
    snapshot(root, "2026-09-01", { personal: 120, acme: 36 });
    const before = readFileSync(join(storePaths(root).telemetryDir, "events-2026-09-01.jsonl"), "utf8");

    const report = purgeTelemetryScope(root, "acme", { dryRun: true });

    expect(report.eventsRemoved).toBe(3);
    expect(report.snapshotsRedacted).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(readFileSync(join(storePaths(root).telemetryDir, "events-2026-09-01.jsonl"), "utf8")).toBe(before);
    expect(JSON.stringify(readTelemetry(root))).toContain("acme");
  });

  test("is idempotent — a second run finds nothing left", () => {
    const root = seeded();
    purgeTelemetryScope(root, "acme");

    const second = purgeTelemetryScope(root, "acme");

    expect(second.eventsRemoved).toBe(0);
    expect(second.filesRewritten).toBe(0);
  });

  test("deletes a day file that held nothing but the purged scope", () => {
    const root = seeded();

    purgeTelemetryScope(root, "acme");

    // 2026-09-02 was an acme-only day: leaving an empty file behind would keep
    // a dated trace of when the client was active.
    const files = readdirSync(storePaths(root).telemetryDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).not.toContain("events-2026-09-02.jsonl");
    expect(files).toContain("events-2026-09-01.jsonl");
  });

  test("reports zero on a store with no telemetry at all", () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-purge-empty-"));
    expect(purgeTelemetryScope(root, "acme")).toMatchObject({ eventsRemoved: 0, filesRewritten: 0, snapshotsRedacted: 0 });
  });
});
