# Getting started

From nothing to an agent that remembers, in about five minutes. Everything here is what
[`install.sh`](../../install.sh) does; if the two ever disagree, the script is right and this
page is a bug.

- [Requirements](#requirements)
- [Search tiers: with or without Ollama](#search-tiers-with-or-without-ollama)
- [Install](#install)
- [Verify](#verify)
- [Update](#update)
- [Uninstall](#uninstall)
- [Installer options](#installer-options)
- [Installing by hand](#installing-by-hand)

## Requirements

macOS or Linux. The installer checks each item, prints `[ok]`, `[warn]` or `[MISSING]`, and for
anything that is not there gives the exact command that fixes it. Only `[MISSING]` items stop
it — and when they do, nothing has been changed.

| Requirement | Status | Why | Fix the installer suggests |
|---|---|---|---|
| **Node.js ≥ 20** | required | Mnemosyne is a Node.js program. | macOS: `brew install node@22` (or nodejs.org, or `nvm install 22`). Linux: `nvm install 22`. |
| **npm** | required | Ships with Node.js. Used only to fetch dependencies — Mnemosyne itself is not on npm. | Same as Node.js. |
| **git** | required (unless you run the installer from your own clone) | Downloads the code and updates it later. | macOS: `xcode-select --install`. Linux: `sudo apt-get install -y git` (Fedora: `sudo dnf install -y git`). |
| C/C++ build tools | warning only | The SQLite modules (`better-sqlite3`, `sqlite-vec`) are native. npm normally downloads a prebuilt binary and compiles only when none matches your machine. | macOS: `xcode-select --install`. Linux: `sudo apt-get install -y build-essential python3` (Fedora: `sudo dnf install -y gcc-c++ make python3`). |
| **Claude Code** (`claude`) | warning only | The agent Mnemosyne wires into. Mnemosyne installs anyway; the session hook does something only once Claude Code is installed. | `curl -fsSL https://claude.ai/install.sh \| bash` |
| [Ollama](https://ollama.com) | optional | Semantic search. See the next section. | `ollama serve` (or open the Ollama app) if it is installed but not running. |

Ollama is checked over HTTP (`$OLLAMA_HOST/api/tags`, default `http://localhost:11434`), so the
check never starts it as a side effect.

If `npm ci` fails during the build, the usual cause is a native module that had to be compiled
without a compiler: install the build tools above and re-run.

## Search tiers: with or without Ollama

Mnemosyne searches your notes in one of two tiers. The installer picks one for you and saves it
in the store's [`.config.json`](configuration.md#the-store-config-configjson), so every process
that runs `mneme` uses the same one.

| Tier | Needs | What you get |
|---|---|---|
| **Embedder** (semantic) | Ollama running locally, serving an embedding model. The installer uses `nomic-embed-text-v2-moe` (a download of a few hundred MB). | Finds a note by **meaning**, even when it shares no words with your query. |
| **Tier 0** (keyword) | Nothing. Fully offline. | Keyword search (BM25) over your notes. What you lose is semantic search: finding a note by meaning when it shares no words with your query. |

How the installer decides, on a fresh install:

- Ollama is running and already has the model → embedder tier.
- Ollama is running without the model → it offers `ollama pull nomic-embed-text-v2-moe` as part
  of the plan you confirm (`--no-ollama-pull` to decline). If the pull fails, it continues in
  tier 0.
- Ollama is not installed, not running, or you declined the pull → **tier 0**, and the installer
  prints how to add semantic search later.

An Ollama that is down later is **not** an automatic fallback to tier 0: a store configured for
the embedder stays on it, and search fails until Ollama is back (see
[Troubleshooting](troubleshooting.md#ollama-is-down-or-not-serving-the-model)). Tier 0 is a mode
you choose.

### Adding semantic search later

These are the four steps the installer prints:

```sh
# 1. install Ollama: https://ollama.com/download
ollama pull nomic-embed-text-v2-moe                                   # 2. the model
mneme init --write --embedder ollama --model nomic-embed-text-v2-moe  # 3. switch the store's tier
rm -rf ~/memory/.index && mneme reindex                               # 4. rebuild the index
```

Step 4 only rebuilds the search index, which is derived: your notes are untouched.

## Install

Preview first — this runs every check and prints the full plan, then stops:

```sh
curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh -s -- --dry-run
```

Then install:

```sh
curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh
```

Or from a clone, if you prefer to read the script before running it. A clone is used **in
place**: the installer builds it where it is, never pulls it for you, and never deletes it.

```sh
git clone https://github.com/juanmaorta/mnemosyne.git
cd mnemosyne
./install.sh --dry-run
./install.sh
```

### What it changes

Before touching anything, the installer prints this plan and asks `Go ahead? [y/N]`. It asks
through the terminal, so the prompt works under `curl | sh`; with no terminal at all (CI, a
pipe) it stops and changes nothing unless you pass `--yes`.

- **code** — `git clone` into `~/.mnemosyne` (or your clone, used in place), then
  `npm ci && npm run build` inside it. Dependencies stay in that folder.
- **commands** — `~/.local/bin/mneme` and `~/.local/bin/mem`: small wrappers that run the built
  CLI with an absolute path to `node` (so the hook works without your shell's `nvm`/`asdf`
  setup) and default to your store.
- **hook** — a `SessionStart` hook that runs `mneme context --root '<store>'`, added to
  `~/.claude/settings.json`. Other settings are untouched; the original file is saved once as
  `settings.json.before-mnemosyne`.
- **data** — your memories live in `~/memory` as plain Markdown files. Existing notes are never
  touched. Added if missing: `.scopemap` (with a catch-all `~ = personal`) and `.config.json`
  (search tier and model, so no environment variables are needed).
- **CLAUDE.md** — a block, between `<!-- mnemosyne:begin … -->` and `<!-- mnemosyne:end -->`
  markers, telling Claude to use `mneme` for memory, appended to `~/.claude/CLAUDE.md`. It is
  skipped if that file already mentions `mneme`; `--no-claude-md` opts out. The block's text is
  [`docs/integrations/memory-instructions.md`](../integrations/memory-instructions.md).
- **ollama** — `ollama pull nomic-embed-text-v2-moe`, only if Ollama is running without the
  model and you did not pass `--no-ollama-pull`.

If `~/.local/bin` is not on your `PATH`, the plan says so and prints the line to add. **The
installer does not edit your shell files**; add it yourself to your shell's startup file (zsh:
`~/.zshenv`; bash: `~/.bashrc` and `~/.profile`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

This matters: the hook runs `mneme`, so it has to be found from a fresh shell.

## Verify

When the installer finishes it prints the next steps. Try them:

```sh
mneme add "I prefer short answers" --type user --slug short-answers
mneme search "answers"
```

`search` returns a short list of matching notes (slug, snippet, score); `mneme get short-answers`
prints the note in full. Then:

- Run `mneme context` in a project directory: that is the digest the hook injects. A store with
  one note prints a digest with one line.
- Open a **new** Claude Code session. It starts with that digest already in context — ask it
  what it knows about your answer preferences.
- `mneme stats` reports the store and index health.

If something is off, see [Troubleshooting](troubleshooting.md).

Already using Claude Code's built-in memory? [Migrating from native memory](migrating-from-native-memory.md)
imports it and switches it off, so there is one store instead of two.

## Update

The installer installs the **latest release** — the highest `vX.Y.Z` tag of the repository — not
whatever is on `main`. When a newer release is published, the next session tells you, once, in
the memory digest:

```
Mnemosyne v0.2.0 is available (you have v0.1.0) — run `mneme upgrade`.
```

To update:

```sh
mneme upgrade              # shows the plan and asks; --dry-run to only look, --yes to not ask
```

`mneme upgrade` runs `~/.mnemosyne/install.sh update`, which you can also run directly. It
fetches the release tags, moves the installer's clone to the newest one (refusing if you edited
files in it), rebuilds, re-runs `mneme init` — which **keeps** your config, hook and
`.scopemap` — and brings the search index up to date with `mneme reindex`. The `CLAUDE.md` block
is refreshed only if a previous install added it (its markers are there). Your data is untouched.
Update is idempotent: run it again on the latest release and nothing changes.

`mneme --version` says which version you are on (and, in a git checkout, the exact tag or commit).

**Your own clone** (installed with `./install.sh` from inside it) is never moved: `git pull` it
yourself, then `npm ci && npm run build`. `mneme upgrade` says so, and the new-version notice
is off for it.

**Following a branch** instead of releases — the development channel — is
`MNEMOSYNE_BRANCH=main sh ~/.mnemosyne/install.sh update` (or the same variable on the first
install). The variable has to be set on every update; without it, update goes back to the latest
release.

How the new-version check works, what it sends and how to turn it off:
[Configuration](configuration.md#the-new-version-check).

Update **never changes the embedding model** a store already uses — replacing it would leave an
index Mnemosyne refuses to use until a full rebuild. Pass `--model <name>` to choose one
explicitly (and see [changing the model](configuration.md#changing-the-model)).

## Uninstall

```sh
sh ~/.mnemosyne/install.sh uninstall                 # keeps ~/memory
sh ~/.mnemosyne/install.sh uninstall --delete-data   # ...and deletes ~/memory too (asks twice)
```

Uninstall removes exactly what install added, and only that:

- **hook** — every `mneme context` SessionStart hook in `~/.claude/settings.json` (via
  `mneme uninstall-hook --write`); the rest of the file is left alone.
- **CLAUDE.md** — the block between the Mnemosyne markers, leaving the rest of the file
  byte-identical.
- **commands** — `mneme` and `mem` in `~/.local/bin`, but only the wrappers the installer wrote
  (a `mneme` you linked yourself is never removed).
- **code** — `~/.mnemosyne`, but only if the installer cloned it. Your own clone is kept.
- **data** — `~/memory` is **kept**: your memories are plain Markdown and still yours.
  `--delete-data` deletes it — every memory, its index and its telemetry — after a second
  confirmation. This cannot be undone. Copies synced to other machines are not touched.

Not touched: Node.js, Ollama and its models (remove the model with
`ollama rm nomic-embed-text-v2-moe`).

To delete only some memories — one scope, say — rather than everything, see
[Deleting memories](everyday-use.md#deleting-memories).

## Installer options

Every command (`install`, the default; `update`; `uninstall`) accepts:

| Option | Meaning |
|---|---|
| `--dry-run` | Say what would happen and change nothing. |
| `-y`, `--yes` | Do not ask for confirmation (required when there is no terminal). Through a pipe: `\| sh -s -- --yes`. |
| `--dir DIR` | Where the code lives (default `~/.mnemosyne`). |
| `--bin-dir DIR` | Where `mneme` and `mem` go (default `~/.local/bin`). |
| `--root DIR` | Where your memories live (default `$MNEMOSYNE_ROOT`, else `~/memory`). The hook and the wrappers both default to that store; `MNEMOSYNE_ROOT` still overrides it at run time. |
| `--model NAME` | Embedding model for Ollama (default `nomic-embed-text-v2-moe`). |
| `--no-ollama-pull` | Never download the embedding model. |
| `--no-claude-md` | Do not add the memory instructions block to `~/.claude/CLAUDE.md`. |
| `--no-build` | Use the checkout as already built (development). |
| `--delete-data` | `uninstall` only: also delete the memory store. |
| `-h`, `--help` | The script's own help. |

The defaults can also come from the environment: `MNEMOSYNE_INSTALL_DIR` (`--dir`),
`MNEMOSYNE_BIN_DIR` (`--bin-dir`), `MNEMOSYNE_ROOT` (`--root`), and `MNEMOSYNE_REPO_URL` for
where the code is cloned from (default: this repository). Which version: the latest release tag,
or — when `MNEMOSYNE_BRANCH` is set — the tip of that branch. A repository with no release tags
yet falls back to `main`, and the plan says so.

## Installing by hand

Underneath, the installer runs `mneme init --write`. You can do the same from a manual build:

```sh
git clone https://github.com/juanmaorta/mnemosyne.git && cd mnemosyne
npm install && npm run build && npm link     # puts mneme and mem on your PATH
mneme init                                   # dry run: shows the hook, scopemap, tier and config
mneme init --write
```

`mneme init --write` installs the session-start hook in `~/.claude/settings.json`, writes a
default `~/memory/.scopemap` if there is none, and saves the search tier in
`~/memory/.config.json` — the embedder if Ollama serves the model, tier 0 otherwise. Re-running
it keeps what the store already has; choose explicitly with `--embedder ollama|none` and
`--model <name>`. All its flags are in the [CLI reference](../reference/cli.md#init).

For the Codex CLI, or an agent with no hook, see
[Wiring it into an agent](../integrations/agents.md).

Next: [Concepts](concepts.md).
