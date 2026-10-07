import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { emitEvents } from "../telemetry/events.js";
import { traceEngram, formatTrace } from "./trace.js";
import { fixedClock } from "../clock.js";

function storeWithDreamRun(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-tracedream-"));
  emitEvents(root, fixedClock(Date.parse("2026-10-05T03:00:00.000Z")), [
    { kind: "dream.run", runId: "r1", scope: "personal", model: "fake-model", proposals: 1 },
    { kind: "dream.proposal", runId: "r1", scope: "personal", slug: "dream-abc123", sources: ["riego-notas"], isDuplicate: false },
  ]);
  return root;
}

describe("trace of dreaming events", () => {
  test("a_derived_notes_trace_shows_the_proposal_that_created_it", () => {
    const root = storeWithDreamRun();

    const entries = traceEngram(root, "dream-abc123");

    expect(entries.some((e) => e.kind === "dream.proposal")).toBe(true);
    const text = formatTrace(entries, "dream-abc123");
    expect(text).toContain("dream.proposal");
    expect(text).toContain("riego-notas"); // the detail names its sources
  });

  test("a_source_notes_trace_shows_the_dreaming_run_that_derived_from_it", () => {
    const root = storeWithDreamRun();

    const entries = traceEngram(root, "riego-notas");

    // The source itself was named in the proposal's `sources`, so its lifeline
    // must surface that it fed a dreaming derivative.
    expect(entries.some((e) => e.kind === "dream.proposal")).toBe(true);
    expect(formatTrace(entries, "riego-notas")).toContain("dream-abc123");
  });
});
