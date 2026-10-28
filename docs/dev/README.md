# Developer docs

For working **on** Mnemosyne rather than with it. Start with [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
(setup, the test loop, never developing against your own store).

- [Retrieval internals](retrieval.md) — how search filters and ranks, the floors, lexical rescue,
  RRF fusion, and what to measure before changing any of it.
- [Benchmarks and calibration](benchmarks.md) — the cosine, retrieval and golden-set benchmarks,
  and calibrating the floors for a store.
- [Dreaming](dreaming.md) — the consolidation pipeline's design, and how it compares to
  Anthropic's Dreams API.
- Measured results live in [`docs/benchmarks/`](../benchmarks/).

## Project status

Mnemosyne is pre-release. Built and tested:

- the data model, file store and migration;
- retrieval, scoring and the CLI;
- read integration — the `SessionStart` digest hook and `.scopemap`;
- write integration — `mneme add` with fail-closed scope, owner policy and the secret scanner;
- the canonical-memory surface for Claude Code: `get --json`, `update --if-match`, `add --file`
  and `import-claude`;
- the one-step installer.

In progress: observability, instrumentation and benchmarking. The clock seam, signal breakdown,
telemetry store, lifecycle instrumentation, the `stats`/`explain`/`trace` surface and the local
cosine, recency and golden-set benchmarks are in; a benchmark gate in CI is not wired yet.

Next: nightly dreaming/consolidation. Plans can be produced, reviewed and applied by hand
(`mneme dream apply`); the scheduled runner and archival (*lethe*) are not built.

**Glossary** — CLI: `mneme` · a single memory: *engram* · the decay → archive subsystem: *lethe*.
