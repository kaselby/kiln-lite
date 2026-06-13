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
#   3. Remove any legacy global pi registration of kiln-lite (idempotent).
#      The extension is intentionally NOT registered globally — `kl` loads
#      it explicitly via `-e <path>`. Bare `pi` runs extension-free.
#   4. Scaffold the starter agent at $KL_AGENTS_DIR/agent (if it doesn't
#      already exist). Use `kl new <name>` to add more later.
#
# Usage:
#   ./install.sh [--no-starter]
#
#   --no-starter    Install kl + daemon only; skip starter-agent scaffold.
#                   Useful for CI or when you'll create agents explicitly
#                   with `kl new <name>`.
#
# Env:
#   KL_AGENTS_DIR    Parent dir for agent homes (default: ~/.kl/agents/).
#
# Migration:
#   If ~/.agent or ~/.kl/agent exist from previous installs and the new
#   layout (~/.kl/agents/agent/) doesn't, you'll be prompted to move them.
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

# --- 4. legacy-layout migration ---
# Two old layouts to handle:
#   ~/.agent/         (pre-v0.3, before ~/.kl/ was introduced)
#   ~/.kl/agent/      (singular, pre-multi-agent layout)
# Both migrate to ~/.kl/agents/agent/ — the new starter location.
maybe_migrate_legacy() {
    local from="$1"
    [ -d "$from" ] || return 0
    if [ -e "$STARTER_HOME" ]; then
        # New layout already populated — don't clobber, but don't silently
        # abandon the legacy dir either. Surface it so the user can decide.
        warn "legacy agent home at $from will be left in place ($STARTER_HOME already exists)."
        warn "  inspect manually: if you want it under the new layout, mv it to \$KL_AGENTS_DIR/<name>/"
        warn "  or delete it if obsolete."
        return 0
    fi

    log "detected legacy agent home at $from"
    log "  starter agent now lives at $STARTER_HOME"
    local reply="y"
    if [ -t 0 ] && [ -t 2 ]; then
        printf '[install] Move %s -> %s? [Y/n] ' "$from" "$STARTER_HOME" >&2
        read -r reply
    fi
    case "${reply:-y}" in
        ""|y|Y|yes|YES|Yes)
            mkdir -p "$KL_AGENTS_DIR"
            mv "$from" "$STARTER_HOME"
            log "migrated $from -> $STARTER_HOME"
            if [ -n "${AGENT_HOME:-}" ] && [ "$AGENT_HOME" = "$from" ]; then
                warn "  \$AGENT_HOME is set to $from — unset it or update your shell rc"
                warn "  (new resolution: kl picks up $STARTER_HOME by default; AGENT_HOME is now an escape hatch)"
            fi
            ;;
        *)
            log "migration declined — leaving $from in place"
            log "  kl will not see it; either rerun install.sh, or 'mv $from $STARTER_HOME' manually"
            ;;
    esac
}

maybe_migrate_legacy "$HOME/.agent"
maybe_migrate_legacy "$HOME/.kl/agent"

# --- 5. starter agent ---
if [ "$SKIP_STARTER" = "1" ]; then
    log "--no-starter: skipping starter scaffold"
elif [ -e "$STARTER_HOME" ]; then
    log "starter agent exists at $STARTER_HOME — refreshing bundled skills + tools"
    log "  (venv + agent.yml left as-is; use bootstrap.sh --rebuild-venv / --force for deeper updates)"
    "$REPO_ROOT/bootstrap.sh" "$STARTER_HOME" --refresh-skills
    "$REPO_ROOT/bootstrap.sh" "$STARTER_HOME" --refresh-tools
else
    log "scaffolding starter agent at $STARTER_HOME"
    mkdir -p "$KL_AGENTS_DIR"
    "$REPO_ROOT/bootstrap.sh" "$STARTER_HOME"
    # Match install.sh's behavior to `kl new <name>`: ensure agent.yml's
    # name field matches the dir name (here: "agent").
    if [ -f "$STARTER_HOME/agent.yml" ]; then
        tmp="$STARTER_HOME/agent.yml.tmp"
        awk -v new_name="$STARTER_NAME" '
            /^name:[[:space:]]/ && !done {
                print "name: " new_name
                done = 1
                next
            }
            { print }
        ' "$STARTER_HOME/agent.yml" > "$tmp" && mv "$tmp" "$STARTER_HOME/agent.yml"
    fi
fi

cat <<DONE

[install] complete.

  Agents dir:   $KL_AGENTS_DIR
  Starter:      $STARTER_HOME
  Pi extension: loaded by \`kl\` via \`pi -e\` (not globally registered — bare \`pi\` stays pristine)
  kl command:   $(command -v kl 2>/dev/null || echo '(not on PATH — see warning above)')

Next:
  Launch the starter:           kl
  Add another agent:            kl new <name>
  List agents:                  kl agents
  Diagnostics:                  kl doctor

DONE
