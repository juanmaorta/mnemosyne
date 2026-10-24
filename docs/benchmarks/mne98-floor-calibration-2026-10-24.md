# MNE-98: cosine floor × lexical rescue calibration (2026-10-24)

## Method and review state

A fresh review set was generated for `personal` on 2026-10-18 with local
`gemma4:e2b`: 25 anchors × (`natural`, `keyword`) plus 15 generated
`unanswerable` questions. Claude made a first pass: it rewrote 8 natural
questions that lacked context, converted all 15 generated "unanswerable"
questions into answerable `near` positives (the store answers every one of them),
added 17 negatives (12 far, 5 near) after grepping the store for their key terms,
and added sibling labels. **The owner reviewed and approved all 82 questions on
2026-10-24.** Final mix: 25 natural, 25 keyword, 15 near, 17 unanswerable.

Between preparation and calibration, 34 notes changed (221 → 251 active
documents). The corpus digest was re-baselined after checking that no labeled
note had disappeared, that no changed note contained the negatives' key terms,
and that the one labeled note that changed still answered its question. The
re-baseline is recorded in the private review set.

Model: `nomic-embed-text-v2-moe`. `calibrate-floor` captures every candidate's
raw cosine and raw BM25 once and sweeps cosine floors 0.20–0.80 (step 0.01) ×
lexical floors off or 0–20 (step 0.5). The order stays cosine-only, as in
production; only eligibility changes. Questions, slugs and labels remain under
`~/.cache/mnemosyne/5b-golden/` and are not committed.

## Two bench defects found and fixed

1. The in-memory bench index never filled `fts_engrams`, so every BM25 value
   measured through `bench-golden.mjs` was empty. Any earlier lexical measurement
   taken through that index is void.
2. Once FTS was filled, it held only the evaluated scope. FTS5's `bm25()` takes
   IDF and average length from the whole table, and production indexes every
   scope in one table. Raw BM25 differed from production by −9% to +9% (median
   +5%), more than the margin of the first lexical floor found (0.15 over the
   strongest negative). The bench now adds the other scopes' text to FTS only.
   Bench and production then differ by one superseded note (301 vs 302 rows).

## Results (production-equal BM25 statistics)

| Gate | Recall | nDCG@10 | False positives |
|---|---|---|---|
| `cos ≥ 0.35` (current) | 0.954 | 0.859 | 3/17 |
| `cos ≥ 0.35` + BM25 `≥ 12` | **0.969** | 0.867 | 3/17 |
| `cos ≥ 0.33`, no rescue | 0.969 | 0.876 | 4/17 |
| `cos ≥ 0.39`, no rescue (best at 0 FP) | 0.923 | 0.820 | 0/17 |
| `cos ≥ 0.39` + BM25 `≥ 11` (best combined at 0 FP) | 0.954 | 0.846 | 0/17 |

- Separation overlaps on both signals: cosine positives go down to 0.282 and
  negatives up to 0.384; on BM25, negatives reach 10.81.
- 0.969 is this set's recall ceiling: two answerable questions never reach the
  top ten at any floor (a ranking problem, not a floor problem).
- With `cos ≥ 0.35`, every lexical floor from 10.0 to 14.5 gives the same result
  (recall 0.969, 3 FP, 2 notes rescued). 12 sits in the middle of that range: 11%
  above the strongest negative and 17% below the point where the rescued note is
  lost. The rescue adds no false positive here; the 3 that remain come in on
  cosine.
- The zero-false-positive gates sit 0.006 (cosine) and 0.15–0.19 (BM25) above
  their strongest negative: one new negative breaks them. With 17 negatives,
  they are not a calibration.

## Decision input

Product priority (owner, 2026-10-24): **a missed note is worse than noise.** That
picks the recall-maximizing gate, `cos ≥ 0.35` + lexical floor 12, over the
zero-false-positive ones. The lexical floor is store-specific (raw BM25 depends
on corpus size, note length and every scope's text) and drifts as the store
grows, so it is not a code default; recalibrate it when the store changes
materially.
