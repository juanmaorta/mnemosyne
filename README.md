# Mnemosyne

[![CI](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml/badge.svg)](https://github.com/juanmaorta/mnemosyne/actions/workflows/ci.yml)

> [!WARNING]
> **Pre-release.** Mnemosyne is used daily by its author but has not had a release yet. The
> on-disk format is stable (plain Markdown), but commands, flags and defaults can still change
> between commits. Your notes are always plain files you can read and keep.

<!-- PITCH: pending MNE-101 -->
**Persistent memory for LLM agents, kept as plain Markdown files on your own disk.**

Agents forget everything between sessions. Mnemosyne gives them a memory that lasts: it keeps
what matters as Markdown files on your disk, brings the relevant part back at the start of
every session, and lets the agent search and add to it as it works.

- **Recall that behaves like memory.** Memories are ranked by relevance, recency and
  importance, reinforced when recalled and allowed to fade when ignored.
- **Local-first.** Runs offline. The Markdown files are the source of truth; the search index
  is derived, local and disposable. Browse and edit your memories in any editor, or in Obsidian.
- **Agent-agnostic.** The data knows nothing about any particular agent. Claude Code and the
  Codex CLI get automatic injection at session start; anything that can run a shell command can
  use it.
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
| **Claude Code** | Recommended: it is the agent the installer wires in. Mnemosyne installs without it. |
| [Ollama](https://ollama.com) | **Optional.** With it you get semantic search; without it Mnemosyne runs in **tier 0** (keyword search, fully offline). |

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
mnemosyne && ./install.sh --dry-run`. Update and uninstall are one command each; see
[Getting started](docs/guide/getting-started.md).

## What changes on your machine

The installer lists all of this and asks before doing any of it:

| Where | What |
|---|---|
| `~/.mnemosyne` | The code, cloned and built there (or your own clone, used in place). |
| `~/.local/bin/mneme`, `mem` | Two small wrapper commands (`mem` is an alias). |
| `~/.claude/settings.json` | A `SessionStart` hook that runs `mneme context`. Other settings are untouched; the original is saved once as `settings.json.before-mnemosyne`. |
| `~/.claude/CLAUDE.md` | A marked block telling Claude to use `mneme` for memory. Skipped if the file already mentions `mneme`; opt out with `--no-claude-md`. |
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
