# Changelog

All notable changes to Mnemosyne. Versions follow [semver](https://semver.org/).

## v0.1.2 — 2026-11-14

### Other

- 📝 «Dreaming» pasa a «consolidation» en la doc y la CLI: `mneme consolidate`, con `dream` como alias oculto (MNE-118)
- 👷 installer.yml: los checks del instalador informan en todos los PR y se omiten si no cambia nada suyo
- 📝 contributing: los PR se mergean con squash; el título es la línea del CHANGELOG
- 📝 plantilla de issue «Feedback»: las dos preguntas que importan y el entorno (MNE-104)
- 📝 changelog: notas legibles de la v0.1.1 y fuera el bloque Unreleased duplicado

## v0.1.1 — 2026-11-09

The first release meant for other people. Mnemosyne has been in daily use by its author
since August 2026.

### Added

- **The installer imports Claude Code's built-in memory.** When `~/.claude/projects/*/memory/`
  has notes and the store's default scope (the catch-all in `.scopemap`, `personal` unless you
  changed it) is its only scope, `install.sh` counts them and offers to import them: a dry run
  per folder, then the import, then a reindex; the originals are never touched, and a folder
  with a conflict or a failed note is left for you to do by hand with the migration guide.
  With more scopes it does not guess which one a folder belongs to and points to the guide.
  New flags `--import-native` / `--no-import-native`. An upgrade offers it only when nothing
  was imported before. (MNE-117)
- `docs/guide/configuration.md` explains how to call the default scope something else.

### Fixed

- The release workflow tags the release's merge commit, not the commit that set the version.
  (MNE-115)

### Changed

- README: what leaves your machine, said precisely. Mnemosyne itself never sends your memories
  anywhere; the one request it makes on its own is the daily release check, and what your
  agent's vendor sees is the digest the hook puts into the session context, as it would see a
  `CLAUDE.md`.

### Feedback

Two questions matter most in this release: did it install first try, and did your agent
remember something useful the next day? Open a *Feedback* issue with the answers.

## v0.1.0 — 2026-11-02

First public release.
