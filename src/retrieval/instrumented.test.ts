import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { searchInstrumented } from "./instrumented.js";
import { readTelemetry } from "../telemetry/events.js";
import { clearTelemetryConfigCache } from "../telemetry/config.js";
import { fixedClock } from "../clock.js";

const CLOCK = fixedClock(Date.parse("2026-08-07T10:00:00.000Z"));

function note(root: string, scope: string, slug: string, body: string) {
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug}`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
}

async function indexed() {
  const root = mkdtempSync(join(tmpdir(), "mneme-instr-"));
  note(root, "personal", "yogurtera", "yogurt maker control fermentation");
  note(root, "personal", "router", "omada router network wifi");
  note(root, "personal", "camara", "panoramic camera film lens");
  const db = openDb(":memory:");
  await reindex({ root, db, embedder: createFakeEmbedder(), clock: CLOCK });
  return { db, root, embedder: createFakeEmbedder() };
}

beforeEach(() => clearTelemetryConfigCache());

describe("searchInstrumented", () => {
  test("emits one query event and one row per candidate, all sharing the corrId", async () => {
    const { db, root, embedder } = await indexed();

    const hits = await searchInstrumented({ db, root, embedder, clock: CLOCK }, { query: "yogurt maker control", k: 2 }, "c1");

    expect(hits).toHaveLength(2); // returns only the included ones
    const evs = readTelemetry(root).filter((e) => e.corrId === "c1");
    const queries = evs.filter((e) => e.kind === "retrieval.query");
    const candidates = evs.filter((e) => e.kind === "retrieval.candidate");

    expect(queries).toHaveLength(1);
    expect(candidates).toHaveLength(3); // every candidate, not just the top-k
    expect(queries[0]).toMatchObject({ k: 2, candidateSetSize: 3, scopes: ["personal"], resultCount: 2 });
    // Duration comes off the monotonic seam — 0 under a frozen clock, which is
    // what keeps recorded latencies deterministic in tests and benchmarks.
    expect(queries[0]!.durationMs).toBe(0);
    expect(candidates.filter((c) => c.included)).toHaveLength(2);
  });

  test("records a query hash, never the query text", async () => {
    const { db, root, embedder } = await indexed();

    await searchInstrumented({ db, root, embedder, clock: CLOCK }, { query: "confidential client search terms" }, "c1");

    const dump = JSON.stringify(readTelemetry(root));
    expect(dump).not.toContain("confidential");
    const q = readTelemetry(root).find((e) => e.kind === "retrieval.query")!;
    expect(q.queryHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("records_the_cosine_floor_and_empty_result_decision", async () => {
    const { db, root, embedder } = await indexed();
    const hits = await searchInstrumented({ db, root, embedder, clock: CLOCK },
      { query: "yogurt maker control", minCos: 1 }, "floor");
    expect(hits).toHaveLength(0);
    const events = readTelemetry(root).filter((e) => e.corrId === "floor");
    expect(events.find((e) => e.kind === "retrieval.query")).toMatchObject({ minCos: 1, resultCount: 0 });
    expect(events.filter((e) => e.kind === "retrieval.candidate")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "retrieval.candidate").every((e) => e.included === false)).toBe(true);
  });

  test("satisfies the reconstruction invariant: score is re-derivable from the log alone", async () => {
    const { db, root, embedder } = await indexed();

    const hits = await searchInstrumented({ db, root, embedder, clock: CLOCK }, { query: "yogurt maker control", k: 1 }, "c1");

    // Join query→candidates by corrId and recompute, using nothing but the log.
    const evs = readTelemetry(root).filter((e) => e.corrId === "c1");
    const q = evs.find((e) => e.kind === "retrieval.query")!;
    const top = evs.find((e) => e.kind === "retrieval.candidate" && e.rank === 0)!;
    const w = q.weights as { recency: number; importance: number; relevance: number };
    const s = top.signals as { normalized: { recency: number; importance: number; relevance: number } };

    const recomputed = (w.recency * s.normalized.recency + w.importance * s.normalized.importance + w.relevance * s.normalized.relevance)
      / (w.recency + w.importance + w.relevance);

    expect(recomputed).toBeCloseTo(hits[0]!.score, 10);
    expect(top.slug).toBe(hits[0]!.slug);
    expect(top.threshold).toBeCloseTo(hits[0]!.score, 10);
  });

  test("returns results normally when telemetry is disabled", async () => {
    const { db, root, embedder } = await indexed();
    const before = readTelemetry(root).length; // indexing already logged some
    writeFileSync(join(root, ".telemetry.json"), JSON.stringify({ enabled: false }));
    clearTelemetryConfigCache();

    const hits = await searchInstrumented({ db, root, embedder, clock: CLOCK }, { query: "yogurt maker control", k: 2 }, "c1");

    expect(hits).toHaveLength(2); // search still works, only recording stops
    expect(readTelemetry(root)).toHaveLength(before);
    expect(readTelemetry(root).filter((e) => e.corrId === "c1")).toEqual([]);
  });
});
