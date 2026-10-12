# Mnemosyne

[![CI](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml/badge.svg)](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml)

**Persistent, human-like memory for LLM agents.** File-based, local-first, agent-agnostic.

Agents forget everything between sessions. The usual fix — stuffing more into the
context window — is the dangerous one: it degrades, it doesn't scale, and it's not
continuity. Mnemosyne gives an agent a real memory instead: it remembers what matters,
forgets what doesn't, and connects ideas over time.

- **Human-like recall.** Memories are scored by recency + importance + relevance, reinforced
  when recalled and decayed when ignored (spaced-repetition). What you use, sticks.
- **Dreaming.** A nightly consolidation pass distills raw facts into curated notes, links
  related memories into an associative graph, re-scores importance, and archives the stale —
  without ever growing what gets loaded into context.
- **Local-first.** Runs offline. Markdown files are the source of truth; the search index
  is derived, local and disposable. Works the same at home or on the road.
- **Agent-agnostic.** The data knows nothing about any particular agent. Claude Code today,
  anything tomorrow. Browse it in Obsidian for free.
- **Compliance by design.** Memory is partitioned by *scope*. Leave a client, delete their
  scope — folder and its separate encrypted backup — and nothing leaks.

The name: **Mnemosyne**, Titaness of memory, whose spring stood opposite the river Lethe —
to remember versus to forget. That duality is the whole system.

## Getting started

### Install

Mnemosyne is not on npm yet — build it from source, then let it set itself up in one command:

```sh
git clone https://github.com/juanmaorta/mnemosyne.git && cd mnemosyne
npm install && npm run build
npm link                   # puts `mneme` (and the `mem` alias) on your PATH — the hook needs it too
mneme init --write
```

`mneme init --write` is the one-command setup: it installs the session-start hook, writes a
default `~/memory/.scopemap`, and detects whether [Ollama](https://ollama.com) is serving an
embedding model. Run `mneme init` with no flags first to preview exactly what it will change.

- **With Ollama** (`ollama pull nomic-embed-text`) you get semantic search.
- **Without it**, run `mneme init --write` while Ollama is unavailable (or set
  `MNEMOSYNE_EMBEDDER=none`) to configure **tier 0** — keyword (BM25) search that runs fully
  offline. An unreachable Ollama is not an automatic fallback: tier 0 is a mode you select.

(`mneme` is the CLI; `mem` is an alias. A one-command installer that skips the build and link
steps is on the roadmap.)

### What the hook does

The session-start hook runs `mneme context` before your agent's first turn and injects the
current scope's **ambient digest** — a short, budgeted list of the memories that matter right
now — so the agent begins every session already knowing, with nothing to prompt from you. It
is read-only and never blocks a session: on any error it injects an empty digest rather than
fail. It wires up for Claude Code (`mneme init --write`) and the Codex CLI
(`mneme install-hook --harness codex --write`); any other agent can still use Mnemosyne by
calling `mneme` directly — see [Wiring it into an agent](#wiring-it-into-an-agent).

### Where your data lives

Everything is plain files under `~/memory/` (override with `MNEMOSYNE_ROOT`):

- `~/memory/<scope>/*.md` — your memories, one Markdown file each. **This is the source of
  truth**: hand-editable, and browsable in Obsidian.
- `~/memory/.index/` — the search index, **derived and disposable**. Rebuilt on demand
  (`mneme reindex`) and never synced.
- `~/memory/.telemetry/` — a local diagnostic log (slugs and scope names only — never query
  text or note content). Machine-local, never synced or backed up.

Memories are partitioned by **scope** (`personal`, a client, a project). A scope is just a
folder — which is what makes the next part a real delete.

### How to delete it

Because it is all files, deletion is direct — but a complete delete has to reach two things
that live *outside* the scope folder: the derived index (which keeps a searchable copy of note
content) and the telemetry log (which keeps the scope's slugs).

```sh
# Delete one scope completely (e.g. offboarding a client):
rm -rf ~/memory/<scope>                          # 1. the memories themselves (source of truth)
rm -rf ~/memory/.index && mneme reindex          # 2. rebuild the index so its copy is gone too
mneme purge-telemetry --scope <scope> --apply    # 3. drop the scope's slugs from the local log

# Or delete everything Mnemosyne stores — index and telemetry included:
rm -rf ~/memory
```

Deleting only the scope folder is **not** a complete delete: the index under `~/memory/.index/`
still holds the note content until it is rebuilt, and the log under `~/memory/.telemetry/` still
holds the slugs. See [Telemetry, and purging a scope from it](#telemetry-and-purging-a-scope-from-it)
and the client-offboarding runbook in [`docs/tasks.md`](docs/tasks.md) for the full procedure.

## Dreaming, and Anthropic's Dreams API

Anthropic's [Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams) (research
preview) reaches for the same mechanism this project calls dreaming: it takes a memory store
plus past sessions and returns a store with duplicates merged and contradicted entries
replaced. Same name, same two inputs, same operations — with no borrowing in either
direction. The common ancestor is the literature both build on, reflection in Generative
Agents and the Auto-Dreamer/SCM line. Two independent designs arriving at the same place is
a good sign for the idea; where they part is the reason this one exists.

|  | Dreams API | Mnemosyne |
|---|---|---|
| **Where it runs** | The store lives in Anthropic's workspace | Files on your disk, consolidated by a local model. A client scope never leaves the boundary, which is what makes deleting one a real delete |
| **What it does** | Merges duplicates, resolves contradictions | A lifecycle: decay, strength and reinforcement on recall, with archival on the roadmap. The forgetting half of the problem, not only the tidying half |
| **What it reads** | Memory stores belonging to Managed Agents | Markdown any tool can open, Obsidian included |

The pitch here is *your memory, not your harness's*. Dreams is the harness owning your
memory — the clearest illustration available of why the alternative is worth having.

---

## Usage

**Semantic** search uses [Ollama](https://ollama.com) running locally with an embedding model
pulled. Without it, configure **tier 0** (keyword/BM25 search, no external dependency): run
`mneme init --write` while Ollama is unavailable, or set `MNEMOSYNE_EMBEDDER=none`. An
unreachable Ollama is not an automatic fallback — tier 0 is a mode you select.

```sh
ollama pull nomic-embed-text
```

The model is configurable: `OLLAMA_MODEL` picks any embedding model Ollama serves (pull it
first). The vector dimension is **not** configured alongside it — it is derived from the model
(`nomic-embed-text` 768, `bge-m3` 1024, `qwen3-embedding:0.6b` 1024, …). For a model Mnemosyne
does not know, declare its width with `OLLAMA_EMBEDDING_DIM`; without it the client refuses to
start rather than guess, because a wrong dimension writes vectors into an index table of another
width. A declared width that the model then contradicts is rejected on the first batch.

Changing the model invalidates the index: vectors from two models are not comparable. Mnemosyne
notices — the fingerprint, or the table's width, differs from what the index was built with — and
**refuses, rather than rebuilding on its own**:

```sh
mneme reindex --force-embedder    # re-embeds every engram, on purpose
```

Nomic embeddings also use `search_document:` for indexed notes and `search_query:` for searches.
This changes the fingerprint even for an existing `nomic-embed-text` installation, so the first
run after upgrading asks for the same explicit rebuild.

The refusal is the point. Rebuilding costs one embedder call per engram, the lazy reindex inside
`search` and `context` means it would fire at the start of a session, and until it finishes there
is no retrieval. An `OLLAMA_MODEL` that disagrees with the index is a mistyped environment far
more often than a decision — a shell profile the session-start hook never reads is enough to
cause it. A fresh, empty index has nothing to protect and adopts whatever embedder shows up
first, so the first run of a non-default model is not an error.

`mneme context` never fails over this: it serves the digest from the index already on disk and
warns that it is degraded. Nothing is lost either way — the Markdown is the truth and the index
is derived.

Build and run the CLI (`mneme`, alias `mem`):

```sh
npm install && npm run build

# Rebuild the local search index from the store (derived, disposable, never synced)
mneme reindex [--scope <scope>]

# Two-tier search: ranked refs + snippet + score (not whole docs). Reindexes lazily first.
mneme search "<query>" [--scope <scope>] [-k <n>] [--min-cos <number>]

# Fetch one engram in full by slug (reinforces it — decay-on-access).
# --json prints exactly one object: {slug, scope, path, content, revision}
mneme get <slug> [--scope <scope>] [--json]

# Print the current scope's ambient digest — what a session-start hook injects.
# Never fails: on any error it prints an empty digest rather than break session start.
# Capped by a token budget AND by a line count (MNEMOSYNE_CONTEXT_MAX_ENTRIES, default 25)
# so a scope of many tiny notes cannot flood it. `snapshot` notes never appear here.
mneme context [--scope <scope>] [--budget <tokens>] [--cwd <path>]

# Scan text or a file for secrets (read-only; exits non-zero on any reject-level finding, never prints a full secret)
mneme scan "<text>" | --file <path>

# Re-scan notes already on disk — catches secrets pasted by hand in Obsidian, which never
# cross the write-path gate. Read-only: it reports path:line and the masked pattern, and
# never rewrites a note. Same exit code as above.
mneme scan --scope <scope> [--scope <scope2>] | --all [--root <path>]

# Diagnose write-side scope resolution for a path (read-only): prints the fail-closed scope
# (or "unmapped → pass --scope") and whether this machine owns it
mneme scope [<path>]

# Write a new memory (fact or authored note). --file supplies the BODY only, never frontmatter
mneme add "<content>" | --file <path> --type feedback|reference|project|user|snapshot [--scope s] [--cwd path] [--description d] [--importance n] [--slug s]

# Rewrite an existing authored note, compare-and-swap on the revision you read
mneme update <slug> "<body>" | --file <path> --if-match <revision> [--scope s] [--cwd path] [--description d] [--importance n]

# Import one Claude Code native memory directory into one scope (dry run by default)
mneme import-claude --source <dir> --source-id <slug> --scope <scope> [--apply]

# Apply (or revert) a reviewed Dreaming plan — creates derived notes, reversibly.
# Dry run by default; --apply commits. See "Applying a Dreaming plan" below.
mneme dream apply  --run <runId> --scope <scope> [--apply] [--root r]
mneme dream revert --run <runId> --scope <scope> [--apply] [--root r]
```

Diagnostics — for asking *why* a memory ranked where it did, not for daily use:

```sh
mneme explain "<query>" [--scope s] [-k n] [--all]  # per-candidate score breakdown
mneme search "<query>" --explain                    # same, on the normal search path
mneme stats [--json]                                # store + index health
mneme trace <slug>                                  # one engram's event history
mneme snapshot [--list]                             # record / list health over time
mneme purge-telemetry --scope <s>                   # drop a scope from the log (simulates; --apply writes)
```

Search filters candidates on their **raw cosine** and then ranks by cosine relevance
alone (ties broken deterministically by scope then slug); recency and importance keep
their role in the `context` digest, not in the search candidate, so an old or never-read
note does not lose its place for that reason. Callers can still pass explicit
`SearchOptions.weights` to request the recency+importance blend instead.
With `nomic-embed-text` and task prefixes, the default floor is `0.70`; other embedding
models have no default floor until calibrated. `--min-cos` overrides it for a query, and
`MNEMOSYNE_MIN_COS` sets a process-wide override (`-1` effectively disables it).
When nothing qualifies, search prints the best candidate and its cosine and exits with
status `2` (ordinary errors use `1`). `explain` shows candidates rejected by the floor.
The ambient `context` digest has no query vector, so a cosine floor cannot apply there.

A search hit is a **candidate, not an answer**: read it with `get` before relying on it,
and treat an empty result as "nothing cleared the floor", not "nothing exists". When the
floor rejects everything, one bounded floorless retry — `--min-cos=-1 -k 3` — can surface
an answerable note sitting just under the cut (validated in MNE-78: it rescued answerable
notes at cosine 0.63–0.69 with no new false positives). Read up to three and **abstain if
none actually supports the answer**. This is a deliberate single retry, not a reason to
lower the floor globally.

The default was chosen from a small, reproducible local Nomic check: 18 answerable
and 18 unrelated English/Spanish queries, with a positive minimum of `0.735` and
a negative maximum of `0.664` after task prefixes. Run `npm run bench:cosine` with
Ollama serving `nomic-embed-text` to repeat it. This synthetic corpus does not prove
the same separation for a larger or different store; adjust the floor if its
false-positive or false-negative rate warrants it.

To measure how recency and importance alter labeled retrieval results, run
`npm run bench:retrieval` with Ollama serving `nomic-embed-text`. It reuses the
same 18 documents, 18 answerable queries, and 18 unrelated queries, adds fixed
read/creation-age profiles, and sweeps recency weights under two policies for
never-read notes: decay from creation age or the neutral `exp(-1)` prior. The
scorecard reports Recall@5, nDCG@5, MRR, top-5 overlap with cosine-only and
no-recency blended ranking, and the negative-query cosine-floor result. To print
the complete scorecard with its algorithm version, run:

```sh
npm run build && node scripts/calibrate-retrieval.mjs --json
```

The benchmark does not change production defaults; its small, controlled fixture
is a calibration signal, not a quality claim for a private store.

For a private, per-scope 5b-golden evaluation, prepare and review a local query
set, then run it against the current retrieval implementation:

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
```

Omit `--scope` to process every scope in the local store, or repeat for each
scope. Preparation embeds the real corpus with local Ollama and generates
up to 25 questions per scope (or every document for smaller scopes) using the
local `gemma4:e2b` model by default. The
script refuses non-local Ollama hosts and cloud models. Queries are generated
from user situations without copying distinctive note terms; cosine-near
documents receive graded relevance suggestions that must be reviewed by hand.
The private review set and scorecards live under `~/.cache/mnemosyne/5b-golden/`,
outside the repository. The runner uses an in-memory SQLite index, reads access
events without modifying them, and reports graded nDCG@10/MRR plus cold-model
and warm-model p50/p95 latency. Never commit local review sets.
Queries approved with an empty relevance array are treated as unanswerable and
reported separately by false-positive rate; they do not depress nDCG/MRR.
`diagnose` writes a private scorecard with query IDs, ranks, cosine values, and
score signals and unanswerable-query false positives; it never includes query
text, slugs, or note text. It compares
the production blend and cosine floor with pure cosine (recency and importance
weights zero, floor disabled). If the corpus has changed since review, the
command refuses by default. `--allow-corpus-drift` makes an explicitly marked
diagnostic run on the current corpus and excludes queries whose graded notes
are gone. That run uses the current time for decay, so its metrics are not
directly comparable with the original scorecard.

`calibrate` requires a reviewed set whose content and ranking-metadata hashes
match the current corpus. It refuses stale sets, unapproved questions, or fewer
than ten reviewed unanswerable questions per scope. For each query, it captures
the full candidate set once, checks that rescoring reproduces production's
top ten, then compares production, blend without floor, cosine with floor, and
pure cosine. A declared grid sweeps recency and importance weights from `0` to
`0.25` in steps of `0.05`, and cosine floors from `0.65` to `0.72` plus off.
Before writing a scorecard it verifies that neither the corpus nor access
events changed during the run. Scorecards, including any locally reviewed
questions and labels, stay under `MNEMOSYNE_GOLDEN_DIR`; only query IDs and
numeric summaries belong in git.

On the 2026-09-28 Nomic run, the current creation-age policy at recency weight
`0.25` matched the cosine-only baseline (Recall@5 and nDCG@5 both `1.0`). At
`0.40`, creation-age nDCG@5 fell to `0.959`; the neutral-prior comparison stayed
at `1.0` through `0.40`. This fixture supports keeping the current `0.25` and
creation-age behavior as the conservative tested choice. The full versioned
scorecard is [`docs/benchmarks/mne74-nomic-scorecard-2026-09-28.json`](docs/benchmarks/mne74-nomic-scorecard-2026-09-28.json).

### Writing memories (`mneme add`)

`--type feedback|reference|project|user|snapshot` is required; `feedback` writes an
append-only fact, the others write an authored note. Three gates apply, fail-closed:

- **Scope**: an unmapped cwd is refused rather than silently defaulting to `personal` — pass
  `--scope` explicitly (see [Scopes](#scopes) below for `.scopemap`).
- **Ownership**: refuses to write a scope this machine doesn't own per `~/memory/.owner`
  (`{"owns":[...]}`) — a machine never materializes a scope it doesn't own.
- **Secrets**: content is scanned before writing; any reject-level finding aborts the write
  with the offending pattern masked, never echoing the full secret (see `mneme scan` above).
  That gate only sees writes that go through this tool: a note edited by hand in Obsidian
  bypasses it, so `mneme scan --scope <s>` / `--all` re-reads what is already on disk.

A body longer than a sentence belongs in a file: argv quoting mangles blank lines,
indentation and code fences. `--file` reads the body as UTF-8 and nothing else — frontmatter
is the store's to write, never the caller's to supply — so positional text *and* `--file`
together is an error, as is an empty body.

```sh
mneme add --file /tmp/memory-body.md --type project --slug api-constraint --cwd /repo
```

A body whose **first character is `-`** (a bulleted list, the usual shape of an
agent-written note) cannot travel as a bare positional: `parseArgs` reads it as an unknown
option and the command exits 1 before the body is ever resolved. Use `--file`, or put the
body after `--`, with every flag before it:

```sh
mneme add --type reference --scope personal --slug lista -- "- uno
- dos"
```

Authored notes (`reference`/`project`/`user`) refuse to overwrite an existing slug: `add`
creates with `O_EXCL` and tells you the note exists. Changing one is `update`, below.

`(scope, slug)` is unique across the whole scope, facts included, so `add` also refuses a
slug that any other document in that scope already claims — a fact's filename is a fresh
ULID, so without that check a second fact under a claimed slug would land on disk and then
be retrievable by nothing (`reindex` counts it as one more `errors`). Each feedback fact is
its own memory: give it its own `--slug`.

### Snapshots — dated photos of state (`--type snapshot`)

A `snapshot` is an authored note like any other (hand-editable, note = truth, refuses to
overwrite its slug), but it records *where something stood at a moment* — "this project was
at B7, tests half-done, on 2026-10-04" — rather than a durable fact. It is the one kind of
note that is almost always stale soon: the state it photographs moves on.

```sh
mneme add --type snapshot --slug estado-2026-10-04 --description "estado 2026-10-04" \
  --file /tmp/estado.md
```

Two things follow, and both are deliberate:

- **The ambient digest leaves snapshots out.** A session-start digest is a handful of lines
  of durable memory; a stale photo of state — or a flood of them — does not belong there.
  You recall a snapshot deliberately with `mneme search` / `mneme get`, where it ranks and
  reinforces like anything else. Nothing is hidden, only kept out of the always-on view.
- **No TTL.** A snapshot does not expire by a clock, because you cannot know at write time
  when its state stops being true — it might be tomorrow or in a month. It expires by an
  **event**: a newer snapshot, or marking it `--superseded-by` once a later one replaces it,
  and it decays by `strength` like any note. Choosing a type instead of a TTL is the whole
  point (MNE-29).

Separately, the ambient digest is capped not only by its token budget but by a hard **line
count** — `MNEMOSYNE_CONTEXT_MAX_ENTRIES`, default 25 — so a scope of many tiny notes can
never inject a disproportionate share of itself (a real case reached 78% of a scope). The
cap keeps `context` a top-few view, not a feed.

### Rewriting a note (`mneme get --json` → `mneme update --if-match`)

A note is canonical, and two writers want it — an agent in one process, you in `$EDITOR`, a
second machine through the synced folder. Last-write-wins there loses an edit silently, so an
update is a **compare-and-swap on the file's bytes**: read the note, get its revision, write
only if the file is still exactly that.

```sh
mneme get api-constraint --json      # {"slug":…,"scope":…,"path":…,"content":…,"revision":"<sha256>"}
mneme update api-constraint --file /tmp/new-body.md --if-match <sha256> [--description d] [--importance n]
```

- `revision` is the SHA-256 of the whole `.md` file as it is on disk, taken from the same read
  that produced `content` — not a value from the index, and not a hash of the body (which
  would let a frontmatter-only change slip past the check).
- `--if-match` is **required**. There is deliberately no `--force`: on a conflict you are told
  the note changed since you read it and nothing is written. The recovery is to re-read it,
  reconcile your edit against what is now there, and update with the revision that read
  returned — never to retry with a fresh revision, which is just last-write-wins spelled
  differently.
- It never creates a missing note, refuses append-only `feedback` facts (record a new one
  instead), and preserves `name`, `scope`, `type`, `created`, `links` and `sources`. Only the
  body, `description` and `importance` change.
- The write is a sibling temp file renamed over the target, so a reader only ever sees the old
  file or the new one, never half of one. The temp file is fsync'd before the rename and the
  directory after it, so a power cut cannot leave the note's name pointing at data that never
  reached the disk. (On macOS `fsync` stops at the drive cache — `F_FULLFSYNC` is not reachable
  from Node.)

`update` goes through the same three gates as `add` — a new `description` cannot smuggle a
secret past the scanner.

### When a note stops being true (`--superseded-by`)

An agent that learns something changed has, by default, exactly one move: write another note.
That is how a store fills up with near-duplicates that quietly disagree with each other, and
nothing says which one holds. Supersession gives it a second move:

```sh
# "the omada plan replaces the old router plan"
mneme update network-upgrade --superseded-by network-upgrade-mesh --if-match <revision>

# a contradiction somebody noticed and has not resolved yet
mneme update dudosa --status flagged --if-match <revision>

# back to normal; both fields are dropped
mneme update network-upgrade --status active --if-match <revision>
```

Two optional frontmatter fields carry it, and **absent means active**, so every note already
on disk stays valid:

```yaml
status: active | superseded | flagged
superseded_by: the-note-that-replaces-this-one
```

What it does and does not do:

- **Nothing is deleted.** The superseded note stays on disk, `mneme get` still serves it, and
  `search` still finds it. It names its replacement, so the trail is followable.
- **The ambient digest drops it.** That digest is a handful of lines loaded before the agent's
  first turn, and a claim something else has replaced is misleading there — doubly so because
  a high `importance` would put it near the top.
- **`flagged` is not hidden.** An unresolved contradiction is exactly the thing worth
  surfacing, so it ranks like any other note.
- The pair is checked: `superseded` without a pointer is refused, a pointer without
  `superseded` is refused, a note cannot supersede itself, and the replacement must exist in
  the same scope. A pointer at a note nobody can read would hide this one and name nothing.

Detecting a contradiction still needs a model, and that is the consolidation pass's job.
Recording one does not, which is why this works today and without one.

### Pinning a note so it is never archived (`--pinned`)

Archival (*lethe*) decides what to retire by **strength**, and strength today measures "never
surfaced by an inverted ranker" as much as it measures "irrelevant". The dry-run protects
against a bad *run*; a **pin** protects against a bad *input* — it says *this never leaves*,
whatever the signal:

```sh
mneme update api-constraint --pinned   --if-match <revision>   # never archive this
mneme update api-constraint --unpinned --if-match <revision>   # back to normal
```

One optional frontmatter field carries it, and **absent means not pinned**, so every note
already on disk stays valid:

```yaml
pinned: true
```

- It affects **archival only**: a pinned note still decays in the ranking and still reinforces
  on recall — it just never moves to `archive/`. (Archival itself is on the roadmap; the pin is
  the cheap safety net that makes turning it on less risky.)
- Written **by hand or by the agent, never by dreaming** — the same `update` compare-and-swap
  as everything else, so two writers cannot race it.
- `mneme stats` counts pinned notes, so pins cannot quietly grow into a hole that empties the
  point of archival.

### Importing Claude Code's native memory (`mneme import-claude`)

Claude Code keeps its own memory in `~/.claude/projects/<cwd-slug>/memory/*.md`, which this
store never indexed (see [`docs/native-memory-gap.md`](docs/native-memory-gap.md)).
`import-claude` brings **one** explicit directory into **one** explicit scope, idempotently,
without ever modifying the originals.

```sh
mneme import-claude --source /absolute/native/memory --source-id repo-a --scope personal
mneme import-claude --source /absolute/native/memory --source-id repo-a --scope personal --apply
```

- **Dry run is the default**; `--apply` is the opt-in. Both run the owner, schema and secret
  gates, so a dry run cannot promise an import that `--apply` would then refuse.
- The scope is **explicit, always**. Native directory names are not reversible paths (the slug
  replaces `/` with `-`, and `-` occurs in directory names too), so nothing is inferred from
  them and an unknown origin never lands in `personal` by default.
- Identity is a deterministic slug — `claude-<source-id>-<filename-slug>-<hash12>` — and
  sameness is a fingerprint over `(type, description, body)` read from the Markdown, not from
  the index. Re-running with the same `source-id` imports nothing new; content already present
  under any slug is `skipped-identical`; the same slug with different content is a visible
  `conflict`, never an overwrite or an automatic second version.
- One line per file, counters, and a non-zero exit on any conflict or failure. There is no
  batch transaction: a file can fail while the rest import, and re-running is how you resume.
- The importer does not touch the index — run `mneme reindex` afterwards to make what it wrote
  retrievable.

The operational side (source inventory, per-scope checks, instruction block, cutover and
rollback) is [`docs/integrations/canonical-memory-cutover.md`](docs/integrations/canonical-memory-cutover.md).

### Applying a Dreaming plan (`mneme dream apply` / `revert`)

Dreaming's nightly consolidation never writes the store directly. It produces a **plan** — a
reviewable dry-run artifact under `.telemetry/dreams/<scope>/<runId>.json` — and applying it
is this separate, explicit, manual step. No model is invoked here, and nothing runs it on a
schedule.

```sh
mneme dream apply  --run <runId> --scope <scope>            # dry run: show what it would create
mneme dream apply  --run <runId> --scope <scope> --apply    # commit, then reindex
mneme dream revert --run <runId> --scope <scope> --apply    # undo exactly that run
```

What apply does, and deliberately does not:

- **Creates derived notes only.** This first version writes new `dream-…` notes with their
  `sources` provenance in frontmatter. It never edits facts or authored notes, never marks an
  original superseded, never archives, and **does not apply the plan's associative links**
  (those would edit existing notes — out of scope here).
- **Refuses a plan it cannot trust.** Before the first write it revalidates the scope owner,
  the budget, and the **revision of every source** against what the plan recorded. A source
  edited since the plan was reviewed makes the plan *stale* and the whole apply is refused —
  its proposals were synthesised from text that no longer exists.
- **Is idempotent.** Re-running finds the notes it already wrote (exclusive-create) and
  reports them as skipped; it never duplicates. A per-note problem (a secret in the model's
  output, an invalid note) skips that one and is reported; the rest still apply.
- **Is reversible, safely.** `revert` removes exactly the notes the run recorded applying —
  but only if their bytes still match what apply wrote. A derived note you have since edited
  by hand is **kept**, never silently deleted.

Applying runs through the same owner and secret gates and the same scope lock as `mneme add`;
the model's output is treated as untrusted content. Enabling this against a real store is a
deliberate decision, made only once the synthesis has been reviewed favourably — apply is the
mechanism, not the permission.

### Wiring it into an agent

The store knows nothing about any particular agent, and neither does the CLI: everything is
`mneme <command>` against files on disk. So there are two levels of integration, and the
first one works in **any** harness today.

**Level 1 — context file + shell (universal).** Tell the agent the commands exist in whatever
file it already reads on startup: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, a Cursor rule.
Something like:

```md
Persistent memory lives in Mnemosyne (CLI: `mneme`). Use it instead of any built-in
memory store.

- Recall before assuming: `mneme search "<topic>"`, then `mneme get <slug>` for the full note.
- A hit is a candidate, not an answer: open it with `mneme get <slug>` before trusting it. An
  empty search means nothing cleared the relevance floor, not that nothing exists — if it
  matters, retry once without the floor (`mneme search "<topic>" --min-cos=-1 -k 3`), read up
  to three, and if no note supports the answer, say you don't have it rather than guess.
- Save what is durable — a preference, a project constraint, a reference:
  `mneme add "<content>" --type feedback|reference|project|user --slug <kebab-slug>`
- Rewrite a note you already wrote: `mneme get <slug> --json`, then
  `mneme update <slug> "<body>" --if-match <revision>`.
- Always pass `--slug` on `add` (`update` takes the slug positionally, not as a flag).
  Without it the slug is derived from the whole description and you get unusable filenames.
- Don't store what's already in git, or what only matters to one conversation.
```

The ready-made, agent-agnostic version of that block — the one to paste into `~/.claude/CLAUDE.md`
or an `AGENTS.md` — is [`docs/integrations/memory-instructions.md`](docs/integrations/memory-instructions.md).

The agent then recalls on demand. It costs nothing to set up and never breaks, but memory is
only as good as the agent's discipline in asking for it.

**Level 2 — automatic injection at session start (Claude Code, Codex CLI).** A hook runs the
digest before the first turn, so the agent starts every session already knowing:

```sh
mneme install-hook                           # prints the SessionStart snippet for ~/.claude/settings.json
mneme install-hook --write                   # opt-in: merges it into ~/.claude/settings.json

mneme install-hook --harness codex           # the same, for $CODEX_HOME/hooks.json
mneme install-hook --harness codex --write
```

The two harnesses differ in one way that matters. Claude Code injects a hook's raw stdout;
**Codex reads one JSON object and silently drops anything else**, so its hook runs
`mneme context --emit codex-session-start`, which wraps the digest — and keeps wrapping it
when something upstream fails, because under Codex a bare digest is indistinguishable from
no memory at all. Two Codex-specific gotchas, both covered in
[`docs/integrations/canonical-memory-cutover.md`](docs/integrations/canonical-memory-cutover.md):
a freshly written `hooks.json` stays inert until you trust it from the TUI with `/hooks`, and
the default sandbox blocks both the network and writes outside the workspace, which leaves
the digest showing while `search` and `add` quietly fail.

Other harnesses expose an equivalent seam — OpenCode has plugins with an
`experimental.chat.system.transform` hook, Cursor has rules — but nothing is shipped for them
here yet; wire `mneme context` in by hand, or stay on level 1. For **OpenCode** specifically,
[`docs/integrations/opencode.md`](docs/integrations/opencode.md) is the one-page wiring guide
(paste the block into `AGENTS.md`, run `mneme context --cwd` at the start since there is no
hook). A local MCP wrapper (see [`docs/plan.md`](docs/plan.md), Fase 6) is the planned
portable answer for tool-style access.

### More than one agent at a time

Several agents — two harnesses, or two sessions of the same one — can share one store and
both write to it. Each `mneme` invocation is a short-lived process, and the store is built to
survive that:

- **Notes** are created with `O_EXCL`. Two writers racing on the same slug: one wins, the
  other is told the note exists. Never a silent clobber.
- **Rewriting a note is a compare-and-swap** on the file's bytes (`mneme update --if-match`,
  above). Two writers that read the same revision: one updates, the other gets a conflict and
  writes nothing. This is the only check that covers a writer the lock cannot see — another
  machine through the synced folder, or a hand edit — because it asks the file itself.
- **Facts** are one ULID-named file each, append-only. Nothing is ever mutated in place, so
  there is no shared file to corrupt and no merge to lose.
- **Writes take a per-scope lock** — a hidden `<scope>/.mneme-write.lock` created with
  `O_EXCL`, with a bounded wait — so two `mneme` processes never interleave a write to the
  same scope. It coordinates *our* processes on *this* machine and nothing else: Obsidian,
  Syncthing and a hand `vim` ignore it, which is why `O_EXCL` on create stays in place
  regardless. A busy lock is reported, never broken by age (a slow writer may still be
  alive): if one is left behind by a killed process, check no `mneme` is still writing and
  delete the file. Lock files are transient local state — don't sync them.
- **The index** is WAL with a busy timeout and `BEGIN IMMEDIATE` write transactions, so
  concurrent writers wait for each other instead of failing. Note that *every* read command
  is also a writer: `search` and `context` reindex lazily, `get` reinforces hot state.
- **Reinforcement is shared on purpose.** Two agents recalling the same memory reinforce it
  twice, because the hot state is a fold over the append-only event log. It's one person's
  memory, not one agent's.

Two things to respect if you embed the CLI in a long-running agent server rather than calling
it per turn.

**Spawn the binary, don't hold a `Db` handle open** — short-lived writers serialize cleanly, a
resident one camps on the write lock.

**Pass `--cwd <path>` on `context` and `add`.** Without it, scope resolution reads the *calling
process's* cwd, which is the right answer only while the caller is ephemeral and started in the
project — one process per invocation, as a session-start hook does. A server started somewhere
else resolves every session against that one directory: reads inject the wrong scope's digest,
and writes land in the wrong scope's folder **without failing**, because the fail-closed gate
covers "I don't know which scope" and not "I think I know and I'm wrong". That folder is the
compliance boundary, so a misrouted write is not recoverable by deleting the scope later. Only
the caller knows which project a turn belongs to, so it has to say:

```sh
mneme context --cwd /path/to/session/project
mneme add "<content>" --type feedback --cwd /path/to/session/project
```

`--scope` still overrides both.

### Scopes

Map directories to scopes in `~/memory/.scopemap` (machine-local, longest-prefix match):

```
~/Projects/acme     = acme
~/Projects/personal = personal
```

A cwd with no match falls back to `personal` for **reads**. **Writes are fail-closed**: an
unmapped cwd is refused (pass `--scope` explicitly) rather than silently written to `personal`.

Prefixes are matched against the path with symlinks resolved, so it does not matter whether the
map or the caller names the link or its target — both reach the same scope. A prefix that is not
on disk yet (a repo not cloned, a volume not mounted) is still matched literally, so mapping a
directory ahead of time works.

A home-level catch-all (`~ = <scope>`) absorbs any unmapped directory. That is handy with one
scope and a hazard with several — a new, unmapped context lands in an existing scope silently. So
when a write **actually** resolves through the catch-all and more than one scope exists, `mneme`
prints a one-line warning on stderr (not on a read, and not when you pass `--scope`). If the
catch-all is deliberate, declare it once and the warning goes quiet:

```
# catch-all: intentional
~ = personal
~/Projects/acme = acme
```

Declare which scopes a machine may write in `~/memory/.owner` (machine-local, JSON):

```json
{ "owns": ["personal", "acme"] }
```

Absent or malformed → `personal`-only (fail-closed). A machine never materializes a scope it
does not own. The digest is the current scope's ambient view — `mneme search "<topic>"`
recalls across every scope on this machine.

**One owner per scope (shared / multi-machine setups).** `.owner` is machine-local and never
synced, but the `.md` store under a scope often *is* shared across machines (Syncthing). When a
scope lives on more than one machine, exactly **one** of them should own it; the others must
exclude it. This matters because every write — and the nightly dreaming consolidation — runs on
the owner: two machines both owning `personal` would consolidate the same notes twice and can
collide before the sync catches up. The fail-closed default is the trap here — a machine with no
`.owner` owns `personal` by default, so a second machine needs an **explicit** `.owner` that
leaves the shared scope out:

```json
// On the secondary machine (e.g. a laptop that syncs `personal` but should not own it):
{ "owns": [] }            // owns nothing — reads and searches still work, writes/dreaming do not
// …or list only the scopes this machine is the owner of:
{ "owns": ["work-laptop"] }
```

Reads and `search` are unaffected by ownership; only writes and dreaming are gated. (The
nightly dreaming runner is not built yet; until it is, this is a configuration convention —
the per-run enforcement is tracked with the runner.)

Ranking blends relevance (semantic) + recency + importance, relevance-primary by default.
Each signal is scaled across the candidates in the current search before blending, so a
search score describes rank within that query and cannot be compared with another query's
score. For a note never read, recency uses its creation date.
Recall raises its strength and slows retention decay (30-day base interval); ignored memories
decay. Hot state lives
only in the local index — the `.md` files are never mutated by retrieval.

### Telemetry, and purging a scope from it

Retrieval writes a diagnostic event log to `~/memory/.telemetry/` (machine-local: never synced,
never backed up). It records slugs and scope names in clear — never the query text and never a
note's content, only hashes of those.

It also records when an injection was **degraded** — when the digest a session started with was
not what a healthy run would have served. `mneme context` never fails by design, so a failure
otherwise shows up only as a shorter digest, and a short digest is indistinguishable from "you
have little memory" both to the agent reading it and to anyone reading a scorecard. `mneme stats`
reports the share as `degraded injections`, next to `budget utilisation` because the two answer
the question a short digest raises: was it configured that way, or did something break? A budget
that truncated the tail is **not** degradation — that is the utilisation row.

**Prevention comes first.** A scope can be kept out of the log entirely:

```json
// ~/memory/.telemetry.json
{ "enabled": true, "excludeScopes": ["acme"] }
```

`MNEMOSYNE_TELEMETRY=0` disables recording altogether. Set `excludeScopes` for a client scope on
**day one** — then there is nothing to purge later. Note that `mneme stats` still shows an excluded
scope on screen (hiding it on your own machine would only invite turning exclusions off); what the
exclusion guarantees is that nothing about it is *persisted*, neither in the log nor in snapshots.

**Purging is the correction, for when the exclusion came too late:**

```sh
mneme purge-telemetry --scope acme            # simulates: reports what it would remove
mneme purge-telemetry --scope acme --apply    # writes the changes
```

Simulating is the default and `--apply` the opt-in, deliberately: this deletes data that cannot be
regenerated, usually on the day a client relationship ends.

What it does:

- Drops every event naming the scope, and **narrows** multi-scope events rather than deleting them
  — a query over `personal` plus a client scope is still a real `personal` query.
- Deletes a day file left empty by the purge; an empty file would still say *the client was active
  on this date*.
- Redacts the scope from snapshot counts.

What it does **not** do:

- It does not touch `~/memory/<scope>/` — your engrams stay on disk. This purges telemetry only;
  removing the memories themselves is the client-offboarding runbook in [`docs/tasks.md`](docs/tasks.md).
- Snapshot aggregates (`countsByType`, `strengthHistogram`) have no per-scope breakdown, so a purged
  scope stays folded into those totals. The scope *name* and its size are gone, which is what
  identifies a client; if even the totals are unacceptable, delete the snapshots outright.

Why this needs a command at all: `.telemetry/` sits **outside** `~/memory/<scope>/`, so deleting the
scope directory reads as a complete purge while leaving the client's slugs behind in the log.

**Configuration** (env vars):

| Var | Default | Purpose |
|-----|---------|---------|
| `MNEMOSYNE_ROOT` | `~/memory` | Store root (overridden by `--root`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint for embeddings |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model; changing it needs `mneme reindex --force-embedder` |
| `OLLAMA_EMBEDDING_DIM` | — | Vector width for a model Mnemosyne does not know (required for those) |
| `MNEMOSYNE_MIN_COS` | `0.70` for prefixed `nomic-embed-text`; off for other models | Raw cosine floor for search (overridden by `--min-cos`) |
| `MNEMOSYNE_CONTEXT_BUDGET` | `1000` | Token budget for the injected digest (overridden by `--budget`) |
| `MNEMOSYNE_EMBEDDER` | — | `none` runs tier 0: no embedder, `search`/`context` rank by BM25 over FTS (works without Ollama) |
| `MNEMOSYNE_FAKE_EMBED` | — | `1` uses a deterministic fake embedder (tests only) |
| `MNEMOSYNE_TELEMETRY` | on | `0` records nothing; overrides `enabled` in `.telemetry.json` |

---

> **Status:** Fase 0 (data model + migration), Fase 1 (retrieval + scoring + CLI),
> Fase 2A (read integration — `SessionStart` digest hook + `.scopemap`), and Fase 2B
> (write integration — `mneme add` with fail-closed scope, owner policy, and secret
> scanner) complete. **Fase 3** (observability, instrumentation & benchmarking) is under way:
> the clock seam, signal breakdown, telemetry store, lifecycle instrumentation and the
> `stats`/`explain`/`trace` surface and local cosine, recency, and 5b-golden benches are in;
> the benchmark CI gate is not wired yet.
> Then Fase 4 (nightly dreaming/consolidation).
> See [`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md).
>
> Alongside that track, Mnemosyne is being made the **canonical** store for what Claude Code
> learns: `get --json`, `update --if-match`, `add --file` and `import-claude` are implemented
> and tested — the migration of the existing native memory and the cutover itself are an
> operational step that has **not** been run. See
> [`docs/integrations/canonical-memory-cutover.md`](docs/integrations/canonical-memory-cutover.md).

**Glossary** — CLI: `mneme` · a single memory: *engram* · the decay→archive subsystem: *lethe*.

---

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). No CLA.
