# CLI reference

The CLI is `mneme`; `mem` is an alias. Every command reads and writes the store at
`MNEMOSYNE_ROOT` (default `~/memory`); most accept `--root <dir>` to point at another one. How
flags, environment variables and the store's `.config.json` combine is in
[Configuration](../guide/configuration.md).

- **Setup:** [`init`](#init) · [`install-hook` / `uninstall-hook`](#install-hook--uninstall-hook)
- **Reading:** [`search`](#search) · [`get`](#get) · [`context`](#context)
- **Writing:** [`add`](#add) · [`update`](#update) · [`import-claude`](#import-claude)
- **Maintenance:** [`reindex`](#reindex) · [`scan`](#scan) · [`scope`](#scope) · [`dream apply` / `revert`](#dream)
- **Diagnostics:** [`explain`, `stats`, `trace`, `snapshot`, `purge-telemetry`](#diagnostics)
- [Exit status](#exit-status)

## Summary

```sh
# Set up: install the session-start hook, write a default .scopemap, persist the search tier.
# Dry run without --write.
mneme init [--write] [--root r] [--model <name>] [--embedder ollama|none] [--min-cos <n>] [--lexical-floor <n>]

# Rebuild the local search index from the store (derived, disposable, never synced)
mneme reindex [--scope <scope>] [--force-embedder]

# Two-tier search: ranked refs + snippet + score (not whole docs). Reindexes lazily first.
mneme search "<query>" [--scope <scope>] [-k <n>] [--min-cos <number>] [--lexical-floor <bm25>] [--fusion rrf] [--explain] [--json]

# Fetch one engram in full by slug (reinforces it — decay-on-access).
# --json prints exactly one object: {slug, scope, path, content, revision}
mneme get <slug> [--scope <scope>] [--json]

# Print the current scope's ambient digest — what a session-start hook injects.
# Never fails: on any error it prints an empty digest rather than break session start.
mneme context [--scope <scope>] [--budget <tokens>] [--cwd <path>]

# Scan text or a file for secrets (read-only; exits non-zero on any reject-level finding,
# never prints a full secret)
mneme scan "<text>" | --file <path>

# Re-scan notes already on disk — catches secrets pasted by hand, which never cross the
# write-path gate. Read-only: reports path:line and the masked pattern, never rewrites a note.
mneme scan --scope <scope> [--scope <scope2>] | --all [--root <path>]

# Diagnose write-side scope resolution for a path (read-only): prints the fail-closed scope
# (or "unmapped → pass --scope") and whether this machine owns it
mneme scope [<path>]

# Write a new memory (fact or authored note). --file supplies the BODY only, never frontmatter
mneme add "<content>" | --file <path> --type feedback|reference|project|user|snapshot [--scope s] [--cwd path] [--description d] [--importance n] [--slug s]

# Rewrite an existing authored note, compare-and-swap on the revision you read
mneme update <slug> ["<body>" | --file <path>] --if-match <revision> [--scope s] [--cwd path] [--description d] [--importance n]
             [--superseded-by <slug> | --status active|superseded|flagged] [--pinned | --unpinned]

# Import one Claude Code native memory directory into one scope (dry run by default)
mneme import-claude --source <dir> --source-id <slug> --scope <scope> [--apply]

# Apply (or revert) a reviewed Dreaming plan — creates derived notes, reversibly.
# Dry run by default; --apply commits.
mneme dream apply  --run <runId> --scope <scope> [--apply] [--root r]
mneme dream revert --run <runId> --scope <scope> [--apply] [--root r]

# Session-start hook for Claude Code (default) or the Codex CLI. Dry run without --write.
mneme install-hook   [--harness codex] [--write]
mneme uninstall-hook [--harness codex] [--write]
```

---

## init

```sh
mneme init                                         # dry run: hook, scopemap, tier, config it would write
mneme init --write
mneme init --write --model nomic-embed-text-v2-moe --lexical-floor 12
```

What `init --write` does:

- installs the `SessionStart` hook in `~/.claude/settings.json`, running
  `mneme context --root '<absolute store root>'` (the root is always baked in, so the hook reads
  this store whatever the environment at session time);
- writes `<root>/.scopemap` with a catch-all `~ = personal`, only if there is none;
- writes `<root>/.config.json` with the search tier and model (and the floors, if given). For
  `nomic-embed-text-v2-moe` on the embedder tier it also writes `"lexicalFloor": 12` when no
  lexical floor is given or already configured.

| Flag | Meaning |
|---|---|
| `--write` | Apply. Without it, `init` only prints what it would do. |
| `--root <dir>` | The store to initialise. |
| `--model <name>` | Embedding model to save. Must be a model Mnemosyne knows, or come with `OLLAMA_EMBEDDING_DIM`. |
| `--embedder ollama\|none` | Search tier: semantic (Ollama) or tier 0 (keyword, offline). |
| `--min-cos <n>` | Cosine floor to save (`-1`…`1`). |
| `--lexical-floor <n>` | Lexical rescue floor to save. |

Each value comes from the flag, else the environment variable present now (`OLLAMA_MODEL`,
`MNEMOSYNE_MIN_COS`, `MNEMOSYNE_LEXICAL_FLOOR`), else what the store's config already says. The
tier comes from `--embedder`, else the store's existing tier, else detection: the embedder if
Ollama serves the model, tier 0 otherwise. So re-running `init` preserves rather than re-decides.
Values are validated before anything is written. If the chosen tier is the embedder but Ollama
does not serve the model right now, `init` writes the config and warns.

## install-hook / uninstall-hook

```sh
mneme install-hook                           # prints the SessionStart snippet for ~/.claude/settings.json
mneme install-hook --write                   # opt-in: merges it into ~/.claude/settings.json
mneme uninstall-hook [--write]               # removes every `mneme context` SessionStart hook (dry run without --write)

mneme install-hook --harness codex           # the same, for $CODEX_HOME/hooks.json (default ~/.codex)
mneme install-hook --harness codex --write
mneme uninstall-hook --harness codex --write
```

`uninstall-hook` removes only Mnemosyne's hooks and leaves everything else in the file alone. A
settings file that cannot be parsed is never modified. Harness differences (Codex's JSON output,
`/hooks` trust, sandbox) are in [Wiring it into an agent](../integrations/agents.md).

## search

```sh
mneme search "<query>" [--scope <scope>] [-k <n>] [--min-cos <c>] [--lexical-floor <b>] [--fusion rrf] [--explain] [--json]
```

Two-tier: it returns ranked references — slug, snippet, score — not whole documents. Read the one
you need with [`get`](#get). It reindexes lazily first. Without `--scope` it searches every scope
on this machine; `--scope` can be repeated.

How candidates are chosen and ordered:

- In the embedder tier, candidates are filtered on their **raw cosine** against the
  [cosine floor](../guide/configuration.md#cosine-floor), then ranked by cosine relevance alone
  (ties broken by scope, then slug). Recency and importance matter in the `context` digest, not
  here, so an old or never-read note does not lose its place for that reason.
- `--min-cos <c>` overrides the floor for this query (`-1` effectively disables it).
- `--lexical-floor <b>` turns on **lexical rescue**: a note whose raw BM25 score (higher is
  better) reaches `b` is eligible even below the cosine floor. The order is unchanged, so a
  rescued note still competes for the `k` slots. Calibrate it per store; see
  [Lexical rescue floor](../guide/configuration.md#lexical-rescue-floor).
- `--fusion rrf` re-orders the eligible candidates by Reciprocal Rank Fusion (`k=60`) of the
  cosine and BM25 rankings. The cosine floor still gates eligibility. It is opt-in and, measured on
  the project's evaluation set, did not beat pure cosine; see
  [Retrieval internals](../dev/retrieval.md#hybrid-rrf-fusion).
- In tier 0 there is no cosine: BM25 ranks, and the floors do not apply.
- `--explain` prints the per-candidate score breakdown (same as [`explain`](#diagnostics)).

When nothing clears the floor, search prints the best candidate and its cosine and exits with
status `2`.

**A hit is a candidate, not an answer**: read it with `get` before relying on it, and treat an
empty result as "nothing cleared the floor", not "nothing exists". When the floor rejects
everything, one bounded floorless retry — `--min-cos=-1 -k 3` — can surface an answerable note
sitting just under the cut. Read up to three and **abstain if none actually supports the
answer**. This is a deliberate single retry, not a reason to lower the floor globally.

## get

```sh
mneme get <slug> [--scope <scope>] [--json]
```

Prints one memory in full and reinforces it (recall raises its strength and slows its decay).
`--json` prints exactly one object, `{slug, scope, path, content, revision}`, where `revision` is
what [`update --if-match`](#update) needs.

## context

```sh
mneme context [--scope <scope>] [--budget <tokens>] [--cwd <path>]
```

Prints the current scope's ambient digest — what the session-start hook injects. It never fails:
on any error it prints an empty digest (plus a `warning: memory digest degraded (…)` on stderr)
rather than break session start.

- Ranked by relevance, recency and importance.
- Capped by a token budget (`--budget`, `MNEMOSYNE_CONTEXT_BUDGET`, default 1000) **and** by a
  line count (`MNEMOSYNE_CONTEXT_MAX_ENTRIES`, default 25), so a scope of many tiny notes cannot
  inject a disproportionate share of itself. The cap keeps `context` a top-few view, not a feed.
- Snapshots and superseded notes never appear.
- There is no query, so no cosine floor applies.
- `--cwd <path>` resolves the scope from that directory instead of the process's own — required
  when a long-running process calls it on behalf of a session (see
  [Wiring it into an agent](../integrations/agents.md#more-than-one-agent-at-a-time)).
- `--emit codex-session-start` wraps the digest in the JSON object the Codex CLI expects (used by
  the Codex hook).

## add

```sh
mneme add "<content>" | --file <path> --type feedback|reference|project|user|snapshot \
  [--scope s] [--cwd path] [--description d] [--importance n] [--slug s]
```

`--type` is required. `feedback` writes an append-only fact; the others write an authored note
(see [Notes and facts](../guide/concepts.md#notes-and-facts)). Always pass `--slug`: without it
the slug is derived from the whole description and you get unusable filenames.

Three gates apply, fail-closed:

- **Scope**: an unmapped working directory is refused rather than silently defaulting to
  `personal` — pass `--scope` explicitly (see [Scopes](../guide/configuration.md#scopes-scopemap)).
- **Ownership**: refuses to write a scope this machine doesn't own per `~/memory/.owner` — a
  machine never materialises a scope it doesn't own.
- **Secrets**: content is scanned before writing; any reject-level finding aborts the write with
  the offending pattern masked, never echoing the full secret. That gate only sees writes made
  through `mneme`: a note edited by hand bypasses it, so [`mneme scan`](#scan) re-reads what is
  already on disk.

**Long bodies go in a file.** Shell quoting mangles blank lines, indentation and code fences.
`--file` reads the body as UTF-8 and nothing else — frontmatter is the store's to write, never
the caller's to supply — so positional text *and* `--file` together is an error, as is an empty
body.

```sh
mneme add --file /tmp/memory-body.md --type project --slug api-constraint --cwd /path/to/repo
```

**A body whose first character is `-`** (a bulleted list, the usual shape of an agent-written
note) cannot travel as a bare positional: it is read as an unknown option and the command exits 1
before the body is ever read. Use `--file`, or put the body after `--`, with every flag before it:

```sh
mneme add --type reference --scope personal --slug checklist -- "- one
- two"
```

**Slugs are unique.** Authored notes (`reference`/`project`/`user`/`snapshot`) refuse to overwrite
an existing slug: `add` creates the file exclusively and tells you the note exists. Changing one
is [`update`](#update). `(scope, slug)` is unique across the whole scope, facts included, so `add`
also refuses a slug any other document in that scope already claims — a fact's filename is a
fresh ULID, so without that check a second fact under a claimed slug would land on disk and be
retrievable by nothing. Each feedback fact is its own memory: give it its own `--slug`.

### Snapshots (`--type snapshot`)

A `snapshot` is an authored note like any other (hand-editable, the note is the truth, refuses to
overwrite its slug), but it records *where something stood at a moment* — "this project was at
step 7, tests half-done, on 2026-10-04" — rather than a durable fact. It is the one kind of note
that is almost always stale soon.

```sh
mneme add --type snapshot --slug migration-status-2026-10-04 --description "migration status 2026-10-04" \
  --file /tmp/status.md
```

- **The digest leaves snapshots out.** A stale photo of state — or a flood of them — does not
  belong in a handful of always-on lines. Recall a snapshot deliberately with `search` / `get`,
  where it ranks and reinforces like anything else.
- **No TTL.** A snapshot does not expire by a clock, because you cannot know at write time when
  its state stops being true. It expires by an **event** — a newer snapshot, or marking it
  `--superseded-by` the one that replaces it — and decays by strength like any note.

## update

```sh
mneme get api-constraint --json      # {"slug":…,"scope":…,"path":…,"content":…,"revision":"<sha256>"}
mneme update api-constraint --file /tmp/new-body.md --if-match <sha256> [--description d] [--importance n]
```

A note is canonical, and several writers want it — an agent in one process, you in your editor, a
second machine through a synced folder. Last-write-wins there loses an edit silently, so an update
is a **compare-and-swap on the file's bytes**: read the note, get its revision, write only if the
file is still exactly that.

- `revision` is the SHA-256 of the whole `.md` file as it is on disk, taken from the same read
  that produced `content` — not a value from the index, and not a hash of the body (which would
  let a frontmatter-only change slip past the check).
- `--if-match` is **required**. There is deliberately no `--force`: on a conflict you are told the
  note changed since you read it and nothing is written. Re-read it, reconcile your edit with what
  is now there, and update with the revision that read returned — never retry with a fresh
  revision blindly, which is just last-write-wins spelled differently.
- It never creates a missing note, refuses append-only `feedback` facts (record a new one
  instead), and preserves `name`, `scope`, `type`, `created`, `links` and `sources`. Only the
  body, `description`, `importance`, and the lifecycle fields below change.
- The write is a sibling temp file renamed over the target, so a reader only ever sees the old
  file or the new one. The temp file is fsync'd before the rename and the directory after it, so a
  power cut cannot leave the note's name pointing at data that never reached the disk. (On macOS
  `fsync` stops at the drive cache — `F_FULLFSYNC` is not reachable from Node.)

`update` goes through the same three gates as `add` — a new `description` cannot smuggle a secret
past the scanner.

### When a note stops being true (`--superseded-by`)

An agent that learns something changed has, by default, exactly one move: write another note.
That is how a store fills up with near-duplicates that quietly disagree. Supersession gives it a
second move:

```sh
# "the v2 deploy plan replaces the old one"
mneme update deploy-plan --superseded-by deploy-plan-v2 --if-match <revision>

# a contradiction somebody noticed and has not resolved yet
mneme update cache-policy --status flagged --if-match <revision>

# back to normal; both fields are dropped
mneme update deploy-plan --status active --if-match <revision>
```

Two optional frontmatter fields carry it, and **absent means active**, so every note already on
disk stays valid:

```yaml
status: active | superseded | flagged
superseded_by: the-note-that-replaces-this-one
```

- **Nothing is deleted.** The superseded note stays on disk, `get` still serves it, and `search`
  still finds it. It names its replacement, so the trail is followable.
- **The digest drops it.** A claim something else has replaced is misleading in the always-on
  view — doubly so because a high importance would put it near the top.
- **`flagged` is not hidden.** An unresolved contradiction is exactly the thing worth surfacing,
  so it ranks like any other note.
- The pair is checked: `superseded` without a pointer is refused, a pointer without `superseded`
  is refused, a note cannot supersede itself, and the replacement must exist in the same scope.

Detecting a contradiction needs a model, and that is the consolidation pass's job. Recording one
does not, which is why this works today without one.

### Pinning a note so it is never archived (`--pinned`)

Archival (*lethe*, on the roadmap) will decide what to retire by **strength**, and strength
measures "never surfaced" as much as "irrelevant". A **pin** says *this never leaves*, whatever
the signal:

```sh
mneme update api-constraint --pinned   --if-match <revision>   # never archive this
mneme update api-constraint --unpinned --if-match <revision>   # back to normal
```

One optional frontmatter field carries it, and **absent means not pinned**:

```yaml
pinned: true
```

- It affects **archival only**: a pinned note still decays in the ranking and still reinforces on
  recall — it just never moves to `archive/`.
- Written **by hand or by the agent, never by dreaming** — through the same `update`
  compare-and-swap as everything else.
- `mneme stats` counts pinned notes, so pins cannot quietly grow until archival is pointless.

## import-claude

Claude Code keeps its own memory in `~/.claude/projects/<cwd-slug>/memory/*.md`, which
Mnemosyne does not read. `import-claude` brings **one** explicit directory into **one** explicit
scope, idempotently, without ever modifying the originals.

```sh
mneme import-claude --source /absolute/native/memory --source-id repo-a --scope personal
mneme import-claude --source /absolute/native/memory --source-id repo-a --scope personal --apply
```

- **Dry run is the default**; `--apply` is the opt-in. Both run the owner, schema and secret
  gates, so a dry run cannot promise an import that `--apply` would then refuse.
- The scope is **explicit, always**. Native directory names are not reversible paths (the slug
  replaces `/` with `-`, and `-` occurs in directory names too), so nothing is inferred from them
  and an unknown origin never lands in `personal` by default.
- Identity is a deterministic slug — `claude-<source-id>-<filename-slug>-<hash12>` — and sameness
  is a fingerprint over `(type, description, body)` read from the Markdown, not from the index.
  Re-running with the same `source-id` imports nothing new; content already present under any slug
  is `skipped-identical`; the same slug with different content is a visible `conflict`, never an
  overwrite or an automatic second version.
- One line per file, counters, and a non-zero exit on any conflict or failure. There is no batch
  transaction: a file can fail while the rest import, and re-running is how you resume.
- The importer does not touch the index — run `mneme reindex` afterwards to make what it wrote
  retrievable.

## reindex

```sh
mneme reindex [--scope <scope>] [--force-embedder]
```

Rebuilds the local search index from the Markdown (the index is derived, disposable and never
synced). `search` and `context` already reindex lazily, so you rarely need it — except after
`import-claude`, after deleting files, or with `--force-embedder` to re-embed every note on
purpose after [changing the model](../guide/configuration.md#changing-the-model).

## scan

```sh
mneme scan "<text>"                    # scan a text
mneme scan --file <path>               # scan a file
mneme scan --scope <s> [--scope <s2>]  # re-scan notes already in these scopes
mneme scan --all [--root <path>]       # re-scan the whole store
```

Read-only. It reports `path:line` and the masked pattern, never prints a full secret and never
rewrites a note. Exits non-zero on any reject-level finding.

## scope

```sh
mneme scope [<path>]
```

Read-only. Prints the scope a write from that path (default: the current directory) would resolve
to — fail-closed, so possibly "unmapped → pass --scope" — and whether this machine owns it.

## dream

Dreaming's consolidation never writes the store directly. It produces a **plan** — a reviewable
dry-run artifact under `.telemetry/dreams/<scope>/<runId>.json` — and applying it is this
separate, explicit, manual step. No model is invoked here, and nothing runs it on a schedule.

```sh
mneme dream apply  --run <runId> --scope <scope>            # dry run: show what it would create
mneme dream apply  --run <runId> --scope <scope> --apply    # commit, then reindex
mneme dream revert --run <runId> --scope <scope> --apply    # undo exactly that run
```

- **Creates derived notes only.** It writes new `dream-…` notes with their `sources` provenance in
  frontmatter. It never edits facts or authored notes, never marks an original superseded, never
  archives, and does not apply the plan's associative links (those would edit existing notes).
- **Refuses a plan it cannot trust.** Before the first write it revalidates the scope owner, the
  budget, and the **revision of every source** against what the plan recorded. A source edited
  since the plan was reviewed makes the plan *stale*, and the whole apply is refused.
- **Is idempotent.** Re-running finds the notes it already wrote and reports them as skipped. A
  per-note problem (a secret in the model's output, an invalid note) skips that one and is
  reported; the rest still apply.
- **Is reversible, safely.** `revert` removes exactly the notes the run recorded applying — but
  only if their bytes still match what apply wrote. A derived note you have since edited by hand
  is **kept**.
- **Stays searchable.** Both apply and revert run a scoped reindex afterwards. If that reindex
  fails, the mutation still stands and the command says so (run
  `mneme reindex --scope <scope>` to catch up); it never reports full success over a pending index.

Applying goes through the same owner and secret gates and the same scope lock as `add`; the
model's output is treated as untrusted content. Design notes: [Dreaming](../dev/dreaming.md).

## Diagnostics

For asking *why* a memory ranked where it did, not for daily use:

```sh
mneme explain "<query>" [--scope s] [-k n] [--min-cos c] [--lexical-floor b] [--all]  # per-candidate score breakdown
mneme search "<query>" --explain                    # same, on the normal search path
mneme stats [--json]                                # store + index health
mneme trace <slug>                                  # one engram's event history
mneme snapshot [--list]                             # record / list health over time
mneme purge-telemetry --scope <s> [--apply]         # drop a scope from the log (simulates; --apply writes)
```

- `explain` shows candidates rejected by the floor and marks rows admitted by lexical rescue.
- `stats` includes `degraded injections` and `budget utilisation` (see
  [Telemetry](../guide/configuration.md#telemetry)) and the number of pinned notes.
- `purge-telemetry` is described in
  [Purging a scope from telemetry](../guide/configuration.md#purging-a-scope-from-telemetry).

## Exit status

| Status | Meaning |
|---|---|
| `0` | Success. |
| `1` | An error: bad arguments, a refused write, a conflict, a secret found by `scan`. |
| `2` | `search`: nothing cleared the floor (it prints the best candidate). |
