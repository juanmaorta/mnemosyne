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

# Scan text or a file for secrets (read-only; exits non-zero on any reject-level finding, never prints a full secret)
mneme scan "<text>" | --file <path>

# Diagnose write-side scope resolution for a path (read-only): prints the fail-closed scope
# (or "unmapped → pass --scope") and whether this machine owns it
mneme scope [<path>]

# Write a new memory (fact or authored note)
mneme add "<content>" --type feedback|reference|project|user [--scope s] [--description d] [--importance n] [--slug s]
```

### Writing memories (`mneme add`)

`--type feedback|reference|project|user` is required; `feedback` writes an append-only fact,
the others write an authored note. Three gates apply, fail-closed:

- **Scope**: an unmapped cwd is refused rather than silently defaulting to `personal` — pass
  `--scope` explicitly (see [Session auto-injection](#session-auto-injection-claude-code) below
  for `.scopemap`).
- **Ownership**: refuses to write a scope this machine doesn't own per `~/memory/.owner`
  (`{"owns":[...]}`) — a machine never materializes a scope it doesn't own.
- **Secrets**: content is scanned before writing; any reject-level finding aborts the write
  with the offending pattern masked, never echoing the full secret (see `mneme scan` above).

Authored notes (`reference`/`project`/`user`) refuse to overwrite an existing slug — edit the
`.md` file directly instead of re-running `add`.

### Session auto-injection (Claude Code)

Inject the current scope's memory digest at session start:

```sh
mneme install-hook            # prints the SessionStart snippet for ~/.claude/settings.json
mneme install-hook --write    # opt-in: merges it into ~/.claude/settings.json
```

Map directories to scopes in `~/memory/.scopemap` (machine-local, longest-prefix match):

```
~/Projects/acme     = acme
~/Projects/personal = personal
```

A cwd with no match falls back to `personal` for **reads**. **Writes are fail-closed**: an
unmapped cwd is refused (pass `--scope` explicitly) rather than silently written to `personal`.

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

**Configuration** (env vars):

| Var | Default | Purpose |
|-----|---------|---------|
| `MNEMOSYNE_ROOT` | `~/memory` | Store root (overridden by `--root`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint for embeddings |
| `MNEMOSYNE_FAKE_EMBED` | — | `1` uses a deterministic fake embedder (tests only) |

---

> **Status:** Fase 0 (data model + migration) and Fase 1 (retrieval + scoring + CLI) complete.
> See [`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md).

**Glossary** — CLI: `mneme` · a single memory: *engram* · the decay→archive subsystem: *lethe*.
