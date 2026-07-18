import { describe, expect, test } from "vitest";
import { needsReindex } from "./fileState.js";

describe("needsReindex", () => {
  const prev = { path: "a.md", mtime: 100, size: 10, hash: "h" };

  test("needsReindex_true_when_no_prior_state", () => {
    expect(needsReindex(undefined, { mtime: 1, size: 1 })).toBe(true);
  });
  test("needsReindex_false_when_mtime_and_size_match", () => {
    expect(needsReindex(prev, { mtime: 100, size: 10 })).toBe(false);
  });
  test("needsReindex_true_when_mtime_differs", () => {
    expect(needsReindex(prev, { mtime: 99, size: 10 })).toBe(true); // Syncthing can deliver an EARLIER mtime
  });
  test("needsReindex_true_when_size_differs", () => {
    expect(needsReindex(prev, { mtime: 100, size: 11 })).toBe(true);
  });
});
