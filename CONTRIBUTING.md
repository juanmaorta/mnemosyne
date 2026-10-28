# Contributing to Mnemosyne

Mnemosyne reads and writes one thing: somebody's memory, as files on their own disk. A bug
here does not render a page wrong — it loses a note, leaks a client's name into the wrong
folder, or tells an agent it saved something it never saved. That is the bar every change is
held to, and it is the reason most of the rules below exist.

The user-facing contract is the [`README`](README.md), the user guide in
[`docs/guide/`](docs/guide/) and the [CLI reference](docs/reference/cli.md). The design reasoning lives in
[`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md), which are **in Spanish**
— that is internal history, not a language policy. Anything a user reads (README,
`CONTRIBUTING.md`, `SECURITY.md`, issue templates) is in English, and issues and pull
requests in English are welcome.

Security problems do **not** go in an issue or a pull request. See
[`SECURITY.md`](SECURITY.md).

---

## Setup

Node **>= 20** (`engines` in `package.json`; CI runs 24).

```sh
npm install
npm run build
```

[Ollama](https://ollama.com) with `nomic-embed-text` is needed to *use* the CLI for real, not
to work on it: the test suite never talks to it (see below).

### Never develop against your own store

The default store root is `~/memory`. Running a half-written `add`, `reindex` or
`purge-telemetry` against it is how you lose your own notes.

```sh
export MNEMOSYNE_ROOT="$(mktemp -d)"     # covers every command, including the ones with no --root
```

`--root <dir>` exists on every command except `install-hook` and `scan`, so the environment
variable is the safer habit — it cannot be forgotten on the one invocation that writes.

`mneme install-hook` prints the snippet and writes nothing unless you pass `--write`; keep it
that way when you try it out, or you will edit your real `~/.claude/settings.json` (or
`$CODEX_HOME/hooks.json`).

## The loop

```sh
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # tsc

npm run test:watch                   # vitest, watching
npx vitest run src/write/add.test.ts # one file
```

Those three are the whole checklist. **Do not run `npm run lint`.** The script is declared as
`eslint .`, ESLint is neither installed nor configured, and so it fails every single time on
every checkout. Whether this project gets a linter at all is still being decided; until then
a red `lint` means nothing and proves nothing.

A CI workflow (`typecheck` + `test` + `build` on every pull request) is on its way in but is
not on `main` yet, so for now the gate is you running the three commands above and saying so.

### About the tests

- Vitest, test files next to the code they cover (`src/**/*.test.ts`).
- A vitest `globalSetup` builds `dist` once before anything runs, because several suites spawn
  the compiled CLI as a real child process. Don't add a per-file build.
- **No Ollama needed.** The embedder tests point at unreachable hosts on purpose and assert the
  error path, and everything else uses the deterministic fake embedder
  (`MNEMOSYNE_FAKE_EMBED=1`).
- Suites write to temp directories, never to a real store. Keep it that way: a test that
  touches `~/memory` is a bug in the test.
- `src/concurrency.test.ts` races several spawned processes and is the slow one. It is also
  the one that catches the failures that matter most, so don't skip it.

This repo is built test-first, and a change that alters behaviour is expected to arrive with
a test that fails without it. Write the test against the behaviour (spawn the CLI, look at
what landed on disk), not against the shape of the implementation.

## What a good change looks like

- **Fail closed.** When the code cannot tell which scope a write belongs to, whether this
  machine owns it, or whether a body contains a secret, the answer is to refuse, not to guess.
  Guessing is how a client's memory ends up in the wrong folder, and that is not recoverable
  by deleting the folder later.
- **Say why in a comment.** The existing comments explain the reasoning behind a decision, not
  what the line does. Match that; it is the most valuable thing in the codebase.
- **Never make a failure look like an empty result.** `mneme context` cannot fail by design,
  which means a broken digest looks exactly like "you have no memories". If you add a path
  that can degrade, make it visible (`degraded injections` in `mneme stats` is the pattern).
- **Docs are part of the change.** A flag that is not in the [CLI reference](docs/reference/cli.md)
  does not exist for users. If you touch the CLI surface, update it (and the
  [user guide](docs/guide/) where behaviour changes), and check
  [`docs/integrations/memory-instructions.md`](docs/integrations/memory-instructions.md) —
  it is pasted into agents' instruction files verbatim, so a command that drifts there becomes
  a write the agent believes it made.
- **Never commit anything from a real store.** `.gitignore` covers `memory/` and `.index/`,
  but import reports, pasted `trace` output and test fixtures copied from your own notes are
  not covered by anything except you.

### Changes worth discussing before you write them

Open an issue first for: the frontmatter schema or anything else about the on-disk format (the
files are the source of truth and every change is a migration); the scope and owner gates; the
secret scanner's severity model; what telemetry records; and anything that writes outside the
resolved store root. These are not off limits — they just cost more to undo than to discuss.

## Commits and pull requests

Commit messages carry a gitmoji prefix and a short summary of *what changed and why*:

```
✨ Codex CLI: install-hook --harness codex y el sobre JSON del digest
🐛 Resolver symlinks al comparar prefijos de .scopemap
📝 Posicionar dreaming frente a la Dreams API de Anthropic
```

`✨` feature, `🐛` fix, `📝` docs are the ones in use. The existing history is in Spanish because
the project has been a single author so far; write yours in English if that is your language.

A pull request should say what changes, why, and what you verified — with the real numbers
(`npm run typecheck` and `npm test`, and what the suite actually printed). "Tests pass" with
no output behind it is the claim this project trusts least.

## Licensing

This project is licensed under **Apache-2.0** (see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE)), and there is **no CLA**: you keep the copyright on what you write, and
contributing it here licenses it under the same terms as the rest — that is all.

Apache-2.0 rather than MIT for one reason worth naming: it grants patent rights explicitly.
The trade is deliberate and already made — no path to relicensing, and no protection against
someone running this as a hosted service.
