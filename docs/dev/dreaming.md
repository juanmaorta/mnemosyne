# Dreaming

*Dreaming* is Mnemosyne's consolidation pass: it distills raw facts into curated notes, links
related memories into an associative graph, re-scores importance and (eventually) archives the
stale — without ever growing what gets loaded into context.

## What exists today

- A **plan** is produced by the synthesis step and stored as a reviewable dry-run artifact under
  `<root>/.telemetry/dreams/<scope>/<runId>.json`. Generation is local-first: it talks to Ollama
  on `localhost` by default.
- Applying a plan is a **separate, explicit, manual** command, `mneme dream apply`, with an exact
  undo, `mneme dream revert`. No model is invoked when applying, and nothing runs it on a schedule.
  Its guarantees (derived notes only, stale-plan refusal, idempotence, safe revert, reindex) are
  documented in the [CLI reference](../reference/cli.md#dream).
- Enabling this against a real store is a deliberate decision, made only once the synthesis has
  been reviewed favourably — apply is the mechanism, not the permission.
- There is no `INDEX.md` file: the digest is built from the index database, so generating one is
  deferred until a consumer needs it (MNE-56).

Opting into a larger model on a remote endpoint is possible but never the default: it is
configured per machine in `<root>/.dreaming.json`, names the scopes allowed to leave, and fails
closed when its API key variable is missing.

Not built yet: the scheduled nightly runner (and with it, per-run enforcement of the
[one-owner-per-scope](../guide/configuration.md#which-scopes-a-machine-may-write-owner) rule),
applying the plan's associative links, and archival (*lethe*).

`npm run eval:dream` evaluates synthesis quality against a private golden set
(`scripts/eval-dream-synthesis.mjs`).

## Dreaming, and Anthropic's Dreams API

Anthropic's [Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams) (research
preview) reaches for the same mechanism this project calls dreaming: it takes a memory store plus
past sessions and returns a store with duplicates merged and contradicted entries replaced. Same
name, same two inputs, same operations — with no borrowing in either direction. The common
ancestor is the literature both build on, reflection in Generative Agents and the
Auto-Dreamer/SCM line. Two independent designs arriving at the same place is a good sign for the
idea; where they part is the reason this one exists.

|  | Dreams API | Mnemosyne |
|---|---|---|
| **Where it runs** | The store lives in Anthropic's workspace | Files on your disk, consolidated by a local model. A client scope never leaves the boundary, which is what makes deleting one a real delete |
| **What it does** | Merges duplicates, resolves contradictions | A lifecycle: decay, strength and reinforcement on recall, with archival on the roadmap. The forgetting half of the problem, not only the tidying half |
| **What it reads** | Memory stores belonging to Managed Agents | Markdown any tool can open, Obsidian included |

The pitch here is *your memory, not your harness's*. Dreams is the harness owning your memory —
the clearest illustration available of why the alternative is worth having.
