import { describe, expect, test } from "vitest";
import { parseScopeMap, catchAllScope } from "./scopemap.js";

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
