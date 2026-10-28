import { describe, expect, test } from "vitest";
import { factFilename, isFactFilename, newFactId, storePaths } from "./store.js";

describe("storePaths", () => {
  const paths = storePaths("/home/u/memory");

  test("scope data lives in a folder per scope", () => {
    expect(paths.scopeDir("personal")).toBe("/home/u/memory/personal");
    expect(paths.scopeDir("work")).toBe("/home/u/memory/work");
  });

  test("facts are append-only under the scope's facts/ folder", () => {
    expect(paths.factsDir("personal")).toBe("/home/u/memory/personal/facts");
  });

  test("archive, index and INDEX.md are root-level derived locations", () => {
    expect(paths.archiveDir).toBe("/home/u/memory/archive");
    expect(paths.indexDir).toBe("/home/u/memory/.index");
    expect(paths.indexDb).toBe("/home/u/memory/.index/store.db");
    expect(paths.indexMd).toBe("/home/u/memory/INDEX.md");
  });

  test("telemetry lives in a durable dir, separate from the disposable index", () => {
    // .index/ is rebuilt by `reindex`; .telemetry/ must survive that, so they
    // can never be the same directory.
    expect(paths.telemetryDir).toBe("/home/u/memory/.telemetry");
    expect(paths.telemetryDir).not.toBe(paths.indexDir);
  });

  test("owner policy file is a root-level machine-local location", () => {
    expect(paths.ownerPolicy).toBe("/home/u/memory/.owner");
  });

  test("rejects a scope that would escape the store root", () => {
    expect(() => paths.scopeDir("../etc")).toThrow();
    expect(() => paths.factsDir("a/b")).toThrow();
  });
});

describe("fact naming (ULID)", () => {
  test("newFactId returns a 26-char Crockford base32 ULID", () => {
    expect(newFactId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("two ids never collide", () => {
    expect(newFactId()).not.toBe(newFactId());
  });

  test("a seeded id encodes the seed time so facts sort chronologically", () => {
    const earlier = newFactId(Date.parse("2020-01-01T00:00:00Z"));
    const later = newFactId(Date.parse("2026-01-01T00:00:00Z"));
    expect(earlier < later).toBe(true);
  });

  test("factFilename appends .md to the id", () => {
    expect(factFilename("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV.md");
  });

  test("isFactFilename recognizes only ULID-named markdown files", () => {
    expect(isFactFilename("01ARZ3NDEKTSV4RRFFQ69G5FAV.md")).toBe(true);
    expect(isFactFilename("some-note.md")).toBe(false);
    expect(isFactFilename("01ARZ3NDEKTSV4RRFFQ69G5FAV.txt")).toBe(false);
  });
});
