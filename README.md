# Mnemosyne

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

---

## Usage

Requires [Ollama](https://ollama.com) running locally with the embedding model pulled:

```sh
ollama pull nomic-embed-text
```

Build and run the CLI (`mneme`, alias `mem`):

```sh
npm install && npm run build

# Rebuild the local search index from the store (derived, disposable, never synced)
mneme reindex [--scope <scope>]

# Two-tier search: ranked refs + snippet + score (not whole docs). Reindexes lazily first.
mneme search "<query>" [--scope <scope>] [-k <n>]

# Fetch one engram in full by slug (reinforces it — decay-on-access)
mneme get <slug> [--scope <scope>]

# Print the current scope's ambient digest — what a session-start hook injects.
# Never fails: on any error it prints an empty digest rather than break session start.
mneme context [--scope <scope>] [--budget <tokens>] [--cwd <path>]

# Scan text or a file for secrets (read-only; exits non-zero on any reject-level finding, never prints a full secret)
mneme scan "<text>" | --file <path>

# Diagnose write-side scope resolution for a path (read-only): prints the fail-closed scope
# (or "unmapped → pass --scope") and whether this machine owns it
mneme scope [<path>]

# Write a new memory (fact or authored note)
mneme add "<content>" --type feedback|reference|project|user [--scope s] [--cwd path] [--description d] [--importance n] [--slug s]
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

### Writing memories (`mneme add`)

`--type feedback|reference|project|user` is required; `feedback` writes an append-only fact,
the others write an authored note. Three gates apply, fail-closed:

- **Scope**: an unmapped cwd is refused rather than silently defaulting to `personal` — pass
  `--scope` explicitly (see [Scopes](#scopes) below for `.scopemap`).
- **Ownership**: refuses to write a scope this machine doesn't own per `~/memory/.owner`
  (`{"owns":[...]}`) — a machine never materializes a scope it doesn't own.
- **Secrets**: content is scanned before writing; any reject-level finding aborts the write
  with the offending pattern masked, never echoing the full secret (see `mneme scan` above).

Authored notes (`reference`/`project`/`user`) refuse to overwrite an existing slug — edit the
`.md` file directly instead of re-running `add`.

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
- Save what is durable — a preference, a project constraint, a reference:
  `mneme add "<content>" --type feedback|reference|project|user --slug <kebab-slug>`
- Always pass `--slug`. Without it the slug is derived from the whole description and you
  get unusable filenames.
- Don't store what's already in git, or what only matters to one conversation.
```

The agent then recalls on demand. It costs nothing to set up and never breaks, but memory is
only as good as the agent's discipline in asking for it.

**Level 2 — automatic injection at session start (Claude Code).** A hook runs the digest
before the first turn, so the agent starts every session already knowing:

```sh
mneme install-hook            # prints the SessionStart snippet for ~/.claude/settings.json
mneme install-hook --write    # opt-in: merges it into ~/.claude/settings.json
```

`install-hook` only knows Claude Code's settings file. Other harnesses expose an equivalent
seam — OpenCode has plugins with an `experimental.chat.system.transform` hook, Cursor has
rules — but nothing is shipped for them here yet; wire `mneme context` in by hand, or stay on
level 1. A local MCP wrapper (see [`docs/plan.md`](docs/plan.md), Fase 6) is the planned
portable answer for tool-style access.

### More than one agent at a time

Several agents — two harnesses, or two sessions of the same one — can share one store and
both write to it. Each `mneme` invocation is a short-lived process, and the store is built to
survive that:

- **Notes** are created with `O_EXCL`. Two writers racing on the same slug: one wins, the
  other is told the note exists. Never a silent clobber.
- **Facts** are one ULID-named file each, append-only. Nothing is ever mutated in place, so
  there is no shared file to corrupt and no merge to lose.
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

Declare which scopes a machine may write in `~/memory/.owner` (machine-local, JSON):

```json
{ "owns": ["personal", "acme"] }
```

Absent or malformed → `personal`-only (fail-closed). A machine never materializes a scope it
does not own. The digest is the current scope's ambient view — `mneme search "<topic>"`
recalls across every scope on this machine.

Ranking blends relevance (semantic) + recency + importance, relevance-primary by default.
Recall reinforces a memory; ignored memories decay (spaced repetition). Hot state lives
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
| `MNEMOSYNE_CONTEXT_BUDGET` | `1000` | Token budget for the injected digest (overridden by `--budget`) |
| `MNEMOSYNE_FAKE_EMBED` | — | `1` uses a deterministic fake embedder (tests only) |
| `MNEMOSYNE_TELEMETRY` | on | `0` records nothing; overrides `enabled` in `.telemetry.json` |

---

> **Status:** Fase 0 (data model + migration), Fase 1 (retrieval + scoring + CLI),
> Fase 2A (read integration — `SessionStart` digest hook + `.scopemap`), and Fase 2B
> (write integration — `mneme add` with fail-closed scope, owner policy, and secret
> scanner) complete. **Fase 3** (observability, instrumentation & benchmarking) is under way:
> the clock seam, signal breakdown, telemetry store, lifecycle instrumentation and the
> `stats`/`explain`/`trace` surface are in; the benchmark harness and its CI gate are not.
> Then Fase 4 (nightly dreaming/consolidation).
> See [`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md).

**Glossary** — CLI: `mneme` · a single memory: *engram* · the decay→archive subsystem: *lethe*.
