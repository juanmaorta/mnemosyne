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
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** Frozen clock: every read returns the same instant. */
export function fixedClock(ms: number): Clock {
  return { now: () => ms, nowIso: () => new Date(ms).toISOString() };
}

/** Test/bench clock: starts at `startMs`, advances `stepMs` per `now()` call. */
export function seqClock(startMs: number, stepMs: number): Clock {
  let t = startMs;
  return {
    now: () => { const v = t; t += stepMs; return v; },
    nowIso: () => new Date(t).toISOString(),
  };
}
