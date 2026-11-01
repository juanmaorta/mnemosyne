# OpenCode (`AGENTS.md`)

Mnemosyne works with OpenCode at **level 1** — a context block the agent reads on startup
plus the `mneme` CLI on demand. There is **no shipped plugin**, so there is no automatic
injection: the agent itself runs `mneme context` at the start of a session, because nothing
does it for it.

## The block

The installer does this when it finds OpenCode. By hand: paste the agent-agnostic block from
[`memory-instructions.md`](memory-instructions.md) into the `AGENTS.md` that OpenCode reads.

Which file: OpenCode reads `~/.config/opencode/AGENTS.md`, and **only while that file does not
exist** falls back to `~/.claude/CLAUDE.md`. So if your `CLAUDE.md` already carries the block
(Claude Code wired too), OpenCode has it and there is nothing to add — and creating
`~/.config/opencode/AGENTS.md` would cut the rest of your `CLAUDE.md` off from OpenCode. The
installer writes there only when the file exists, when nothing would be hidden, or when
`OPENCODE_DISABLE_CLAUDE_CODE` / `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` is set.
It is the same block used for Claude Code and the Codex CLI — it names no harness and uses
only real `mneme` commands — so there is nothing OpenCode-specific to add to it.

## Minimal usage (what the block already instructs)

- **At the start of a project**, run the digest yourself — there is no hook to do it:

  ```sh
  mneme context --cwd /real/path/to/project
  ```

- **On demand**, use the CLI: `mneme search "<topic>"`, `mneme get <slug>`,
  `mneme add … --cwd <project>`, `mneme update <slug> --if-match <revision> --cwd <project>`.

Pass `--cwd` explicitly on `context`, `add` and `update`: OpenCode is not an ephemeral
per-invocation process started in the project, so without `--cwd` the scope resolves against
the wrong directory.

## No automatic injection without a plugin

OpenCode exposes a plugin seam (`experimental.chat.system.transform`), but **nothing is
shipped here**, so promising automatic injection would be false — unlike Claude Code and the
Codex CLI, which have a `SessionStart` hook (`mneme init --write` /
`mneme install-hook --harness codex --write`). If you build a plugin to inject
`mneme context` per session, revalidate the hook name and config paths against the
documentation for your installed OpenCode version first:

- <https://opencode.ai/docs/rules/>
- <https://opencode.ai/docs/plugins/>

## See also

- [`memory-instructions.md`](memory-instructions.md) — the block to paste.
- [Migrating from native memory](../guide/migrating-from-native-memory.md) — moving an existing
  setup onto Mnemosyne and switching the native memory off.
