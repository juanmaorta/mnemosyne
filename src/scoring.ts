export interface Weights { recency: number; importance: number; relevance: number }
export const DEFAULT_WEIGHTS: Weights = { recency: 0.25, importance: 0.25, relevance: 1 };
export const DEFAULT_TAU_MS = 14 * 24 * 3600 * 1000;
export const INITIAL_STRENGTH = 1;

const DAY_MS = 24 * 3600 * 1000;

export function recencyScore(nowMs: number, lastAccessMs: number, tauMs: number = DEFAULT_TAU_MS): number {
  const dt = Math.max(0, nowMs - lastAccessMs);
  return Math.exp(-dt / tauMs);
}

export function importanceNorm(importance: number): number {
  return (importance - 1) / 9;
}

export interface BlendSignals { recency: number; importance: number; relevance: number }

/** Scale each axis within the same candidate set before applying weights.
 * A constant axis carries no ranking information and maps to the midpoint.
 * The raw cosine and decay are retained separately for explain and telemetry.
 */
export function normalizeCandidateSignals<T extends BlendSignals>(candidates: readonly T[]): BlendSignals[] {
  const axes: (keyof BlendSignals)[] = ["recency", "importance", "relevance"];
  const bounds = axes.map((axis) => candidates.reduce(
    (range, candidate) => ({
      min: Math.min(range.min, candidate[axis]),
      max: Math.max(range.max, candidate[axis]),
    }),
    { min: Infinity, max: -Infinity },
  ));
  return candidates.map((candidate) => {
    const scaled = axes.map((axis, i) => {
      const { min, max } = bounds[i]!;
      return max === min ? 0.5 : (candidate[axis] - min) / (max - min);
    });
    return { recency: scaled[0]!, importance: scaled[1]!, relevance: scaled[2]! };
  });
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
  /** exp(-dt/tau) in [0,1], from last access or creation for never-read notes. */
  recencyNorm: number;
  importanceRaw: number;
  importanceNorm: number;
  relevanceCosine: number;
  /** Candidate-relative values used by search. Absent for standalone scoring. */
  normalized?: BlendSignals;
  /**
   * Whether the engram has real access events. False means recency is measured
   * from creation rather than from a read.
   */
  accessed: boolean;
}

export function scoreBreakdown(
  input: { nowMs: number; lastAccessMs: number | null; accessCount: number; importance: number; relevanceCosine: number },
  w: Weights = DEFAULT_WEIGHTS,
): { score: number; signals: ScoreSignals } {
  const accessed = input.accessCount > 0 && input.lastAccessMs !== null;
  const recencyRaw = input.lastAccessMs !== null ? Math.max(0, input.nowMs - input.lastAccessMs) : 0;
  // Hot state seeds last_access from created when there are no read events.
  // This makes the age of an unread note a measured value rather than a fixed
  // prior shared by every unread note. Candidate-relative scaling in search
  // keeps that age from overwhelming a narrower cosine range.
  const recencyNorm = input.lastAccessMs === null ? 0 : recencyScore(input.nowMs, input.lastAccessMs);
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
