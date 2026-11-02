# Security Policy

Mnemosyne is a tool whose whole job is to read and write a person's memory: notes about their
work, their clients, their preferences, sitting as Markdown files on their own disk. There is
no server and no account, so the interesting failures are not the usual ones. They are: a
write landing in the wrong scope, a secret making it onto disk or into a log, content leaving
the machine, and a deletion that did not actually delete.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.** An issue
describing how to get a secret out of a store is a working exploit, published.

Report it privately, through GitHub's private vulnerability reporting: the repository's
**Security** tab → **Report a vulnerability**. Only the maintainer sees the report.

Please include what you can: what an attacker gets, the steps to reproduce, the commit you
tested, and your OS and Node version. **Redact your own data** — never paste real note
content, real scope names or a real secret into a report; a masked example or a synthetic
store is enough to make the point.

What you can expect:

- **An acknowledgement within 72 hours.**
- **A fix or a mitigation within 30 days** for anything that breaks a promise below — a write in
  the wrong scope, a secret or content leaving where it should not, a deletion that does not
  delete. Lesser issues are fixed as time allows, and you will be told which it is.
- Credit in the release notes of the fix, by the name you choose — or none, if you prefer.

## Supported versions

Pre-1.0. Only the **latest release** is supported: fixes land on `main` and ship in the next
release, with no backports. `mneme --version` says which one you run; from a checkout, say
which commit.

## What this software touches

Everything lives under the store root — `~/memory` by default, `MNEMOSYNE_ROOT` or `--root`
otherwise:

| Path | What is in it |
|---|---|
| `<root>/<scope>/**.md` | The memories themselves. Plain Markdown, the source of truth |
| `<root>/.index/store.db` | Derived SQLite index: description, a ~200-character snippet of each body, an FTS5 copy of the **full body**, embeddings, and hot state (strength, access counts) |
| `<root>/.telemetry/events-*.jsonl` | Diagnostic event log: slugs and scope names in clear, query text only as a hash, never note content |
| `<root>/.telemetry/dreams/<scope>/` | Dreaming plans and their apply records: proposed notes **with their bodies**. Dreaming is in development and nothing creates these in normal use yet |
| `<root>/<scope>/.mneme-write.lock` | Transient write lock |

Two consequences worth stating plainly, because both surprise people:

- **The index is a second copy of the content**, not just an index of it. Anything that treats
  `.index/` as harmless derived state — syncing it, backing it up, leaving it behind when a
  scope is deleted — is moving note bodies around.
- **The telemetry folder sits outside the scope folders.** Deleting `<root>/<scope>/` leaves
  that scope's slugs in the log, and any dreaming plan for it.

## What counts as a vulnerability here

- **Escaping the store root or a scope directory** — path traversal through a slug, a scope
  name, `--root`, `--cwd` or an imported file, or any write outside the resolved root.
- **A write landing in the wrong scope**, or a note showing up in another scope's results.
  Scope partition is the compliance boundary of this project; a misrouted write is not fixable
  by deleting the scope afterwards. A note's scope is the **folder it is in**: a note whose
  frontmatter names another scope is refused by the index and reported, never filed under the
  scope it claims. A scope gate (`.scopemap`, `.owner`) that can be made to resolve silently
  instead of failing closed is a security bug, not a usability one.
- **Getting a secret past the write-path scanner**, or getting a *full* secret to appear
  anywhere it shouldn't — an error message, the telemetry log, a report. The scanner masks by
  contract; a path that prints the token is a leak.
- **Content or query text leaving the machine.** These are the only network calls, and only
  the first two can carry your text:
  - **The embedder** (`OLLAMA_HOST`, default `http://localhost:11434`), which by necessity
    receives note bodies at index time and query text at search time. Pointing it at a remote
    box is the user's deliberate choice and their data leaving on purpose.
  - **Dreaming's generator** (in development): the same local Ollama by default. A remote
    endpoint only by a per-machine opt-in (`<root>/.dreaming.json`) that names which scopes may
    leave; the prompt is scanned for secrets first. See
    [Dreaming — remote opt-in](docs/dreaming-remote-opt-in.md).
  - **The new-version check**: once a day, one HTTPS `GET` of the latest release from
    `api.github.com`. It sends no content and nothing about you or your store. Off with
    `MNEMOSYNE_NO_UPDATE_CHECK=1` or `"updateCheck": false` in `.config.json`.
  - **Installing and upgrading**: `git` fetches this repository and `npm` its dependencies.

  The two that carry your text, the embedder and the generator, never follow a redirect: a
  3xx would re-send the payload to whatever host it names. Anything else — any other host, any
  other payload — is a bug.
- **Silent loss or clobbering of a memory.** Bypassing the `--if-match` compare-and-swap on
  `update`, overwriting an existing note through `add`, breaking or stealing another process's
  write lock, or an importer overwriting an original.
- **A deletion that isn't one** — see the next section.
- **Claiming a write that did not happen.** An agent told "saved" when nothing reached disk is
  a data-loss bug with a friendly face.

### Not vulnerabilities

- Anyone who already has your user account. The store is files owned by you, unencrypted at
  rest: whole-disk encryption and backup encryption are yours to set up, and nothing here can
  defend against a process running as you.
- An agent writing the wrong thing into a memory. Mnemosyne stores what it is told.
- Storing a credential that the scanner does not recognise (see below) — the scanner is a
  safety net, not a boundary.
- `npm run lint` failing. It is a declared script with no ESLint installed; it always fails.

## Deleting a scope, for real

"Leave a client, delete their scope" is a claim this project makes, so here is what it takes.
`rm -rf <root>/<scope>` alone is **not** enough:

1. `rm -rf <root>/<scope>` — the notes and facts.
2. Rebuild or drop the index. `mneme reindex` prunes the rows whose files have vanished, but
   SQLite frees pages without necessarily zeroing them, and the FTS5 table held a copy of every
   body. For a clean guarantee, delete `<root>/.index/` outright and reindex from the files
   that remain.
3. `mneme purge-telemetry --scope <scope> --apply` — simulating is the default, `--apply`
   writes. It drops events naming the scope, narrows multi-scope events, deletes a day file
   left empty (an empty file still says *the client was active that day*), deletes the scope's
   dreaming plans and apply records, and redacts the scope from snapshots. Snapshot aggregates
   have no per-scope breakdown, so the totals stay; if even those are unacceptable, delete the
   snapshots.
4. Your backups and your sync history. Neither is under this tool's control.
5. Anything imported from a harness. `mneme import-claude` never modifies its sources, so
   `~/.claude/projects/<slug>/memory/` and the harness's transcripts are still there, and they
   are separate data with a separate decision.

The cheaper move is prevention: put a client scope in `excludeScopes` in
`<root>/.telemetry.json` on day one, and there is nothing to purge later.

## The secret scanner is a gate, not a guarantee

Every `add` and `update` scans the **whole serialized document** — body, description,
frontmatter — before anything touches the filesystem. Reject-level findings abort the write
and are reported with the token masked. The rules are a list of known key shapes (OpenAI,
GitHub, AWS, Slack, JWT, PEM private keys), a `password=`/`token:`-style assignment heuristic,
and a high-entropy run detector that only warns.

That stops accidents — a pasted log line, a config fragment an agent decided was worth
remembering. It cannot stop a credential that does not look like one. **Do not put secrets in
your memory store**, and if one gets in, treat it as exposed and rotate it: it is in the
Markdown, in the index, and in every backup and sync copy you have.

## Hardening notes for users

- Map your scopes in `~/memory/.scopemap` and declare what this machine may write in
  `~/memory/.owner`. Writes fail closed on an unmapped cwd; reads fall back to `personal`.
- Pass `--cwd` when a long-running process calls the CLI. Without it, scope resolution reads
  the *calling process's* working directory, and a misrouted write does not fail — it succeeds
  in the wrong scope.
- Set `excludeScopes` for sensitive scopes before they are first used; `MNEMOSYNE_TELEMETRY=0`
  turns recording off entirely.
- Don't sync `.index/` or the write lock files. The index is disposable and rebuildable
  (`mneme reindex`), and it is a copy of your content.
- Keep the embedder local unless you mean otherwise. `OLLAMA_HOST` is where your note text is
  sent at index and search time; dreaming sends it nowhere else unless you opt in per scope.
