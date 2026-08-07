import { describe, it, expect } from "vitest";
import { fixedClock, seqClock, systemClock } from "./clock.js";

describe("fixedClock", () => {
  it("returns the same instant on every call", () => {
    const c = fixedClock(1_700_000_000_000);
    expect(c.now()).toBe(1_700_000_000_000);
    expect(c.now()).toBe(1_700_000_000_000);
    expect(c.nowIso()).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("monotonicMs", () => {
  it("is 0 on a frozen clock, so recorded durations stay deterministic", () => {
    const c = fixedClock(1_700_000_000_000);
    expect(c.monotonicMs()).toBe(0);
    expect(c.monotonicMs()).toBe(0);
  });

  it("tracks the scripted timeline on a sequential clock", () => {
    const c = seqClock(1000, 500);
    expect(c.monotonicMs()).toBe(0);
    c.now(); c.now();
    expect(c.monotonicMs()).toBe(1000); // two 500ms steps elapsed
  });

  it("advances on the system clock", async () => {
    const t0 = systemClock.monotonicMs();
    await new Promise((r) => setTimeout(r, 5));
    expect(systemClock.monotonicMs()).toBeGreaterThan(t0);
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
