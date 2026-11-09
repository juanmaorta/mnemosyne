# Changelog

All notable changes to Mnemosyne. Versions follow [semver](https://semver.org/).

## v0.1.1 — 2026-11-09

### Added

- instalador: la importación nativa va al scope del catch-all, y cómo renombrar el scope por defecto (MNE-117)
- instalador: detectar la memoria nativa de Claude Code y ofrecer importarla (MNE-117)

### Fixed

- instalador: identidad única por carpeta nativa y marcador de importación (MNE-117)
- release: etiquetar el commit de la release, no el que creó la versión (MNE-115)

### Other

- 📝 readme: decir con precisión qué sale de la máquina

## Unreleased

- **Installer: imports Claude Code's native memory.** When `~/.claude/projects/*/memory/` has
  notes and `personal` is the store's only scope, `install.sh` offers to import them (dry run
  per folder, then import; originals untouched). With more scopes it points to the migration
  guide instead of guessing. New flags `--import-native` / `--no-import-native`. (MNE-117)

## v0.1.0 — 2026-11-02

First public release.
