# MNE-75: golden retrieval diagnosis (2026-10-01)

## Method

The existing, human-approved 5b review sets were evaluated against an in-memory
index built from the current local corpus with `nomic-embed-text`. Every query
was run with the production weights and Nomic cosine floor (`0.70`), then with
recency and importance weights set to zero and the floor disabled. The local
diagnostic scorecards contain query IDs, ranks, cosine values, and score-signal
breakdowns. They remain outside git, in a local scratch directory.
Because the corpora changed, decay was evaluated at the current time instead
of the review set's older timestamp.

Both corpora changed after their review sets were created. The personal scope
grew from 171 to 179 active documents; one graded document for `q-16` is gone,
so that query was excluded. The private scope still has 17 documents, but its
content digest changed. These measurements describe the **current** corpus and
must not be presented as an exact rerun of the September scorecards.

## Results

| Scope | Reviewed queries used | Answerable | Production nDCG@10 | Pure cosine nDCG@10 | Difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| personal | 24/25 | 23 | 0.473 | 0.551 | +0.077 |
| private | 17/17 | 17 | 0.427 | 0.812 | +0.384 |

The one unanswerable personal query returns no result under production settings
and one result under floor-free pure cosine (false positives: **0/1** versus
**1/1**). There are no unanswerable queries in the private review set. The
cosine-only gain therefore cannot be adopted as a production setting without
a broader negative-query check.

The categories below count queries, not documents. “Ranker” means the blend
reduced graded nDCG while a relevant document was in cosine's top ten.
“Cosine floor” means a relevant top-ten cosine hit fell below the production
floor. “Embedder or label” means cosine either missed the top ten or placed
relevant results too low for nDCG@10 to reach 0.5. The private review set
needs a human judgment before attributing those cases to one cause.
These older review sets do not record an importance-metadata digest, so
changes to that ranking signal since review cannot be verified independently.

| Scope | Ranker | Cosine floor | Embedder candidate | Question/label review | No diagnosed loss | Unanswerable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| personal | 3 | 2 | 3 | 5 | 10 | 1 |
| private | 9 | 5 | 0 | 0 | 3 | 0 |

The code groups the two middle review columns as `embedder-or-label` until
the local review set is inspected. Their split above is the manual triage,
not an automated model-quality claim.

The private scorecard's nine ranker cases are `q-02`, `q-03`, `q-05`, `q-07`,
`q-08`, `q-11`, `q-15`, `q-16`, and `q-17`. Its five floor cases are `q-09`,
`q-10`, `q-12`, `q-13`, and `q-14`; their best relevant cosine values are
0.675–0.693. All 17 private queries find a relevant document in cosine's top
ten, so an embedding-model A/B is not the first intervention there.

The personal scope's eight unresolved cosine failures are `q-05`, `q-06`,
`q-08`, `q-11`, `q-12`, `q-17`, `q-23`, and `q-24`. Private manual inspection
flagged five for question/label review (`q-05`, `q-06`, `q-11`, `q-12`, `q-24`)
and three as possible embedding or vector-granularity misses (`q-08`, `q-17`,
`q-23`). This is a diagnostic judgment, not a relabeling of the review set.
No query text, slug, or note content is recorded here.

## Recommendation

1. Open a separately benchmarked ranking/floor calibration issue before
   changing defaults. The private scope gains **0.384 nDCG@10** under pure
   cosine, and five of its queries are rejected by a floor only 0.007–0.025
   above their relevant cosine. Compare production, blend without floor,
   cosine with floor, and pure cosine to isolate each contribution. Preserve
   false-positive checks on unanswerable queries. A measurable target is
   **nDCG@10 ≥ 0.70** for this private review set while keeping the expanded
   negative-query false-positive rate at its production baseline; it is a
   hypothesis to test, not a promised outcome.
2. Repair and reapprove the five flagged personal queries/labels, then refresh
   the changed review sets. Do not treat the present personal nDCG difference
   as a release gate because it excludes one previously labeled query.
3. After that review, use the remaining personal misses to justify
   MNE-33 (vector granularity)
   or MNE-32 (embedding model A/B)
   with a measured target. The current evidence does not justify changing the
   embedding model globally.

No production ranking default changed in MNE-75.
