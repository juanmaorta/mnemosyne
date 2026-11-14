# Consolidation

*Consolidation* is Mnemosyne's pass that distills raw facts into curated notes, links
related memories into an associative graph, re-scores importance and (eventually) archives the
stale — without ever growing what gets loaded into context.

## What exists today

- The **synthesis** (`src/dreaming/`) turns a scope's facts into proposed notes; it is
  local-first (Ollama on `localhost` by default) and is measured by `npm run eval:dream`. A
  **plan** is the reviewable dry-run artifact it feeds, stored under
  `<root>/.telemetry/dreams/<scope>/<runId>.json` (`buildPlan` / `persistPlan`).
- **No command generates a plan yet.** Today plans are only built in tests; the CLI step that
  runs the synthesis and writes the plan for review is planned (MNE-109). Until it lands,
  `mneme consolidate apply` has nothing to apply in normal use — which is why the user docs present
  consolidation as in development.
- Applying a plan is a **separate, explicit, manual** command, `mneme consolidate apply`, with an exact
  undo, `mneme consolidate revert`. No model is invoked when applying, and nothing runs it on a schedule.
  Its guarantees (derived notes only, stale-plan refusal, idempotence, safe revert, reindex) are
  documented in the [CLI reference](../reference/cli.md#consolidate).
- Enabling this against a real store is a deliberate decision, made only once the synthesis has
  been reviewed favourably — apply is the mechanism, not the permission.
- There is no `INDEX.md` file: the digest is built from the index database, so generating one is
  deferred until a consumer needs it (MNE-56).

Opting into a larger model on a remote endpoint is possible but never the default: it is
configured per machine in `<root>/.dreaming.json`, names the scopes allowed to leave, and fails
closed when its API key variable is missing. The file format and its guarantees are in
[Consolidation — remote opt-in](../consolidation-remote-opt-in.md).

Not built yet: the scheduled nightly runner (and with it, per-run enforcement of the
[one-owner-per-scope](../guide/configuration.md#which-scopes-a-machine-may-write-owner) rule),
applying the plan's associative links, and archival (*lethe*).

`npm run eval:dream` evaluates synthesis quality against a private golden set
(`scripts/eval-dream-synthesis.mjs`).

## Consolidation, and Anthropic's Dreams API

Anthropic's [Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams) (research
preview) reaches for the same mechanism this project calls consolidation: it takes a memory store plus
past sessions and returns a store with duplicates merged and contradicted entries replaced. Same
two inputs, same operations — with no borrowing in either direction. The common
ancestor is the literature both build on, reflection in Generative Agents and the
Auto-Dreamer/SCM line. Two independent designs arriving at the same place is a good sign for the
idea; where they part is the reason this one exists. (This project called it dreaming too, and
its command was `mneme dream`, until the name was dropped to keep the two apart; some on-disk
names still say `dream`.)

|  | Dreams API | Mnemosyne |
|---|---|---|
| **Where it runs** | The store lives in Anthropic's workspace | Files on your disk, consolidated by a local model. A client scope never leaves the boundary, which is what makes deleting one a real delete |
| **What it does** | Merges duplicates, resolves contradictions | A lifecycle: decay, strength and reinforcement on recall, with archival on the roadmap. The forgetting half of the problem, not only the tidying half |
| **What it reads** | Memory stores belonging to Managed Agents | Markdown any tool can open, Obsidian included |

The pitch here is *your memory, not your harness's*. Dreams is the harness owning your memory —
the clearest illustration available of why the alternative is worth having.
