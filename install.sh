#!/usr/bin/env bash
# install.sh — one-stop kiln-lite install.
#
# Installs the kl CLI globally and scaffolds the default agent, `worker`.
# Agents live under $KL_AGENTS_DIR (default ~/.kl/agents/). `kl` with no
# agent, and the subagent tool with none, launch the worker.
#
# Does, in order:
#   1. Install node deps (npm install).
#   2. Link the `kl` command globally (npm link).
#   3. Create the worker at $KL_AGENTS_DIR/worker (if it doesn't already
#      exist) with `kl init worker`. Use `kl init <name> [--full]` for more.
#
# Usage:
#   ./install.sh
#
# Env:
#   KL_AGENTS_DIR    Parent dir for agent homes (default: <kl root>/agents).
#   KL_ROOT          kl root (default: ~/.kl).
#
# Prerequisites (checked, not installed — bail if missing):
#   - node, npm (for kl and the pi package)
#   - pi (@earendil-works/pi-coding-agent)
#   - tmux (kl requires it; warned but not fatal)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- defaults / args ---
KL_AGENTS_DIR="${KL_AGENTS_DIR:-${KL_ROOT:-$HOME/.kl}/agents}"
WORKER_HOME="$KL_AGENTS_DIR/worker"

for arg in "$@"; do
    case "$arg" in
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

# --- 3. the worker (the default agent) ---
if [ -e "$WORKER_HOME" ]; then
    log "worker exists at $WORKER_HOME — leaving it as-is"
else
    log "creating the worker at $WORKER_HOME"
    KL_AGENTS_DIR="$KL_AGENTS_DIR" "$REPO_ROOT/bin/kl" init worker
    sed -i.bak 's/^description: ""$/description: "General-purpose worker: Pi'"'"'s default prompt, tools and skills, plus kl."/' "$WORKER_HOME/agent.yml"
    rm -f "$WORKER_HOME/agent.yml.bak"
fi

cat <<DONE

[install] complete.

  Agents dir:   $KL_AGENTS_DIR
  Worker:       $WORKER_HOME (the default agent)
  Pi extension: loaded by \`kl\` via \`pi -e\` (not globally registered — bare \`pi\` stays pristine)
  kl command:   $(command -v kl 2>/dev/null || echo '(not on PATH — see warning above)')

Next:
  Launch the worker:            kl
  Add another agent:            kl init <name> [--full]
  List agents:                  kl agents
  Diagnostics:                  kl doctor

DONE
