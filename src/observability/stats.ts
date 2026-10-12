import type { Db } from "../index/db.js";
import { readTelemetry, type TelemetryEvent } from "../telemetry/events.js";
import { readEvents } from "../events.js";
import { listScopes } from "../index/walk.js";

export interface Stats {
  countsByScope: Record<string, number>;
  countsByType: Record<string, number>;
  /**
   * Notes pinned as non-archivable (MNE-62). Counted so pins cannot become a
   * silent hole that quietly empties the point of archival: if most of a scope
   * is pinned, archival is doing nothing and that should be visible here.
   */
  pinnedCount: number;
  /** Access events across all scopes — the synced stream hot state is folded from. */
  factStreamSize: number;
  /** Engrams in the index with no vector: unsearchable until the next reindex. */
  staleCount: number;
  searchLatencyMs: { p50: number; p95: number } | null;
  avgCandidateSetSize: number | null;
  /** Mean cosine of INCLUDED candidates — how relevant what we served actually was. */
  avgTopKCosine: number | null;
  emptyResultRate: number | null;
  /** Share of ranked engrams that survived the context budget. */
  injectionBudgetUtil: number | null;
  /**
   * Share of injections that were degraded — the digest was not what a healthy
   * run would have served. Budget truncation is excluded on purpose: that is
   * `injectionBudgetUtil` above, and folding it in here would make a tight
   * budget look like a broken system.
   *
   * This is the one failure that zeroes retrieval, and it used to be invisible:
   * the read path exits 0 and prints a digest whatever happens, so a scorecard
   * built on the ranking alone would average over sessions that received no
   * memory at all without ever knowing it.
   */
  degradedInjectionRate: number | null;
  strengthHistogram: Record<string, number>;
  /** Reinforcements per query: how often retrieval turns into an actual read. */
  reinforcementRate: number | null;
}

/**
 * Linear-interpolated percentile over an unsorted sample. Pure and
 * deterministic — the benchmark scorecard compares these across runs, so it
 * cannot depend on a library's tie-breaking.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Bucket label for a strength value: "0-1", "1-2", … */
function strengthBucket(strength: number): string {
  const lo = Math.floor(strength);
  return `${lo}-${lo + 1}`;
}

export interface StatsOptions {
  /**
   * Scopes to leave out entirely. Used when the result is going to be
   * PERSISTED (snapshots): telemetry exclusions stop the event log from
   * naming a client scope, but these counts come straight from the `engrams`
   * table and never pass through that gate. On-screen `mneme stats` passes
   * nothing — hiding a scope from the user on their own machine would only
   * push them to switch exclusions off altogether.
   */
  excludeScopes?: string[];
}

export function computeStats(db: Db, root: string, opts: StatsOptions = {}): Stats {
  const excluded = opts.excludeScopes ?? [];
  const notExcluded = excluded.length === 0
    ? { sql: "", params: [] as string[] }
    : { sql: ` where scope not in (${excluded.map(() => "?").join(",")})`, params: excluded };
  const andNotExcluded = excluded.length === 0
    ? { sql: "", params: [] as string[] }
    : { sql: ` and e.scope not in (${excluded.map(() => "?").join(",")})`, params: excluded };
  const countsByScope: Record<string, number> = {};
  for (const r of db.prepare(`select scope, count(*) as n from engrams${notExcluded.sql} group by scope`).all(...notExcluded.params) as { scope: string; n: number }[]) {
    countsByScope[r.scope] = r.n;
  }
  const countsByType: Record<string, number> = {};
  for (const r of db.prepare(`select type, count(*) as n from engrams${notExcluded.sql} group by type`).all(...notExcluded.params) as { type: string; n: number }[]) {
    countsByType[r.type] = r.n;
  }

  const staleCount = (db.prepare(
    `select count(*) as n from engrams e where not exists (select 1 from vec_engrams v where v.rowid = e.id)${andNotExcluded.sql}`,
  ).get(...andNotExcluded.params) as { n: number }).n;

  const pinnedExclusion = excluded.length === 0 ? "" : ` and scope not in (${excluded.map(() => "?").join(",")})`;
  const pinnedCount = (db.prepare(
    `select count(*) as n from engrams where pinned = 1${pinnedExclusion}`,
  ).get(...excluded) as { n: number }).n;

  const strengthHistogram: Record<string, number> = {};
  for (const r of db.prepare(`select strength from hot_state${notExcluded.sql}`).all(...notExcluded.params) as { strength: number }[]) {
    const b = strengthBucket(r.strength);
    strengthHistogram[b] = (strengthHistogram[b] ?? 0) + 1;
  }

  let factStreamSize = 0;
  try {
    const scopes = listScopes(root).filter((sc) => !excluded.includes(sc));
    for (const evs of readEvents(root, scopes).values()) factStreamSize += evs.length;
  } catch { /* no store on disk — leave at 0 */ }

  const telemetry = readTelemetry(root);
  const byKind = (kind: string): TelemetryEvent[] => telemetry.filter((e) => e.kind === kind);
  const queries = byKind("retrieval.query");

  const durations = queries.map((q) => num(q.durationMs)).filter((d): d is number => d !== undefined);
  const candidateSizes = queries.map((q) => num(q.candidateSetSize)).filter((n): n is number => n !== undefined);
  const resultCounts = queries.map((q) => num(q.resultCount)).filter((n): n is number => n !== undefined);

  const includedCosines = byKind("retrieval.candidate")
    .filter((c) => c.included === true)
    .map((c) => num((c.signals as { relevanceCosine?: unknown } | undefined)?.relevanceCosine))
    .filter((n): n is number => n !== undefined);

  const injections = byKind("retrieval.injected");
  const injectedTotal = injections.reduce((sum, e) => sum + (Array.isArray(e.injectedSlugs) ? e.injectedSlugs.length : 0), 0);
  const droppedTotal = injections.reduce((sum, e) => sum + (num(e.droppedForBudget) ?? 0), 0);
  const consideredTotal = injectedTotal + droppedTotal;
  const degradedInjections = injections.filter((e) => Array.isArray(e.degraded) && e.degraded.length > 0).length;

  const reinforcements = byKind("access.reinforced").length;

  // Every rate stays null until there is something to measure. Reporting 0
  // would be indistinguishable from "measured, and it really is zero".
  return {
    countsByScope,
    countsByType,
    pinnedCount,
    factStreamSize,
    staleCount,
    searchLatencyMs: durations.length === 0
      ? null
      : { p50: percentile(durations, 50), p95: percentile(durations, 95) },
    avgCandidateSetSize: mean(candidateSizes),
    avgTopKCosine: mean(includedCosines),
    emptyResultRate: resultCounts.length === 0
      ? null
      : resultCounts.filter((n) => n === 0).length / resultCounts.length,
    injectionBudgetUtil: consideredTotal === 0 ? null : injectedTotal / consideredTotal,
    degradedInjectionRate: injections.length === 0 ? null : degradedInjections / injections.length,
    strengthHistogram,
    reinforcementRate: queries.length === 0 ? null : reinforcements / queries.length,
  };
}
