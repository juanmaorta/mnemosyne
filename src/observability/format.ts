import type { Stats } from "./stats.js";
import type { StatsSnapshot } from "./snapshot.js";

/** `—` rather than 0: a metric with no data is not a metric that measured zero. */
function n(value: number | null, digits = 2, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(24)}${value}`;
}

export function formatStats(s: Stats): string {
  const lines: string[] = ["Store"];

  const scopes = Object.entries(s.countsByScope).sort(([a], [b]) => a.localeCompare(b));
  const total = scopes.reduce((sum, [, v]) => sum + v, 0);
  lines.push(row("engrams", `${total}${scopes.length ? `  (${scopes.map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`));

  const types = Object.entries(s.countsByType).sort(([a], [b]) => a.localeCompare(b));
  if (types.length) lines.push(row("by type", types.map(([k, v]) => `${k}: ${v}`).join(", ")));
  lines.push(row("access events", String(s.factStreamSize)));
  if (s.pinnedCount > 0) lines.push(row("pinned (never archived)", String(s.pinnedCount)));
  if (s.staleCount > 0) lines.push(row("stale (no vector)", `${s.staleCount}  ← run 'mneme reindex'`));

  const buckets = Object.entries(s.strengthHistogram).sort(([a], [b]) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  if (buckets.length) {
    lines.push("", "Strength");
    const peak = Math.max(...buckets.map(([, v]) => v));
    for (const [bucket, count] of buckets) {
      lines.push(row(bucket, `${"█".repeat(Math.max(1, Math.round((count / peak) * 20)))} ${count}`));
    }
  }

  lines.push("", "Retrieval");
  lines.push(row("latency p50 / p95", s.searchLatencyMs === null
    ? "—"
    : `${s.searchLatencyMs.p50.toFixed(1)} ms / ${s.searchLatencyMs.p95.toFixed(1)} ms`));
  lines.push(row("candidate set (avg)", n(s.avgCandidateSetSize, 1)));
  lines.push(row("top-k cosine (avg)", n(s.avgTopKCosine, 3)));
  lines.push(row("empty results", pct(s.emptyResultRate)));
  lines.push(row("budget utilisation", pct(s.injectionBudgetUtil)));
  // Deliberately adjacent to budget utilisation, because the two answer the
  // question a short digest raises — was it configured, or was it broken?
  lines.push(row("degraded injections", pct(s.degradedInjectionRate)));
  lines.push(row("reinforcement rate", n(s.reinforcementRate, 2, " per query")));

  // Only claim there is no telemetry when no query was recorded at all —
  // an older log can hold queries that predate a field and still be real data.
  if (s.avgCandidateSetSize === null) {
    lines.push("", "  (— means no retrieval recorded yet; see MNEMOSYNE_TELEMETRY)");
  }
  return lines.join("\n");
}

/**
 * The snapshot series as one row per date. Deliberately narrow: the columns
 * are the ones a memory-rewriting subsystem would move — engram count (it
 * archives), mean strength (it re-scores importance), top-k cosine (it rewrites
 * text, changing embeddings) and budget utilisation (it consolidates).
 */
export function formatSnapshotSeries(series: StatsSnapshot[]): string {
  if (series.length === 0) {
    return "no snapshots yet — run 'mneme snapshot' to start the series";
  }
  const header = `${"date".padEnd(12)}${"algo".padEnd(8)}${"engrams".padStart(8)}${"avg str".padStart(9)}${"cos".padStart(8)}${"budget".padStart(9)}`;
  const rows = series.map((s) => {
    const engrams = Object.values(s.stats.countsByScope).reduce((a, b) => a + b, 0);
    const buckets = Object.entries(s.stats.strengthHistogram);
    const totalEngramsWithState = buckets.reduce((sum, [, n]) => sum + n, 0);
    // Bucket midpoint is enough to see a trend; the histogram itself is in the JSON.
    const avgStrength = totalEngramsWithState === 0
      ? null
      : buckets.reduce((sum, [b, n]) => sum + (Number(b.split("-")[0]) + 0.5) * n, 0) / totalEngramsWithState;
    return [
      s.ts.slice(0, 10).padEnd(12),
      s.algoVersion.padEnd(8),
      String(engrams).padStart(8),
      (avgStrength === null ? "—" : avgStrength.toFixed(2)).padStart(9),
      (s.stats.avgTopKCosine === null ? "—" : s.stats.avgTopKCosine.toFixed(3)).padStart(8),
      (s.stats.injectionBudgetUtil === null ? "—" : `${(s.stats.injectionBudgetUtil * 100).toFixed(0)}%`).padStart(9),
    ].join("");
  });
  return [header, "─".repeat(header.length), ...rows].join("\n");
}
