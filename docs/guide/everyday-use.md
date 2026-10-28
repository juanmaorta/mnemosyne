# Everyday use

Once installed, most of Mnemosyne runs without you. This page is about the split: what happens
on its own, what you ask your agent for, and the few things you do by hand.

- [What happens on its own](#what-happens-on-its-own)
- [What to ask your agent](#what-to-ask-your-agent)
- [Doing it yourself](#doing-it-yourself)
- [When something changes](#when-something-changes)
- [Working in several contexts](#working-in-several-contexts)
- [Deleting memories](#deleting-memories)

## What happens on its own

- **At the start of every session**, the hook injects the current scope's digest. The agent
  starts already knowing your preferences and the project's constraints.
- **The agent recalls on demand.** The instruction block the installer adds to
  `~/.claude/CLAUDE.md` tells it to search before assuming, to read a hit before trusting it, and
  to say "I don't have that" rather than guess when nothing supports an answer.
- **The agent saves what is durable** — a preference, a correction, a project constraint, a
  reference — as it comes up, not only at the end of a session. It is told not to store code or
  anything git already knows.
- **Recall reinforces.** Every memory read with `get` gets a little stronger; memories nobody
  reads fade in the digest. Nothing in your files changes when this happens.
- **The index maintains itself.** `search` and `context` reindex lazily when notes have changed,
  including notes you edited by hand.

## What to ask your agent

Plain language works; the agent translates it into `mneme` commands.

| You say | The agent does |
|---|---|
| "Remember that I prefer short answers." | `mneme add "…" --type user --slug short-answers` |
| "From now on, always run the linter before committing in this repo." | Saves a `feedback` fact in the project's scope. |
| "Note that the billing API is limited to 100 requests a minute." | Saves a `project` note. |
| "Keep the link to the staging dashboard." | Saves a `reference` note. |
| "What do you know about the deploy process?" | `mneme search "deploy process"`, then `mneme get` on the best hit. |
| "That note about the API limit is out of date; it's 500 now." | Reads the note and updates it (compare-and-swap on the version it read). |
| "Write down where we left the migration today." | Saves a dated `snapshot`. |

If the agent ever saves into the wrong place, or with an unusable slug, tell it — and check the
instruction block is in its context (`~/.claude/CLAUDE.md` for Claude Code, `AGENTS.md` for
others).

## Doing it yourself

Everything the agent does, you can do from a shell. The commands you will actually use:

```sh
mneme search "deploy"                 # ranked references, not whole notes
mneme get deploy-process              # one note in full
mneme add "Staging is reset every Monday" --type project --slug staging-reset
mneme context                         # what the hook would inject here
mneme stats                           # store and index health
```

Long bodies belong in a file (`--file`), and a body starting with `-` needs `--` before it; see
[`mneme add`](../reference/cli.md#add). You can also simply **edit the Markdown** in your editor or
Obsidian: the files are the truth, and the index catches up on the next search. A note edited by
hand bypasses the secret scanner, so `mneme scan --all` now and then is a good habit.

The full command list is the [CLI reference](../reference/cli.md).

## When something changes

Do not let near-duplicates pile up. A note that is no longer true can be:

- **updated** — rewrite its body (`mneme update`, which refuses if the note changed since it was
  read, so two writers never lose each other's edits);
- **superseded** — kept for the record but marked as replaced by another note; it stays
  searchable and leaves the digest;
- **flagged** — marked as an unresolved contradiction, which keeps it visible;
- **pinned** — protected from any future archival, whatever its strength.

Facts (`feedback`) are never edited: a new observation is a new fact. Commands and examples:
[Rewriting a note](../reference/cli.md#update) and
[Marking a note superseded](../reference/cli.md#when-a-note-stops-being-true---superseded-by).

## Working in several contexts

If you keep work, clients or projects apart, give each one a scope. Two steps:

1. Map its directories in `~/memory/.scopemap`:

   ```
   ~/Projects/acme = acme
   ~/Projects/oss  = personal
   ```

2. Let this machine write it, in `~/memory/.owner` (without an `.owner` file a machine may write
   only `personal`):

   ```json
   { "owns": ["personal", "acme"] }
   ```

From then on, a session started in `~/Projects/acme` gets the `acme` digest and saves into
`acme`. A directory that maps to nothing gets the `personal` digest but **cannot be written to**
without an explicit `--scope`. Remember to replace the installer's catch-all (`~ = personal`)
once you have more than one scope, or acknowledge it — see
[Configuration](configuration.md#scopes-scopemap).

For a client scope, also keep it out of telemetry from day one:
[Telemetry](configuration.md#telemetry).

## Deleting memories

Because it is all files, deletion is direct — but a complete delete has to reach two things
that live *outside* the scope folder: the derived index (which keeps a searchable copy of note
content) and the telemetry log (which keeps the scope's slugs).

```sh
# Delete one scope completely (e.g. when a client engagement ends):
rm -rf ~/memory/<scope>                          # 1. the memories themselves (source of truth)
rm -rf ~/memory/.index && mneme reindex          # 2. rebuild the index so its copy is gone too
mneme purge-telemetry --scope <scope> --apply    # 3. drop the scope's slugs from the local log

# Or delete everything Mnemosyne stores — index and telemetry included:
rm -rf ~/memory
```

Deleting only the scope folder is **not** a complete delete: the index under `~/memory/.index/`
still holds the note content until it is rebuilt, and the log under `~/memory/.telemetry/` still
holds the slugs. Also remove the scope's line from `.scopemap` and `.owner`, and remember that
copies synced to other machines need the same treatment there. What `purge-telemetry` does and
does not remove is in [Telemetry](configuration.md#purging-a-scope-from-telemetry).

To delete a single note, delete its file and run `mneme reindex`.
