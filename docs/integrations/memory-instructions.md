# Memory instruction block (agent-agnostic)

What this is: the text pasted verbatim into `~/.claude/CLAUDE.md` (Claude Code),
`~/.codex/AGENTS.md` (Codex CLI) and the `AGENTS.md` that OpenCode reads. It is the same block
for all three: it names no harness and only uses real `mneme` CLI commands.

The installer (`install.sh`) copies the fenced block below into `~/.claude/CLAUDE.md` between
its own markers, so whatever is inside the ` ````md ` fence is exactly what the agent reads.
How to wire it into each agent: [Wiring it into an agent](agents.md). Moving an existing
setup off the harness's native memory:
[Migrating from native memory](../guide/migrating-from-native-memory.md).

Every example works literally against the current CLI (once the `<placeholders>` are
replaced). When editing it, check every flag against `src/cli.ts` first: a flag invented here
becomes a write the agent believes it made.

---

## The block (copy all of it)

````md
## Durable memory — Mnemosyne (`mneme` CLI)

Durable memory lives in `~/memory` and is accessed only through `mneme`. Do not create or use
any other memory store, including the harness's native memory.

When you start working on a project:

```sh
mneme context --cwd /real/path/to/the/project
```

Before assuming something, and before creating a note on a topic that may already exist:

```sh
mneme search "<topic>"         # returns refs + snippet, NOT the document
mneme get <slug>               # full content; a search result is not the same as reading it
```

Save as soon as it comes up — a preference, a correction, a reusable constraint — not only at
the end of the session. Do not save code or anything derivable from git (branches, authors,
diffs, history): that is already in the repository.

```sh
# New observation (feedback is append-only: each observation is a new fact with its own
# slug; reusing a slug already taken in that scope is rejected, exit 1)
mneme add "<observation>" --type feedback --slug <new-slug> --cwd /real/path/to/the/project

# New authored note
mneme add "<content>" --type reference --slug <stable-slug> --cwd /real/path/to/the/project
```

`--type` is required: `feedback` (append-only fact) | `reference` | `project` | `user`
(authored, editable notes). A body that starts with `-` (a bulleted list) cannot be passed as
a bare positional: use `--file`, or put it after `--` with the flags first
(`mneme add --type reference --slug <slug> -- "- one"`). For long bodies, use `--file` with a
file that contains ONLY the body, never frontmatter (passing positional text and `--file`
together is an error):

```sh
mneme add --file /tmp/body.md --type project --slug <stable-slug> --cwd /real/path/to/the/project
```

To change an existing authored note: read it, reconcile, write against the revision you read.

```sh
mneme get <slug> --json        # prints one object: {slug, scope, path, content, revision}
mneme update <slug> "<new body>" --if-match <revision> --cwd /real/path/to/the/project
```

`--if-match` is required and there is no `--force`. If it answers
`conflict: <slug> changed since you read it`, another writer won: go back to
`mneme get <slug> --json`, reconcile your change against that content and update with the new
revision. Never retry with another revision without re-reading, and never duplicate the note.

A `feedback` fact is never updated: add a new one (`mneme add ... --type feedback`).

Non-negotiable rules:

- Pass `--slug` on every `add`: it is the note's identity. `update` takes the slug as a
  positional argument, not as a flag, and `context` does not accept it in any form.
- Pass `--cwd` with the session's real working directory to `add`, `update` and `context`.
  Without it the scope is resolved against the process's directory, which may not be the
  project's.
- Do not invent flags. `add` and `update` fail with `Unknown option '--x'` and exit 1, but
  `context` swallows the error and returns an EMPTY digest of the default scope with exit 0:
  it will look as if there is no memory when what there is is a mistyped command.
- If the cwd does not map to any scope, the write fails on purpose
  (`cannot resolve a scope for this cwd`). Ask which scope it belongs to; do not conclude it
  is `personal` just because it is unmapped.
- A freshly created note is not indexed yet: `mneme get` will not find it until you run
  `mneme search "<topic>"` (it reindexes before searching) or `mneme reindex`.
- If saving fails, say so and quote the error. Never claim it was saved, and never fall back
  to writing into the native memory or any other file.
````

---

## Notes for whoever maintains the block

- **Why `--slug` only on `add`.** Without `--slug`, the slug is derived from the whole
  description and produces unusable file names. For authored notes the slug is the identity
  `update` uses later; for `feedback`, each fact needs its own because the index enforces
  `(scope, slug)` uniqueness. A slug already claimed in that scope is rejected at write time
  (`slug '<slug>' is already claimed in scope '<scope>' by <path>`, exit 1, nothing on disk):
  previously the second file was written and left unindexed, visible only as `errors 1` in
  `mneme reindex`.
- **Why the warning about bodies starting with `-`.** Node's `parseArgs` rejects a positional
  that starts with `-` before the command reads anything: `Unknown option '- '` and exit 1.
  With the "if saving fails, say so" rule, the agent reports a failed save over a misplaced
  quote. `--file` and `--` are the two forms that do work.
- **Why `get` after `search`.** `search` returns score + slug + snippet, not the document.
  `get` reads the whole `.md` (frontmatter included) and reinforces the memory.
- **Why the index warning.** `get` resolves the slug against the store's SQLite index
  (`<root>/.index/store.db`, with `<root>` = `MNEMOSYNE_ROOT` or `~/memory`), which is derived
  state; `search` and `context` reindex lazily before querying, `get` does not.
- **Why the no-invented-flags rule.** `add` and `update` let `parseArgs` fail and return exit
  1, but `context` wraps its whole body in a catch that cannot fail (see the `context` command
  in `src/cli.ts`): an unknown flag there produces an empty digest of the default scope, exit
  0, and only a `warning: memory digest degraded (fatal)` on stderr.
- **Why there is no `--force`.** An `update` is a compare-and-swap over the file's bytes. The
  only correct recovery from a conflict is to re-read and reconcile; see
  `src/write/update.ts`.
