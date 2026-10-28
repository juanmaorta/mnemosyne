# Troubleshooting

Start with these two; they answer most questions:

```sh
mneme stats      # store and index health, degraded injections
mneme context    # exactly what the hook injects in this directory (warnings go to stderr)
```

**Search**

- [The index was built with a different model](#the-index-was-built-with-a-different-model)
- [Ollama is down, or not serving the model](#ollama-is-down-or-not-serving-the-model)
- [Unknown model: "declare its width"](#unknown-model-declare-its-width)
- [Search returns nothing (exit status 2)](#search-returns-nothing-exit-status-2)

**Writing**

- [A write is refused: unmapped scope](#a-write-is-refused-unmapped-scope)
- [Warning: "resolved … via the '~' catch-all"](#warning-resolved--via-the--catch-all)
- [A write is refused: this machine does not own the scope](#a-write-is-refused-this-machine-does-not-own-the-scope)
- [A write is refused: secret detected](#a-write-is-refused-secret-detected)
- [A body starting with `-` fails](#a-body-starting-with---fails)
- [`update` reports a conflict](#update-reports-a-conflict)
- [A busy write lock that never clears](#a-busy-write-lock-that-never-clears)

**The session hook**

- [The new session starts without memories](#the-new-session-starts-without-memories)
- [Codex: the hook does nothing, or search/add fail inside Codex](#codex-the-hook-does-nothing-or-searchadd-fail-inside-codex)

**The installer**

- [The installer stops: "no terminal to ask for confirmation"](#the-installer-stops-no-terminal-to-ask-for-confirmation)
- [Installing dependencies failed](#installing-dependencies-failed)
- [`~/.local/bin/mneme` exists and was not created by this installer](#localbinmneme-exists-and-was-not-created-by-this-installer)
- [`git pull failed` during update](#git-pull-failed-during-update)
- [The CLAUDE.md block was not added](#the-claudemd-block-was-not-added)
- [`Could not parse settings.json`](#could-not-parse-settingsjson)

---

## The index was built with a different model

`search` or `reindex` refuses because the embedder fingerprint (or the vector width) differs from
the one the index was built with. Vectors from two models cannot be compared, and Mnemosyne will
not silently rebuild — see [Changing the model](configuration.md#changing-the-model).

1. Check which model this process is using. The usual cause is an `OLLAMA_MODEL` in your shell
   that disagrees with the store's `.config.json` — the environment variable wins.
   `cat ~/memory/.config.json`, and `echo $OLLAMA_MODEL`.
2. If the environment is wrong, unset the variable (or fix it). Nothing else to do.
3. If you really changed the model, rebuild on purpose:
   `mneme init --write --model <name>` and then `mneme reindex --force-embedder`.

Upgrading from an old version can trigger this once even without a model change: Nomic models
now use task prefixes (`search_document:` / `search_query:`), which changes the fingerprint. The
fix is the same explicit `mneme reindex --force-embedder`.

Meanwhile the session digest still works: `mneme context` serves it from the index on disk and
warns that it is degraded.

## Ollama is down, or not serving the model

A store configured for the embedder tier does **not** fall back to keyword search on its own:
`search` fails until Ollama answers. (`mneme init` warns: *Ollama is not serving '…' right now.*)

- Start it: `ollama serve`, or open the Ollama app.
- Make sure the model is there: `ollama list`, then `ollama pull <model>` (the model is the one
  in `~/memory/.config.json`).
- Check the endpoint: `OLLAMA_HOST` (default `http://localhost:11434`).

If you would rather not depend on Ollama, switch the store to tier 0 (keyword search, offline):

```sh
mneme init --write --embedder none
```

For one command only, `MNEMOSYNE_EMBEDDER=none mneme search "…"` does the same.

## Unknown model: "declare its width"

Mnemosyne refuses to start with an embedding model whose vector width it does not know, rather
than guess. Declare it, e.g. `OLLAMA_EMBEDDING_DIM=1024`, using the dimension the model's
documentation gives. A declared width the model contradicts is rejected on the first batch.

## Search returns nothing (exit status 2)

Status `2` means nothing cleared the [cosine floor](configuration.md#cosine-floor); search prints
the best candidate and its cosine. It does not mean the store has nothing on the topic.

- Try other words, or one bounded retry without the floor: `mneme search "<query>" --min-cos=-1 -k 3`,
  then read the results with `mneme get` and judge whether they actually answer.
- `mneme explain "<query>"` shows every candidate and why it was rejected.
- If true answers are consistently just under the floor on your store, calibrate it (or the
  [lexical rescue floor](configuration.md#lexical-rescue-floor)) rather than lowering it blindly.
- In a brand-new store, check there is something to find: `mneme stats`.

## A write is refused: unmapped scope

`mneme add` refuses when the current directory maps to no scope. That is deliberate: guessing the
scope is how a client's memory ends up in the wrong folder. Either pass `--scope <scope>`, or map
the directory in `~/memory/.scopemap` (see [Scopes](configuration.md#scopes-scopemap)).
`mneme scope` shows how the current directory resolves.

## Warning: "resolved … via the '~' catch-all"

A write landed in a scope only because of the home-level catch-all (`~ = …`), and more than one
scope exists. Map the directory explicitly, or, if the catch-all is intended, add a
`# catch-all: intentional` line to `.scopemap`. See
[the catch-all](configuration.md#scopes-scopemap).

## A write is refused: this machine does not own the scope

Writes are allowed only to scopes listed in `~/memory/.owner`; with no `.owner`, only `personal`.
Add the scope to `owns` — but on a multi-machine setup, make sure only **one** machine owns each
scope. See [`.owner`](configuration.md#which-scopes-a-machine-may-write-owner).

## A write is refused: secret detected

Every write is scanned for secrets, and a reject-level finding aborts it with the pattern masked.
Remove the secret from the content; never try to store credentials. To check text beforehand:
`mneme scan "<text>"`. Notes edited by hand bypass the gate; `mneme scan --all` re-checks the
store (read-only).

## A body starting with `-` fails

A body whose first character is `-` (a bulleted list) is read as an unknown option. Put it after
`--`, with every flag before it, or use `--file`. See [`mneme add`](../reference/cli.md#add).

## `update` reports a conflict

The note changed since you read it (another agent, another machine through sync, or a hand edit),
and nothing was written. Re-read it with `mneme get <slug> --json`, reconcile your edit with what
is there now, and update with the new revision. There is deliberately no `--force`.

## A busy write lock that never clears

Writes take a per-scope lock, `<scope>/.mneme-write.lock`. A busy lock is reported, never broken
by age, because a slow writer may still be alive. If a killed process left one behind, check that
no `mneme` is still running and delete the file.

## The new session starts without memories

1. Open a **new** session: the hook runs only at session start.
2. Check the hook is installed: `~/.claude/settings.json` should contain a `SessionStart` hook
   running `mneme context`. `mneme init` (dry run) shows what it would install; `mneme init --write`
   installs it.
3. Check `mneme` is found from a fresh shell: `command -v mneme`. If not, add `~/.local/bin` to
   your `PATH` in your shell's startup file (zsh: `~/.zshenv`; bash: `~/.bashrc` and `~/.profile`).
4. Run `mneme context` in the project directory. An empty digest with a `warning: memory digest
   degraded (…)` on stderr names what failed; `mneme stats` shows how often it happens.
5. Check the scope: the digest is for the directory's scope only (`mneme scope` shows it).
   Memories saved in another scope are found by `search`, but are not in this digest.

## Codex: the hook does nothing, or search/add fail inside Codex

- A freshly written `hooks.json` stays inert until you trust it from the Codex TUI with `/hooks`.
- Codex's default sandbox blocks the network and writes outside the workspace. The digest still
  appears, but `search` (which needs Ollama over the network) and `add` (which writes to
  `~/memory`) quietly fail. Allow them in your Codex sandbox settings.

More in [Wiring it into an agent](../integrations/agents.md#level-2--automatic-injection-at-session-start).

## The installer stops: "no terminal to ask for confirmation"

Under CI or a pipe with no terminal, nobody can answer the prompt, so the installer stops and
changes nothing. Review the plan (`--dry-run`), then re-run with `--yes`
(through a pipe: `| sh -s -- --yes`).

## Installing dependencies failed

`npm ci` failed, usually because a native module (`better-sqlite3`, `sqlite-vec`) had to be
compiled and there is no compiler. Install the build tools and re-run:
macOS `xcode-select --install`; Linux `sudo apt-get install -y build-essential python3`.

## `~/.local/bin/mneme` exists and was not created by this installer

There is already a `mneme` there (from `npm link`, say). The installer will not overwrite what it
did not create. Remove it, or install the wrappers elsewhere with `--bin-dir`.

## `git pull failed` during update

The installer's clone in `~/.mnemosyne` has local changes or has diverged. Nothing else was
changed. Inspect it with `git -C ~/.mnemosyne status`, discard or move your changes, and re-run
the update.

## The CLAUDE.md block was not added

If `~/.claude/CLAUDE.md` already mentions `mneme`, the installer assumes you have your own
instructions and does not add its block. If you want it, paste the block from
[`memory-instructions.md`](../integrations/memory-instructions.md) yourself. With `--no-claude-md`
it is never added.

## `Could not parse settings.json`

`mneme init` and `mneme uninstall-hook` never modify a settings file they cannot parse. Fix the
JSON in `~/.claude/settings.json` (or restore `settings.json.before-mnemosyne`) and re-run.
