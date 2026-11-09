# Changelog

All notable changes to Mnemosyne. Versions follow [semver](https://semver.org/).

## Unreleased

- **Installer: imports Claude Code's native memory.** When `~/.claude/projects/*/memory/` has
  notes and `personal` is the store's only scope, `install.sh` offers to import them (dry run
  per folder, then import; originals untouched). With more scopes it points to the migration
  guide instead of guessing. New flags `--import-native` / `--no-import-native`. (MNE-117)

## v0.1.0 — 2026-11-02

First public release.
