#!/usr/bin/env bash
# install.sh — one-stop kiln-lite install.
#
# Installs the kl CLI globally and scaffolds a starter agent. Agents live
# under $KL_AGENTS_DIR (default ~/.kl/agents/). The starter is created at
# ~/.kl/agents/agent — launchable as `kl` (no args).
#
# Does, in order:
#   1. Install node deps (npm install).
#   2. Link the `kl` command globally (npm link).
#   3. Create a compact starter agent at $KL_AGENTS_DIR/agent (if it doesn't
#      already exist) with `kl init`. Use `kl init <name> [--full]` for more.
#
# Usage:
#   ./install.sh [--no-starter]
#
#   --no-starter    Install kl + daemon only; skip starter-agent scaffold.
#                   Useful for CI or when you'll create agents explicitly
#                   with `kl init <name>`.
#
# Env:
#   KL_AGENTS_DIR    Parent dir for agent homes (default: ~/.kl/agents/).
#
# Prerequisites (checked, not installed — bail if missing):
#   - node, npm (for kl and the pi package)
#   - pi (@earendil-works/pi-coding-agent)
#   - tmux (kl requires it; warned but not fatal)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- defaults / args ---
KL_AGENTS_DIR="${KL_AGENTS_DIR:-$HOME/.kl/agents}"
STARTER_NAME="agent"
STARTER_HOME="$KL_AGENTS_DIR/$STARTER_NAME"
SKIP_STARTER=0

for arg in "$@"; do
    case "$arg" in
        --no-starter) SKIP_STARTER=1 ;;
        -h|--help)
            awk '
                NR == 1 { next }
                /^[^#]/ { exit }
                /^#$/ { print ""; next }
                /^# ?/ { sub(/^# ?/, ""); print }
            ' "$0"
            exit 0
            ;;
        *)
            printf '[install] unknown arg: %s (try --help)\n' "$arg" >&2
            exit 1
            ;;
    esac
done

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---
command -v node >/dev/null 2>&1 || die "node not found — install Node.js >= 20"
command -v npm  >/dev/null 2>&1 || die "npm not found (ships with node)"
command -v pi   >/dev/null 2>&1 || die "pi not found — install @earendil-works/pi-coding-agent first"
if ! command -v tmux >/dev/null 2>&1; then
    warn "tmux not found — kl requires it (brew install tmux / apt install tmux)"
fi

cd "$REPO_ROOT"

# --- 1. npm install ---
log "installing node dependencies"
npm install --silent

# --- 2. link kl globally ---
log "linking kl globally via npm link"
if ! npm link --silent 2>&1; then
    warn "npm link failed — you may need to run it with sudo, or configure a user-level prefix"
    warn "  see: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
    die "install aborted"
fi

if command -v kl >/dev/null 2>&1; then
    log "kl available at: $(command -v kl)"
else
    NPM_GLOBAL="$(npm config get prefix 2>/dev/null)/bin"
    warn "npm link succeeded but 'kl' isn't on PATH"
    warn "  add this to your shell config: export PATH=\"$NPM_GLOBAL:\$PATH\""
fi

# --- 3. starter agent ---
if [ "$SKIP_STARTER" = "1" ]; then
    log "--no-starter: skipping starter scaffold"
elif [ -e "$STARTER_HOME" ]; then
    log "starter agent exists at $STARTER_HOME — leaving it as-is"
else
    log "creating compact starter agent at $STARTER_HOME"
    KL_AGENTS_DIR="$KL_AGENTS_DIR" "$REPO_ROOT/bin/kl" init "$STARTER_NAME"
fi

cat <<DONE

[install] complete.

  Agents dir:   $KL_AGENTS_DIR
  Starter:      $STARTER_HOME
  Pi extension: loaded by \`kl\` via \`pi -e\` (not globally registered — bare \`pi\` stays pristine)
  kl command:   $(command -v kl 2>/dev/null || echo '(not on PATH — see warning above)')

Next:
  Launch the starter:           kl
  Add another agent:            kl init <name> [--full]
  List agents:                  kl agents
  Diagnostics:                  kl doctor

DONE
