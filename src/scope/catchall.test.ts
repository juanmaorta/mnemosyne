import { describe, expect, test } from "vitest";
import { parseScopeMap, catchAllScope, resolvesViaCatchAll, catchAllIsIntentional } from "./scopemap.js";

const HOME = "/Users/alice";

describe("catchAllScope", () => {
  test("returns the scope of a home-level catch-all", () => {
    const entries = parseScopeMap("~ = personal\n~/Projects/acme = acme", HOME);
    expect(catchAllScope(entries, HOME)).toBe("personal");
  });

  test("returns undefined when the map has no catch-all", () => {
    const entries = parseScopeMap("~/Projects/acme = acme\n~/memory = personal", HOME);
    expect(catchAllScope(entries, HOME)).toBeUndefined();
  });

  test("is undefined for an empty map", () => {
    expect(catchAllScope([], HOME)).toBeUndefined();
  });

  test("detects a catch-all named by the RESOLVED home when home is a symlink", () => {
    // home /Users/alice is a symlink to /real/home, and .scopemap names the
    // resolved path. Both parse and detection must canonicalize to see it.
    const canon = (p: string): string | undefined => (p === HOME ? "/real/home" : undefined);
    const entries = parseScopeMap("/real/home = personal", HOME, canon);
    expect(catchAllScope(entries, HOME, canon)).toBe("personal");
  });
});

describe("resolvesViaCatchAll (MNE-94)", () => {
  const entries = parseScopeMap("~ = personal\n~/Projects/acme = acme", HOME);
  test("true when only the home catch-all matches the cwd", () => {
    expect(resolvesViaCatchAll(entries, "/Users/alice/Projects/misc", HOME)).toBe(true);
  });
  test("false when a more-specific prefix matches (a well-mapped context)", () => {
    expect(resolvesViaCatchAll(entries, "/Users/alice/Projects/acme/repo", HOME)).toBe(false);
  });
  test("false when there is no catch-all at all", () => {
    const noCatch = parseScopeMap("~/Projects/acme = acme", HOME);
    expect(resolvesViaCatchAll(noCatch, "/Users/alice/Projects/misc", HOME)).toBe(false);
  });
  test("false for a cwd outside home even with a home catch-all", () => {
    expect(resolvesViaCatchAll(entries, "/tmp/elsewhere", HOME)).toBe(false);
  });
});

describe("catchAllIsIntentional (MNE-94)", () => {
  test("detects the structured marker regardless of spacing", () => {
    expect(catchAllIsIntentional("#catch-all: intentional\n~ = personal")).toBe(true);
    expect(catchAllIsIntentional("  #  catch-all:  intentional \n~ = personal")).toBe(true);
  });
  test("is false without the marker", () => {
    expect(catchAllIsIntentional("# just a plain comment\n~ = personal")).toBe(false);
    expect(catchAllIsIntentional("~ = personal")).toBe(false);
  });
});
