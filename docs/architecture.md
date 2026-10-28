# Architecture

Mnemosyne is a file-based, local-first memory system for LLM agents. This page is the design
reasoning behind it: the goal, the principles every change is held to, the data model, and the
roadmap at a high level. How to *use* it is in the [user guide](guide/); how the parts work in
detail is in the [developer docs](dev/README.md).

**Naming.** Mnemosyne is the Titaness of memory; her spring faced the river Lethe — remembering
versus forgetting, which is retrieval versus decay. The CLI is **`mneme`** (alias `mem`), a
single memory is an **engram**, and the decay → archive subsystem is **lethe**.

## Goal

Persistent memory for LLM agents that behaves like memory rather than like a pile of notes:

- recall ranked by **relevance, recency and importance**;
- **decay** of what is never used, and **reinforcement** of what is recalled;
- an **associative graph** between memories;
- offline **consolidation** ("dreaming") that distills raw observations into curated notes;
- **local-first** (works offline, nothing leaves the machine by default), **agent-agnostic**,
  usable across several machines;
- **selective deletion by scope**: when you stop working with a client, deleting that client's
  scope deletes everything about them.

## Design principles

These are non-negotiable; most of the code exists to keep them true.

1. **The files are the system of record; the index is derived.** The Markdown files are the
   truth — synced, auditable, hand-editable. The search index (`.index/`) is derived,
   machine-local, disposable and **never synced**, which removes the multi-machine problem a
   shared database would have.
2. **Dumb data, logic outside.** The files know nothing about any agent or editor; agents,
   editors and the CLI are all *clients*. That is what makes the store agent-agnostic and lets a
   viewer such as Obsidian be thrown away without lock-in.
3. **The format is the interoperability.** Markdown + YAML frontmatter + `[[wikilinks]]` is
   native to Obsidian/Logseq and portable to any agent.
4. **Scope decides everything**: sync, who consolidates, the blast radius of a deletion, and
   retrieval. The working directory is the operational default, mapped through `.scopemap`;
   when it maps to nothing, writes **fail closed** (never a silent `personal`). The `scope`
   field in the frontmatter is authoritative. Content may only *escalate* to a more
   restrictive scope, never de-escalate silently. A machine only limits which scopes physically
   live on it.
5. **What is regenerated is never merged.** The index, the digest and notes derived from the
   fact stream are derived state, so they cannot produce merge conflicts.
6. **One consolidation owner per scope.** Only one machine rewrites or consolidates a given
   scope (`.owner`).
7. **Auditable forgetting.** Decay moves memories to an archive; it does not delete them.
8. **Pluggable LLM, local by default.** Generation runs on a local Ollama by default; the
   endpoint is configurable, but a scope is only ever sent off the machine when the user has
   explicitly allowed it (see [remote opt-in](dreaming-remote-opt-in.md)).
9. **Append-only for observed memory.** In a session the agent does not rewrite observed
   memories: it *appends facts*, one immutable file per fact. Only the consolidation owner
   derives curated notes from the stream. This keeps sync conflict-free and gives rollback: a
   bad consolidation or a misclassified fact does not destroy the truth, it is regenerated from
   the log.
10. **Fail closed on compliance.** When in doubt about scope, refuse or classify towards the
    more restrictive scope. A client fact wrongly marked `personal` survives the client's
    deletion — a leak. Append-only gives rollback of *quality*, not of *compliance*, so the
    write-time scope gate is hardened separately.
11. **Observable, explainable, measurable.** Every important decision — what was recalled and
    what was dropped, why, how a memory decays, what dreaming rewrote — must be reconstructible
    from a trace, explainable from its signal breakdown, and evaluated against reproducible
    benchmarks. The system evolves on data, not trial and error.

## Two kinds of memory

The `type` field already encodes the boundary:

| Kind | `type` | Truth | Writes | Human edits |
|---|---|---|---|---|
| **Observed / learned** | `feedback` | append-only fact stream | the agent appends facts; dreaming derives notes | through re-consolidation, not directly |
| **Authored / reference** | `user`, `reference`, `project`, `snapshot` | the note *is* the truth | edited directly (by hand or by the agent, with compare-and-swap) | direct |

The fact stream is for episodic, observed material: high volume, lower confidence, meant to be
distilled. Authored notes — a configuration, a profile, a pointer to a dashboard — are curated
and edited directly; they are not consolidated.

## Store layout

```
~/memory/                    # system of record, agent-agnostic
  personal/                  # scope = folder
    facts/  *.md             # append-only fact stream (immutable, one fact per file)
    *.md                     # notes: derived (dreaming) + authored
  acme/                      # another scope, e.g. a client: a new scope is a new folder
    facts/  *.md
    *.md
  archive/                   # low-strength memories, not deleted (lethe, planned)
  .index/                    # derived, machine-local, never synced
    store.db                 # SQLite: vectors + FTS + hot state, disposable
  .telemetry/                # machine-local decision log, survives reindex
  .config.json  .scopemap  .owner  .telemetry.json  .dreaming.json
```

**Scope = folder** (the operational unit for sync: only the folders a machine needs are
shared) **+ `scope` in the frontmatter** (authoritative: classification, taint, ranking).
`facts/` is append-only: one fact = one immutable file, so syncing it is conflict-free by
construction.

## Frontmatter

```yaml
---
name: slug                   # kebab-case, unique within the scope
description: one-liner used for recall
scope: personal
type: user|feedback|project|reference|snapshot
created: 2026-06-22T10:00:00
importance: 7                # 1-10; set by the agent, re-scored by dreaming
links: [other-slug]          # associative graph (+ [[wikilinks]] in the body)
sources: [slug, ...]         # provenance of derived memories → scope taint
---
```

**Hot state lives outside the synced file.** `last_access`, `access_count` and `strength` are
not in the frontmatter: accesses are appended as events, and `strength` is derived state that
each machine materializes in its local index. Decay never touches a `.md`; its only
materialized effect is archival, performed by the scope's owner. That avoids nightly sync and
backup churn, and conflicts between a hand edit and the owner.

## Mechanisms

- **Retrieval scoring** (after *Generative Agents*):
  `score = w_r·recency + w_i·importance + w_rel·cosine(query, embedding)` for the ambient
  digest; search ranks on relevance, with similarity floors and a lexical rescue. Details:
  [Retrieval internals](dev/retrieval.md). At personal scale a brute-force cosine scan is fast
  enough (a design assumption the scale benchmark measures), so there is no ANN index.
- **Decay and reinforcement** (after *MemoryBank*): `R = e^(-t/S)`; each recall increases `S`
  and resets `t`, in the local index only — spaced repetition.
- **Associative graph** (after *A-MEM* / Zettelkasten): `[[links]]` plus the `links` field;
  dreaming proposes new links.
- **Consolidation / dreaming**: per scope, never across scopes; derives notes from the fact
  stream, writes higher-level reflections tagged with their `sources`, proposes links,
  re-scores importance and archives by strength. Details: [Dreaming](dev/dreaming.md).
- **Secret scanning**: regular expressions plus an entropy heuristic on every write; no LLM.

## Integration

Agents reach the store through three layers, from most to least portable:

1. **CLI + an instruction in the agent's context file** (`AGENTS.md`, `CLAUDE.md`): works with
   any agent that can run a shell command. See the
   [instruction block](integrations/memory-instructions.md).
2. **MCP** (planned): a local MCP server wrapping the CLI, the first-class multi-agent surface.
   It runs locally on each machine, never as a remote service, to preserve offline use.
3. **Hooks**: a `SessionStart` hook injects the scope's digest automatically where the harness
   supports it. A convenience, not the boundary.

Embeddings come from a local Ollama (`nomic-embed-text` by default). The index records which
model built it and warns on a mismatch, because mixing vectors from two models silently ruins
ranking.

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 — Data model and migration | Frontmatter schema, scope folders, append-only `facts/`, migration from native agent memory, Obsidian round-trip | done |
| 1 — Retrieval and scoring | Local embeddings, derived SQLite index, two-tier `search`/`get`, lazy reindex on change, decay-on-access | done |
| 2 — Hook integration | Session-start digest, `.scopemap`, fail-closed write path, owner policy, secret scanner, compare-and-swap updates | done |
| 3 — Observability, instrumentation, benchmarking | Clock seam, signal breakdown, decision log, `stats`/`explain`/`trace`, reproducible benchmarks | mostly done; CI benchmark gate pending |
| 4 — Dreaming | Reviewable consolidation plans, manual apply/revert; scheduled runner and archival | in progress |
| 5 — Sync and backup | Per-scope sync between your own machines; per-scope encrypted backups, so deleting a scope can include destroying its backup | planned |
| 6 — Later | Local MCP server; optional first-person diary stream | planned |

Observability comes **before** dreaming on purpose: dreaming is the most complex subsystem and
the only one that rewrites curated notes with an LLM. Without instrumentation there is no way
to know whether a run improves the memory or silently degrades it, and the benchmark has to
exist before the thing it judges, or it ends up overfitted to it.

### Dreaming compute and the scope boundary

Consolidation wants a capable model, and the most capable hardware may not be the machine that
owns a sensitive scope. The recommended pattern is **stateless inference offload**: the owner
machine orchestrates and persists (reads the scope's facts, writes the derived notes locally)
and only delegates *generation* to an inference endpoint. For that to keep the boundary:

1. the transport is encrypted (a plain-HTTP Ollama port is never exposed);
2. the inference endpoint does not log prompts;
3. orchestration and writes always stay on the owner — the endpoint is a "dumb GPU";
4. "single owner" means who reads and writes the scope's files, not who runs the model.

Whether a given scope may use an off-machine endpoint at all is an explicit per-scope decision
(`allowScopes` in `.dreaming.json`), never a default.

### Team use (captured, outside the roadmap)

- **Each developer runs their own instance, with no sync.** This is the current product,
  distributed N times; it needs packaging and shared conventions, not new architecture.
- **Optional shared team scope, read-mostly and curated** (conventions, architecture
  decisions, post-mortems), consumed read-only by each instance. Git is a better substrate than
  file sync for this one: review by pull request, history, access control.
- **Explicitly out of scope: multi-writer synchronized memory.** That is a different product
  (server, auth, access control, central index) and would break single-owner consolidation and
  deletion by scope.

## Risks and open questions

- **Scope classification is compliance.** Fail-closed writes and the cwd prior are the
  direction, but this remains the critical link: append-only gives rollback of quality, not of
  compliance.
- **Backups are snapshots**: really deleting a scope requires destroying its backup repository,
  which is why each sensitive scope should have its own.
- **Sync conflicts** are minimized by append-only facts and regenerable derived state; how to
  handle the residue is decided with phase 5.
- **Long-term compute cost** of continuous consolidation and link evolution at the scale of
  years.
- **No viewer may become load-bearing.** Obsidian stays vanilla, with no plugins that mutate
  frontmatter and no Obsidian Sync.
