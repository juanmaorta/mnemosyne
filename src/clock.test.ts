import { describe, it, expect } from "vitest";
import { fixedClock, seqClock } from "./clock.js";

describe("fixedClock", () => {
  it("returns the same instant on every call", () => {
    const c = fixedClock(1_700_000_000_000);
    expect(c.now()).toBe(1_700_000_000_000);
    expect(c.now()).toBe(1_700_000_000_000);
    expect(c.nowIso()).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("seqClock", () => {
  it("advances by step on each now()", () => {
    const c = seqClock(1000, 500);
    expect(c.now()).toBe(1000);
    expect(c.now()).toBe(1500);
    expect(c.now()).toBe(2000);
  });
});
