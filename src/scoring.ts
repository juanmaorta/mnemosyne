export interface Weights { recency: number; importance: number; relevance: number }
export const DEFAULT_WEIGHTS: Weights = { recency: 0.25, importance: 0.25, relevance: 1 };
export const DEFAULT_TAU_MS = 14 * 24 * 3600 * 1000;
export const INITIAL_STRENGTH = 1;

/**
 * Recency assigned to an engram with no access history.
 *
 * It must NOT be 1: that is the top of the axis, so "never read" would beat
 * "read yesterday" and reading an engram would push it down the ranking. That
 * was the behaviour until 2026-09-03, measured in the field as accessed
 * engrams reaching the top-k 4-8x less often than untouched ones
 * (docs/diagnostico-retrieval-2026-09-03.md).
 *
 * exp(-1) is the value the decay curve itself yields at one time constant, so
 * the prior reads as "unknown, treated as one half-life old" rather than as an
 * arbitrary constant. An access fresher than tau therefore wins against no
 * information, and an access older than tau loses to it — which is the point:
 * the evidence of a read expires.
 *
 * The exact value is a calibration target for the Fase 3 benchmark, not a
 * settled constant.
 */
export const UNACCESSED_RECENCY_PRIOR = Math.exp(-1);
const DAY_MS = 24 * 3600 * 1000;

export function recencyScore(nowMs: number, lastAccessMs: number, tauMs: number = DEFAULT_TAU_MS): number {
  const dt = Math.max(0, nowMs - lastAccessMs);
  return Math.exp(-dt / tauMs);
}

export function importanceNorm(importance: number): number {
  return (importance - 1) / 9;
}

export function blendedScore(
  parts: { recency: number; importance: number; relevance: number },
  w: Weights = DEFAULT_WEIGHTS,
): number {
  const total = w.recency + w.importance + w.relevance || 1;
  return (w.recency * parts.recency + w.importance * parts.importance + w.relevance * parts.relevance) / total;
}

/**
 * Per-signal breakdown behind a score. Every ranking decision must be
 * re-derivable from this object alone (plus `weights`) — it is what the
 * telemetry event log records and what `--explain` renders.
 */
export interface ScoreSignals {
  /**
   * Age in ms since `last_access`. NOTE this is reported even when the engram
   * was never accessed: hot state seeds `last_access` from `created`, so the
   * timestamp exists and its age is informative. Read it together with
   * `accessed` — on its own, a raw age says nothing about whether the engram
   * actually earned recency.
   */
  recencyRaw: number;
  /** exp(-dt/tau) in [0,1], or UNACCESSED_RECENCY_PRIOR when `accessed` is false. */
  recencyNorm: number;
  importanceRaw: number;
  importanceNorm: number;
  relevanceCosine: number;
  /**
   * Whether the engram has real access events. False means `recencyNorm` was
   * neutralized rather than earned — without this flag a never-accessed note
   * is indistinguishable from one accessed this instant.
   */
  accessed: boolean;
}

export function scoreBreakdown(
  input: { nowMs: number; lastAccessMs: number | null; accessCount: number; importance: number; relevanceCosine: number },
  w: Weights = DEFAULT_WEIGHTS,
): { score: number; signals: ScoreSignals } {
  const accessed = input.accessCount > 0 && input.lastAccessMs !== null;
  const recencyRaw = input.lastAccessMs !== null ? Math.max(0, input.nowMs - input.lastAccessMs) : 0;
  // No access history means no evidence, which is not the same as fresh
  // evidence: unaccessed engrams get a mid-curve prior, never the top of the
  // axis. Their last_access is seeded from `created`, so decaying it directly
  // would instead rank a stale-but-relevant note below a freshly-created
  // irrelevant one — the prior avoids both failure modes.
  const recencyNorm = accessed ? recencyScore(input.nowMs, input.lastAccessMs!) : UNACCESSED_RECENCY_PRIOR;
  const importanceNormV = importanceNorm(input.importance);
  const relevanceCosine = Math.max(0, Math.min(1, input.relevanceCosine));
  const score = blendedScore(
    { recency: recencyNorm, importance: importanceNormV, relevance: relevanceCosine },
    w,
  );
  return {
    score,
    signals: { recencyRaw, recencyNorm, importanceRaw: input.importance, importanceNorm: importanceNormV, relevanceCosine, accessed },
  };
}

export function retention(nowMs: number, lastAccessMs: number, strength: number): number {
  const dt = Math.max(0, nowMs - lastAccessMs);
  return Math.exp(-dt / (strength * DAY_MS));
}

export function reinforce(prev: { strength: number; accessCount: number }): { strength: number; accessCount: number } {
  return { strength: prev.strength + 1, accessCount: prev.accessCount + 1 };
}
