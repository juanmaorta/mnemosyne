# Configuration

Mnemosyne works with no configuration beyond what the installer writes. Everything lives in
small files at the root of the store (`~/memory/` by default):

| File | What it holds |
|---|---|
| [`.config.json`](#the-store-config-configjson) | Search tier, embedding model, search floors. Written by `mneme init`. |
| [`.scopemap`](#scopes-scopemap) | Which directories map to which scope. |
| [`.owner`](#which-scopes-a-machine-may-write-owner) | Which scopes this machine may write. |
| [`.telemetry.json`](#telemetry) | Telemetry on/off and excluded scopes. |

[Environment variables](#environment-variables) override the config for one process or shell.

## The store config (`.config.json`)

`mneme init` saves the embedding model and, if you give them, the search floors in the store's
`.config.json`. Every process that runs `mneme` — the hook, an agent's non-interactive shell —
then uses the same model the index was built with. Nothing has to go in `~/.zshenv`.

```json
{
  "embedder": "ollama",
  "model": "nomic-embed-text-v2-moe"
}
```

| Setting | `init` flag | Env var that overrides it | Meaning |
|---|---|---|---|
| `embedder` | `--embedder ollama\|none` | `MNEMOSYNE_EMBEDDER` | Search tier: `ollama` (semantic) or `none` (tier 0, keyword only). |
| `model` | `--model <name>` | `OLLAMA_MODEL` | Embedding model Ollama serves. |
| `minCos` | `--min-cos <n>` | `MNEMOSYNE_MIN_COS` | Cosine floor for search (`-1` to `1`). |
| `lexicalFloor` | `--lexical-floor <n>` | `MNEMOSYNE_LEXICAL_FLOOR` | Keyword-rescue floor for search ([below](#lexical-rescue-floor)). |

**Precedence: command-line flag > environment variable > `.config.json` > built-in default.**

```sh
mneme init                                   # dry run: shows the config it would write
mneme init --write --model nomic-embed-text-v2-moe
mneme init --write --embedder none           # switch to tier 0
```

Re-running `mneme init --write` **keeps** what the store already has, tier included, instead of
deciding again — an Ollama that happens to be down during an update does not demote a working
store. Values are validated before anything is written.

If you used to set these as environment variables in `~/.zshenv`, run `mneme init --write` once
with them in the environment: it copies them into `.config.json`, and you can then remove them.

### Embedding model

The installer uses **`nomic-embed-text-v2-moe`**, which ranked clearly better than its
predecessor on the project's evaluation set at the same 768 dimensions. Any embedding model
Ollama serves works (pull it first). If a store has no model in its config and no `OLLAMA_MODEL`
is set, the built-in default is `nomic-embed-text`.

The vector width is **not** configured alongside the model; it is derived from it
(`nomic-embed-text` and `nomic-embed-text-v2-moe` 768, `bge-m3` 1024, `qwen3-embedding:0.6b`
1024, …). For a model Mnemosyne does not know, declare the width with `OLLAMA_EMBEDDING_DIM`.
Without it Mnemosyne refuses to start rather than guess, because a wrong width would write
vectors into an index table of another width; a declared width the model then contradicts is
rejected on the first batch.

### Changing the model

Vectors from two models are not comparable, so changing the model invalidates the index.
Mnemosyne notices — the embedder fingerprint, or the table width, differs from what the index
was built with — and **refuses rather than rebuilding on its own**. Rebuild on purpose:

```sh
ollama pull nomic-embed-text-v2-moe
mneme init --write --model nomic-embed-text-v2-moe
mneme reindex --force-embedder          # re-embeds every note with the new model
```

Why a refusal and not an automatic rebuild: rebuilding costs one embedder call per note, the
lazy reindex inside `search` and `context` would fire it at the start of a session, and until it
finished there would be no retrieval. A model that disagrees with the index is a mistyped
environment far more often than a decision. A fresh, empty index has nothing to protect and
adopts whatever embedder shows up first.

`mneme context` never fails over this: it serves the digest from the index already on disk and
warns that it is degraded. Nothing is lost either way — the Markdown is the truth and the index
is derived.

### Cosine floor

In the embedder tier, search drops candidates whose cosine similarity to the query is below a
floor, so unrelated notes do not come back as answers. Each known model has its own calibrated
default, applied automatically:

| Model | Default floor |
|---|---|
| `nomic-embed-text` | `0.70` |
| `nomic-embed-text-v2-moe` | `0.35` |
| any other model | none (no floor) until you calibrate one |

Override it per search with `--min-cos`, for a process with `MNEMOSYNE_MIN_COS`, or for the
store with `mneme init --write --min-cos <n>`. `-1` effectively disables it. When nothing
qualifies, search prints the best candidate and its cosine and exits with status `2`. The digest
(`mneme context`) has no query, so no floor applies there.

### Lexical rescue floor

Off by default. When set, a note whose raw keyword (BM25) score reaches this floor is eligible
even below the cosine floor — a strong match on a rare term is evidence the cosine can miss. The
ranking order is unchanged. The right value depends on your store (its size, the length of its
notes), so there is no default: calibrate it on your own store (see
[Benchmarks and calibration](../dev/benchmarks.md#calibrating-the-floors-for-your-store)), then
save it:

```sh
mneme init --write --lexical-floor 12      # 12 is one store's calibrated value, not a default
```

Raw BM25 drifts as the store grows, so recalibrate after big changes. Tier 0 ignores it (BM25
already ranks there).

## Scopes (`.scopemap`)

Map directories to scopes in `~/memory/.scopemap` — machine-local, longest prefix wins:

```
~/Projects/acme     = acme
~/Projects/personal = personal
```

A directory with no match falls back to `personal` for **reads**. **Writes are fail-closed**: an
unmapped directory is refused (pass `--scope` explicitly) rather than silently written to
`personal`. `mneme scope [<path>]` shows which scope a path resolves to for writing.

Prefixes are matched against the path with symlinks resolved, so it does not matter whether the
map or the caller names the link or its target. A prefix that is not on disk yet (a repository
not cloned, a volume not mounted) is still matched literally, so mapping a directory ahead of
time works.

**The catch-all.** A home-level line, `~ = <scope>`, absorbs every unmapped directory. The
installer writes `~ = personal`. That is handy with one scope and a hazard with several: a new,
unmapped context lands in an existing scope silently. So when a write **actually** resolves
through the catch-all and more than one scope exists, `mneme` prints a one-line warning (not on
reads, and not when you pass `--scope`). If the catch-all is deliberate, declare it and the
warning goes quiet:

```
# catch-all: intentional
~ = personal
~/Projects/acme = acme
```

## Which scopes a machine may write (`.owner`)

Declare which scopes this machine may write in `~/memory/.owner` (machine-local, JSON):

```json
{ "owns": ["personal", "acme"] }
```

Absent or malformed means `personal` only (fail-closed). A machine never writes a scope it does
not own. Reads and `search` are unaffected by ownership; only writes and dreaming are gated.

**One owner per scope on multi-machine setups.** `.owner` is never synced, but the scope folders
often are (Syncthing). When a scope lives on more than one machine, exactly **one** of them
should own it. Every write — and dreaming consolidation — runs on the owner: two machines both
owning `personal` would consolidate the same notes twice and can collide before the sync catches
up. Because the default is to own `personal`, a second machine needs an **explicit** `.owner`
that leaves the shared scope out:

```jsonc
// On a secondary machine that syncs `personal` but should not own it:
{ "owns": [] }            // owns nothing: reads and search work, writes and dreaming do not
// …or list only the scopes this machine owns:
{ "owns": ["work-laptop"] }
```

(The scheduled dreaming runner is not built yet; until it is, this is a configuration
convention.)

## Telemetry

Retrieval writes a diagnostic event log to `~/memory/.telemetry/`, machine-local: never synced,
never backed up. It records slugs and scope names in clear — never the query text and never a
note's content, only hashes of those.

It also records when a session's digest was **degraded** — not what a healthy run would have
served. `mneme context` never fails by design, so a failure otherwise shows up only as a shorter
digest, which looks exactly like "you have little memory". `mneme stats` reports the share as
`degraded injections`, next to `budget utilisation`; a budget that truncated the tail is not
degradation, it is the utilisation row.

**Prevention comes first.** Keep a scope out of the log entirely:

```jsonc
// ~/memory/.telemetry.json
{ "enabled": true, "excludeScopes": ["acme"] }
```

`MNEMOSYNE_TELEMETRY=0` disables recording altogether. Set `excludeScopes` for a client scope on
**day one** — then there is nothing to purge later. `mneme stats` still shows an excluded scope on
screen; what the exclusion guarantees is that nothing about it is *persisted*, neither in the log
nor in snapshots.

### Purging a scope from telemetry

For when the exclusion came too late:

```sh
mneme purge-telemetry --scope acme            # simulates: reports what it would remove
mneme purge-telemetry --scope acme --apply    # writes the changes
```

Simulating is the default and `--apply` the opt-in, deliberately: this deletes data that cannot
be regenerated, usually on the day a client relationship ends.

What it does:

- Drops every event naming the scope, and **narrows** multi-scope events rather than deleting
  them — a query over `personal` plus a client scope is still a real `personal` query.
- Deletes a day file the purge leaves empty; an empty file would still say *the client was active
  on this date*.
- Redacts the scope from snapshot counts.

What it does **not** do:

- It does not touch `~/memory/<scope>/` — the memories stay on disk. Removing those is
  [Deleting memories](everyday-use.md#deleting-memories).
- Snapshot aggregates (`countsByType`, `strengthHistogram`) have no per-scope breakdown, so a
  purged scope stays folded into those totals. The scope *name* and its size are gone, which is
  what identifies a client; if even the totals are unacceptable, delete the snapshots outright.

Why this needs a command at all: `.telemetry/` sits **outside** `~/memory/<scope>/`, so deleting
the scope folder looks like a complete purge while leaving the client's slugs behind in the log.

## Environment variables

Every variable has a working default; with the installer you need none of them. Where a setting
also lives in [`.config.json`](#the-store-config-configjson), the variable overrides the config
and a command-line flag overrides both.

| Variable | Default | Purpose |
|---|---|---|
| `MNEMOSYNE_ROOT` | `~/memory` (the installer's wrappers default to the store they were installed for) | Store root. Overridden by `--root`. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint for embeddings. |
| `OLLAMA_MODEL` | the store's `.config.json`, else `nomic-embed-text` | Embedding model. Changing it needs `mneme reindex --force-embedder`. |
| `OLLAMA_EMBEDDING_DIM` | — | Vector width for a model Mnemosyne does not know (required for those). |
| `MNEMOSYNE_EMBEDDER` | the store's `.config.json` | `none` runs tier 0: no embedder; `search`/`context` rank by BM25 (works without Ollama). |
| `MNEMOSYNE_MIN_COS` | the store's `.config.json`, else `0.70` for `nomic-embed-text`, `0.35` for `nomic-embed-text-v2-moe`, off for other models | Cosine floor for search. Overridden by `--min-cos`. |
| `MNEMOSYNE_LEXICAL_FLOOR` | the store's `.config.json`, else off | Keyword-rescue floor for `search`/`explain`. Overridden by `--lexical-floor`. |
| `MNEMOSYNE_CONTEXT_BUDGET` | `1000` | Token budget for the injected digest. Overridden by `--budget`. |
| `MNEMOSYNE_CONTEXT_MAX_ENTRIES` | `25` | Maximum number of lines in the digest. |
| `MNEMOSYNE_TELEMETRY` | on | `0` records nothing; overrides `enabled` in `.telemetry.json`. |
| `MNEMOSYNE_FAKE_EMBED` | — | `1` uses a deterministic fake embedder. Tests only. |

Variables that only matter when developing or benchmarking Mnemosyne (`MNEMOSYNE_GOLDEN_DIR` and
the like) are in the [developer docs](../dev/benchmarks.md).
