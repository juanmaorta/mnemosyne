# Wiring Mnemosyne into an agent

The store knows nothing about any particular agent, and neither does the CLI: everything is
`mneme <command>` against files on disk. So there are two levels of integration, and the first
one works in **any** harness today. The installer sets up both for Claude Code.

- [Level 1 — context file + shell (universal)](#level-1--context-file--shell-universal)
- [Level 2 — automatic injection at session start](#level-2--automatic-injection-at-session-start)
- [Other harnesses](#other-harnesses)
- [More than one agent at a time](#more-than-one-agent-at-a-time)

## Level 1 — context file + shell (universal)

Tell the agent the commands exist, in whatever file it already reads on startup: `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, a Cursor rule. Something like:

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

The ready-made, agent-agnostic version of that block — the one the installer appends to
`~/.claude/CLAUDE.md`, and the one to paste into an `AGENTS.md` — is
[`memory-instructions.md`](memory-instructions.md).

The agent then recalls on demand. It costs nothing to set up and never breaks, but memory is only
as good as the agent's discipline in asking for it.

## Level 2 — automatic injection at session start

For **Claude Code** and the **Codex CLI**, a hook runs the digest before the first turn, so the
agent starts every session already knowing:

```sh
mneme install-hook                           # prints the SessionStart snippet for ~/.claude/settings.json
mneme install-hook --write                   # opt-in: merges it into ~/.claude/settings.json
mneme uninstall-hook [--write]               # removes every `mneme context` SessionStart hook (dry run without --write)

mneme install-hook --harness codex           # the same, for $CODEX_HOME/hooks.json (default ~/.codex)
mneme install-hook --harness codex --write
```

For Claude Code, the installer (or `mneme init --write`) already does this.

The two harnesses differ in one way that matters. Claude Code injects a hook's raw stdout;
**Codex reads one JSON object and silently drops anything else**, so its hook runs
`mneme context --emit codex-session-start`, which wraps the digest — and keeps wrapping it when
something upstream fails, because under Codex a bare digest is indistinguishable from no memory
at all. Two Codex-specific gotchas:

- A freshly written `hooks.json` stays **inert until you trust it** from the Codex TUI with
  `/hooks`.
- Codex's default **sandbox blocks both the network and writes outside the workspace**, which
  leaves the digest showing while `search` (Ollama is reached over the network) and `add` (it
  writes to `~/memory`) quietly fail. Allow both for `mneme` in your sandbox settings.

For Codex, also paste the [instruction block](memory-instructions.md) into `~/.codex/AGENTS.md`.

## Other harnesses

Other harnesses expose an equivalent seam — OpenCode has plugins with an
`experimental.chat.system.transform` hook, Cursor has rules — but nothing is shipped for them
yet; wire `mneme context` in by hand, or stay on level 1.

- **OpenCode**: [`opencode.md`](opencode.md) is the one-page guide (paste the block into
  `AGENTS.md`, and have the agent run `mneme context --cwd` at the start, since there is no hook).
- A local MCP server wrapping the CLI is planned, as the portable answer for tool-style access.

## More than one agent at a time

Several agents — two harnesses, or two sessions of the same one — can share one store and both
write to it. Each `mneme` invocation is a short-lived process, and the store is built to survive
that:

- **Notes** are created exclusively (`O_EXCL`). Two writers racing on the same slug: one wins,
  the other is told the note exists. Never a silent clobber.
- **Rewriting a note is a compare-and-swap** on the file's bytes
  ([`mneme update --if-match`](../reference/cli.md#update)). Two writers that read the same
  revision: one updates, the other gets a conflict and writes nothing. This is the only check that
  covers a writer the lock cannot see — another machine through a synced folder, or a hand edit —
  because it asks the file itself.
- **Facts** are one ULID-named file each, append-only. Nothing is mutated in place, so there is no
  shared file to corrupt and no merge to lose.
- **Writes take a per-scope lock** — a hidden `<scope>/.mneme-write.lock` created exclusively,
  with a bounded wait — so two `mneme` processes never interleave a write to the same scope. It
  coordinates *our* processes on *this* machine and nothing else: Obsidian, Syncthing and a hand
  `vim` ignore it, which is why exclusive create stays in place regardless. A busy lock is
  reported, never broken by age (a slow writer may still be alive): if a killed process left one
  behind, check no `mneme` is still writing and delete the file. Lock files are transient local
  state — don't sync them.
- **The index** uses SQLite WAL with a busy timeout and `BEGIN IMMEDIATE` write transactions, so
  concurrent writers wait for each other instead of failing. *Every* read command is also a
  writer: `search` and `context` reindex lazily, `get` reinforces hot state.
- **Reinforcement is shared on purpose.** Two agents recalling the same memory reinforce it twice,
  because the hot state is a fold over the append-only event log. It's one person's memory, not
  one agent's.

### Embedding the CLI in a long-running agent server

Two things to respect if you call the CLI from a long-running process rather than per turn.

**Spawn the binary, don't hold a database handle open.** Short-lived writers serialise cleanly; a
resident one camps on the write lock.

**Pass `--cwd <path>` on `context` and `add`.** Without it, scope resolution reads the *calling
process's* working directory, which is right only while the caller is ephemeral and started in the
project — one process per invocation, as a session-start hook does. A server started somewhere
else resolves every session against that one directory: reads inject the wrong scope's digest,
and writes land in the wrong scope's folder **without failing**, because the fail-closed gate
covers "I don't know which scope" and not "I think I know and I'm wrong". That folder is the
compliance boundary, so a misrouted write is not recoverable by deleting the scope later. Only
the caller knows which project a turn belongs to, so it has to say:

```sh
mneme context --cwd /path/to/session/project
mneme add "<content>" --type feedback --slug <kebab-slug> --cwd /path/to/session/project
```

`--scope` still overrides both.
