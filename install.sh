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

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
BLOCK_BEGIN="<!-- mnemosyne:begin — managed by Mnemosyne's install.sh; edits between these markers are replaced on update -->"
BLOCK_END="<!-- mnemosyne:end -->"
# Marks files the installer owns, so uninstall never deletes something it did
# not create (a checkout you cloned yourself, a `mneme` you linked by hand).
OWNER_MARK="mnemosyne-installer"

usage() {
  cat <<EOF
Mnemosyne installer

Usage: install.sh [install|update|uninstall] [options]

Commands:
  install     (default) check requirements, get the code, build it, wire it in
  update      move to the latest release and rebuild; keeps config, hook, .scopemap, data
  uninstall   remove what install added; keeps your memories unless --delete-data

Options:
  --dry-run         say what would happen and change nothing
  -y, --yes         do not ask for confirmation (required when there is no terminal)
  --dir DIR         where the code lives            (default: \$HOME/.mnemosyne)
  --bin-dir DIR     where 'mneme' and 'mem' go       (default: \$HOME/.local/bin)
  --root DIR        where your memories live         (default: \$MNEMOSYNE_ROOT or \$HOME/memory)
  --model NAME      embedding model for Ollama       (default: nomic-embed-text-v2-moe)
  --no-ollama-pull  never download the embedding model
  --no-claude-md    do not add the memory instructions block to ~/.claude/CLAUDE.md
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

while [ $# -gt 0 ]; do
  case "$1" in
    install|update|uninstall) ACTION="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --dir) shift; check_dir_arg --dir "${1:?--dir needs a value}"; INSTALL_DIR="$1" ;;
    --bin-dir) shift; check_dir_arg --bin-dir "${1:?--bin-dir needs a value}"; BIN_DIR="$1" ;;
    --root) shift; check_dir_arg --root "${1:?--root needs a value}"; STORE_ROOT="$1" ;;
    --model) shift; MODEL="${1:?--model needs a value}"; MODEL_EXPLICIT=1 ;;
    --no-ollama-pull) DO_OLLAMA_PULL=0 ;;
    --no-claude-md) DO_CLAUDE_MD=0 ;;
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

check_requirements() {
  section "Requirements"
  # update needs it too: it fetches and checks out the new release.
  if [ "$IN_PLACE" = 0 ] && { [ "$ACTION" = install ] || [ "$ACTION" = update ]; }; then
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

  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code (claude) — the agent Mnemosyne wires into"
  else
    warn "Claude Code (claude) not found — Mnemosyne installs anyway, but the session hook only does something once Claude Code is installed"
    fix "curl -fsSL https://claude.ai/install.sh | bash   (docs: https://docs.claude.com/en/docs/claude-code/setup)"
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
    note "search (BM25) over your notes, fully offline. What you lose is semantic search:"
    note "finding a note by meaning when it shares no words with your query."
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
    if [ "$ACTION" = update ]; then
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
    say "  code:     nothing to update: $INSTALL_DIR is not an installation"
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
  say "  hook:     SessionStart -> mneme context --root '$STORE_ROOT'"
  say "            added to $SETTINGS (other settings untouched; original saved once as settings.json.before-mnemosyne)"
  say "  data:     your memories live in $STORE_ROOT as plain Markdown files."
  say "            Existing notes are never touched. Added if missing: .scopemap (catch-all '~ = personal'),"
  say "            and .config.json (search tier and model, so no environment variables are needed)."
  if [ "$ACTION" = update ]; then
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
  if [ "$DO_CLAUDE_MD" = 1 ]; then
    if [ "$ACTION" = update ]; then
      say "  CLAUDE.md: refresh the Mnemosyne block in $CLAUDE_MD, only if a previous install added it"
    else
      say "  CLAUDE.md: append a marked block telling Claude to use 'mneme' for memory to $CLAUDE_MD"
      say "            (skipped if that file already mentions mneme; removed by uninstall)"
    fi
  fi
  if [ "$CHOOSE_MODEL" = 1 ] && [ "$HAS_OLLAMA" = 1 ] && [ "$OLLAMA_UP" = 1 ] && [ "$MODEL_PRESENT" = 0 ] && [ "$DO_OLLAMA_PULL" = 1 ]; then
    say "  ollama:   ollama pull $MODEL (download of a few hundred MB)"
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

plan_uninstall() {
  section "What uninstall will change"
  say "  hook:     remove every 'mneme context' SessionStart hook from $SETTINGS"
  say "  CLAUDE.md: remove the block between the Mnemosyne markers in $CLAUDE_MD (if present)"
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
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # Under `curl | sh` stdin is the script itself, so ask the terminal directly.
  # No terminal at all (CI, a pipe with no tty) means nobody can answer: stop.
  # Probed in a subshell: a failed `exec` redirection would end this shell.
  if (exec 3</dev/tty) 2>/dev/null; then
    exec 3</dev/tty
    printf '\n%s [y/N] ' "$1" >/dev/tty
    read -r _answer <&3 || _answer=""
    exec 3<&-
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

write_claude_md_block() { # $1 = install|update
  [ "$DO_CLAUDE_MD" = 1 ] || return 0
  if [ -f "$CLAUDE_MD" ] && grep -qF "$BLOCK_BEGIN" "$CLAUDE_MD"; then
    _tmp="$CLAUDE_MD.mnemosyne-tmp"
    { strip_block "$CLAUDE_MD"; printf '\n%s\n' "$BLOCK_BEGIN"; memory_block; printf '%s\n' "$BLOCK_END"; } > "$_tmp"
    if cmp -s "$_tmp" "$CLAUDE_MD"; then rm -f "$_tmp"; else mv "$_tmp" "$CLAUDE_MD"; say "Refreshed the Mnemosyne block in $CLAUDE_MD."; fi
    return 0
  fi
  [ "$1" = install ] || return 0
  if [ -f "$CLAUDE_MD" ] && grep -q 'mneme' "$CLAUDE_MD"; then
    say "$CLAUDE_MD already mentions mneme; not adding the instructions block."
    return 0
  fi
  mkdir -p "$CLAUDE_DIR"
  backup_once "$CLAUDE_MD"
  { printf '\n%s\n' "$BLOCK_BEGIN"; memory_block; printf '%s\n' "$BLOCK_END"; } >> "$CLAUDE_MD"
  say "Added the Mnemosyne block to $CLAUDE_MD."
}

remove_claude_md_block() {
  if [ -f "$CLAUDE_MD" ] && grep -qF "$BLOCK_BEGIN" "$CLAUDE_MD"; then
    _tmp="$CLAUDE_MD.mnemosyne-tmp"
    strip_block "$CLAUDE_MD" > "$_tmp"
    # An empty leftover means the file only ever held our block.
    if [ -s "$_tmp" ] && grep -q '[^[:space:]]' "$_tmp"; then mv "$_tmp" "$CLAUDE_MD"; else rm -f "$_tmp" "$CLAUDE_MD"; fi
    say "Removed the Mnemosyne block from $CLAUDE_MD."
  fi
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
    (cd "$INSTALL_DIR/node_modules/better-sqlite3" 2>/dev/null && { npx --no prebuild-install || npx --no node-gyp rebuild --release; }) || true
    if ! sqlite_loads; then
      say ""
      say "The SQLite module (better-sqlite3) still does not load: no prebuilt binary matched"
      say "this machine and compiling it failed. Install the build tools and re-run:"
      if [ "$OS" = macos ]; then say "  xcode-select --install"; else say "  sudo apt-get install -y build-essential python3"; fi
      exit 1
    fi
  fi
}

sqlite_loads() {
  (cd "$INSTALL_DIR" && node -e 'new (require("better-sqlite3"))(":memory:").close()') >/dev/null 2>&1
}

run_init() {
  # Pass the model only when Ollama can actually serve it; otherwise init keeps
  # whatever this store already has, or picks tier 0 on a fresh one.
  if [ "$CHOOSE_MODEL" = 1 ] && { [ "$MODEL_PRESENT" = 1 ] || [ "$MODEL_EXPLICIT" = 1 ]; }; then
    mneme_run init --write --root "$STORE_ROOT" --model "$MODEL"
  else
    mneme_run init --write --root "$STORE_ROOT"
  fi
}

# ---------------------------------------------------------------- actions ---
do_install_or_update() {
  check_requirements
  resolve_target
  plan_install
  if [ "$BLOCKING" = 1 ]; then
    die "fix the [MISSING] items above, then re-run. Nothing was changed."
  fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ -f "$MNEME_JS" ] && command -v node >/dev/null 2>&1; then
      section "mneme init would do (its own dry run)"
      if [ "$CHOOSE_MODEL" = 1 ] && { [ "$MODEL_PRESENT" = 1 ] || [ "$MODEL_EXPLICIT" = 1 ]; }; then mneme_run init --root "$STORE_ROOT" --model "$MODEL"; else mneme_run init --root "$STORE_ROOT"; fi
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
    elif [ "$ACTION" = update ]; then
      die "no installation found in $INSTALL_DIR. Run the installer without 'update' first (or pass --dir)."
    else
      [ -e "$INSTALL_DIR" ] && die "$INSTALL_DIR exists but is not a Mnemosyne clone. Move it away, or pass --dir."
      section "Downloading $TARGET_REF into $INSTALL_DIR"
      git -c advice.detachedHead=false clone --branch "$TARGET_REF" "$REPO_URL" "$INSTALL_DIR"
      : > "$INSTALL_DIR/.$OWNER_MARK"
    fi
  fi
  build
  [ -f "$MNEME_JS" ] || die "$MNEME_JS is missing; the build did not produce the CLI."

  if [ "$CHOOSE_MODEL" = 1 ] && [ "$HAS_OLLAMA" = 1 ] && [ "$OLLAMA_UP" = 1 ] && [ "$MODEL_PRESENT" = 0 ] && [ "$DO_OLLAMA_PULL" = 1 ]; then
    section "Downloading the embedding model"
    if ollama pull "$MODEL"; then MODEL_PRESENT=1; else warn "ollama pull failed; continuing in tier 0 (see above to add it later)"; fi
  fi

  section "Wiring it in"
  write_wrappers
  say "Wrote $BIN_DIR/mneme and $BIN_DIR/mem."
  [ "$ACTION" = install ] && backup_once "$SETTINGS"
  run_init
  write_claude_md_block "$ACTION"
  if [ "$ACTION" = update ]; then
    # No index schema version to migrate: schema additions apply themselves
    # when the index is opened, and a changed embedder is caught by reindex.
    # Running it here does both now, instead of in the next session's hook.
    section "Bringing the index up to date"
    mneme_run reindex --root "$STORE_ROOT" || warn "reindex failed; the next 'mneme search' or session retries it"
  fi

  section "Done"
  [ "$IN_PLACE" = 0 ] && say "Mnemosyne $(current_version) is installed in $INSTALL_DIR."
  say "Your memories live in $STORE_ROOT. Open a new Claude Code session and it starts with them."
  say "Try: mneme add \"I prefer short answers\" --type user --slug short-answers"
  say "     mneme search \"answers\""
  say "Update later with:    $( [ "$IN_PLACE" = 1 ] && printf '%s' "$INSTALL_DIR/install.sh update" || printf '%s' "mneme upgrade   (or: sh $INSTALL_DIR/install.sh update)" )"
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
  # Removed BEFORE the wrappers, and with the wrapper's own node first: a hook
  # left behind without its command breaks the start of every session.
  _unode="$(wrapper_node)"
  [ -n "$_unode" ] || _unode="$(command -v node 2>/dev/null || true)"
  _had_hook=0
  if [ -f "$SETTINGS" ] && grep -q 'mneme context' "$SETTINGS"; then _had_hook=1; fi
  if [ -f "$MNEME_JS" ] && [ -n "$_unode" ] && "$_unode" "$MNEME_JS" uninstall-hook --write; then
    # A settings.json the install created (no original was saved) and that
    # THIS removal left empty goes too; one the user had stays, even if empty.
    if [ "$_had_hook" = 1 ] && [ ! -e "$SETTINGS.before-mnemosyne" ] && [ -f "$SETTINGS" ] && [ "$(cat "$SETTINGS")" = "{}" ]; then
      rm -f "$SETTINGS"
      say "Deleted $SETTINGS (the install created it, and nothing else is in it)."
    fi
  elif [ -f "$SETTINGS" ] && grep -q 'mneme context' "$SETTINGS"; then
    warn "cannot run mneme to edit $SETTINGS; remove the 'mneme context' SessionStart hook from it by hand."
  fi
  remove_claude_md_block
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

say "Mnemosyne — $ACTION$( [ "$DRY_RUN" = 1 ] && printf ' (dry run: nothing will be changed)' )"
case "$ACTION" in
  install|update) do_install_or_update ;;
  uninstall) do_uninstall ;;
esac
