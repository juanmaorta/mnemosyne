import { mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getMachineId, appendEvent, readEvents, eventKey } from "./events.js";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "mneme-events-"));
  mkdirSync(join(r, "personal"), { recursive: true });
  mkdirSync(join(r, ".index"), { recursive: true });
  return r;
}

describe("getMachineId", () => {
  test("getMachineId_is_stable_across_calls", () => {
    const r = root();
    const a = getMachineId(join(r, ".index"));
    const b = getMachineId(join(r, ".index"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("append + read", () => {
  test("appendEvent_then_readEvents_returns_grouped", () => {
    const r = root();
    appendEvent(r, "personal", "M1", { slug: "yogurtera", ts: "2026-07-06T10:00:00.000Z", kind: "get" });
    appendEvent(r, "personal", "M1", { slug: "yogurtera", ts: "2026-07-06T11:00:00.000Z", kind: "get" });
    const grouped = readEvents(r, ["personal"]);
    expect(grouped.get(eventKey("personal", "yogurtera"))).toHaveLength(2);
  });

  test("readEvents_merges_multiple_machines", () => {
    const r = root();
    appendEvent(r, "personal", "M1", { slug: "s", ts: "2026-07-06T10:00:00.000Z", kind: "get" });
    appendEvent(r, "personal", "M2", { slug: "s", ts: "2026-07-06T12:00:00.000Z", kind: "get" });
    expect(readEvents(r, ["personal"]).get(eventKey("personal", "s"))).toHaveLength(2);
  });

  test("readEvents_tolerates_partial_last_line", () => {
    const r = root();
    appendEvent(r, "personal", "M1", { slug: "s", ts: "2026-07-06T10:00:00.000Z", kind: "get" });
    const dir = join(r, "personal", "events", "M1");
    appendFileSync(join(dir, "2026-07-06.jsonl"), '{"slug":"s","ts":"2026'); // truncated append mid-sync
    expect(readEvents(r, ["personal"]).get(eventKey("personal", "s"))).toHaveLength(1);
  });

  test("readEvents_does_not_merge_same_slug_across_scopes", () => {
    const r = root();
    mkdirSync(join(r, "acme"), { recursive: true });
    appendEvent(r, "personal", "M1", { slug: "s", ts: "2026-07-06T10:00:00.000Z", kind: "get" });
    appendEvent(r, "acme", "M1", { slug: "s", ts: "2026-07-06T10:00:00.000Z", kind: "get" });
    const g = readEvents(r, ["personal", "acme"]);
    expect(g.get(eventKey("personal", "s"))).toHaveLength(1);
    expect(g.get(eventKey("acme", "s"))).toHaveLength(1);
  });
});
