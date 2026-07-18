import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendEvalLog, readEvalLog } from "./log.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "mneme-eval-"));
}

describe("eval log", () => {
  test("appendEvalLog_then_readEvalLog_round_trips", () => {
    const r = root();
    appendEvalLog(r, { ts: "2026-07-07T10:00:00.000Z", cmd: "context", scope: "personal", slugs: ["a", "b"] });
    appendEvalLog(r, { ts: "2026-07-07T10:01:00.000Z", cmd: "search", scope: "acme", slugs: ["c"] });
    const recs = readEvalLog(r);
    expect(recs).toHaveLength(2);
    expect(recs[1]).toMatchObject({ cmd: "search", scope: "acme", slugs: ["c"] });
  });

  test("readEvalLog_returns_empty_when_absent", () => {
    expect(readEvalLog(root())).toEqual([]);
  });

  test("appendEvalLog_never_throws_on_bad_root", () => {
    expect(() => appendEvalLog("/no/such/\0/path", { ts: "t", cmd: "context", scope: "personal", slugs: [] })).not.toThrow();
  });
});
