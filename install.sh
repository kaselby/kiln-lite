#!/usr/bin/env bash
# install.sh — one-stop kiln-lite install.
#
# Does, in order:
#   1. Install node deps (npm install).
#   2. Link the `kl` command globally (npm link).
#   3. Remove any legacy global pi registration of kiln-lite (idempotent).
#      The extension is intentionally NOT registered globally — `kl` loads
#      it explicitly via `-e <path>`. Bare `pi` runs extension-free.
#   4. Scaffold or refresh the agent home via bootstrap.sh.
#      If the home already exists, bundled skills + tools are refreshed
#      so fixes from this repo propagate without a second command. venv
#      and agent.yml are left alone (they may carry user state). Use
#      bootstrap.sh directly with --rebuild-venv / --force for deeper
#      updates.
#
# Usage:
#   ./install.sh [home-dir]
#
# Defaults:
#   home-dir = $AGENT_HOME if set, else ~/.kl/agent
#
# Migration:
#   If ~/.agent exists from a previous install and ~/.kl/agent does not,
#   you'll be prompted to move it (the default kiln-lite layout is now
#   ~/.kl/ with agent home + daemon state living side-by-side).
#
# Prerequisites (checked, not installed — bail if missing):
#   - node, npm (for kl and the pi package)
#   - pi (@mariozechner/pi-coding-agent)
#   - tmux (kl requires it; warned but not fatal)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default home: $AGENT_HOME if set, else ~/.kl/agent. Explicit positional
# arg wins over both.
DEFAULT_HOME="$HOME/.kl/agent"
HOME_DIR="${1:-${AGENT_HOME:-$DEFAULT_HOME}}"

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    awk '
        NR == 1 { next }
        /^[^#]/ { exit }
        /^#$/ { print ""; next }
        /^# ?/ { sub(/^# ?/, ""); print }
    ' "$0"
    exit 0
fi

# --- prerequisites ---
command -v node >/dev/null 2>&1 || die "node not found — install Node.js >= 20"
command -v npm  >/dev/null 2>&1 || die "npm not found (ships with node)"
command -v pi   >/dev/null 2>&1 || die "pi not found — install @mariozechner/pi-coding-agent first"
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

# --- 3. clean up legacy global pi registration ---
# kiln-lite is not a user-facing pi extension — it's the plumbing behind the
# `kl` launcher. `kl` loads it explicitly with `-e`, and bare `pi` should
# stay pristine. If a previous install.sh ran `pi install .`, remove that
# registration so `pi` no longer auto-discovers kiln-lite. Idempotent: a
# fresh install has nothing to remove and we just log and move on.
if pi list 2>/dev/null | grep -q "kiln-lite"; then
    log "removing legacy global pi registration of kiln-lite"
    # pi stores packages by source path (what was passed to `pi install`), not
    # by name — so `pi remove kiln-lite` fails with "No matching package found".
    # Pass the absolute repo path; pi normalizes and matches whichever form
    # (relative / absolute / .) was originally recorded.
    if ! pi remove "$REPO_ROOT" 2>&1; then
        warn "pi remove $REPO_ROOT failed — manually drop any entry pointing at $REPO_ROOT from ~/.pi/agent/settings.json"
    fi
else
    log "pi global registration: not present (good — kl loads the extension directly)"
fi

# --- 4. migrate ~/.agent -> ~/.kl/agent if applicable ---
# Fires whenever the resolved HOME_DIR is the legacy ~/.agent path (either
# because $AGENT_HOME still points there or because it was passed
# explicitly). Moves ~/.agent -> ~/.kl/agent and rewrites HOME_DIR so the
# rest of this script operates on the new layout.
LEGACY_HOME="$HOME/.agent"
if [ "$HOME_DIR" = "$LEGACY_HOME" ] && [ -d "$LEGACY_HOME" ] && [ ! -e "$DEFAULT_HOME" ]; then
    log "detected legacy agent home at $LEGACY_HOME (pre-v0.3 layout)"
    log "kiln-lite now lives under ~/.kl/ (agent home + daemon state side-by-side)"
    if [ -n "${AGENT_HOME:-}" ]; then
        log "  note: \$AGENT_HOME is set to $AGENT_HOME — update your shell rc to point at"
        log "        $DEFAULT_HOME after migration (or unset it to use the new default)"
    fi
    reply="y"
    if [ -t 0 ] && [ -t 2 ]; then
        printf '[install] Move %s to %s? [Y/n] ' "$LEGACY_HOME" "$DEFAULT_HOME" >&2
        read -r reply
    fi
    case "${reply:-y}" in
        ""|y|Y|yes|YES|Yes)
            mkdir -p "$(dirname "$DEFAULT_HOME")"
            mv "$LEGACY_HOME" "$DEFAULT_HOME"
            HOME_DIR="$DEFAULT_HOME"
            log "migrated $LEGACY_HOME -> $DEFAULT_HOME"
            ;;
        *)
            log "migration declined — continuing with legacy path $LEGACY_HOME"
            ;;
    esac
fi

# --- 5. scaffold OR refresh the home dir ---
# Fresh install: full bootstrap (venv + skills + tools + agent.yml).
# Existing home: refresh bundled skills + tools so fixes propagate without
# requiring the user to know which bootstrap flag to reach for. venv +
# agent.yml are left untouched — they may carry user customization.
if [ -e "$HOME_DIR" ]; then
    log "agent home exists at $HOME_DIR — refreshing bundled skills + tools"
    log "  (venv + agent.yml left as-is; use bootstrap.sh --rebuild-venv / --force for deeper updates)"
    "$REPO_ROOT/bootstrap.sh" "$HOME_DIR" --refresh-skills
    "$REPO_ROOT/bootstrap.sh" "$HOME_DIR" --refresh-tools
else
    log "scaffolding agent home at $HOME_DIR"
    "$REPO_ROOT/bootstrap.sh" "$HOME_DIR"
fi

cat <<DONE

[install] complete.

  Agent home:   $HOME_DIR
  Pi extension: loaded via \`kl -e\` (not globally registered — bare \`pi\` is pristine)
  kl command:   $(command -v kl 2>/dev/null || echo '(not on PATH — see warning above)')

Next:
  1. Edit $HOME_DIR/agent.yml — set 'name' and any context_injection files.
  2. Launch a session:
       kl

DONE
