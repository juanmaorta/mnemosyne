# MNE-76: calibration on the reviewed golden set (2026-10-01)

## Method and review state

The existing 5b review sets were copied to a separate local directory before
revalidation. The originals were preserved. The current corpus has 181 active
`personal` documents (171 at the original review) and 20 active `private`
documents (17 at the original review). The missing graded document in personal
`q-16` was removed, its broad question and unrelated labels were replaced,
and the five personal question/label pairs flagged by MNE-75 were adjudicated
against current notes. One private question was updated for newer relevant
notes. Twelve new unanswerable questions were added to each scope. These
changes were reviewed by Codex in this unattended run; **they have not received
an independent human review**. The old positive questions retain their earlier
human approvals where unchanged.

Both scopes were evaluated at one fixed clock, `2026-10-01T21:46:55.956Z`, with
local `nomic-embed-text`. For each query, the runner built an in-memory index,
captured the full `searchExplain` candidate set once, verified the reconstructed
production top ten, and reranked those candidates offline. It checked corpus
content, ranking metadata, and access-event fingerprints before and after each
scope. No memory notes or events were written. Review sets and numeric local
scorecards remain under `/private/tmp/mnemosyne-5b-mne76/`; neither questions,
document identifiers, nor relevance labels are committed.

The refreshed baseline is measured on the **same** questions, labels, corpus,
and clock as the alternatives. It is not directly comparable to the MNE-75
private result of 0.427, which used 17 documents and older labels.

## Four-arm results

The production blend uses recency/importance/relevance weights
`0.25/0.25/1` and cosine floor `0.70`. “Cosine” uses `0/0/1`.
False positives count unanswerable questions with at least one returned result.

| Scope | Arm | Answerable nDCG@10 | MRR | False positives |
| --- | --- | ---: | ---: | ---: |
| personal (24 answerable, 13 unanswerable) | Production blend + floor | 0.635 | 0.660 | 7/13 |
| personal | Blend, no floor | 0.550 | 0.527 | 13/13 |
| personal | Cosine + floor | 0.680 | 0.729 | 7/13 |
| personal | Pure cosine, no floor | 0.724 | 0.750 | 13/13 |
| private (17 answerable, 12 unanswerable) | Production blend + floor | 0.449 | 0.676 | 8/12 |
| private | Blend, no floor | 0.809 | 0.941 | 12/12 |
| private | Cosine + floor | 0.470 | 0.706 | 8/12 |
| private | Pure cosine, no floor | 0.823 | 0.971 | 12/12 |

Removing the floor accounts for most of the private answerable-query gain:
with the production weights held fixed, nDCG@10 rises by 0.361, while false
positives rise from 8 to 12. Changing only the weights at floor 0.70 yields a
smaller private gain (+0.022) without adding false positives. For personal,
changing only the weights at floor 0.70 gains 0.046; removing the floor from
the production blend *reduces* nDCG by 0.085 and raises false positives by six.

## Weight and floor sweep

The local runner evaluated 324 configurations: recency and importance weights
each in `0, 0.05, 0.10, 0.15, 0.20, 0.25`, relevance weight fixed at `1`, and
cosine floors off or `0.65–0.72` in steps of `0.01`. The following pure-cosine
slice shows why lowering the floor misses the false-positive gate:

| Floor | Personal nDCG@10 | Personal FP | Private nDCG@10 | Private FP |
| --- | ---: | ---: | ---: | ---: |
| off | 0.724 | 13/13 | 0.823 | 12/12 |
| 0.65 | 0.706 | 11/13 | 0.713 | 11/12 |
| 0.67 | 0.686 | 10/13 | 0.642 | 10/12 |
| 0.69 | 0.684 | 8/13 | 0.537 | 9/12 |
| 0.70 | 0.680 | 7/13 | 0.470 | 8/12 |
| 0.72 | 0.569 | 5/13 | 0.349 | 7/12 |

No swept configuration reaches the private nDCG@10 target of **0.70** while
keeping private false positives at or below **8/12**. In fact, none clears even
those two private gates together; therefore none clears the full joint gate,
which also requires personal nDCG@10 at least **0.635** and false positives no
more than **7/13**. The best private nDCG among configurations satisfying both
false-positive ceilings and the personal nDCG floor is **0.470** (pure cosine,
floor 0.70).

## Recommendation

Keep the production weights and floor unchanged. The target can be achieved
only by admitting more false positives on this set; the observed gain from
weaker recency weights alone is too small. A later candidate should change
retrieval or abstention behavior and be measured on separately reviewed
negatives before adjusting defaults. These small, locally adjudicated sets
are useful for this decision but are not an estimate of population-wide
retrieval quality. The grid is exploratory and could overfit its 66 questions.
