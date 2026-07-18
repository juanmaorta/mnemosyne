// src/scope/scopemap.test.ts
import { describe, expect, test } from "vitest";
import { parseScopeMap, resolveScope, resolveScopeStrict } from "./scopemap.js";

const HOME = "/Users/j";

describe("parseScopeMap", () => {
  test("parseScopeMap_expands_tilde_and_skips_comments_and_blanks", () => {
    const text = ["# a comment", "", "~/Projects/acme = acme", "/abs/personal = personal"].join("\n");
    expect(parseScopeMap(text, HOME)).toEqual([
      { prefix: "/Users/j/Projects/acme", scope: "acme" },
      { prefix: "/abs/personal", scope: "personal" },
    ]);
  });

  test("parseScopeMap_skips_malformed_lines", () => {
    const text = ["garbage no equals", "~/ok = work", "~/bad = Not_Kebab"].join("\n");
    expect(parseScopeMap(text, HOME)).toEqual([{ prefix: "/Users/j/ok", scope: "work" }]);
  });
});

describe("resolveScope", () => {
  const entries = [
    { prefix: "/Users/j/Projects", scope: "personal" },
    { prefix: "/Users/j/Projects/acme", scope: "acme" },
  ];
  test("resolveScope_picks_longest_prefix", () => {
    expect(resolveScope(entries, "/Users/j/Projects/acme/repo")).toBe("acme");
  });
  test("resolveScope_matches_general_prefix_when_specific_absent", () => {
    expect(resolveScope(entries, "/Users/j/Projects/misc")).toBe("personal");
  });
  test("resolveScope_falls_back_to_personal_when_no_match", () => {
    expect(resolveScope(entries, "/tmp/elsewhere")).toBe("personal");
  });
  test("resolveScope_does_not_match_on_partial_path_segment", () => {
    expect(resolveScope([{ prefix: "/a/foo", scope: "x" }], "/a/foobar")).toBe("personal");
  });
});

describe("resolveScopeStrict (write-side, fail-closed)", () => {
  const entries = [
    { prefix: "/Users/j/Projects", scope: "personal" },
    { prefix: "/Users/j/Projects/acme", scope: "acme" },
  ];
  test("resolveScopeStrict_picks_longest_prefix", () => {
    expect(resolveScopeStrict(entries, "/Users/j/Projects/acme/repo")).toBe("acme");
  });
  test("resolveScopeStrict_matches_general_prefix_when_specific_absent", () => {
    expect(resolveScopeStrict(entries, "/Users/j/Projects/misc")).toBe("personal");
  });
  test("resolveScopeStrict_returns_null_when_unmapped", () => {
    expect(resolveScopeStrict(entries, "/tmp/elsewhere")).toBeNull();
  });
  test("resolveScopeStrict_does_not_match_on_partial_path_segment", () => {
    expect(resolveScopeStrict([{ prefix: "/a/foo", scope: "x" }], "/a/foobar")).toBeNull();
  });
});
