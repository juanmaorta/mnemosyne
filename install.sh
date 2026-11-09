#!/bin/sh
# Mnemosyne installer — install, update or uninstall in one step (MNE-97).
#
#   curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/juanmaorta/mnemosyne/main/install.sh | sh -s -- --dry-run
#   ./install.sh [install|update|uninstall] [options]     # from a clone
#
# It checks what it needs, tells you what is missing and the exact command that
# fixes it, then says what it is going to change BEFORE changing anything and
# asks. `--dry-run` stops after that. Nothing is published to npm: the code is
# cloned from git and built locally; `npm` is only used to fetch dependencies.
#
# Which code: the newest release — the highest `vX.Y.Z` tag of the repo — unless
# MNEMOSYNE_BRANCH names a branch to follow instead (the development channel).
# A repo with no release tags yet falls back to `main`, and says so (MNE-111).
#
# POSIX sh on purpose: it has to run under `curl | sh` on macOS and on Linux
# (where `sh` is dash), before anything else is installed.

set -eu

# Handed over by an older installer (see handoff), this script is a temporary
# copy: delete it first thing, before anything that could exit. The shell
# already has it open, so it keeps running.
if [ -n "${MNEMOSYNE_HANDOFF_FILE:-}" ] && [ "$MNEMOSYNE_HANDOFF_FILE" = "$0" ]; then rm -f "$0"; fi

# ---------------------------------------------------------------- defaults ---
REPO_URL="${MNEMOSYNE_REPO_URL:-https://github.com/juanmaorta/mnemosyne.git}"
# Set explicitly, it is the development channel: follow that branch's tip.
# Unset, the installer follows releases (tags), falling back to this default
# branch only while the repo has none.
BRANCH="${MNEMOSYNE_BRANCH:-main}"
BRANCH_EXPLICIT=0
[ -n "${MNEMOSYNE_BRANCH:-}" ] && BRANCH_EXPLICIT=1
INSTALL_DIR="${MNEMOSYNE_INSTALL_DIR:-$HOME/.mnemosyne}"
BIN_DIR="${MNEMOSYNE_BIN_DIR:-$HOME/.local/bin}"
STORE_ROOT="${MNEMOSYNE_ROOT:-$HOME/memory}"
MODEL="nomic-embed-text-v2-moe"
MODEL_EXPLICIT=0
NODE_MIN_MAJOR=20

ACTION=install
DRY_RUN=0
ASSUME_YES=0
DO_BUILD=1
DO_CLAUDE_MD=1
DO_OLLAMA_PULL=1
DELETE_DATA=0
# --no-claude / --no-codex / --no-opencode (MNE-113)
NO_CLAUDE=0
NO_CODEX=0
NO_OPENCODE=0
# Claude Code's own memory, `~/.claude/projects/<cwd-slug>/memory/*.md` (MNE-117):
# offered for import when this store has no scope but `personal`. ask|yes|no.
IMPORT_NATIVE=ask

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
CLAUDE_PROJECTS="$CLAUDE_DIR/projects"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOOKS="$CODEX_DIR/hooks.json"
OPENCODE_DIR="$HOME/.config/opencode"
OPENCODE_MD="$OPENCODE_DIR/AGENTS.md"
# Where the questions are read from. Under `curl | sh` stdin is the script
# itself, so the terminal is asked directly; the tests point it at a file.
TTY_IN="${MNEMOSYNE_INSTALL_TTY:-/dev/tty}"
BLOCK_BEGIN="<!-- mnemosyne:begin — managed by Mnemosyne's install.sh; edits between these markers are replaced on update -->"
BLOCK_END="<!-- mnemosyne:end -->"
# Marks files the installer owns, so uninstall never deletes something it did
# not create (a checkout you cloned yourself, a `mneme` you linked by hand).
OWNER_MARK="mnemosyne-installer"

usage() {
  cat <<EOF
Mnemosyne installer

Usage: install.sh [install|upgrade|uninstall] [options]

Commands:
  install     (default) check requirements, get the code, build it, wire it in
  upgrade     move to the latest release and rebuild; keeps config, hooks, .scopemap, data
              (what 'mneme upgrade' runs; 'update' is the same)
  uninstall   remove what install added; keeps your memories unless --delete-data

Options:
  --dry-run         say what would happen and change nothing
  -y, --yes         do not ask: take the defaults (every agent found, download the
                    model) and go ahead. Required when there is no terminal
  --dir DIR         where the code lives            (default: \$HOME/.mnemosyne)
  --bin-dir DIR     where 'mneme' and 'mem' go       (default: \$HOME/.local/bin)
  --root DIR        where your memories live         (default: \$MNEMOSYNE_ROOT or \$HOME/memory)
  --model NAME      embedding model for Ollama       (default: nomic-embed-text-v2-moe)
  --no-ollama-pull  never download the embedding model
  --no-claude       do not wire Claude Code     (hook + ~/.claude/CLAUDE.md block)
  --no-codex        do not wire the Codex CLI   (hook + \$CODEX_HOME/AGENTS.md block)
  --no-opencode     do not wire OpenCode        (~/.config/opencode/AGENTS.md block)
  --no-claude-md    wire Claude Code's hook but not the ~/.claude/CLAUDE.md block
  --import-native   import Claude Code's native memory (~/.claude/projects/*/memory) into
                    scope 'personal' without asking; --no-import-native never offers it.
                    Only when 'personal' is the store's only scope; otherwise see
                    docs/guide/migrating-from-native-memory.md
  --no-build        use the checkout as already built (development)
  --delete-data     uninstall only: also delete the memory store (--root)
  -h, --help        this help

Environment:
  MNEMOSYNE_BRANCH=NAME   follow branch NAME instead of the latest release (development)
  MNEMOSYNE_REPO_URL=URL  where to get the code from (default: the GitHub repo)
EOF
}

# A directory option's value, refused when it looks like a flag (MNE-106):
# `--root --help` would otherwise install a store at ./--help.
check_dir_arg() { # $1 = option, $2 = value
  case "$2" in
    -*) echo "install.sh: $1 expects a directory, got '$2' (write a path that starts with '-' as './$2')" >&2; exit 2 ;;
  esac
}

# The arguments as given, single-quoted for `eval`: an upgrade hands them,
# unchanged, to the installer of the version it moves to (see handoff).
ORIG_ARGS=""
for _a in "$@"; do ORIG_ARGS="$ORIG_ARGS '$(printf '%s' "$_a" | sed "s/'/'\\\\''/g")'"; done

while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall) ACTION="$1" ;;
    upgrade|update) ACTION=upgrade ;;   # `update`: its name before MNE-114
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --dir) shift; check_dir_arg --dir "${1:?--dir needs a value}"; INSTALL_DIR="$1" ;;
    --bin-dir) shift; check_dir_arg --bin-dir "${1:?--bin-dir needs a value}"; BIN_DIR="$1" ;;
    --root) shift; check_dir_arg --root "${1:?--root needs a value}"; STORE_ROOT="$1" ;;
    --model) shift; MODEL="${1:?--model needs a value}"; MODEL_EXPLICIT=1 ;;
    --no-ollama-pull) DO_OLLAMA_PULL=0 ;;
    --no-claude-md) DO_CLAUDE_MD=0 ;;
    --no-claude) NO_CLAUDE=1 ;;
    --no-codex) NO_CODEX=1 ;;
    --no-opencode) NO_OPENCODE=1 ;;
    --import-native) IMPORT_NATIVE=yes ;;
    --no-import-native) IMPORT_NATIVE=no ;;
    --no-build) DO_BUILD=0 ;;
    --delete-data) DELETE_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ------------------------------------------------------------------ output ---
say() { printf '%s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
miss() { printf '  [MISSING] %s\n' "$*"; }
fix() { printf '           fix: %s\n' "$*"; }
note() { printf '           %s\n' "$*"; }
die() { printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) OS=other ;;
esac

# Absolute path without requiring the directory to exist.
abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}
INSTALL_DIR="$(abspath "$INSTALL_DIR")"
BIN_DIR="$(abspath "$BIN_DIR")"
STORE_ROOT="$(abspath "$STORE_ROOT")"

# Run from inside a clone (`./install.sh`), the clone IS the code: use it in
# place and never delete it. Piped through `sh`, there is no script path, so the
# code comes from a fresh clone into INSTALL_DIR. The clone the installer made
# itself (marked) is managed, not "yours": `sh ~/.mnemosyne/install.sh update`
# pulls it, and uninstall deletes it.
IN_PLACE=0
case "$0" in
  */install.sh|install.sh)
    _src="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$_src/package.json" ] && grep -q '"name": "mnemosyne"' "$_src/package.json"; then
      INSTALL_DIR="$_src"
      [ -f "$_src/.$OWNER_MARK" ] || IN_PLACE=1
    fi
    ;;
esac
# Handed over: work on exactly the clone the previous installer chose, which
# may have come from its own path rather than from --dir.
[ -n "${MNEMOSYNE_HANDOFF_DIR:-}" ] && INSTALL_DIR="$MNEMOSYNE_HANDOFF_DIR"
MNEME_JS="$INSTALL_DIR/dist/bin/mneme.js"

# The installer picks the model only when nobody has yet: an explicit --model,
# or a store with no model in its config and no OLLAMA_MODEL. A store that
# already embeds with some model keeps it — replacing it on an update would
# leave an index that mneme refuses to use until a full rebuild.
CHOOSE_MODEL=0
if [ "$MODEL_EXPLICIT" = 1 ]; then
  CHOOSE_MODEL=1
elif [ "$ACTION" = install ] && [ -z "${OLLAMA_MODEL:-}" ] && ! grep -q '"model"' "$STORE_ROOT/.config.json" 2>/dev/null; then
  CHOOSE_MODEL=1
fi

# ------------------------------------------------------------ requirements ---
BLOCKING=0
HAS_OLLAMA=0     # the CLI exists
OLLAMA_UP=0      # and its server answers
MODEL_PRESENT=0  # and already has the model

OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"
case "$OLLAMA_URL" in http://*|https://*) ;; *) OLLAMA_URL="http://$OLLAMA_URL" ;; esac

ollama_tags() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e 'fetch(process.argv[1] + "/api/tags", { signal: AbortSignal.timeout(3000) }).then(async (r) => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); }).catch(() => process.exit(1))' "$OLLAMA_URL" 2>/dev/null
  else
    return 1
  fi
}

node_fix() {
  if [ "$OS" = macos ]; then
    # Not 'brew install node@22': that formula is keg-only (not on the PATH), and
    # a clean Mac has no Homebrew anyway.
    fix "the LTS installer from https://nodejs.org/en/download   (or: brew install node — or nvm: 'nvm install --lts')"
  else
    fix "nvm install 22   (nvm: https://github.com/nvm-sh/nvm — or https://nodejs.org/en/download/package-manager)"
  fi
}

# ------------------------------------------------------------------ agents ---
# MNE-113: which agents are on this machine (FOUND_*), which ones a previous
# install already wired (WIRED_*, found by what it left behind, so it does not
# depend on the PATH) and which ones this run wires (WIRE_*).
FOUND_CLAUDE=0; FOUND_CODEX=0; FOUND_OPENCODE=0
WIRED_CLAUDE=0; WIRED_CODEX=0; WIRED_OPENCODE=0
WIRE_CLAUDE=0; WIRE_CODEX=0; WIRE_OPENCODE=0

has_block() { [ -f "$1" ] && grep -qF "$BLOCK_BEGIN" "$1"; }
has_hook() { [ -f "$1" ] && grep -q 'mneme context' "$1"; }

# Codex reads AGENTS.override.md instead of AGENTS.md when the override has
# anything in it, so that is where the block has to go.
codex_md() {
  if [ -f "$CODEX_DIR/AGENTS.override.md" ] && grep -q '[^[:space:]]' "$CODEX_DIR/AGENTS.override.md"; then
    printf '%s' "$CODEX_DIR/AGENTS.override.md"
  else
    printf '%s' "$CODEX_DIR/AGENTS.md"
  fi
}

detect_agents() {
  { command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE_DIR" ]; } && FOUND_CLAUDE=1
  { command -v codex >/dev/null 2>&1 || [ -d "$CODEX_DIR" ]; } && FOUND_CODEX=1
  { command -v opencode >/dev/null 2>&1 || [ -d "$OPENCODE_DIR" ]; } && FOUND_OPENCODE=1
  { has_hook "$SETTINGS" || has_block "$CLAUDE_MD"; } && WIRED_CLAUDE=1
  { has_hook "$CODEX_HOOKS" || has_block "$CODEX_DIR/AGENTS.md" || has_block "$CODEX_DIR/AGENTS.override.md"; } && WIRED_CODEX=1
  has_block "$OPENCODE_MD" && WIRED_OPENCODE=1
  if [ "$ACTION" = upgrade ]; then
    # An update keeps what is wired as it is; adding an agent is an install.
    WIRE_CLAUDE=$WIRED_CLAUDE; WIRE_CODEX=$WIRED_CODEX; WIRE_OPENCODE=$WIRED_OPENCODE
  else
    WIRE_CLAUDE=$FOUND_CLAUDE; WIRE_CODEX=$FOUND_CODEX; WIRE_OPENCODE=$FOUND_OPENCODE
    # Nothing found: Claude Code, as before there was a choice.
    [ "$FOUND_CLAUDE$FOUND_CODEX$FOUND_OPENCODE" = 000 ] && WIRE_CLAUDE=1
  fi
  [ "$NO_CLAUDE" = 1 ] && WIRE_CLAUDE=0
  [ "$NO_CODEX" = 1 ] && WIRE_CODEX=0
  [ "$NO_OPENCODE" = 1 ] && WIRE_OPENCODE=0
  return 0
}

# How OpenCode gets the block. It reads ~/.config/opencode/AGENTS.md, and only
# while that file does not exist falls back to ~/.claude/CLAUDE.md — so creating
# it would silently cut everything else in CLAUDE.md off from OpenCode.
#   own       the block goes into its AGENTS.md (there already, or created)
#   fallback  it reads the block from CLAUDE.md; nothing to write
#   manual    CLAUDE.md is the user's, without the block: leave both alone
opencode_mode() {
  if [ -f "$OPENCODE_MD" ]; then printf own; return 0; fi
  if [ -n "${OPENCODE_DISABLE_CLAUDE_CODE:-}" ] || [ -n "${OPENCODE_DISABLE_CLAUDE_CODE_PROMPT:-}" ]; then printf own; return 0; fi
  if [ "$WIRE_CLAUDE" = 1 ] && [ "$DO_CLAUDE_MD" = 1 ]; then printf fallback; return 0; fi
  if [ -f "$CLAUDE_MD" ]; then
    if grep -q 'mneme' "$CLAUDE_MD"; then printf fallback; else printf manual; fi
    return 0
  fi
  printf own
}

check_requirements() {
  section "Requirements"
  # update needs it too: it fetches and checks out the new release.
  if [ "$IN_PLACE" = 0 ] && { [ "$ACTION" = install ] || [ "$ACTION" = upgrade ]; }; then
    if command -v git >/dev/null 2>&1; then
      ok "git ($(git --version 2>/dev/null | head -n1)) — to download the code"
    else
      miss "git — needed to download the code and to update it later"
      if [ "$OS" = macos ]; then fix "xcode-select --install   (installs git with the compiler tools)"
      else fix "sudo apt-get install -y git   (Fedora: sudo dnf install -y git)"; fi
      BLOCKING=1
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    _nv="$(node -p 'process.versions.node' 2>/dev/null || node --version 2>/dev/null || echo unknown)"
    _nv="${_nv#v}"
    _major="${_nv%%.*}"
    case "$_major" in ''|*[!0-9]*) _major=0 ;; esac
    if [ "$_major" -ge "$NODE_MIN_MAJOR" ]; then
      ok "Node.js $_nv — runs Mnemosyne"
    else
      miss "Node.js $_nv is too old: Mnemosyne needs Node.js >= $NODE_MIN_MAJOR"
      node_fix
      BLOCKING=1
    fi
    if ! command -v npm >/dev/null 2>&1; then
      miss "npm — ships with Node.js; used here only to fetch dependencies (Mnemosyne itself is not on npm)"
      node_fix
      BLOCKING=1
    fi
  else
    miss "Node.js >= $NODE_MIN_MAJOR — Mnemosyne is a Node.js program"
    node_fix
    BLOCKING=1
  fi

  # better-sqlite3 and sqlite-vec are native modules. npm usually downloads a
  # prebuilt binary, and only compiles when none matches this machine — so a
  # missing toolchain is a warning, not a stop.
  if [ "$OS" = macos ]; then
    if xcode-select -p >/dev/null 2>&1; then
      ok "Xcode Command Line Tools — compiler for the SQLite modules, if they need building"
    else
      warn "Xcode Command Line Tools not found — needed only if the SQLite modules have to be compiled"
      fix "xcode-select --install"
    fi
  else
    _tc_missing=""
    command -v make >/dev/null 2>&1 || _tc_missing="$_tc_missing make"
    { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; } || _tc_missing="$_tc_missing g++"
    command -v python3 >/dev/null 2>&1 || _tc_missing="$_tc_missing python3"
    if [ -z "$_tc_missing" ]; then
      ok "build tools (make, g++, python3) — to compile the SQLite modules, if they need building"
    else
      warn "build tools missing:$_tc_missing — needed only if the SQLite modules have to be compiled"
      fix "sudo apt-get install -y build-essential python3   (Fedora: sudo dnf install -y gcc-c++ make python3)"
    fi
  fi

  detect_agents
  [ "$FOUND_CLAUDE" = 1 ] && ok "Claude Code (claude) — Mnemosyne wires into it: a session-start hook and an instructions block"
  [ "$FOUND_CODEX" = 1 ] && ok "Codex CLI (codex) — Mnemosyne wires into it: a session-start hook and an instructions block"
  [ "$FOUND_OPENCODE" = 1 ] && ok "OpenCode (opencode) — Mnemosyne wires into it: an instructions block (OpenCode has no session hook)"
  if [ "$FOUND_CLAUDE" = 0 ] && [ "$FOUND_CODEX" = 0 ] && [ "$FOUND_OPENCODE" = 0 ]; then
    warn "no agent found (Claude Code, Codex CLI, OpenCode) — Mnemosyne installs anyway and wires Claude Code, the default"
    note "Claude Code:  curl -fsSL https://claude.ai/install.sh | bash"
    note "Codex CLI:    curl -fsSL https://chatgpt.com/codex/install.sh | sh"
    note "OpenCode:     https://opencode.ai/docs"
    note "Installed one later? Run this installer again and it wires that one in too."
  fi

  # Asked over HTTP, not with `ollama list`: that command tries to START the
  # server (and waits for it), which is a side effect a check must not have.
  command -v ollama >/dev/null 2>&1 && HAS_OLLAMA=1
  if _tags="$(ollama_tags)"; then
    OLLAMA_UP=1
    if printf '%s' "$_tags" | grep -Eq "\"name\": *\"${MODEL}(:latest)?\""; then
      MODEL_PRESENT=1
      ok "Ollama at $OLLAMA_URL, with $MODEL — semantic search (optional)"
    else
      ok "Ollama at $OLLAMA_URL — semantic search (optional); the model $MODEL is not downloaded yet"
    fi
  elif [ "$HAS_OLLAMA" = 1 ]; then
    warn "Ollama is installed but not answering at $OLLAMA_URL — semantic search needs it running"
    fix "ollama serve   (or open the Ollama app), then re-run this installer"
  else
    say "  [opt]  Ollama not found — optional."
  fi
  if [ "$CHOOSE_MODEL" = 1 ] && [ "$MODEL_PRESENT" = 0 ] && { [ "$OLLAMA_UP" = 0 ] || [ "$HAS_OLLAMA" = 0 ] || [ "$DO_OLLAMA_PULL" = 0 ]; }; then
    note "Without Ollama serving an embedding model Mnemosyne runs in TIER 0: keyword"
    note "search (BM25) over your notes, with nothing else to install. What you lose"
    note "is semantic search: finding a note by meaning when it shares no words with"
    note "your query."
    note "To add it later:"
    [ "$HAS_OLLAMA" = 1 ] || note "  - install Ollama: https://ollama.com/download"
    note "  - ollama pull $MODEL"
    note "  - mneme init --write --embedder ollama --model $MODEL"
    note "  - rm -rf '$STORE_ROOT/.index' && mneme reindex   (the index is derived; your notes are untouched)"
  fi
}

# ------------------------------------------------------- which version ---
# What install/update will check out: TARGET_KIND is `tag` (a release),
# `branch` (MNEMOSYNE_BRANCH, or no release exists yet) or `unreachable` (the
# repo could not be listed). Resolved BEFORE the plan, so the plan and
# --dry-run name the exact version, and without writing anything.
TARGET_KIND=""
TARGET_REF=""
TARGET_WHY=""

# stdin: tag names, one per line -> stdout: the newest `vX.Y.Z`, or when there
# is none, the newest pre-release `vX.Y.Z-…`; nothing at all when neither exists.
# Compared by semver precedence (numbers as numbers, so v0.10.0 is after v0.9.0;
# pre-release identifiers left to right, so beta.1 is after alpha.9). Other tags
# are ignored.
newest_tag() {
  awk '
    function cmpid(x, y,   xn, yn) {
      xn = (x ~ /^[0-9]+$/); yn = (y ~ /^[0-9]+$/)
      if (xn && yn) return (x + 0 < y + 0) ? -1 : (x + 0 > y + 0)
      if (xn != yn) return xn ? -1 : 1
      return (x "" < y "") ? -1 : (x "" > y "")
    }
    function cmpver(a, b,   ia, ib, ca, cb, pa, pb, xa, xb, ya, yb, na, nb, i, c) {
      ia = index(a, "-"); ib = index(b, "-")
      ca = ia ? substr(a, 1, ia - 1) : a; pa = ia ? substr(a, ia + 1) : ""
      cb = ib ? substr(b, 1, ib - 1) : b; pb = ib ? substr(b, ib + 1) : ""
      split(ca, xa, "."); split(cb, xb, ".")
      for (i = 1; i <= 3; i++) if (xa[i] + 0 != xb[i] + 0) return (xa[i] + 0 < xb[i] + 0) ? -1 : 1
      if (pa == "" || pb == "") return (pa == "") - (pb == "")
      na = split(pa, ya, "."); nb = split(pb, yb, ".")
      for (i = 1; i <= na && i <= nb; i++) { c = cmpid(ya[i], yb[i]); if (c) return c }
      return (na < nb) ? -1 : (na > nb)
    }
    /^v[0-9]+[.][0-9]+[.][0-9]+$/ { v = substr($0, 2); if (stable == "" || cmpver(v, stable) > 0) stable = v; next }
    /^v[0-9]+[.][0-9]+[.][0-9]+-[0-9A-Za-z.-]+$/ { v = substr($0, 2); if (pre == "" || cmpver(v, pre) > 0) pre = v }
    END { if (stable != "") print "v" stable; else if (pre != "") print "v" pre }
  '
}

# Tag names of a repo, read-only: `git ls-remote` works the same for https,
# ssh, a local path or a bundle. $1 = URL or remote name, $2 = repo to run in
# (for a remote name). Fails when the repo cannot be reached. Never prompts:
# under `curl | sh` there is nobody to type a password.
remote_tags() {
  if [ -n "${2:-}" ]; then
    _refs="$(GIT_TERMINAL_PROMPT=0 git -C "$2" ls-remote --tags --refs "$1" 2>/dev/null)" || return 1
  else
    _refs="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$1" 2>/dev/null)" || return 1
  fi
  printf '%s\n' "$_refs" | sed -n 's|^.*[[:space:]]refs/tags/||p'
}

resolve_target() {
  [ "$IN_PLACE" = 0 ] || return 0   # your own checkout is never moved
  [ "$ACTION" != uninstall ] || return 0
  if [ "$BRANCH_EXPLICIT" = 1 ]; then
    TARGET_KIND=branch; TARGET_REF="$BRANCH"
    TARGET_WHY="development channel: following branch '$BRANCH' because MNEMOSYNE_BRANCH is set"
    return 0
  fi
  command -v git >/dev/null 2>&1 || return 0   # reported as [MISSING] already
  # An existing clone updates from wherever it was cloned from.
  if [ -d "$INSTALL_DIR/.git" ]; then _from=origin; _in="$INSTALL_DIR"; else _from="$REPO_URL"; _in=""; fi
  if _tags="$(remote_tags "$_from" "$_in")"; then
    TARGET_REF="$(printf '%s\n' "$_tags" | newest_tag)"
    if [ -n "$TARGET_REF" ]; then
      TARGET_KIND=tag; TARGET_WHY="latest release"
    else
      TARGET_KIND=branch; TARGET_REF="$BRANCH"
      TARGET_WHY="no release tags published yet, so following branch '$BRANCH' until there are"
    fi
  else
    TARGET_KIND=unreachable
    TARGET_WHY="could not list the releases of $( [ -n "$_in" ] && git -C "$_in" remote get-url origin 2>/dev/null || printf '%s' "$REPO_URL" ) (offline, or no access?)"
  fi
}

current_version() { git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || printf 'unknown'; }

# ------------------------------------------------------------- the plan -----
plan_install() {
  section "What $ACTION will change"
  if [ "$IN_PLACE" = 1 ]; then
    say "  code:     use this checkout in place: $INSTALL_DIR"
    if [ "$ACTION" = upgrade ]; then
      say "            (not pulled: it is your checkout — run 'git pull' in it yourself)"
    fi
  elif [ "$TARGET_KIND" = unreachable ]; then
    say "  code:     UNKNOWN — $TARGET_WHY"
  elif [ "$ACTION" = install ] && [ ! -d "$INSTALL_DIR/.git" ] && [ -z "$TARGET_REF" ]; then
    # No git yet (reported as [MISSING]), so the releases cannot be listed.
    say "  code:     git clone $REPO_URL"
    say "            into $INSTALL_DIR — the latest release (resolved once git is installed)"
  elif [ -d "$INSTALL_DIR/.git" ] && [ -z "$TARGET_REF" ]; then
    say "  code:     move $INSTALL_DIR to the latest release (resolved once git is installed)"
  elif [ "$ACTION" = install ] && [ ! -d "$INSTALL_DIR/.git" ]; then
    say "  code:     git clone --branch $TARGET_REF $REPO_URL"
    say "            into $INSTALL_DIR  ($TARGET_WHY)"
  elif [ ! -d "$INSTALL_DIR/.git" ]; then
    say "  code:     nothing to upgrade: $INSTALL_DIR is not an installation"
  else
    _cur="$(current_version)"
    if [ "$TARGET_KIND" = tag ] && [ "$_cur" = "$TARGET_REF" ]; then
      say "  code:     already at $TARGET_REF ($TARGET_WHY) in $INSTALL_DIR"
    elif [ "$TARGET_KIND" = tag ]; then
      say "  code:     move $INSTALL_DIR from $_cur to $TARGET_REF ($TARGET_WHY)"
    else
      say "  code:     move $INSTALL_DIR from $_cur to the tip of '$TARGET_REF'"
      say "            ($TARGET_WHY)"
    fi
    say "            refused if that folder has local changes"
  fi
  if [ "$DO_BUILD" = 1 ]; then
    say "  build:    npm ci && npm run build inside $INSTALL_DIR (dependencies stay in that folder)"
  else
    say "  build:    skipped (--no-build)"
  fi
  say "  commands: $BIN_DIR/mneme and $BIN_DIR/mem (small wrappers that run $MNEME_JS)"
  plan_agents
  say "  data:     your memories live in $STORE_ROOT as plain Markdown files."
  say "            Existing notes are never touched. Added if missing: .scopemap (catch-all '~ = personal'),"
  say "            and .config.json (search tier and model, so no environment variables are needed)."
  plan_native
  if [ "$ACTION" = upgrade ]; then
    say "  index:    mneme reindex --root '$STORE_ROOT' — incremental: picks up what the new version"
    say "            changes in the index now rather than at the next session"
  fi
  if [ "$IN_PLACE" = 1 ]; then
    say "  updates:  no new-version check (it runs only for the installer's own clone)"
  else
    say "  updates:  once a day, 'mneme context' asks GitHub whether a newer release exists (one"
    say "            HTTPS GET to api.github.com; nothing about you or your memories is sent) and says"
    say "            so at session start. Turn it off with MNEMOSYNE_NO_UPDATE_CHECK=1, or"
    say "            \"updateCheck\": false in $STORE_ROOT/.config.json"
  fi
  if will_pull_model; then
    say "  ollama:   ollama pull $MODEL ($(model_size))"
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say ""
      say "  NOTE: $BIN_DIR is not on your PATH. The hook runs 'mneme', so add this line to"
      say "        your shell's startup file (zsh: ~/.zshenv; bash: ~/.bashrc and ~/.profile)."
      say "        The installer does not edit those files for you:"
      say "          export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

# One entry per agent: what is wired, what is not and why. The instructions
# block is the same everywhere (docs/integrations/memory-instructions.md),
# between markers, appended once; skipped where the file already mentions mneme.
plan_agents() {
  say "  agents:"
  _verb=add; [ "$ACTION" = upgrade ] && _verb=refresh
  if [ "$WIRE_CLAUDE" = 1 ]; then
    say "    Claude Code: SessionStart hook -> mneme context --root '$STORE_ROOT'"
    say "                 in $SETTINGS (other settings untouched; original saved once as settings.json.before-mnemosyne)"
    [ "$DO_CLAUDE_MD" = 1 ] && say "                 $_verb the instructions block in $CLAUDE_MD"
  else
    plan_not_wired "Claude Code" "$FOUND_CLAUDE" "$NO_CLAUDE" --no-claude
  fi
  if [ "$WIRE_CODEX" = 1 ]; then
    say "    Codex CLI:   SessionStart hook in $CODEX_HOOKS — trust it once in Codex with /hooks"
    say "                 $_verb the instructions block in $(codex_md)"
  else
    plan_not_wired "Codex CLI" "$FOUND_CODEX" "$NO_CODEX" --no-codex
  fi
  if [ "$WIRE_OPENCODE" = 1 ]; then
    case "$(opencode_mode)" in
      own) say "    OpenCode:    $_verb the instructions block in $OPENCODE_MD (no session hook: the agent runs 'mneme context' itself)" ;;
      fallback) say "    OpenCode:    reads the block from $CLAUDE_MD (its fallback while it has no AGENTS.md of its own); nothing to write" ;;
      manual)
        say "    OpenCode:    nothing written. It reads $CLAUDE_MD while $OPENCODE_MD does not exist,"
        say "                 so creating that file would hide your CLAUDE.md from OpenCode. Paste the block"
        say "                 from $INSTALL_DIR/docs/integrations/memory-instructions.md where you want it."
        ;;
    esac
  else
    plan_not_wired "OpenCode" "$FOUND_OPENCODE" "$NO_OPENCODE" --no-opencode
  fi
}

plan_not_wired() { # $1 = name, $2 = found, $3 = skipped by flag, $4 = that flag
  if [ "$3" = 1 ]; then printf '    %-12s %s\n' "$1:" "skipped ($4)"
  elif [ "$2" = 1 ] && [ "$ACTION" = upgrade ]; then printf '    %-12s %s\n' "$1:" "found but not wired — run the installer again (install, not upgrade) to add it"
  elif [ "$2" = 1 ]; then printf '    %-12s %s\n' "$1:" "not wired (you said no)"
  fi
  return 0
}

plan_uninstall() {
  section "What uninstall will change"
  say "  hooks:    remove every 'mneme context' SessionStart hook from $SETTINGS and $CODEX_HOOKS"
  say "  blocks:   remove the block between the Mnemosyne markers (where present) from"
  say "            $CLAUDE_MD, $CODEX_DIR/AGENTS.md (and AGENTS.override.md), $OPENCODE_MD"
  say "  commands: remove $BIN_DIR/mneme and $BIN_DIR/mem (only the installer's wrappers)"
  if [ "$IN_PLACE" = 1 ]; then
    say "  code:     keep $INSTALL_DIR — it is your own checkout"
  elif [ -f "$INSTALL_DIR/.$OWNER_MARK" ]; then
    say "  code:     delete $INSTALL_DIR"
  else
    say "  code:     nothing to delete ($INSTALL_DIR was not created by this installer)"
  fi
  if [ "$DELETE_DATA" = 1 ]; then
    say "  data:     DELETE $STORE_ROOT — every memory, its index and its telemetry."
    say "            This cannot be undone. Copies synced to other machines are not touched."
  else
    say "  data:     KEEP $STORE_ROOT (your memories are plain Markdown; still yours)."
    say "            To delete them too, re-run with --delete-data."
  fi
  say "  not touched: Node.js, Ollama and its models (remove one with 'ollama rm $MODEL')."
}

# ---------------------------------------------------------- confirmation ---
# The terminal, opened once on fd 3 so successive questions read successive
# answers. Probed in a subshell: a failed `exec` redirection would end this shell.
TTY_STATE=unknown
open_tty() {
  if [ "$TTY_STATE" = unknown ]; then
    if (exec 3<"$TTY_IN") 2>/dev/null; then exec 3<"$TTY_IN"; TTY_STATE=open; else TTY_STATE=none; fi
  fi
  [ "$TTY_STATE" = open ]
}

prompt() { # the question goes where the answer comes from: a real terminal, or stdout
  if [ "$TTY_IN" = /dev/tty ]; then printf '%s' "$1" >/dev/tty; else printf '%s' "$1"; fi
}

# A choice with a default of yes. Asked only when someone can answer: never
# with --yes, in a dry run, or without a terminal — those take the default.
ask_yes() {
  [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ] && open_tty || return 0
  prompt "$1 [Y/n] "
  read -r _answer <&3 || _answer=""
  case "$_answer" in n|N|no|NO|No) return 1 ;; esac
  return 0
}

ask_choices() {
  [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ] && open_tty || return 0
  [ "$ACTION" = install ] || native_offered || return 0
  section "Choices (Enter = yes)"
  if [ "$ACTION" = install ]; then
    if [ "$WIRE_CLAUDE" = 1 ]; then ask_yes "  Wire Mnemosyne into Claude Code?" || WIRE_CLAUDE=0; fi
    if [ "$WIRE_CODEX" = 1 ]; then ask_yes "  Wire Mnemosyne into the Codex CLI?" || WIRE_CODEX=0; fi
    if [ "$WIRE_OPENCODE" = 1 ]; then ask_yes "  Wire Mnemosyne into OpenCode?" || WIRE_OPENCODE=0; fi
    if will_pull_model; then
      ask_yes "  Download the embedding model $MODEL ($(model_size)) for semantic search? Without it, search is by keywords only." || DO_OLLAMA_PULL=0
    fi
  fi
  if native_offered && [ "$IMPORT_NATIVE" = ask ]; then
    ask_yes "  Import $(plural "$NATIVE_NOTES" note) from Claude Code's native memory ($(plural "$NATIVE_DIRS" folder) under $CLAUDE_PROJECTS) into scope 'personal'?" || IMPORT_NATIVE=declined
  fi
  return 0
}

# ------------------------------------------------- native memory (MNE-117) ---
# Claude Code keeps its own memory per project in ~/.claude/projects/<cwd-slug>/memory/.
# Someone who has used it installs Mnemosyne and gets an empty digest: it looks
# like nothing works. The installer offers to import it — but only into a store
# whose only scope is `personal`. With more scopes there is a client somewhere
# and a folder name cannot be decoded into a project (docs/guide/migrating-
# from-native-memory.md does it by hand, scope by scope); a note misrouted to
# `personal` would survive deleting that client's scope. Fail closed.
NATIVE_DIRS=0
NATIVE_NOTES=0
NATIVE_LIST=""
NATIVE_OTHER_SCOPES=""
NATIVE_IMPORTED_BEFORE=0
NATIVE_IMPORTED=0
NATIVE_LEFT=0
NATIVE_MARKER="$STORE_ROOT/.native-imported"

plural() { if [ "$1" = 1 ]; then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }

native_notes_in() { # $1 = a memory folder → how many notes the importer would consider
  find "$1" -maxdepth 1 -type f -name '*.md' ! -name '.*' ! -iname 'MEMORY.md' ! -iname 'INDEX.md' 2>/dev/null | wc -l | tr -d ' '
}

# The source-id is the project folder's name as a kebab slug plus a checksum of
# the exact name: deterministic, so a second run lands on the same slugs and
# imports nothing twice, and distinct folders that slugify alike ('my-app',
# 'my_app') never share an identity — the import's own slug hashes only the
# filename, so a shared source-id would turn them into conflicts.
native_source_id() { # $1 = a memory folder
  _folder="$(basename "$(dirname "$1")")"
  _sid="$(printf '%s' "$_folder" | tr 'A-Z' 'a-z' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//')"
  printf '%s-%s' "${_sid:-project}" "$(printf '%s' "$_folder" | cksum | cut -d' ' -f1)"
}

scan_native() {
  [ -d "$CLAUDE_PROJECTS" ] || return 0
  for _d in "$CLAUDE_PROJECTS"/*/memory; do
    [ -d "$_d" ] || continue
    _n="$(native_notes_in "$_d")"
    [ "$_n" -gt 0 ] || continue
    NATIVE_DIRS=$((NATIVE_DIRS + 1))
    NATIVE_NOTES=$((NATIVE_NOTES + _n))
    NATIVE_LIST="$NATIVE_LIST$_d
"
  done
  [ "$NATIVE_NOTES" -gt 0 ] || return 0
  # Scope folders are kebab-case directories in the store root ('archive' is not one).
  for _s in "$STORE_ROOT"/*/; do
    [ -d "$_s" ] || continue
    _name="$(basename "$_s")"
    case "$_name" in personal|archive) continue ;; esac
    printf '%s' "$_name" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || continue
    NATIVE_OTHER_SCOPES="$NATIVE_OTHER_SCOPES${NATIVE_OTHER_SCOPES:+, }$_name"
  done
  # Imported before: the installer's marker (feedback notes become facts under a
  # ulid, so the slugs alone would miss a feedback-only import), or notes with the
  # importer's slug prefix from an import done by hand.
  [ -f "$NATIVE_MARKER" ] && NATIVE_IMPORTED_BEFORE=1
  for _f in "$STORE_ROOT"/personal/claude-*.md; do
    [ -f "$_f" ] && NATIVE_IMPORTED_BEFORE=1
    break
  done
  return 0
}

# Offered = there is something to import and no reason not to. An upgrade
# offers it once: when nothing was ever imported (new native notes after that
# are the guide's job, not a surprise on every upgrade).
native_offered() {
  [ "$NATIVE_NOTES" -gt 0 ] || return 1
  [ "$IMPORT_NATIVE" != no ] || return 1
  [ -z "$NATIVE_OTHER_SCOPES" ] || return 1
  if [ "$ACTION" = upgrade ] && [ "$NATIVE_IMPORTED_BEFORE" = 1 ]; then return 1; fi
  return 0
}

native_wanted() { native_offered && [ "$IMPORT_NATIVE" != declined ]; }

plan_native() {
  [ "$NATIVE_NOTES" -gt 0 ] || return 0
  say "  native:   Claude Code's native memory: $(plural "$NATIVE_NOTES" note) in $(plural "$NATIVE_DIRS" folder) under $CLAUDE_PROJECTS"
  if [ "$IMPORT_NATIVE" = no ]; then
    say "            skipped (--no-import-native)"
  elif [ -n "$NATIVE_OTHER_SCOPES" ]; then
    say "            not imported: this store has scopes besides personal ($NATIVE_OTHER_SCOPES), so each folder"
    say "            needs a scope chosen by hand — see $INSTALL_DIR/docs/guide/migrating-from-native-memory.md"
  elif [ "$ACTION" = upgrade ] && [ "$NATIVE_IMPORTED_BEFORE" = 1 ]; then
    say "            not imported again: the native memory was imported before. For notes added since,"
    say "            see $INSTALL_DIR/docs/guide/migrating-from-native-memory.md"
  elif [ "$IMPORT_NATIVE" = declined ]; then
    say "            not imported (you said no)"
  else
    say "            → import into scope 'personal' (a dry run per folder first; the originals are never"
    say "            touched, and a folder with a conflict or a failed note is left for you to do by hand)"
  fi
}

do_native_import() {
  native_wanted || return 0
  section "Importing Claude Code's native memory"
  printf '%s' "$NATIVE_LIST" | while IFS= read -r _d; do
    [ -n "$_d" ] || continue
    _sid="$(native_source_id "$_d")"
    _label="$(basename "$(dirname "$_d")")"
    _report="$(mneme_run import-claude --source "$_d" --source-id "$_sid" --scope personal --root "$STORE_ROOT" 2>&1)" || {
      warn "$_label: $(printf '%s\n' "$_report" | grep '^summary:' || printf '%s' "$_report" | tail -1)"
      note "left alone: resolve it by hand with 'mneme import-claude' — $INSTALL_DIR/docs/guide/migrating-from-native-memory.md"
      printf 'left\n' >> "$NATIVE_TALLY"
      continue
    }
    _report="$(mneme_run import-claude --source "$_d" --source-id "$_sid" --scope personal --root "$STORE_ROOT" --apply 2>&1)" || {
      warn "$_label: $(printf '%s\n' "$_report" | grep '^summary:' || printf '%s' "$_report" | tail -1)"
      printf 'left\n' >> "$NATIVE_TALLY"
      continue
    }
    _sum="$(printf '%s\n' "$_report" | grep '^summary:')"
    say "  $_label: ${_sum#summary: }"
    printf '%s\n' "$(printf '%s' "$_sum" | sed -n 's/^summary: imported \([0-9][0-9]*\),.*/\1/p')" >> "$NATIVE_TALLY"
  done
}

# The while loop above runs in a subshell, so the tally comes back through a file.
native_tally() {
  [ -f "$NATIVE_TALLY" ] || return 0
  while IFS= read -r _t; do
    case "$_t" in
      left) NATIVE_LEFT=$((NATIVE_LEFT + 1)) ;;
      '') ;;
      *) NATIVE_IMPORTED=$((NATIVE_IMPORTED + _t)) ;;
    esac
  done < "$NATIVE_TALLY"
  rm -f "$NATIVE_TALLY"
  [ "$NATIVE_IMPORTED" -gt 0 ] && date '+%Y-%m-%d' > "$NATIVE_MARKER"
  return 0
}

will_pull_model() {
  [ "$CHOOSE_MODEL" = 1 ] && [ "$HAS_OLLAMA" = 1 ] && [ "$OLLAMA_UP" = 1 ] && [ "$MODEL_PRESENT" = 0 ] && [ "$DO_OLLAMA_PULL" = 1 ]
}

model_size() {
  if [ "$MODEL" = nomic-embed-text-v2-moe ]; then printf 'about 960 MB'; else printf 'size depends on the model'; fi
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # No terminal at all (CI, a pipe with no tty) means nobody can answer: stop.
  if open_tty; then
    prompt "$(printf '\n%s [y/N] ' "$1")"
    read -r _answer <&3 || _answer=""
    case "$_answer" in y|Y|yes|YES) return 0 ;; esac
    say "Nothing changed."
    exit 1
  fi
  die "no terminal to ask for confirmation; nothing changed. Re-run with --yes to accept the plan above (pipe: '| sh -s -- --yes')."
}

# --------------------------------------------------------------- helpers ---
backup_once() {
  # Keep the user's original, once: the first file before Mnemosyne ever touched it.
  if [ -f "$1" ] && [ ! -e "$1.before-mnemosyne" ]; then cp -p "$1" "$1.before-mnemosyne"; fi
}

mneme_run() { node "$MNEME_JS" "$@"; }

# The absolute node baked into the installer's own wrapper: the one the native
# modules were built for, and still there when this shell's PATH has no node
# (nvm not loaded). Empty when there is no such wrapper or its node is gone.
wrapper_node() {
  [ -f "$BIN_DIR/mneme" ] && grep -q "$OWNER_MARK" "$BIN_DIR/mneme" 2>/dev/null || return 0
  _wn="$(sed -n 's/^exec "\([^"]*\)" .*/\1/p' "$BIN_DIR/mneme")"
  if [ -n "$_wn" ] && [ -x "$_wn" ]; then printf '%s' "$_wn"; fi
}

# The block is the agent-agnostic instructions maintained in the repo, so the
# installer never carries a second copy that could drift from the CLI.
memory_block() {
  awk '/^````md$/ {on=1; next} /^````$/ {if (on) exit} on {print}' "$INSTALL_DIR/docs/integrations/memory-instructions.md"
}

strip_block() { # file -> stdout without the managed block (and the blank line we put before it)
  awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
    $0 == b { skip = 1; if (held) held = 0; next }
    skip && $0 == e { skip = 0; next }
    skip { next }
    { if (held) print ""; held = 0 }
    $0 == "" { held = 1; next }
    { print }
    END { if (held) print "" }
  ' "$1"
}

write_block() { # $1 = file (CLAUDE.md, an AGENTS.md), $2 = install|update
  if has_block "$1"; then
    _tmp="$1.mnemosyne-tmp"
    { strip_block "$1"; printf '\n%s\n' "$BLOCK_BEGIN"; memory_block; printf '%s\n' "$BLOCK_END"; } > "$_tmp"
    if cmp -s "$_tmp" "$1"; then rm -f "$_tmp"; else mv "$_tmp" "$1"; say "Refreshed the Mnemosyne block in $1."; fi
    return 0
  fi
  [ "$2" = install ] || return 0
  if [ -f "$1" ] && grep -q 'mneme' "$1"; then
    say "$1 already mentions mneme; not adding the instructions block."
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  backup_once "$1"
  { printf '\n%s\n' "$BLOCK_BEGIN"; memory_block; printf '%s\n' "$BLOCK_END"; } >> "$1"
  say "Added the Mnemosyne block to $1."
}

remove_block() { # $1 = file
  if has_block "$1"; then
    _tmp="$1.mnemosyne-tmp"
    strip_block "$1" > "$_tmp"
    # An empty leftover means the file only ever held our block.
    if [ -s "$_tmp" ] && grep -q '[^[:space:]]' "$_tmp"; then mv "$_tmp" "$1"; else rm -f "$_tmp" "$1"; fi
    say "Removed the Mnemosyne block from $1."
  fi
}

# Remove the session hook from a harness's settings file, running mneme with
# the wrapper's own node first: a hook left behind without its command breaks
# the start of every session. A file the install created (no original was
# saved) and that THIS removal left empty goes too; one the user had stays.
remove_hook() { # $1 = claude-code|codex, $2 = its settings file
  has_hook "$2" || return 0
  if [ -f "$MNEME_JS" ] && [ -n "$_unode" ] && "$_unode" "$MNEME_JS" uninstall-hook --harness "$1" --write; then
    if [ ! -e "$2.before-mnemosyne" ] && [ -f "$2" ] && [ "$(cat "$2")" = "{}" ]; then
      rm -f "$2"
      say "Deleted $2 (the install created it, and nothing else is in it)."
    fi
  else
    warn "cannot run mneme to edit $2; remove the 'mneme context' SessionStart hook from it by hand."
  fi
}

wire_agents() {
  if [ "$WIRE_CLAUDE" = 1 ] && [ "$DO_CLAUDE_MD" = 1 ]; then write_block "$CLAUDE_MD" "$ACTION"; fi
  if [ "$WIRE_CODEX" = 1 ]; then
    [ "$ACTION" = install ] && backup_once "$CODEX_HOOKS"
    mneme_run install-hook --harness codex --write --root "$STORE_ROOT" || warn "could not write the Codex hook; see 'mneme install-hook --harness codex'"
    write_block "$(codex_md)" "$ACTION"
  fi
  if [ "$WIRE_OPENCODE" = 1 ] && [ "$(opencode_mode)" = own ]; then write_block "$OPENCODE_MD" "$ACTION"; fi
  return 0
}

write_wrappers() {
  mkdir -p "$BIN_DIR"
  # The absolute node is baked in: the hook runs without your shell's PATH
  # tweaks (nvm, asdf), and the native modules were built for THIS node.
  _node="$(command -v node)"
  for _name in mneme mem; do
    _dest="$BIN_DIR/$_name"
    if [ -e "$_dest" ] && ! grep -q "$OWNER_MARK" "$_dest" 2>/dev/null; then
      die "$_dest exists and was not created by this installer (npm link?). Remove it, or pass --bin-dir, and re-run."
    fi
    _tmp="$_dest.mnemosyne-tmp"
    # The store root is baked in too, as a default: without it a --root install
    # would have the hook read one store and every other command use ~/memory.
    # MNEMOSYNE_ROOT and --root still override it.
    _q_root="$(printf '%s' "$STORE_ROOT" | sed "s/'/'\\\\''/g")"
    printf '#!/bin/sh\n# %s: generated wrapper, safe to delete with ./install.sh uninstall\nif [ -z "${MNEMOSYNE_ROOT:-}" ]; then MNEMOSYNE_ROOT=%s; export MNEMOSYNE_ROOT; fi\nexec "%s" "%s" "$@"\n' "$OWNER_MARK" "'$_q_root'" "$_node" "$MNEME_JS" > "$_tmp"
    chmod 755 "$_tmp"
    if [ -f "$_dest" ] && cmp -s "$_tmp" "$_dest"; then rm -f "$_tmp"; else mv "$_tmp" "$_dest"; fi
  done
}

# Move the installer's clone to the resolved target. Refuses when the clone has
# local changes to tracked files: checking out over them would either fail
# halfway or carry them into a version they were not written for.
checkout_target() {
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    die "$INSTALL_DIR has local changes (see 'git -C $INSTALL_DIR status'). Commit or discard them and re-run. Nothing was changed."
  fi
  case "$TARGET_KIND" in
    tag)
      git -C "$INSTALL_DIR" fetch --quiet --tags --force origin || die "git fetch failed in $INSTALL_DIR. Nothing else was changed."
      git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$TARGET_REF" \
        || die "could not check out $TARGET_REF in $INSTALL_DIR. Nothing else was changed."
      ;;
    branch)
      git -C "$INSTALL_DIR" fetch --quiet origin "+refs/heads/$TARGET_REF:refs/remotes/origin/$TARGET_REF" \
        || die "git fetch of branch '$TARGET_REF' failed in $INSTALL_DIR. Nothing else was changed."
      git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout --quiet --detach "refs/remotes/origin/$TARGET_REF" \
        || die "could not check out '$TARGET_REF' in $INSTALL_DIR. Nothing else was changed."
      ;;
    *) die "do not know which version to check out. Nothing else was changed." ;;
  esac
  say "Now at $(current_version)."
}

build() {
  [ "$DO_BUILD" = 1 ] || return 0
  section "Building in $INSTALL_DIR"
  if ! (cd "$INSTALL_DIR" && npm ci --no-audit --no-fund); then
    say ""
    say "Installing dependencies failed. The usual cause is a native module (better-sqlite3,"
    say "sqlite-vec) that had to be compiled without a compiler. Install the build tools and re-run:"
    if [ "$OS" = macos ]; then say "  xcode-select --install"; else say "  sudo apt-get install -y build-essential python3"; fi
    exit 1
  fi
  (cd "$INSTALL_DIR" && npm run build)
  # npm can finish without better-sqlite3's native binary: npm 12 blocks
  # dependency install scripts not covered by allowScripts, and an
  # ignore-scripts config skips them all. Every command would then fail, so
  # check now and, once, run that install step by hand (npm rebuild is blocked
  # the same way): download the prebuilt binary, or compile it.
  if ! sqlite_loads; then
    say "The SQLite module (better-sqlite3) has no native binary; fetching it..."
    (cd "$INSTALL_DIR/node_modules/better-sqlite3" 2>/dev/null && { npx --no prebuild-install || node_gyp rebuild --release; }) || true
    if ! sqlite_loads; then
      say ""
      say "The SQLite module (better-sqlite3) still does not load: no prebuilt binary matched"
      say "this machine and compiling it failed. Install the build tools and re-run:"
      if [ "$OS" = macos ]; then say "  xcode-select --install"; else say "  sudo apt-get install -y build-essential python3"; fi
      exit 1
    fi
  fi
}

# npm's own copy of node-gyp — what it would use for the install script. Not
# found where npm keeps it: give up (the caller says to install the build
# tools) rather than fetch an unpinned node-gyp from the registry (MNE-115).
node_gyp() {
  _gyp="$(npm prefix -g 2>/dev/null)/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  [ -f "$_gyp" ] || return 1
  node "$_gyp" "$@"
}

sqlite_loads() {
  (cd "$INSTALL_DIR" && node -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1
}

run_init() {
  # Pass the model only when Ollama can actually serve it; otherwise init keeps
  # whatever this store already has, or picks tier 0 on a fresh one.
  # Claude Code's hook comes with init; skipped when Claude Code is not wired.
  _hook=""; [ "$WIRE_CLAUDE" = 1 ] || _hook="--no-hook"
  if [ "$CHOOSE_MODEL" = 1 ] && { [ "$MODEL_PRESENT" = 1 ] || [ "$MODEL_EXPLICIT" = 1 ]; }; then
    mneme_run init --write --root "$STORE_ROOT" --model "$MODEL" $_hook
  else
    mneme_run init --write --root "$STORE_ROOT" $_hook
  fi
}

# ---------------------------------------------------------------- actions ---
do_install_or_upgrade() {
  check_requirements
  resolve_target
  scan_native
  [ "$BLOCKING" = 1 ] || ask_choices
  plan_install
  if [ "$BLOCKING" = 1 ]; then
    die "fix the [MISSING] items above, then re-run. Nothing was changed."
  fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ -f "$MNEME_JS" ] && command -v node >/dev/null 2>&1; then
      section "mneme init would do (its own dry run)"
      _hook=""; [ "$WIRE_CLAUDE" = 1 ] || _hook="--no-hook"
      if [ "$CHOOSE_MODEL" = 1 ] && { [ "$MODEL_PRESENT" = 1 ] || [ "$MODEL_EXPLICIT" = 1 ]; }; then mneme_run init --root "$STORE_ROOT" --model "$MODEL" $_hook; else mneme_run init --root "$STORE_ROOT" $_hook; fi
    fi
    say ""
    say "Dry run: nothing was changed."
    return 0
  fi
  if [ "$IN_PLACE" = 0 ] && [ "$TARGET_KIND" = unreachable ]; then
    die "$TARGET_WHY. Nothing was changed."
  fi
  confirm "Go ahead?"

  if [ "$IN_PLACE" = 0 ]; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      section "Updating the code in $INSTALL_DIR"
      checkout_target
    elif [ "$ACTION" = upgrade ]; then
      die "no installation found in $INSTALL_DIR. Run the installer without 'upgrade' first (or pass --dir)."
    else
      [ -e "$INSTALL_DIR" ] && die "$INSTALL_DIR exists but is not a Mnemosyne clone. Move it away, or pass --dir."
      section "Downloading $TARGET_REF into $INSTALL_DIR"
      git -c advice.detachedHead=false clone --branch "$TARGET_REF" "$REPO_URL" "$INSTALL_DIR"
      : > "$INSTALL_DIR/.$OWNER_MARK"
    fi
  fi
  build
  [ -f "$MNEME_JS" ] || die "$MNEME_JS is missing; the build did not produce the CLI."

  if will_pull_model; then
    section "Downloading the embedding model"
    if ollama pull "$MODEL"; then MODEL_PRESENT=1; else warn "ollama pull failed; continuing in tier 0 (see above to add it later)"; fi
  fi

  section "Wiring it in"
  write_wrappers
  say "Wrote $BIN_DIR/mneme and $BIN_DIR/mem."
  [ "$ACTION" = install ] && [ "$WIRE_CLAUDE" = 1 ] && backup_once "$SETTINGS"
  run_init
  wire_agents
  NATIVE_TALLY="$(mktemp "${TMPDIR:-/tmp}/mnemosyne-native.XXXXXX")"
  do_native_import
  native_tally
  if [ "$ACTION" = upgrade ] || [ "$NATIVE_IMPORTED" -gt 0 ]; then
    # No index schema version to migrate: schema additions apply themselves
    # when the index is opened, and a changed embedder is caught by reindex.
    # Running it here does both now, instead of in the next session's hook.
    # Imported notes are on disk but not in the index until this runs.
    section "Bringing the index up to date"
    mneme_run reindex --root "$STORE_ROOT" || warn "reindex failed; the next 'mneme search' or session retries it"
  fi

  section "Done"
  [ "$IN_PLACE" = 0 ] && say "Mnemosyne $(current_version) is installed in $INSTALL_DIR."
  say "Your memories live in $STORE_ROOT."
  if [ "$NATIVE_IMPORTED" -gt 0 ] || [ "$NATIVE_LEFT" -gt 0 ]; then
    say "Imported $(plural "$NATIVE_IMPORTED" note) from Claude Code's native memory; the originals were not touched."
    [ "$NATIVE_LEFT" -gt 0 ] && say "$(plural "$NATIVE_LEFT" folder) left for you to import by hand (see above)."
    say "While the native memory stays on, the agent writes to both stores. To switch it off:"
    say "  $INSTALL_DIR/docs/guide/migrating-from-native-memory.md#5-turn-the-native-memory-off--first-in-a-test-configuration"
  fi
  [ "$WIRE_CLAUDE" = 1 ] && say "Claude Code: open a new session and it starts with them."
  if [ "$WIRE_CODEX" = 1 ]; then
    say "Codex CLI:   open Codex and trust the hook once with /hooks (until then it does nothing). Its"
    say "             default sandbox blocks the network and writes outside the project: allow 'mneme'"
    say "             both, or search (Ollama) and add (writes to $STORE_ROOT) fail quietly."
  fi
  if [ "$WIRE_OPENCODE" = 1 ]; then
    if [ "$(opencode_mode)" = manual ]; then
      say "OpenCode:    not wired — paste the block from $INSTALL_DIR/docs/integrations/memory-instructions.md"
    else
      say "OpenCode:    no session hook — the instructions tell the agent to run 'mneme context' itself."
    fi
  fi
  say "Try: mneme add \"I prefer short answers\" --type user --slug short-answers"
  say "     mneme search \"answers\""
  say "Upgrade later with:   $( [ "$IN_PLACE" = 1 ] && printf '%s' "$INSTALL_DIR/install.sh upgrade" || printf '%s' "mneme upgrade   (or: sh $INSTALL_DIR/install.sh upgrade)" )"
  say "Uninstall with:       $( [ "$IN_PLACE" = 1 ] && printf '%s' "$INSTALL_DIR/install.sh uninstall" || printf '%s' "sh $INSTALL_DIR/install.sh uninstall" )"
  # Said again at the end: the plan's NOTE has scrolled away by now, and the
  # "Try:" lines above fail in this very terminal (Ubuntu's ~/.profile adds
  # ~/.local/bin only if it existed when the shell started).
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say ""
      say "NOTE: $BIN_DIR is not on this terminal's PATH, so 'mneme' is not found here yet."
      say "      Open a new terminal, or run:   export PATH=\"$BIN_DIR:\$PATH\""
      say "      If a new terminal does not find it either, add that line to your shell's startup"
      say "      file (zsh: ~/.zshenv; bash: ~/.bashrc and ~/.profile)."
      ;;
  esac
}

do_uninstall() {
  plan_uninstall
  if [ "$DRY_RUN" = 1 ]; then say ""; say "Dry run: nothing was changed."; return 0; fi
  confirm "Uninstall?"
  if [ "$DELETE_DATA" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
    confirm "Really delete every memory in $STORE_ROOT? This cannot be undone."
  fi

  section "Uninstalling"
  # Hooks go BEFORE the wrappers (see remove_hook), for every agent, whatever
  # is on the PATH now: they are found by what the install left behind.
  _unode="$(wrapper_node)"
  [ -n "$_unode" ] || _unode="$(command -v node 2>/dev/null || true)"
  remove_hook claude-code "$SETTINGS"
  remove_hook codex "$CODEX_HOOKS"
  for _f in "$CLAUDE_MD" "$CODEX_DIR/AGENTS.md" "$CODEX_DIR/AGENTS.override.md" "$OPENCODE_MD"; do remove_block "$_f"; done
  for _name in mneme mem; do
    if [ -f "$BIN_DIR/$_name" ] && grep -q "$OWNER_MARK" "$BIN_DIR/$_name"; then rm -f "$BIN_DIR/$_name"; fi
  done
  say "Removed the mneme and mem commands from $BIN_DIR."
  if [ "$IN_PLACE" = 0 ] && [ -f "$INSTALL_DIR/.$OWNER_MARK" ]; then
    rm -rf "$INSTALL_DIR"
    say "Deleted $INSTALL_DIR."
  fi
  if [ "$DELETE_DATA" = 1 ]; then
    rm -rf "$STORE_ROOT"
    say "Deleted $STORE_ROOT."
  else
    say "Your memories were kept in $STORE_ROOT."
  fi
}

# ---------------------------------------------------------------- handoff ---
# MNE-114: an upgrade is planned and carried out by the installer of the
# version it moves TO, not by the one already installed — otherwise every
# installer fix would reach users one release late. Before printing anything:
# find the target, fetch it (git's object store and FETCH_HEAD only; the files
# are not touched) and, if its install.sh differs from this one, run that one
# with the same arguments. Anything that fails here just leaves this installer
# in charge, which reports the problem as before. A --dry-run hands over too,
# so the preview is the plan that will really run: the new installer changes
# nothing either, and the only write is the fetched release in git's object
# cache.
handoff() {
  [ -z "${MNEMOSYNE_HANDOFF:-}" ] || return 0          # already the target's installer
  [ "$IN_PLACE" = 0 ] && [ -d "$INSTALL_DIR/.git" ] || return 0
  case "$ACTION" in install|upgrade) ;; *) return 0 ;; esac
  command -v git >/dev/null 2>&1 || return 0
  resolve_target
  case "$TARGET_KIND" in
    tag) _ref="refs/tags/$TARGET_REF" ;;
    branch) _ref="refs/heads/$TARGET_REF" ;;
    *) return 0 ;;
  esac
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" fetch --quiet --no-tags origin "$_ref" 2>/dev/null || return 0
  _next="$(mktemp "${TMPDIR:-/tmp}/mnemosyne-installer.XXXXXX")" || return 0
  if ! git -C "$INSTALL_DIR" show FETCH_HEAD:install.sh > "$_next" 2>/dev/null || [ ! -s "$_next" ] \
     || { [ -f "$0" ] && cmp -s "$_next" "$0"; }; then
    rm -f "$_next"
    return 0
  fi
  # This installer may have found its clone from its own path (a --dir
  # install); the copy runs from a temp file, so it is told where it is.
  MNEMOSYNE_HANDOFF="$TARGET_REF"; MNEMOSYNE_HANDOFF_FILE="$_next"; MNEMOSYNE_HANDOFF_DIR="$INSTALL_DIR"
  export MNEMOSYNE_HANDOFF MNEMOSYNE_HANDOFF_FILE MNEMOSYNE_HANDOFF_DIR
  eval "set -- $ORIG_ARGS"
  exec sh "$_next" "$@"
}

handoff

say "Mnemosyne — $ACTION$( [ "$DRY_RUN" = 1 ] && printf ' (dry run: nothing will be changed)' )"
case "$ACTION" in
  install|upgrade) do_install_or_upgrade ;;
  uninstall) do_uninstall ;;
esac
