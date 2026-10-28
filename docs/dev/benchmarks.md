# Benchmarks and calibration

The benchmarks behind retrieval's defaults, and how to calibrate the floors for a given store.
None of them changes production defaults on its own; they are calibration signals. Results that
are safe to publish (query IDs and numeric summaries only) live in
[`docs/benchmarks/`](../benchmarks/). What the floors do is in
[Retrieval internals](retrieval.md).

All of them need Ollama serving the embedding model locally. None of them touches your store's
Markdown.

- [Cosine floor check](#cosine-floor-check)
- [Recency and importance on labelled retrieval](#recency-and-importance-on-labelled-retrieval)
- [Private golden-set evaluation (`bench:golden`)](#private-golden-set-evaluation-benchgolden)
- [Calibrating the floors for your store](#calibrating-the-floors-for-your-store)

## Cosine floor check

```sh
npm run bench:cosine        # with Ollama serving nomic-embed-text
```

The small, reproducible local Nomic check behind the `0.70` default: 18 answerable and 18
unrelated English/Spanish queries, with a positive minimum of `0.735` and a negative maximum of
`0.664` after task prefixes. This synthetic corpus does not prove the same separation for a
larger or different store; adjust the floor if its false-positive or false-negative rate warrants
it.

## Recency and importance on labelled retrieval

```sh
npm run bench:retrieval     # with Ollama serving nomic-embed-text
```

Measures how recency and importance alter labelled retrieval results. It reuses the same 18
documents, 18 answerable queries and 18 unrelated queries, adds fixed read/creation-age profiles,
and sweeps recency weights under two policies for never-read notes: decay from creation age, or
the neutral `exp(-1)` prior. The scorecard reports Recall@5, nDCG@5, MRR, top-5 overlap with
cosine-only and no-recency blended ranking, and the negative-query cosine-floor result. To print
the complete scorecard with its algorithm version:

```sh
npm run build && node scripts/calibrate-retrieval.mjs --json
```

The benchmark does not change production defaults; its small, controlled fixture is a calibration
signal, not a quality claim for a private store.

On the 2026-09-28 Nomic run, the creation-age policy at recency weight `0.25` matched the
cosine-only baseline (Recall@5 and nDCG@5 both `1.0`). At `0.40`, creation-age nDCG@5 fell to
`0.959`; the neutral-prior comparison stayed at `1.0` through `0.40`. This fixture supports
keeping `0.25` and creation-age behaviour as the conservative tested choice. The full versioned
scorecard is
[`mne74-nomic-scorecard-2026-09-28.json`](../benchmarks/mne74-nomic-scorecard-2026-09-28.json).

## Private golden-set evaluation (`bench:golden`)

A per-scope evaluation on **your own** store: prepare and review a local query set, then run it
against the current retrieval implementation.

```sh
npm run bench:golden -- prepare --scope personal
# Review ~/.cache/mnemosyne/5b-golden/scope-<hash>.json locally:
# edit questions and graded cluster relevance, then set approved=true.
npm run bench:golden -- run --scope personal

# Diagnose each reviewed query against production ranking and pure cosine.
npm run bench:golden -- diagnose --scope personal

# Once each local set is revalidated and has at least ten reviewed
# unanswerable questions, compare ranking weights and cosine floors.
npm run bench:golden -- calibrate

# Calibrate the eligibility gate for the CURRENT embedding model:
# cosine floor × raw-BM25 lexical rescue floor, recall per query style.
OLLAMA_MODEL=nomic-embed-text-v2-moe npm run bench:golden -- calibrate-floor --scope personal
```

Omit `--scope` to process every scope in the local store, or repeat for each scope.

**`prepare`** embeds the real corpus with local Ollama and generates up to 25 questions per scope
(or every document for smaller scopes) using the local `gemma4:e2b` model by default. The script
refuses non-local Ollama hosts and cloud models. Each anchor note gets two labelled queries:
`natural` (from user situations, without copying distinctive note terms) and `keyword` (2–5 search
terms taken from the note); review may add more styles (e.g. `near`), and `calibrate-floor` reports
every answerable style it finds. Then ~15 `unanswerable` queries are generated against the scope's
note descriptions, half near its topics and half unrelated, and review confirms that no note
answers them. Cosine-near documents receive graded relevance suggestions that must be reviewed by
hand. Review sets from before MNE-98 have no `style`: they are read as natural/unanswerable.

**Privacy.** The private review set and scorecards live under `~/.cache/mnemosyne/5b-golden/`
(`MNEMOSYNE_GOLDEN_DIR`), outside the repository. **Never commit local review sets**; only query
IDs and numeric summaries belong in git.

**`run`** uses an in-memory SQLite index, reads access events without modifying them, and reports
graded nDCG@10/MRR plus cold-model and warm-model p50/p95 latency. Queries approved with an empty
relevance array are treated as unanswerable and reported separately by false-positive rate; they
do not depress nDCG/MRR.

**`diagnose`** writes a private scorecard with query IDs, ranks, cosine values, score signals and
unanswerable-query false positives; it never includes query text, slugs or note text. It compares
the production blend and cosine floor with pure cosine (recency and importance weights zero, floor
disabled). If the corpus has changed since review, the command refuses by default.
`--allow-corpus-drift` makes an explicitly marked diagnostic run on the current corpus and excludes
queries whose graded notes are gone. That run uses the current time for decay, so its metrics are
not directly comparable with the original scorecard.

**`calibrate`** requires a reviewed set whose content and ranking-metadata hashes match the current
corpus. It refuses stale sets, unapproved questions, or fewer than ten reviewed unanswerable
questions per scope. For each query, it captures the full candidate set once, checks that rescoring
reproduces production's top ten, then compares production, blend without floor, cosine with floor,
and pure cosine. A declared grid sweeps recency and importance weights from `0` to `0.25` in steps
of `0.05`, and cosine floors from `0.65` to `0.72` plus off. Before writing a scorecard it verifies
that neither the corpus nor access events changed during the run. Scorecards, including any locally
reviewed questions and labels, stay under `MNEMOSYNE_GOLDEN_DIR`.

## Calibrating the floors for your store

**`calibrate-floor`** has the same preconditions as `calibrate` but is not tied to
`nomic-embed-text`: it calibrates whatever `OLLAMA_MODEL` names.

```sh
OLLAMA_MODEL=nomic-embed-text-v2-moe npm run bench:golden -- calibrate-floor --scope personal
# equivalently, after a build: node scripts/bench-golden.mjs calibrate-floor --scope personal
```

It captures every candidate's raw cosine and raw BM25 once, then sweeps cosine floors `0.20`–`0.80`
(step `0.01`) × lexical floors off or `0`–`20` (step `0.5`). Ranking stays cosine-only, as in
production search. Its in-memory FTS table also holds the other scopes' text (FTS only, never
returned): FTS5 takes BM25's IDF from the whole table, as production does, so a lexical floor
measured on one scope alone would sit on a different scale.

It reports where the positive and negative bands sit on each signal and whether they overlap, the
production floor, the best cosine-only floor and the best combined pair at zero false positives,
plus recall per query style. Ties go to the pair that relies least on the lexical rescue, then to
the stricter lexical floor, then to the median cosine floor of the tied plateau: a golden whose
positives all share vocabulary with their notes would otherwise push the cosine floor up until
BM25 carried everything.

Adopt the result for the store with
`mneme init --write --min-cos <c> --lexical-floor <b>` (see
[Configuration](../guide/configuration.md#the-store-config-configjson)).

Other measured results: [`mne75-golden-diagnosis-2026-10-01.md`](../benchmarks/mne75-golden-diagnosis-2026-10-01.md),
[`mne76-golden-calibration-2026-10-01.md`](../benchmarks/mne76-golden-calibration-2026-10-01.md),
[`mne98-floor-calibration-2026-10-24.md`](../benchmarks/mne98-floor-calibration-2026-10-24.md).
