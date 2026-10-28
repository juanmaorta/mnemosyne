import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { traceEngram, formatTrace } from "./trace.js";
import { emitEvents } from "../telemetry/events.js";
import { fixedClock } from "../clock.js";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-08-01T10:00:00.000Z");

function seededLog() {
  const root = mkdtempSync(join(tmpdir(), "mneme-trace-"));
  emitEvents(root, fixedClock(T0), [
    { kind: "engram.created", scope: "personal", type: "project", importance: 7, origin: "agent", scannerVerdict: "clean" },
  ]);
  // engram.created carries no slug (the write path knows scope+hash, and the
  // slug is only settled once indexed), so the trace starts at indexing.
  emitEvents(root, fixedClock(T0 + 60_000), [
    { kind: "engram.indexed", scope: "personal", slug: "fermentor", embeddingId: "fake-bow/dim768", dim: 768, reason: "new" },
  ]);
  emitEvents(root, fixedClock(T0 + DAY), [
    { kind: "retrieval.candidate", corrId: "c1", slug: "fermentor", scope: "personal", rank: 0, included: true, threshold: 0.5, signals: { relevanceCosine: 0.81, recencyNorm: 1, importanceNorm: 0.67, accessed: false } },
    { kind: "retrieval.candidate", corrId: "c1", slug: "router", scope: "personal", rank: 1, included: false, threshold: 0.5, signals: { relevanceCosine: 0.2, recencyNorm: 1, importanceNorm: 0.44, accessed: false } },
  ]);
  emitEvents(root, fixedClock(T0 + 2 * DAY), [
    { kind: "retrieval.injected", corrId: "c2", scope: "personal", budget: 1000, injectedSlugs: ["fermentor", "router"], droppedForBudget: 3 },
  ]);
  emitEvents(root, fixedClock(T0 + 3 * DAY), [
    { kind: "access.reinforced", scope: "personal", slug: "fermentor", strengthBefore: 1, strengthAfter: 2, accessCountAfter: 1 },
  ]);
  return root;
}

describe("traceEngram", () => {
  test("returns only this engram's milestones, in time order", () => {
    const entries = traceEngram(seededLog(), "fermentor");

    expect(entries.map((e) => e.kind)).toEqual([
      "engram.indexed", "retrieval.candidate", "retrieval.injected", "access.reinforced",
    ]);
    expect(entries.map((e) => e.ts)).toEqual([...entries.map((e) => e.ts)].sort());
  });

  test("excludes events belonging to other engrams", () => {
    const entries = traceEngram(seededLog(), "fermentor");
    expect(JSON.stringify(entries)).not.toContain("router");
  });

  test("finds the engram inside an injection's slug list", () => {
    // retrieval.injected names slugs in an array, not a `slug` field — a naive
    // filter would silently drop the moment the agent actually saw the note.
    const entries = traceEngram(seededLog(), "fermentor");
    expect(entries.find((e) => e.kind === "retrieval.injected")).toBeDefined();
  });

  test("returns nothing for an unknown slug", () => {
    expect(traceEngram(seededLog(), "does-not-exist")).toEqual([]);
  });
});

describe("formatTrace", () => {
  test("renders one line per milestone with the value at that moment", () => {
    const out = formatTrace(traceEngram(seededLog(), "fermentor"), "fermentor");

    expect(out).toContain("fermentor");
    expect(out).toContain("indexed");
    expect(out).toContain("0.810");   // the cosine it scored back then
    expect(out).toContain("1 → 2");   // strength evolution
    expect(out.split("\n").filter((l) => l.includes("2026-08-")).length).toBe(4);
  });

  test("says so plainly when there is no history", () => {
    expect(formatTrace([], "ghost")).toContain("no recorded history");
  });
});
