# Mnemosyne

**Persistent, human-like memory for LLM agents.** File-based, local-first, agent-agnostic.

Agents forget everything between sessions. The usual fix — stuffing more into the
context window — is the dangerous one: it degrades, it doesn't scale, and it's not
continuity. Mnemosyne gives an agent a real memory instead: it remembers what matters,
forgets what doesn't, and connects ideas over time.

- **Human-like recall.** Memories are scored by recency + importance + relevance, reinforced
  when recalled and decayed when ignored (spaced-repetition). What you use, sticks.
- **Dreaming.** A nightly consolidation pass distills raw facts into curated notes, links
  related memories into an associative graph, re-scores importance, and archives the stale —
  without ever growing what gets loaded into context.
- **Local-first.** Runs offline. Markdown files are the source of truth; the search index
  is derived, local and disposable. Works the same at home or on the road.
- **Agent-agnostic.** The data knows nothing about any particular agent. Claude Code today,
  anything tomorrow. Browse it in Obsidian for free.
- **Compliance by design.** Memory is partitioned by *scope*. Leave a client, delete their
  scope — folder and its separate encrypted backup — and nothing leaks.

The name: **Mnemosyne**, Titaness of memory, whose spring stood opposite the river Lethe —
to remember versus to forget. That duality is the whole system.

---

> **Status:** Fase 0 (data model + migration) complete; Fase 1 (retrieval) not started.
> See [`docs/plan.md`](docs/plan.md) and [`docs/tasks.md`](docs/tasks.md).

**Glossary** — CLI: `mneme` · a single memory: *engram* · the decay→archive subsystem: *lethe*.
