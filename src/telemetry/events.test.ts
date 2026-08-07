import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEvent, emitEvents, readTelemetry } from "./events.js";
import { newCorrId } from "./corr.js";
import { fixedClock, type Clock } from "../clock.js";
import { storePaths } from "../store.js";

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "mneme-tel-"));
}

describe("telemetry event log", () => {
  it("emits and reads back an event stamped with ts and algoVersion", () => {
    const root = tmpRoot();
    emitEvent(root, fixedClock(T0), { kind: "retrieval.query", corrId: "c1", query: "hola", k: 5 });

    const evs = readTelemetry(root);

    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe("retrieval.query");
    expect(evs[0]!.corrId).toBe("c1");
    expect(evs[0]!.algoVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(evs[0]!.ts).toBe(new Date(T0).toISOString());
    expect(evs[0]!.query).toBe("hola"); // kind-specific payload survives
  });

  it("never throws when the telemetry dir cannot be written", () => {
    // Telemetry is best-effort: it must never break the command emitting it.
    expect(() => emitEvent("/proc/nonexistent/xyz", fixedClock(0), { kind: "engram.created" })).not.toThrow();
    expect(() => emitEvents("/proc/nonexistent/xyz", fixedClock(0), [{ kind: "engram.created" }])).not.toThrow();
  });

  it("writes a batch as one atomic append sharing a single timestamp", () => {
    // A single retrieval emits ~one event per candidate. Stamping and appending
    // them one by one would mean N clock reads and N syscalls on the hot path,
    // and would let events from the same query drift apart in time.
    const root = tmpRoot();
    let isoReads = 0;
    const counting: Clock = {
      now: () => T0,
      nowIso: () => { isoReads++; return new Date(T0).toISOString(); },
    };

    emitEvents(root, counting, [
      { kind: "retrieval.candidate", corrId: "c1", slug: "a" },
      { kind: "retrieval.candidate", corrId: "c1", slug: "b" },
      { kind: "retrieval.candidate", corrId: "c1", slug: "c" },
    ]);

    expect(isoReads).toBe(1);
    const evs = readTelemetry(root);
    expect(evs).toHaveLength(3);
    expect(evs.map((e) => e.slug)).toEqual(["a", "b", "c"]);
    expect(new Set(evs.map((e) => e.ts)).size).toBe(1);
  });

  it("emitting an empty batch writes nothing", () => {
    const root = tmpRoot();
    emitEvents(root, fixedClock(T0), []);
    expect(readTelemetry(root)).toEqual([]);
  });

  it("reads an empty log as an empty list", () => {
    expect(readTelemetry(tmpRoot())).toEqual([]);
  });

  it("filters by since/until without reading out-of-range day files", () => {
    const root = tmpRoot();
    const DAY = 24 * 3600 * 1000;
    emitEvent(root, fixedClock(T0), { kind: "engram.created", slug: "day0" });
    emitEvent(root, fixedClock(T0 + DAY), { kind: "engram.created", slug: "day1" });
    emitEvent(root, fixedClock(T0 + 2 * DAY), { kind: "engram.created", slug: "day2" });

    // A valid event in a far-off day file: it shows up in a full read and must
    // disappear under a range, proving the day-file filter actually excludes.
    writeFileSync(join(storePaths(root).telemetryDir, "events-2019-01-01.jsonl"),
      `${JSON.stringify({ ts: "2019-01-01T00:00:00.000Z", kind: "engram.created", algoVersion: "1.0.0", slug: "ancient" })}\n`);

    const all = readTelemetry(root);
    expect(all.map((e) => e.slug)).toEqual(["ancient", "day0", "day1", "day2"]);

    const since = readTelemetry(root, { since: new Date(T0 + DAY).toISOString() });
    expect(since.map((e) => e.slug)).toEqual(["day1", "day2"]);

    // `until` alone is open-ended below, so the ancient event is in range.
    const until = readTelemetry(root, { until: new Date(T0 + DAY).toISOString() });
    expect(until.map((e) => e.slug)).toEqual(["ancient", "day0", "day1"]);

    const window = readTelemetry(root, {
      since: new Date(T0 + DAY).toISOString(),
      until: new Date(T0 + DAY).toISOString(),
    });
    expect(window.map((e) => e.slug)).toEqual(["day1"]);
  });

  it("skips torn lines instead of failing the whole read", () => {
    const root = tmpRoot();
    emitEvent(root, fixedClock(T0), { kind: "engram.created", slug: "good" });
    const dir = storePaths(root).telemetryDir;
    mkdirSync(dir, { recursive: true });
    // Simulates a process killed mid-append.
    writeFileSync(join(dir, `events-${new Date(T0).toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify({ ts: new Date(T0).toISOString(), kind: "engram.created", algoVersion: "1.0.0", slug: "good" })}\n{"ts":"2023-11-14T22:1\n`);

    const evs = readTelemetry(root);

    expect(evs).toHaveLength(1);
    expect(evs[0]!.slug).toBe("good");
  });

  it("returns events sorted by ts across day files", () => {
    const root = tmpRoot();
    const DAY = 24 * 3600 * 1000;
    emitEvent(root, fixedClock(T0 + 2 * DAY), { kind: "engram.created", slug: "later" });
    emitEvent(root, fixedClock(T0), { kind: "engram.created", slug: "earlier" });

    expect(readTelemetry(root).map((e) => e.slug)).toEqual(["earlier", "later"]);
  });
});

describe("newCorrId", () => {
  it("is seeded from the clock, so ids from one instant share a prefix", () => {
    const a = newCorrId(fixedClock(T0));
    const b = newCorrId(fixedClock(T0));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // ULID timestamp prefix
    expect(a).not.toBe(b);                        // random suffix still differs
  });

  it("orders ids chronologically by clock", () => {
    const early = newCorrId(fixedClock(T0));
    const late = newCorrId(fixedClock(T0 + 60_000));
    expect(early < late).toBe(true);
  });
});
