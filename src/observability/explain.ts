import type { ExplainResult } from "../retrieval/search.js";

const f3 = (n: number): string => n.toFixed(3);

/**
 * Candidate-by-candidate table for a ranking decision, discarded rows
 * included: "why did X beat Y" is unanswerable from the top-k alone.
 *
 * Pure formatting over an ExplainResult — no store access, so it renders the
 * same data the telemetry log records.
 */
/**
 * Rows shown before truncating. The candidate set is the whole scope (a 105-note
 * store prints 105 rows), and the interesting region is the cut line: the last
 * included and the first few that missed. The log keeps every row regardless —
 * truncation here is a display choice, never a recording one.
 */
export const DEFAULT_EXPLAIN_ROWS = 15;

export function formatExplain(res: ExplainResult, opts: { limit?: number | null } = {}): string {
  const w = res.weights;
  const header = [
    `query: "${res.query}"  scopes: [${res.scopes.join(", ")}]  k=${res.k}  ${res.candidates.length} candidates`,
    `weights: recency ${w.recency} · importance ${w.importance} · relevance ${w.relevance}`,
  ];

  if (res.candidates.length === 0) {
    return [...header, "", "  no candidates — the scope is empty or unindexed"].join("\n");
  }

  const threshold = res.candidates[0]!.threshold;
  const limit = opts.limit === undefined ? DEFAULT_EXPLAIN_ROWS : opts.limit;
  const shown = limit === null ? res.candidates : res.candidates.slice(0, Math.max(limit, res.k));
  const hidden = res.candidates.length - shown.length;

  const rows = shown.map((c) => {
    // A trailing marker beats hiding the value: the neutral 1.000 is real, it
    // just wasn't earned, and a reader comparing rows needs to see which.
    const recency = `${f3(c.signals.recencyNorm)}${c.signals.accessed ? " " : "*"}`;
    return [
      String(c.rank).padStart(4),
      c.included ? " ✓ " : " ✗ ",
      f3(c.score).padStart(7),
      recency.padStart(8),
      f3(c.signals.importanceNorm).padStart(7),
      f3(c.signals.relevanceCosine).padStart(7),
      `  ${c.slug} [${c.scope}]`,
    ].join(" ");
  });

  const columns = ["rank", "   ", "  score", "    recN", "   impN", "    cos", "  slug [scope]"].join(" ");
  const anyNeutralised = shown.some((c) => !c.signals.accessed);

  return [
    ...header,
    "",
    columns,
    "─".repeat(columns.length),
    ...rows,
    ...(hidden > 0 ? [`  … ${hidden} more below the cut line (--all to show)`] : []),
    "",
    `cut line (threshold): ${f3(threshold)}`,
    ...(anyNeutralised ? ["* recency neutralised (never accessed)"] : []),
  ].join("\n");
}
