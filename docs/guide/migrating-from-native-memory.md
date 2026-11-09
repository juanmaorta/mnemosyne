# Migrating from native memory

Claude Code (and Codex CLI) ship their own memory. If you have been using it, you have
memories spread across per-project folders that Mnemosyne does not read. This page moves them
into your store and makes Mnemosyne the **only** memory your agent writes to.

**The simple case is handled by the installer.** When `personal` is the only scope in your
store, `install.sh` finds Claude Code's memory folders, counts the notes and offers to import
them all into `personal` (dry run per folder, then import; originals untouched). If you said
yes there, skip to [step 5](#5-turn-the-native-memory-off--first-in-a-test-configuration).
This page is for everything else: a store with several scopes, where each folder needs a scope
chosen by hand; a folder the installer left alone because of a conflict or a failed note; and
Codex's own memory.

Do it in order. Each step ends with a check; if the check fails, stop there.

- [Why switch the native memory off](#why-switch-the-native-memory-off)
- [1. Install, and check the hook can find `mneme`](#1-install-and-check-the-hook-can-find-mneme)
- [2. Map your scopes and inventory the native folders](#2-map-your-scopes-and-inventory-the-native-folders)
- [3. Import: dry run per folder, resolve, apply](#3-import-dry-run-per-folder-resolve-apply)
- [4. Reindex and spot-check each scope](#4-reindex-and-spot-check-each-scope)
- [5. Turn the native memory off — first in a test configuration](#5-turn-the-native-memory-off--first-in-a-test-configuration)
- [6. Apply it for real](#6-apply-it-for-real)
- [7. What happens to the originals](#7-what-happens-to-the-originals)
- [Rolling back](#rolling-back)

## Why switch the native memory off

While the native memory is on, two instructions compete: the harness's own system prompt
pushes the agent to write into `~/.claude/projects/<cwd-slug>/memory/`, and Mnemosyne's
[instruction block](../integrations/memory-instructions.md) tells it to write with `mneme`.
Each thing it learns lands in one store or the other depending on which instruction wins, and
neither store has the whole picture. Importing once and then switching the native memory off
leaves a single source of truth.

## 1. Install, and check the hook can find `mneme`

Install with the [one-step installer](getting-started.md#install). It wires the
`SessionStart` hook, adds the instruction block to `~/.claude/CLAUDE.md`, and puts `mneme` in
`~/.local/bin`.

The hook does not inherit your interactive shell's `PATH` — it does not read `.zshrc`, so a
`mneme` that only exists through an alias or an `nvm use` in your profile will not be there.
Check the command exactly as the hook will see it, with a minimal environment:

```sh
env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  sh -c 'command -v mneme && mneme context --cwd ~/Projects/acme/app'
```

This matters more than it looks: `mneme context` is designed never to fail and to return an
empty digest instead, so a missing binary does not produce a visible error — it produces
silent sessions with no memory. If it is not found, put the absolute path in the hook's
command.

## 2. Map your scopes and inventory the native folders

Every memory you import goes into a scope, and the scope must be explicit. Make sure
`~/memory/.scopemap` maps each project directory, and that `~/memory/.owner` lists every scope
this machine may write (see [Configuration](configuration.md#scopes-scopemap)):

```sh
cat ~/memory/.scopemap
cat ~/memory/.owner
mneme scope ~/Projects/acme/app     # → `<scope>  owned` | `unmapped → pass --scope`
```

Every destination scope must come out `owned`. Otherwise each file is reported as
`failed  [not-owner]` — in the dry run too, which is exactly when you want to find out.

Now list the native folders:

```sh
ls -d ~/.claude/projects/*/memory | sort
find ~/.claude/projects -path '*/memory/*.md' | wc -l
```

and build the table of origins **by hand**:

| Source directory | source-id | Scope |
|---|---|---|
| `~/.claude/projects/-home-you-Projects-acme-app/memory` | `acme-app` | `acme` |
| `~/.claude/projects/-home-you-Projects-blog/memory` | `blog` | `personal` |
| … | … | … |

- The folder names under `~/.claude/projects/` are **not reversible paths**: `/` is replaced by
  `-`, and `-` also occurs inside directory names, so there is no unambiguous decoding.
  Guessing is exactly how a client's memory ends up in the wrong scope, and a misrouted write
  cannot be fixed by deleting the scope later.
- The `source-id` is a kebab-case name you choose; it identifies a **logical origin** even if
  its absolute path changes. It is part of each imported memory's deterministic slug
  (`claude-<source-id>-<filename-slug>-<hash12>`), so **reuse the same `source-id`** on later
  runs: changing it reimports everything under a new identity.
- If you do not know which scope a folder belongs to, do not import it until you decide.
  There is no fallback to `personal`.

## 3. Import: dry run per folder, resolve, apply

First, **close the agent sessions that write into those folders**. The importer only reads the
originals, but a file that changes mid-run makes the reviewed dry run differ from the apply.

```sh
OUT=~/import-reports          # outside any repository: reports contain memory names
mkdir -p "$OUT"

mneme import-claude \
  --source ~/.claude/projects/-home-you-Projects-acme-app/memory \
  --source-id acme-app --scope acme | tee "$OUT/acme-app.dry.txt"
```

The dry run is the default: it parses, normalizes and runs the owner, schema and secret gates,
but creates no directories, lock, index or telemetry. The report is your review — one line per
file and a summary:

- `importable` / `imported` — will be / has been created, with its destination.
- `skipped-identical` — that content is already in the scope, under any slug. Not duplicated.
- `conflict` — the deterministic slug already exists with different content. **Never
  overwritten, and no second version is created**: resolve it by hand.
- `failed` — a problem with the source file (`unknown-type`, `missing-description`,
  `relations-need-review`, `invalid-slug`, `parse-error`, `invalid-schema (<fields>)`,
  `secret-detected`) or with the environment (`not-owner`, `read-error`, `stat-error`,
  `write-error`).
- `ignored` — `MEMORY.md`, `INDEX.md`, hidden files, symlinks, non-Markdown. No recursion.
- `(warning: …)` at the end of a line — the body has wikilinks or references to native `.md`
  files that were **not** rewritten (fix by hand if that memory matters), or the source had no
  `description` and one was derived from the first line of the body.

The exit code is non-zero on any `conflict` or `failed`. Resolve those first (fix the
original, or prepare a reviewed copy of the source folder and import from that), then:

```sh
mneme import-claude \
  --source ~/.claude/projects/-home-you-Projects-acme-app/memory \
  --source-id acme-app --scope acme --apply | tee "$OUT/acme-app.apply.txt"
```

What you can rely on, and its limits:

- **Idempotent.** Re-running the apply with the same `source-id` creates nothing new.
- **No batch transaction.** One file can fail while the rest import. Re-running is safe and is
  how you resume.
- **The originals are never modified**, not even on a partial failure.
- **Keep the reports out of any repository.** They contain file names and slugs of your
  memories.

Full flag reference: [`import-claude`](../reference/cli.md#import-claude).

## 4. Reindex and spot-check each scope

```sh
mneme reindex --scope acme        # → `indexed N, skipped N, deleted N, errors N`
mneme search "<an imported topic>" --scope acme
mneme get <slug-from-the-report> --scope acme
```

A non-zero `errors` count needs a look: the usual cause is a duplicate slug within the scope
(the index enforces `(scope, slug)` uniqueness), and the affected file stays unindexed even
though it is on disk.

Check a representative sample **per scope**, not a single file: the scope is the one in your
table, the body matches the original, and `mneme context --cwd <project>` shows the expected
scope.

## 5. Turn the native memory off — first in a test configuration

```json
{ "autoMemoryEnabled": false }
```

Do this in a **separate test configuration** before touching your real one. Claude Code
supports an alternative configuration directory (`CLAUDE_CONFIG_DIR`); check the variable and
setting names against the documentation of the version you have installed.

**Copy the instruction block into that test configuration's `CLAUDE.md` too.** The installer
put it in `~/.claude/CLAUDE.md`, which a session started with another configuration directory
does not read — without the copy you would be testing whether the agent follows a block it
never sees.

Then, in the test configuration, check at least:

| Scenario | Expected |
|---|---|
| Ask it to remember a (made-up) durable constraint | A successful `mneme add`, and no native write |
| Correct a reusable preference without saying "remember" | The agent saves it with `mneme` |
| New session: ask about that constraint without repeating it | `search`/`get` recovers the right value |
| Another repository mapped to the same scope | Recovered without copying files |
| Change an authored note, ask again in a new session | The new version, no duplicated contradicting note |
| Write from a directory with no mapping and no `--scope` | The write fails, the agent says so, and nothing is saved elsewhere |

A passing unit test of the CLI is not evidence that the agent remembers: only real sessions
show whether it writes when something comes up and recalls it later. Use synthetic data for
these checks. If spontaneous capture fails, adjust the instruction block once and repeat.

**Codex CLI** has the same kind of native memory (the `memories` feature). Leave it off on
purpose rather than by inherited default; [Wiring it into an agent](../integrations/agents.md)
covers the Codex hook and the sandbox settings it needs.

## 6. Apply it for real

Only once the test scenarios look right:

```sh
cp ~/.claude/settings.json ~/.claude/settings.json.bak.pre-automemory
jq '. + {autoMemoryEnabled: false}' ~/.claude/settings.json > /tmp/settings.json \
  && mv /tmp/settings.json ~/.claude/settings.json
```

Preserve the existing JSON (never rewrite it whole) and check for **overrides**: a project
settings file, a local settings file or a managed policy can win over the user setting, in
which case the effective value is not the one you just wrote. Confirm the effective value in a
real session.

## 7. What happens to the originals

Leave the native folders where they are, as read-only history, until you decide otherwise.
Deleting them later is a separate, explicit decision.

Worth stating, because it is easy to believe the opposite: **deleting `~/memory/<scope>` does
not delete the originals in `~/.claude/projects/<cwd-slug>/memory/` or the harness's
transcripts.** "I stopped working with this client → delete their scope" only covers the
Mnemosyne store; imported originals and transcripts are separate data and need separate
handling. See [Deleting memories](everyday-use.md#deleting-memories).

## Rolling back

1. Restore `~/.claude/settings.json.bak.pre-automemory` (or remove the `autoMemoryEnabled`
   key to return to the default behaviour).
2. **Keep what Mnemosyne wrote in the meantime.** There is no reverse sync: notes written with
   `mneme` do not appear in the native memory, and deleting them would be the only real loss of
   a rollback. The native originals are untouched, so going back loses no history.
3. Running two stores is a **temporary** measure: while it lasts, each thing the agent learns
   lands in one or the other. Note when and why you rolled back, and when you will retry.
