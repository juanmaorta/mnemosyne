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
| **Node.js ≥ 20** | required | Mnemosyne is a Node.js program. | macOS: the LTS installer from [nodejs.org](https://nodejs.org/en/download) (or `brew install node`, or `nvm install --lts`). Linux: `nvm install 22`. |
| **npm** | required | Ships with Node.js. Used only to fetch dependencies — Mnemosyne itself is not on npm. | Same as Node.js. |
| **git** | required (unless you run the installer from your own clone) | Downloads the code and updates it later. | macOS: `xcode-select --install`. Linux: `sudo apt-get install -y git` (Fedora: `sudo dnf install -y git`). |
| C/C++ build tools | warning only | The SQLite modules (`better-sqlite3`, `sqlite-vec`) are native. npm normally downloads a prebuilt binary and compiles only when none matches your machine. | macOS: `xcode-select --install`. Linux: `sudo apt-get install -y build-essential python3` (Fedora: `sudo dnf install -y gcc-c++ make python3`). |
| An agent: **Claude Code** (`claude`), the **Codex CLI** (`codex`), **OpenCode** (`opencode`) | warning only | The installer wires into every one it finds (on the `PATH`, or its config folder). None found: it wires Claude Code and installs anyway. | Claude Code: `curl -fsSL https://claude.ai/install.sh \| bash`. Codex: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`. OpenCode: [opencode.ai](https://opencode.ai/docs). |
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
| **Embedder** (semantic) | Ollama running locally, serving an embedding model. The installer uses `nomic-embed-text-v2-moe` (a download of about 960 MB). Once it is downloaded, it works offline too. | Finds a note by **meaning**, even when it shares no words with your query. |
| **Tier 0** (keyword) | Nothing else to install. | Keyword search (BM25) over your notes. What you lose is semantic search: finding a note by meaning when it shares no words with your query. |

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

First it asks a few questions, each defaulting to yes (Enter): whether to wire each agent it
found, only when Ollama is running without the model, whether to download the model (about
960 MB), and, when Claude Code's own memory has notes, whether to import them. Then it prints this plan and asks `Go ahead? [y/N]`. It asks through the
terminal, so the prompts work under `curl | sh`; with `--yes` it takes the defaults without
asking, and with no terminal at all (CI, a pipe) it stops and changes nothing unless you pass
`--yes`.

- **code** — `git clone` into `~/.mnemosyne` (or your clone, used in place), then
  `npm ci && npm run build` inside it. Dependencies stay in that folder.
- **commands** — `~/.local/bin/mneme` and `~/.local/bin/mem`: small wrappers that run the built
  CLI with an absolute path to `node` (so the hook works without your shell's `nvm`/`asdf`
  setup) and default to your store.
- **agents** — for each agent it wires:
  - **Claude Code**: a `SessionStart` hook that runs `mneme context --root '<store>'`, added to
    `~/.claude/settings.json` (other settings untouched; the original file saved once as
    `settings.json.before-mnemosyne`), and the instructions block in `~/.claude/CLAUDE.md`.
  - **Codex CLI**: a `SessionStart` hook in `$CODEX_HOME/hooks.json` (default `~/.codex`), and
    the block in `$CODEX_HOME/AGENTS.md` — or in `AGENTS.override.md` when that file has
    content, because Codex then ignores `AGENTS.md`. Codex runs a new hook only once you trust
    it with `/hooks`, and its default sandbox blocks the network and writes outside the project:
    allow both for `mneme` ([details](../integrations/agents.md#level-2--automatic-injection-at-session-start)).
  - **OpenCode**: no hook (OpenCode has none); the block in `~/.config/opencode/AGENTS.md`,
    which tells the agent to run `mneme context` itself. While that file does not exist,
    OpenCode reads `~/.claude/CLAUDE.md` instead — so when that one carries the block, nothing
    is written, and creating the file is avoided whenever it would hide your `CLAUDE.md`.
- **data** — your memories live in `~/memory` as plain Markdown files. Existing notes are never
  touched. Added if missing: `.scopemap` (with a catch-all `~ = personal`) and `.config.json`
  (search tier and model, so no environment variables are needed).
- **native memory** — if Claude Code's built-in memory has notes
  (`~/.claude/projects/<project>/memory/*.md`), the plan counts them and, when `personal` is the
  store's only scope, the installer imports them into it: a dry run per folder first, then the
  import; the originals are never touched, and a folder with a conflict or a failed note is
  left for you to do by hand. With more scopes it does not guess which one a folder belongs
  to: it names [Migrating from native memory](migrating-from-native-memory.md), which does it
  scope by scope. `--no-import-native` never offers it; `--import-native` does it without
  asking. An upgrade offers it only when nothing was imported before.
- **the instructions block** — the same text for every agent, between
  `<!-- mnemosyne:begin … -->` and `<!-- mnemosyne:end -->` markers, telling the agent to use
  `mneme` for memory. Skipped in a file that already mentions `mneme`. The text is
  [`docs/integrations/memory-instructions.md`](../integrations/memory-instructions.md).
- **ollama** — `ollama pull nomic-embed-text-v2-moe` (about 960 MB), only if Ollama is running
  without the model, you said yes (or passed `--yes`) and did not pass `--no-ollama-pull`.

If `~/.local/bin` is not on your `PATH`, the plan says so and prints the line to add, and the
end of the install repeats it. **The installer does not edit your shell files**; add it yourself to your shell's startup file (zsh:
`~/.zshenv`; bash: `~/.bashrc` and `~/.profile`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

This matters: the hook runs `mneme`, so it has to be found from a fresh shell.

On a first install, `mneme` may not be found in the terminal you installed from, even when
your shell setup is right: on Ubuntu, for example, `~/.profile` adds `~/.local/bin` only if it
already existed when the shell started. Open a new terminal (or run the `export` line above in
this one).

## Verify

When the installer finishes it prints the next steps. Try them:

```sh
mneme add "I prefer short answers" --type user --slug short-answers
mneme search "answers"
```

`search` returns a short list of matching notes (slug, snippet, score); `mneme get short-answers`
prints the note in full. Then:

- Run `mneme context` in a project directory: that is the digest the hook injects. A store with
  one note prints a digest with one line; if the installer imported Claude Code's native memory,
  those notes are in it too.
- Open a **new** Claude Code or Codex session (in Codex, trust the hook first with `/hooks`). It
  starts with that digest already in context — ask it what it knows about your answer
  preferences. OpenCode runs `mneme context` itself, as the block tells it.
- `mneme stats` reports the store and index health.

If something is off, see [Troubleshooting](troubleshooting.md).

Already using Claude Code's built-in memory? The installer offers to import it when `personal`
is your only scope. [Migrating from native memory](migrating-from-native-memory.md) covers the
rest: several scopes, conflicts, and switching the native memory off so there is one store
instead of two.

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

`mneme upgrade` runs `~/.mnemosyne/install.sh upgrade`, which you can also run directly
(`update` is accepted as the same thing). It fetches the release tags and hands over to the
**installer of the new release**: it reads that version's `install.sh` without touching your
files and runs it with the same options, so the plan you see and every step after it come
from the version you are moving to — an installer fix reaches you in the upgrade that ships
it. `--dry-run` does the same, so the preview is the plan that will really run: it changes
none of your files, and the only thing it writes is the downloaded release, in git's own cache
inside `~/.mnemosyne/.git`. That installer moves the clone to the new release (refusing if you edited files in it),
rebuilds, re-runs `mneme init` — which **keeps** your config, hook and
`.scopemap` — and brings the search index up to date with `mneme reindex`. It refreshes the
agents a previous install wired (their hooks, and the blocks where their markers are) and adds
none: an agent you installed since is wired by running the installer again (`install`, not
`upgrade`). Your data is untouched.
Upgrade is idempotent: run it again on the latest release and nothing changes.

`mneme --version` says which version you are on (and, in a git checkout, the exact tag or commit).

**Your own clone** (installed with `./install.sh` from inside it) is never moved: `git pull` it
yourself, then `npm ci && npm run build`. `mneme upgrade` says so, and the new-version notice
is off for it.

**Following a branch** instead of releases — the development channel — is
`MNEMOSYNE_BRANCH=main sh ~/.mnemosyne/install.sh upgrade` (or the same variable on the first
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

- **hooks** — every `mneme context` SessionStart hook in `~/.claude/settings.json` and
  `$CODEX_HOME/hooks.json` (via `mneme uninstall-hook --write`, run with the same Node.js the
  install used, so it works even from a shell where `node` is not on the `PATH`); the rest of
  each file is left alone. A file the install created with nothing else left in it is deleted.
- **blocks** — the block between the Mnemosyne markers in `~/.claude/CLAUDE.md`, Codex's
  `AGENTS.md` / `AGENTS.override.md` and `~/.config/opencode/AGENTS.md`, leaving the rest of
  each file byte-identical. Agents are found by these markers, whether or not they are still
  installed.
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

Every command (`install`, the default; `upgrade`, also accepted as `update`; `uninstall`) accepts:

| Option | Meaning |
|---|---|
| `--dry-run` | Say what would happen and change nothing. |
| `-y`, `--yes` | Do not ask: take the defaults (wire every agent found, download the model) and go ahead. Required when there is no terminal. Through a pipe: `\| sh -s -- --yes`. |
| `--dir DIR` | Where the code lives (default `~/.mnemosyne`). |
| `--bin-dir DIR` | Where `mneme` and `mem` go (default `~/.local/bin`). |
| `--root DIR` | Where your memories live (default `$MNEMOSYNE_ROOT`, else `~/memory`). The hook and the wrappers both default to that store; `MNEMOSYNE_ROOT` still overrides it at run time. |
| `--model NAME` | Embedding model for Ollama (default `nomic-embed-text-v2-moe`). |
| `--no-ollama-pull` | Never download the embedding model. |
| `--no-claude` | Do not wire Claude Code (neither its hook nor the `~/.claude/CLAUDE.md` block). |
| `--no-codex` | Do not wire the Codex CLI. |
| `--no-opencode` | Do not wire OpenCode. |
| `--no-claude-md` | Wire Claude Code's hook, but do not add the block to `~/.claude/CLAUDE.md`. |
| `--import-native` | Import Claude Code's native memory into scope `personal` without asking (only when that is the store's only scope). |
| `--no-import-native` | Never offer that import. |
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
