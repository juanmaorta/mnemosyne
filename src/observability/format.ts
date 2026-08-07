import type { Stats } from "./stats.js";

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
  lines.push(row("reinforcement rate", n(s.reinforcementRate, 2, " per query")));

  // Only claim there is no telemetry when no query was recorded at all —
  // an older log can hold queries that predate a field and still be real data.
  if (s.avgCandidateSetSize === null) {
    lines.push("", "  (— means no retrieval recorded yet; see MNEMOSYNE_TELEMETRY)");
  }
  return lines.join("\n");
}
