# Concepts

What Mnemosyne keeps, where, and how it brings it back. Five ideas cover almost everything:

- [Memories are files](#memories-are-files)
- [Scopes](#scopes)
- [Notes and facts](#notes-and-facts)
- [Recall: how memories come back](#recall-how-memories-come-back)
- [The session-start hook](#the-session-start-hook)
- [Dreaming](#dreaming)
- [Glossary](#glossary)

## Memories are files

Everything is plain files under `~/memory/` (another location with `--root` or
`MNEMOSYNE_ROOT`):

- `~/memory/<scope>/*.md` — your memories, one Markdown file each, with a small YAML
  frontmatter. **This is the source of truth**: hand-editable, and browsable in Obsidian or any
  editor.
- `~/memory/<scope>/facts/*.md` — append-only facts (see [Notes and facts](#notes-and-facts)).
- `~/memory/.index/` — the search index, **derived and disposable**. Rebuilt on demand
  (`mneme reindex`) and never synced. Deleting it loses nothing.
- `~/memory/.telemetry/` — a local diagnostic log (slugs and scope names only — never query
  text or note content). Machine-local, never synced or backed up. See
  [Telemetry](configuration.md#telemetry).
- `~/memory/.config.json`, `.scopemap`, `.owner`, `.telemetry.json` — settings, described in
  [Configuration](configuration.md). `.scopemap` and `.owner` are machine-local: do not sync them.

Because the Markdown is the truth and the index is derived, you can sync the scope folders
between machines (with Syncthing, say) and let each machine build its own index.

## Scopes

Memories are partitioned by **scope**: `personal`, `work`, a client such as `acme`, a project.
A scope is just a folder under `~/memory/`, which is what makes it a real boundary — deleting a
client's scope deletes the client's memories, and nothing about them leaks into another scope.

Which scope applies is decided by the directory you (or your agent) are working in, through
`~/memory/.scopemap`:

```
~/Projects/acme     = acme
~/Projects/personal = personal
```

- **Reads** (the session digest) use the scope of the current directory, and fall back to
  `personal` when nothing matches. `mneme search` looks across every scope on this machine.
- **Writes are fail-closed.** If the current directory maps to no scope, `mneme add` refuses
  rather than guessing — pass `--scope` explicitly. Guessing is how a client's memory ends up in
  the wrong folder, and that cannot be undone by deleting the folder later.

The installer's default `.scopemap` is a single catch-all, `~ = personal`, which is right while
you have one scope. Once you have several, map each project directory explicitly, and list the
scopes this machine may write in `.owner`. Details —
prefix matching, the catch-all warning, and which scopes a machine may write (`.owner`) — are in
[Configuration](configuration.md#scopes-scopemap).

## Notes and facts

Every memory has a `--type`, and the type decides which of two kinds it is:

| Kind | Types | Behaviour |
|---|---|---|
| **Authored note** | `user`, `reference`, `project`, `snapshot` | One file per slug, the truth about something. Hand-editable. Never silently overwritten: changing one is an explicit `update`. |
| **Fact** | `feedback` | An observation, appended to the scope's `facts/` folder. Never edited in place: a new observation is a new fact with its own slug. |

What the types are for:

- `user` — who you are: role, expertise, preferences.
- `feedback` — guidance or corrections you gave the agent, ideally with the reason.
- `project` — ongoing work, goals and constraints.
- `reference` — pointers to things outside the store: URLs, dashboards, tickets.
- `snapshot` — a dated photo of where something stood ("the migration was at step 7 on
  2026-10-04"). Snapshots go stale by nature, so they are left out of the session digest; you
  find them with `search`. They do not expire by a clock, because you cannot know at write time
  when their state stops being true — a newer snapshot replaces them.

Each memory also has a **slug** (its kebab-case name, unique within the scope), a one-line
**description**, and an **importance** from 1 to 10.

A note that stops being true does not have to be deleted. It can be marked **superseded** by
the note that replaces it — it stays on disk and searchable, but stops appearing in the digest —
or **flagged** as an unresolved contradiction, which keeps it visible on purpose. A note can
also be **pinned** so a future archival pass never retires it. See
[Everyday use](everyday-use.md#when-something-changes).

## Recall: how memories come back

There are two ways a memory reaches the agent.

**The ambient digest** — `mneme context` — is a short list of the memories that matter right
now in the current scope, injected at the start of every session by the
[hook](#the-session-start-hook). It is ranked by **relevance, recency and importance**, capped
by a token budget (1000 by default) *and* by a line count (25 entries), so a scope with many
tiny notes cannot flood the context. Snapshots and superseded notes are left out.

**Search** — `mneme search "<query>"` — is what the agent runs when it needs something specific.
It is two-tier on purpose: search returns references (slug, snippet, score), not whole
documents, and `mneme get <slug>` fetches the one worth reading. Search ranks by relevance to
the query alone, so an old or rarely-read note is not penalised for that.

Two rules make search trustworthy:

- **A hit is a candidate, not an answer.** Read it with `get` before relying on it.
- **An empty result means "nothing cleared the relevance floor"**, not "nothing exists". In
  the embedder tier, search drops candidates below a minimum similarity (the *cosine floor*) so
  that unrelated notes do not come back as if they were answers. When the floor rejects
  everything, one bounded retry without it (`--min-cos=-1 -k 3`) can surface a note sitting just
  under the cut; read up to three, and if none supports the answer, the right response is "I
  don't have that", not a guess. The [instruction block](../integrations/memory-instructions.md)
  the installer adds tells the agent exactly this.

**Memory that behaves like memory.** Recalling a memory (`get`) reinforces it: its strength
rises and it decays more slowly (spaced repetition, 30-day base interval). Memories you never
use fade in the digest ranking. This "hot state" lives only in the local index — retrieval never
modifies your Markdown files.

How ranking and the floors work in detail, and how they were measured:
[Retrieval internals](../dev/retrieval.md).

## The session-start hook

The hook runs `mneme context` before your agent's first turn and injects the current scope's
digest, so the agent begins every session already knowing — with nothing to prompt from you.

- It is **read-only**, and it **never blocks a session**: on any error it injects an empty
  digest rather than fail, and records the injection as *degraded* (visible in `mneme stats`)
  so a broken digest does not silently look like "you have little memory".
- It is installed for **Claude Code** (`~/.claude/settings.json`) by the installer or
  `mneme init --write`, and for the **Codex CLI** with `mneme install-hook --harness codex --write`.
- Any other agent can still use Mnemosyne by running `mneme` itself — see
  [Wiring it into an agent](../integrations/agents.md).

The hook covers *reading*. *Writing* — saving something new — is the agent's job, guided by the
instruction block in `~/.claude/CLAUDE.md`. See [Everyday use](everyday-use.md).

## Dreaming

> **In development.** Dreaming is not something you can run yet. It is here because it is where
> the project is going, and feedback on the design is welcome.

*Dreaming* is a consolidation pass that distills raw facts into curated notes and links related
memories, without growing what gets loaded into context. It never writes your store on its own:
it produces a **plan** you review, and applying that plan is a separate, explicit, reversible
step.

- **Built:** applying a reviewed plan and reverting it, with their guarantees — derived notes
  only, a plan whose sources changed since is refused, an exact undo that keeps notes you edited
  by hand (`mneme dream apply` / `revert`, see the [CLI reference](../reference/cli.md#dream)).
  The synthesis that writes the plan exists too, and is being evaluated against real notes.
- **Not built yet:** a command that generates a plan — so today there is no plan for
  `dream apply` to use —, running it on a schedule, and archiving what has faded (*lethe*).

Design notes, what exists in detail, and how it compares to Anthropic's Dreams API:
[Dreaming](../dev/dreaming.md).

## Glossary

| Term | Meaning |
|---|---|
| `mneme` | The CLI. `mem` is an alias. |
| engram | A single memory (one file). |
| scope | A partition of the store; one folder. |
| digest | The short, budgeted list of memories injected at session start (`mneme context`). |
| tier 0 | Search without an embedder: keyword (BM25) only, fully offline. |
| cosine floor | The minimum similarity a search candidate needs in the embedder tier. |
| lethe | The decay → archive subsystem (archival is on the roadmap). |
| dreaming | Offline consolidation of facts into notes (in development). |
