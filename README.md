# Mnemosyne

[![CI](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml/badge.svg)](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml)

> [!WARNING]
> **Early days (v0.1).** Mnemosyne is used daily by its author, but it is young: commands,
> flags and defaults can still change between releases. The on-disk format is stable (plain
> Markdown), so your notes are always plain files you can read and keep.

**Your agent's memory, owned by you — not by your agent's vendor.**

Mnemosyne is a single, local memory store shared by Claude Code, Codex, OpenCode and any agent
that can run a shell command. It lives in plain Markdown on your disk: read it, edit it, grep
it, back it up. Change tools whenever you like; what your agents learned comes with you.

- **Recall that behaves like memory.** Memories are ranked by relevance, recency and
  importance, reinforced when recalled and allowed to fade when ignored.
- **Local-first.** Runs offline. The Markdown files are the source of truth; the search index
  is derived, local and disposable. Browse and edit your memories in any editor, or in Obsidian.
- **Agent-agnostic.** The data knows nothing about any particular agent. The installer wires
  in each one it finds: Claude Code and the Codex CLI get the memory injected at session start,
  OpenCode gets instructions to load it itself, and any other agent can use the `mneme` CLI.
- **One memory across your machines.** It is just files: sync the scope folders with the tool
  you already use (Syncthing, say) and the agents on every machine share the same memory. Each
  machine builds its own search index, and a scope you do not sync — a client's — never leaves
  its machine. [How](docs/guide/configuration.md#several-machines).
- **Separated by design.** Memory is partitioned into *scopes* (personal, work, a client).
  A scope is a folder: deleting it is a real delete.

The name: **Mnemosyne**, Titaness of memory, whose spring stood opposite the river Lethe — to
remember versus to forget. That duality is the whole system.

## Who it is for

- You use **Claude Code** (or the Codex CLI, OpenCode, or another terminal agent) and are tired
  of re-explaining your preferences, your projects and their constraints every session.
- You want that memory **on your machine, in files you own**, not inside a vendor's account.
- You work across contexts that must not mix — personal projects, an employer, clients — and
  need to be able to remove one completely.

## Requirements

| | |
|---|---|
| **Node.js ≥ 20** and npm | Required. Mnemosyne is a Node.js program (it is not published to npm; npm only fetches its dependencies). |
| **git** | Required to download and update the code. |
| C/C++ build tools | Only if no prebuilt SQLite binary matches your machine: Xcode Command Line Tools on macOS, `build-essential` + `python3` on Linux. |
| An agent | **Claude Code**, the **Codex CLI** or **OpenCode**: the installer wires in each one it finds. Mnemosyne installs without any. |
| [Ollama](https://ollama.com) | **Optional.** With it you get semantic search, computed on your machine; without it Mnemosyne runs in **tier 0** (keyword search, nothing else to install). Either way, nothing leaves your machine. |

macOS and Linux. Details, and what each search tier gives you:
[Getting started](docs/guide/getting-started.md#requirements).

## Install in three steps

**1. Preview** what the installer would do — it changes nothing:

```sh
curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh -s -- --dry-run
```

**2. Install.** It checks the requirements, prints the exact command for anything missing,
lists every change it will make, and asks before making them:

```sh
curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh
```

**3. Check it works.** Make sure `~/.local/bin` is on your `PATH` (the installer prints the line
to add if it is not), then:

```sh
mneme add "I prefer short answers" --type user --slug short-answers
mneme search "answers"
```

Open a new Claude Code session: it starts with your memories already loaded.

Prefer to read the script first? `git clone https://github.com/juanmaorta/mnemosyne.git && cd
mnemosyne && ./install.sh --dry-run`. The installer installs the latest release; `mneme upgrade`
moves you to a newer one, and uninstall is one command too; see
[Getting started](docs/guide/getting-started.md).

## Privacy

Your memories never leave your machine. The **only network request Mnemosyne makes on its own**
is a once-a-day check for a newer release: a plain HTTPS `GET` to GitHub's releases API that
carries nothing about you or your memories. It never delays session start, and when a release
is out your next session says so in one line. Turn it off with `"updateCheck": false` in
`~/memory/.config.json` or `MNEMOSYNE_NO_UPDATE_CHECK=1`; details in
[Configuration](docs/guide/configuration.md#the-new-version-check). Semantic search talks only to
the Ollama you point it at (your own machine by default).

## What changes on your machine

The installer lists all of this and asks before doing any of it (agents only where found):

| Where | What |
|---|---|
| `~/.mnemosyne` | The code, cloned and built there (or your own clone, used in place). |
| `~/.local/bin/mneme`, `mem` | Two small wrapper commands (`mem` is an alias). |
| `~/.claude/settings.json` | A `SessionStart` hook that runs `mneme context`. Other settings are untouched; the original is saved once as `settings.json.before-mnemosyne`. |
| `~/.claude/CLAUDE.md` | A marked block telling the agent to use `mneme` for memory. Skipped if the file already mentions `mneme`; opt out with `--no-claude-md`. |
| `~/.codex/hooks.json`, `AGENTS.md` | Codex CLI: the same hook and block (`$CODEX_HOME` if set). Trust the hook once with `/hooks`. |
| `~/.config/opencode/AGENTS.md` | OpenCode: the block (no hook; the agent runs `mneme context` itself). Not created when OpenCode already reads the block from `~/.claude/CLAUDE.md`. |
| `~/memory/` | Your memories, as plain Markdown. A default `.scopemap` and a `.config.json` (search tier and model) are added if missing. |

It does **not** edit your shell startup files, and it does not install Node.js or Ollama for
you. `install.sh uninstall` removes everything above except `~/memory`, which it keeps unless
you pass `--delete-data`.

## Documentation

**Using it**

- [Getting started](docs/guide/getting-started.md) — requirements, search tiers, install,
  verify, update, uninstall.
- [Concepts](docs/guide/concepts.md) — scopes, notes and facts, how recall works, the hook.
- [Everyday use](docs/guide/everyday-use.md) — what happens on its own and what to ask your
  agent for.
- [Configuration](docs/guide/configuration.md) — `.config.json`, environment variables,
  `.scopemap`, `.owner`, telemetry.
- [Troubleshooting](docs/guide/troubleshooting.md) — index built with another model, Ollama
  down, unmapped scope, and more.
- [Migrating from native memory](docs/guide/migrating-from-native-memory.md) — import what
  Claude Code already remembered and switch its native memory off.

**Reference**

- [CLI reference](docs/reference/cli.md) — every `mneme` command and flag.
- [Wiring it into an agent](docs/integrations/agents.md) — Claude Code, Codex CLI, any other
  agent; several agents sharing one store. [OpenCode](docs/integrations/opencode.md) has its
  own page.

**Developing it**

- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md).
- [Architecture](docs/architecture.md) — goal, design principles, data model and roadmap.
- [Developer docs](docs/dev/README.md) — retrieval internals, benchmarks and calibration,
  dreaming, project status.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). No CLA.
