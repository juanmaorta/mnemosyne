import { createHash } from "node:crypto";
import { searchExplain, type SearchDeps, type SearchOptions, type SearchHit, type ExplainResult } from "./search.js";
import { emitEvents, type TelemetryInput } from "../telemetry/events.js";

/**
 * Queries are hashed, never stored. A query is user text that can name people,
 * clients or secrets, and a diagnostic log is not the place for it. The hash
 * still supports what observability needs: spotting repeated queries and
 * correlating them across sessions.
 */
function queryHash(q: string): string {
  return createHash("sha256").update(q).digest("hex").slice(0, 16);
}

/**
 * `search` plus the telemetry that makes a ranking decision reconstructable:
 * one `retrieval.query` and one `retrieval.candidate` per candidate considered
 * — discarded ones included, since "why did X lose to Y" is unanswerable
 * without them.
 *
 * The score is deliberately NOT stored: it is re-derivable from `signals` and
 * the `weights` on the correlated query event, and a stored copy could drift
 * from the formula that produced it.
 */
export async function searchExplainInstrumented(
  deps: SearchDeps,
  opts: SearchOptions,
  corrId: string,
): Promise<ExplainResult> {
  // Measured on the monotonic seam, not the wall clock: this is the number
  // `mneme stats` turns into p50/p95, and it must not move when NTP does.
  const startedAt = deps.clock.monotonicMs();
  const res = await searchExplain(deps, opts);
  const durationMs = deps.clock.monotonicMs() - startedAt;

  // Query and candidates go out as ONE append sharing a single timestamp: they
  // are one logical event, and this runs on the retrieval hot path.
  const events: TelemetryInput[] = [
    {
      kind: "retrieval.query",
      corrId,
      queryHash: queryHash(opts.query),
      scopes: res.scopes,
      k: res.k,
      weights: res.weights,
      minCos: res.minCos,
      // Record the ranking mode: under "rrf" the score is NOT reconstructable from
      // signals+weights (those still describe cosine), so the candidate events below
      // carry the fused score explicitly to keep the decision reconstructable.
      ...(res.fusion ? { fusion: res.fusion } : {}),
      candidateSetSize: res.candidates.length,
      durationMs,
      resultCount: res.candidates.filter((c) => c.included).length,
    },
    ...res.candidates.map((c): TelemetryInput => ({
      kind: "retrieval.candidate",
      corrId,
      slug: c.slug,
      scope: c.scope,
      rank: c.rank,
      included: c.included,
      threshold: c.threshold,
      signals: c.signals,
      // Only stored for a non-reconstructable order (fusion); the default cosine
      // order re-derives the score from signals+weights, so storing it would just
      // risk drift from the formula.
      ...(res.fusion ? { score: c.score } : {}),
    })),
  ];
  emitEvents(deps.root, deps.clock, events);

  return res;
}

export async function searchInstrumented(deps: SearchDeps, opts: SearchOptions, corrId: string): Promise<SearchHit[]> {
  const res = await searchExplainInstrumented(deps, opts, corrId);
  return res.candidates.filter((c) => c.included);
}
