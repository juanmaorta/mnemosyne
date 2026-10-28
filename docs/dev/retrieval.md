# Retrieval internals

How `search` and `context` decide what comes back, and the measurements behind each default.
User-facing behaviour is in [Concepts](../guide/concepts.md#recall-how-memories-come-back) and
[Configuration](../guide/configuration.md); this page is for changing it.

**Before changing retrieval**, measure: run the benchmarks in [benchmarks.md](benchmarks.md)
before and after, on the synthetic fixtures and, if you have one, on a reviewed private golden
set. A ranking change that is not measured is not reviewable.

- [Search: filter, then rank](#search-filter-then-rank)
- [The cosine floor](#the-cosine-floor)
- [Embedding models](#embedding-models)
- [Lexical rescue](#lexical-rescue)
- [Hybrid RRF fusion](#hybrid-rrf-fusion)
- [The context digest](#the-context-digest)
- [The floorless retry](#the-floorless-retry)

## Search: filter, then rank

Search filters candidates on their **raw cosine** and then ranks by cosine relevance alone (ties
broken deterministically by scope then slug). Recency and importance keep their role in the
`context` digest, not in the search candidate, so an old or never-read note does not lose its
place for that reason. Callers of the library can still pass explicit `SearchOptions.weights` to
request the recency + importance blend instead.

The blend (used by `context`, and by search when weights are passed) combines relevance
(semantic) + recency + importance, relevance-primary by default. Each signal is scaled across the
candidates of the current query before blending, so a blended score describes rank within that
query and cannot be compared with another query's score. For a note never read, recency uses its
creation date. Recall raises strength and slows retention decay (30-day base interval); ignored
memories decay. Hot state lives only in the local index — the `.md` files are never mutated by
retrieval.

In tier 0 (`MNEMOSYNE_EMBEDDER=none`) there is no embedder: `search` and `context` rank by BM25
over FTS5.

## The cosine floor

With `nomic-embed-text` and task prefixes (`search_document:` for indexed notes, `search_query:`
for searches), the default floor is `0.70`; `nomic-embed-text-v2-moe` uses `0.35`; other models
have no default floor until calibrated. Both defaults are applied automatically from the embedder
fingerprint. `--min-cos` overrides it per query, `MNEMOSYNE_MIN_COS` per process, and the store's
`.config.json` (`minCos`) per store; `-1` effectively disables it. When nothing qualifies, search
prints the best candidate and its cosine and exits with status `2` (ordinary errors use `1`).
`explain` shows candidates rejected by the floor. The `context` digest has no query vector, so no
cosine floor applies there.

The `0.70` default was chosen from a small, reproducible local Nomic check: 18 answerable and 18
unrelated English/Spanish queries, with a positive minimum of `0.735` and a negative maximum of
`0.664` after task prefixes. `npm run bench:cosine` repeats it (see
[benchmarks.md](benchmarks.md#cosine-floor-check)). This synthetic corpus does not prove the same
separation for a larger or different store; adjust the floor if its false-positive or
false-negative rate warrants it.

## Embedding models

**`nomic-embed-text-v2-moe` is a measured upgrade** (MNE-32). On the local golden set it ranked
far better than v1 (nDCG@10 0.74 vs 0.28, MRR 0.78 vs 0.30) at the same 768 dimensions, so the
index table is unchanged. Each model carries its own calibrated cosine floor — v2-moe's
distribution sits lower, so it uses **0.35** where v1 uses 0.70 (a shared floor would reject the
wrong candidates).

The 0.35 was recalibrated in MNE-98 on a reviewed golden set (82 questions): v2-moe's positive and
off-topic cosine bands overlap (about 0.28–0.38), so no floor separates them. 0.35 is the
recall-first choice: it keeps every note a stricter floor would drop, at the cost of some
off-topic hits (3 of 17 negatives). Lexical rescue (below) recovers what it still misses. Numbers
in [`mne98-floor-calibration-2026-10-24.md`](../benchmarks/mne98-floor-calibration-2026-10-24.md).
The floor was calibrated on a small private set and should be revalidated on a larger golden
before being treated as final.

The vector dimension is derived from the model, never configured next to it; an unknown model
needs `OLLAMA_EMBEDDING_DIM`, and the client refuses to start rather than guess. Changing the model
changes the embedder fingerprint, and Mnemosyne refuses to use the old index until
`mneme reindex --force-embedder` (see
[Changing the model](../guide/configuration.md#changing-the-model) for the reasoning). Adding the
Nomic task prefixes changed the fingerprint for existing `nomic-embed-text` installations too, so
the first run after that upgrade asked for the same explicit rebuild.

## Lexical rescue

**`--lexical-floor` is opt-in and off by default (MNE-98).** A note whose raw BM25 score
(`-bm25()`, IDF-weighted, higher = better) reaches the lexical floor is eligible even below the
cosine floor; the order is unchanged, so a rescued note still competes for the k slots. It exists
because with `nomic-embed-text-v2-moe` the cosine bands of true positives and off-topic queries
overlap, while raw BM25 separated them in the probe — a strong rare-term match is the evidence
cosine is missing.

The scale depends on the store (size, note length), so there is no default: calibrate it per store
with `calibrate-floor` ([benchmarks.md](benchmarks.md#calibrating-the-floors-for-your-store)),
which sweeps the cosine floor × lexical floor grid on the reviewed golden and reports recall per
query style (natural paraphrase vs. keyword). On the author's store (MNE-98), `0.35` plus a
lexical floor of `12` reached the golden's recall ceiling without adding false positives, and any
value from 10 to 14.5 gave the same result. Raw BM25 drifts as the store grows, so recalibrate
after big changes. Persist it with `mneme init --write --lexical-floor <n>`. `explain` marks
rescued rows and telemetry records each candidate's BM25. Tier 0 ignores it (BM25 already ranks
there).

## Hybrid RRF fusion

**`--fusion rrf` is opt-in, and measured not to help here (MNE-96).** It re-ranks the vector
candidates by Reciprocal Rank Fusion (`k=60`) of the cosine and BM25 rankings; the cosine floor
still gates eligibility, so fusion only reorders notes that already clear it. On the golden
`personal` set it did not beat pure cosine — it was identical with `nomic-embed-text` (the 0.70
floor pre-filters the lexical candidates RRF would promote) and slightly worse with
`nomic-embed-text-v2-moe` (0.729 vs 0.742 nDCG@10). So production keeps pure cosine (MNE-77);
`--fusion rrf` stays available for re-evaluation on a more lexical query mix (the golden queries
are generated to avoid the note's distinctive terms, which biases the set against BM25).

## The context digest

The digest is ranked with the blend (relevance + recency + importance) and capped by a token
budget (`MNEMOSYNE_CONTEXT_BUDGET`, 1000) **and** a line count (`MNEMOSYNE_CONTEXT_MAX_ENTRIES`,
25). The line cap exists so a scope of many tiny notes cannot inject a disproportionate share of
itself (a real case reached 78% of a scope within the token budget alone); it keeps `context` a
top-few view, not a feed. Snapshots and superseded
notes are excluded at query time. `context` never fails: errors are recorded as *degraded*
injections and surfaced by `mneme stats`.

## The floorless retry

When the floor rejects everything, one bounded floorless retry — `--min-cos=-1 -k 3` — can surface
an answerable note sitting just under the cut. Validated in MNE-78: it rescued answerable notes at
cosine 0.63–0.69 with no new false positives. The agent reads up to three and **abstains if none
actually supports the answer**. This is a deliberate single retry, not a reason to lower the floor
globally; the instruction block in
[`memory-instructions.md`](../integrations/memory-instructions.md) encodes it.
