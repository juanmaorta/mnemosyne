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

/** Why a candidate's eligibility differs from "cleared the cosine floor", if it does. */
function floorNote(res: ExplainResult, c: ExplainResult["candidates"][number]): string {
  if (c.lexicalRescue) return ` (lexical rescue, bm25 ${f3(c.bm25!)})`;
  return res.minCos !== null && c.signals.relevanceCosine < res.minCos ? " (below cosine floor)" : "";
}

export function formatExplain(res: ExplainResult, opts: { limit?: number | null } = {}): string {
  const w = res.weights;
  const header = [
    `query: "${res.query}"  scopes: [${res.scopes.join(", ")}]  k=${res.k}  ${res.candidates.length} candidates`,
    `weights: recency ${w.recency} · importance ${w.importance} · relevance ${w.relevance}`,
    res.fusion === "rrf"
      // Under fusion the `score` column is the RRF fused value, not the scaled
      // signal blend; cosine (and its floor) only decides eligibility here.
      ? "order: RRF fusion (vector + BM25); score = fused rank value; cosine is eligibility only, not the order"
      : "score axes: each signal scaled to [0,1] among these candidates; scores are relative to this query",
    `minimum raw cosine: ${res.minCos === null ? "off" : f3(res.minCos)}`,
    ...(res.lexicalFloor === undefined ? [] : [`lexical rescue floor (raw BM25): ${f3(res.lexicalFloor)}`]),
  ];

  if (res.candidates.length === 0) {
    return [...header, "", "  no candidates — the scope is empty or unindexed"].join("\n");
  }

  const threshold = res.candidates[0]!.threshold;
  const limit = opts.limit === undefined ? DEFAULT_EXPLAIN_ROWS : opts.limit;
  let lastIncluded = -1;
  for (let i = res.candidates.length - 1; i >= 0; i--) {
    if (res.candidates[i]!.included) { lastIncluded = i; break; }
  }
  const shown = limit === null ? res.candidates : res.candidates.slice(0, Math.max(limit, res.k, lastIncluded + 1));
  const hidden = res.candidates.length - shown.length;

  const rows = shown.map((c) => {
    // Raw decay remains visible; the marker distinguishes creation-age from
    // access-age. The scaled blend beside it reconstructs the score.
    const recency = `${f3(c.signals.recencyNorm)}${c.signals.accessed ? " " : "*"}`;
    const blend = c.signals.normalized;
    return [
      String(c.rank).padStart(4),
      c.included ? " ✓ " : " ✗ ",
      f3(c.score).padStart(7),
      recency.padStart(8),
      f3(c.signals.importanceNorm).padStart(7),
      f3(c.signals.relevanceCosine).padStart(7),
      blend ? `${f3(blend.recency)}/${f3(blend.importance)}/${f3(blend.relevance)}` : "        —        ",
      `  ${c.slug} [${c.scope}]${floorNote(res, c)}`,
    ].join(" ");
  });

  const columns = ["rank", "   ", "  score", "  decay", "   impN", "    cos", "scaled r/i/c", "  slug [scope]"].join(" ");
  const anyNeverRead = shown.some((c) => !c.signals.accessed);

  return [
    ...header,
    "",
    columns,
    "─".repeat(columns.length),
    ...rows,
    ...(hidden > 0 ? [`  … ${hidden} more below the cut line (--all to show)`] : []),
    "",
    `top-k score cut line: ${res.candidates.some((c) => c.included) ? f3(threshold) : "none"}`,
    ...(anyNeverRead ? ["* decay measured from creation (never accessed)"] : []),
  ].join("\n");
}
