/**
 * Injectable clock. Every time-dependent decision in production code (recency,
 * decay, `created` stamps, telemetry timestamps) reads the clock through this
 * seam so benchmarks can freeze or script time and stay reproducible.
 *
 * Production wires `systemClock`; tests and the bench harness wire the fakes.
 */
export interface Clock {
  now(): number;
  nowIso(): string;
  /**
   * Monotonic reading for measuring elapsed time, in ms. Separate from `now()`
   * because wall-clock time can jump (NTP, DST) and because a frozen clock must
   * still yield a sane duration: the fakes report 0 elapsed, keeping recorded
   * durations deterministic in tests and benchmarks.
   */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

/** Frozen clock: every read returns the same instant, every duration is 0. */
export function fixedClock(ms: number): Clock {
  return { now: () => ms, nowIso: () => new Date(ms).toISOString(), monotonicMs: () => 0 };
}

/** Test/bench clock: starts at `startMs`, advances `stepMs` per `now()` call. */
export function seqClock(startMs: number, stepMs: number): Clock {
  let t = startMs;
  return {
    now: () => { const v = t; t += stepMs; return v; },
    nowIso: () => new Date(t).toISOString(),
    // Tracks the scripted timeline so a measured duration equals the steps taken.
    monotonicMs: () => t - startMs,
  };
}
