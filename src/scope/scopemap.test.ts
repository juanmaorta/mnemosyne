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

describe("parseScopeMap canonical prefixes", () => {
  // `process.cwd()` hands back a path with symlinks already resolved, but a
  // .scopemap is written by a human naming a path they can `cd` into. On macOS
  // /tmp is a symlink to /private/tmp, so a map naming /tmp/x could never match
  // the cwd it plainly names — it fell through to the fallback in silence.
  test("parseScopeMap_records_the_canonical_prefix_when_it_differs", () => {
    const canonicalize = (path: string) => path.replace("/tmp", "/private/tmp");

    expect(parseScopeMap("/tmp/client = acme", HOME, canonicalize)).toEqual([
      { prefix: "/tmp/client", canonical: "/private/tmp/client", scope: "acme" },
    ]);
  });

  test("parseScopeMap_omits_the_canonical_prefix_when_it_is_the_same_path", () => {
    // Storing an identical second copy would only invite a reader to wonder
    // which one wins.
    expect(parseScopeMap("/abs/x = personal", HOME, (path) => path)).toEqual([
      { prefix: "/abs/x", scope: "personal" },
    ]);
  });

  test("parseScopeMap_keeps_a_prefix_that_cannot_be_canonicalized", () => {
    // A map may legitimately name a directory that is not there yet: a repo not
    // cloned, a volume not mounted. That must stay a literal prefix, not vanish.
    expect(parseScopeMap("/not/yet = personal", HOME, () => undefined)).toEqual([
      { prefix: "/not/yet", scope: "personal" },
    ]);
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

  test("resolveScope_matches_a_prefix_written_through_a_symlink", () => {
    const entries = [{ prefix: "/tmp/client", canonical: "/private/tmp/client", scope: "acme" }];

    expect(resolveScope(entries, "/private/tmp/client/repo")).toBe("acme");
  });

  test("resolveScope_prefers_the_longest_MATCHING_form_not_the_longest_written_prefix", () => {
    const entries = [
      { prefix: "/private/tmp", scope: "personal" },        // written length 12
      { prefix: "/tmp/client", canonical: "/private/tmp/client", scope: "acme" }, // written 11, matching 19
    ];

    // Ranking by the written prefix would hand a client's directory to
    // `personal` — the more specific entry must win on the form that matched.
    expect(resolveScope(entries, "/private/tmp/client/repo")).toBe("acme");
  });

  test("resolveScopeStrict_matches_a_canonical_prefix_too", () => {
    const entries = [{ prefix: "/tmp/client", canonical: "/private/tmp/client", scope: "acme" }];

    // The write path is fail-closed, so a missed match here is not a silent
    // fallback but a refusal — the symlink bug made writes impossible, not wrong.
    expect(resolveScopeStrict(entries, "/private/tmp/client")).toBe("acme");
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
