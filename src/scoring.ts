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

export function blendedScore(
  parts: { recency: number; importance: number; relevance: number },
  w: Weights = DEFAULT_WEIGHTS,
): number {
  const total = w.recency + w.importance + w.relevance || 1;
  return (w.recency * parts.recency + w.importance * parts.importance + w.relevance * parts.relevance) / total;
}

export function retention(nowMs: number, lastAccessMs: number, strength: number): number {
  const dt = Math.max(0, nowMs - lastAccessMs);
  return Math.exp(-dt / (strength * DAY_MS));
}

export function reinforce(prev: { strength: number; accessCount: number }): { strength: number; accessCount: number } {
  return { strength: prev.strength + 1, accessCount: prev.accessCount + 1 };
}
