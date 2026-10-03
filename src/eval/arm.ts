import { search, type SearchDeps, type SearchOptions, type SearchHit } from "../retrieval/search.js";
import type { Weights } from "../scoring.js";

/**
 * The three arms of the MNE-78 validation (personal scope):
 * - `P`: the pre-MNE-77 blended default (recency + importance + relevance).
 * - `S`: the current default — cosine relevance with the floor.
 * - `E`: `S`, plus one floorless second pass the agent may explore when the
 *   primary result is insufficient after reading it.
 */
export type Arm = "P" | "S" | "E";

/** The blended weights that were the production default before MNE-77. */
const BLENDED_WEIGHTS: Weights = { recency: 0.25, importance: 0.25, relevance: 1 };

/** How many floorless candidates E's exploratory pass returns. */
const E_FALLBACK_K = 3;

export interface ArmResult {
  /** What the agent sees first: the arm's primary search, with the floor applied. */
  primary: SearchHit[];
  /**
   * `E` only — floorless candidates offered for exploration when `primary` was
   * not enough, with anything already in `primary` removed. Empty for P and S.
   */
  fallback: SearchHit[];
}

export async function rankForArm(deps: SearchDeps, opts: SearchOptions, arm: Arm): Promise<ArmResult> {
  if (arm === "P") {
    return { primary: await search(deps, { ...opts, weights: BLENDED_WEIGHTS }), fallback: [] };
  }
  // S and E share the same primary: the cosine default with the floor in place.
  const primary = await search(deps, opts);
  if (arm === "S") return { primary, fallback: [] };
  const floorless = await search(deps, { ...opts, minCos: -1, k: E_FALLBACK_K });
  const fallback = floorless.filter((f) => !primary.some((p) => p.slug === f.slug && p.scope === f.scope));
  return { primary, fallback };
}
