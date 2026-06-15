#!/usr/bin/env bash
# bootstrap.sh — scaffold a kiln-lite agent home.
#
# Usage:
#   ./bootstrap.sh <agent-home>              # fresh install
#   ./bootstrap.sh <agent-home> --force      # overwrite existing files
#   ./bootstrap.sh <agent-home> --upgrade-deps   # refresh venv deps only
#   ./bootstrap.sh <agent-home> --rebuild-venv   # nuke + recreate the venv
#   ./bootstrap.sh <agent-home> --refresh-skills # recopy bundled skills
#   ./bootstrap.sh <agent-home> --refresh-tools  # recopy bundled tools
#
# Scaffolds:
#   memory/     scratch/    tools/     inbox/
#   sessions/   skills/     venv/      agent.yml
#
# Also copies every bundled skill in <repo>/skills/* into <agent-home>/skills/
# and every bundled tool in <repo>/tools/* into <agent-home>/tools/.
# Requires `uv` (https://docs.astral.sh/uv/) — uv creates the venv at the
# Python version named in <repo>/.python-version and installs
# <repo>/requirements.txt into it. If `uv` is not found, bootstrap offers to
# install it via the official installer (https://astral.sh/uv/install.sh).
# Set AUTO_INSTALL_UV=1 to auto-install without prompting (useful in CI).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
}

# --- arg parsing ---
if [ $# -lt 1 ]; then
    usage
fi

TARGET=""
FORCE=0
UPGRADE_DEPS=0
REBUILD_VENV=0
REFRESH_SKILLS=0
REFRESH_TOOLS=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --upgrade-deps) UPGRADE_DEPS=1 ;;
        --rebuild-venv) REBUILD_VENV=1 ;;
        --refresh-skills) REFRESH_SKILLS=1 ;;
        --refresh-tools) REFRESH_TOOLS=1 ;;
        -h|--help) usage ;;
        -*)
            echo "unknown flag: $arg" >&2
            exit 1
            ;;
        *)
            if [ -z "$TARGET" ]; then
                TARGET="$arg"
            else
                echo "unexpected extra arg: $arg" >&2
                exit 1
            fi
            ;;
    esac
done

if [ -z "$TARGET" ]; then
    usage
fi

# Resolve target to absolute path.
TARGET="$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd)/$(basename "$TARGET")" || {
    # Parent doesn't exist yet — resolve after mkdir.
    mkdir -p "$TARGET"
    TARGET="$(cd "$TARGET" && pwd)"
}

log() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARNING: %s\n' "$*" >&2; }
die()  { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# --- uv guard (we need it for venv + package install) ---
# If uv is missing, offer to install it via the official installer. Set
# AUTO_INSTALL_UV=1 to skip the prompt (useful in CI / non-interactive use).
# Set AUTO_INSTALL_UV=0 (or run without a TTY) to error out instead.
require_uv() {
    if command -v uv >/dev/null; then
        return 0
    fi

    log "uv not found on PATH"

    local install=0
    if [ "${AUTO_INSTALL_UV:-}" = "1" ]; then
        install=1
    elif [ "${AUTO_INSTALL_UV:-}" = "0" ]; then
        install=0
    elif [ -t 0 ] && [ -t 2 ]; then
        # Interactive — prompt. Default is Yes.
        local reply
        printf '[bootstrap] Install uv now via https://astral.sh/uv/install.sh? [Y/n] ' >&2
        read -r reply
        case "$reply" in
            ""|y|Y|yes|YES|Yes) install=1 ;;
            *) install=0 ;;
        esac
    else
        # Non-interactive and no opt-in env var — bail with instructions.
        die "uv missing and stdin is not a TTY. Set AUTO_INSTALL_UV=1 to auto-install, or install manually: https://docs.astral.sh/uv/getting-started/installation/"
    fi

    if [ "$install" = "0" ]; then
        die "uv install declined. Install manually: https://docs.astral.sh/uv/getting-started/installation/"
    fi

    command -v curl >/dev/null || die "curl not found — cannot fetch uv installer. Install uv manually: https://docs.astral.sh/uv/getting-started/installation/"

    log "installing uv via the official installer (curl -LsSf https://astral.sh/uv/install.sh | sh)"
    curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv installer exited non-zero"

    # The installer drops the binary at ~/.local/bin/uv by default and
    # updates shell rc files — but those don't affect our already-running
    # shell, so we prepend the install dir to PATH for this script's lifetime.
    local uv_bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
    if [ -d "$uv_bin" ] && [ -x "$uv_bin/uv" ]; then
        PATH="$uv_bin:$PATH"
        export PATH
    fi
    hash -r 2>/dev/null || true

    command -v uv >/dev/null || die "uv install reported success but 'uv' still isn't on PATH. Open a new shell and re-run bootstrap."
    log "uv installed: $(uv --version 2>/dev/null || echo '(version check failed)')"
}

# --- venv helpers ---
# Target Python version. Read from <repo>/.python-version (uv convention),
# falling back to 3.12 if the file is missing.
resolve_python_version() {
    if [ -f "$REPO_ROOT/.python-version" ]; then
        local v
        v="$(tr -d '[:space:]' < "$REPO_ROOT/.python-version")"
        [ -n "$v" ] && { printf '%s' "$v"; return; }
    fi
    printf '3.12'
}

create_venv() {
    local python_version
    python_version="$(resolve_python_version)"
    log "creating python $python_version venv at $TARGET/venv (via uv)"
    rm -rf "$TARGET/venv"
    uv venv --python "$python_version" "$TARGET/venv"
}

install_deps() {
    if [ ! -f "$REPO_ROOT/requirements.txt" ]; then
        warn "no requirements.txt found at $REPO_ROOT — skipping dep install"
        return 0
    fi
    log "installing python dependencies from requirements.txt (via uv)"
    VIRTUAL_ENV="$TARGET/venv" uv pip install --quiet -r "$REPO_ROOT/requirements.txt"
}

upgrade_deps() {
    if [ ! -f "$REPO_ROOT/requirements.txt" ]; then
        warn "no requirements.txt found at $REPO_ROOT — skipping dep upgrade"
        return 0
    fi
    log "upgrading python deps in $TARGET/venv (via uv)"
    VIRTUAL_ENV="$TARGET/venv" uv pip install --quiet --upgrade -r "$REPO_ROOT/requirements.txt"
}

# --- skill copy (defined early so shortcut mode can call it) ---
copy_skills() {
    if [ ! -d "$REPO_ROOT/skills" ]; then
        warn "no skills/ dir in $REPO_ROOT — skipping skill copy"
        return 0
    fi
    local skill_count=0
    for skill_path in "$REPO_ROOT/skills/"*/; do
        [ -d "$skill_path" ] || continue
        local name
        name="$(basename "$skill_path")"
        if [ -e "$TARGET/skills/$name" ] && [ "$FORCE" = "0" ] && [ "$REFRESH_SKILLS" = "0" ]; then
            log "skill $name already present — skipping (use --refresh-skills to overwrite)"
            continue
        fi
        rm -rf "$TARGET/skills/$name"
        cp -R "$skill_path" "$TARGET/skills/$name"
        skill_count=$((skill_count + 1))
        log "installed skill: $name"
    done
    log "installed $skill_count skill(s)"
}

# --- tool copy (bundled scripts → $AGENT_HOME/tools/) ---
copy_tools() {
    if [ ! -d "$REPO_ROOT/tools" ]; then
        warn "no tools/ dir in $REPO_ROOT — skipping tool copy"
        return 0
    fi
    local tool_count=0
    for tool_path in "$REPO_ROOT/tools/"*; do
        [ -f "$tool_path" ] || continue
        local name
        name="$(basename "$tool_path")"
        # Skip dotfiles (.gitkeep, .DS_Store, etc).
        case "$name" in .*) continue ;; esac
        if [ -e "$TARGET/tools/$name" ] && [ "$FORCE" = "0" ] && [ "$REFRESH_TOOLS" = "0" ]; then
            log "tool $name already present — skipping (use --refresh-tools to overwrite)"
            continue
        fi
        rm -f "$TARGET/tools/$name"
        cp "$tool_path" "$TARGET/tools/$name"
        chmod +x "$TARGET/tools/$name"
        tool_count=$((tool_count + 1))
        log "installed tool: $name"
    done
    log "installed $tool_count tool(s)"
}

# --- deps-only refresh shortcut ---
if [ "$UPGRADE_DEPS" = "1" ] && [ "$REBUILD_VENV" = "0" ] && [ "$REFRESH_SKILLS" = "0" ] && [ "$REFRESH_TOOLS" = "0" ]; then
    [ -d "$TARGET/venv" ] || die "no venv at $TARGET/venv — run without --upgrade-deps first (or use --rebuild-venv)"
    require_uv
    upgrade_deps
    log "done."
    exit 0
fi

# --- venv-rebuild shortcut ---
if [ "$REBUILD_VENV" = "1" ] && [ "$UPGRADE_DEPS" = "0" ] && [ "$REFRESH_SKILLS" = "0" ] && [ "$REFRESH_TOOLS" = "0" ]; then
    [ -d "$TARGET" ] || die "no agent home at $TARGET — run without --rebuild-venv first"
    require_uv
    create_venv
    install_deps
    log "done."
    exit 0
fi

# --- skills-only refresh shortcut ---
if [ "$REFRESH_SKILLS" = "1" ] && [ "$UPGRADE_DEPS" = "0" ] && [ "$REBUILD_VENV" = "0" ] && [ "$REFRESH_TOOLS" = "0" ]; then
    [ -d "$TARGET/skills" ] || die "no skills/ dir at $TARGET — run without --refresh-skills first"
    log "refreshing skills from $REPO_ROOT/skills/"
    copy_skills
    exit 0
fi

# --- tools-only refresh shortcut ---
if [ "$REFRESH_TOOLS" = "1" ] && [ "$UPGRADE_DEPS" = "0" ] && [ "$REBUILD_VENV" = "0" ] && [ "$REFRESH_SKILLS" = "0" ]; then
    [ -d "$TARGET/tools" ] || die "no tools/ dir at $TARGET — run without --refresh-tools first"
    log "refreshing tools from $REPO_ROOT/tools/"
    copy_tools
    exit 0
fi

# --- fresh install / forced install ---
if [ -e "$TARGET" ] && [ "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "$FORCE" = "0" ]; then
    die "target $TARGET is not empty — pass --force to overwrite, or --upgrade-deps/--rebuild-venv/--refresh-skills/--refresh-tools for partial updates"
fi

require_uv

log "bootstrapping kiln-lite agent home at $TARGET"

# --- directories ---
log "creating directory scaffold"
for d in memory scratch tools inbox sessions skills; do
    mkdir -p "$TARGET/$d"
done

# Empty marker files so git (if the user inits a repo here) can track them.
for d in memory scratch tools inbox sessions skills; do
    [ -f "$TARGET/$d/.gitkeep" ] || : > "$TARGET/$d/.gitkeep"
done

# --- agent.yml ---
if [ -f "$TARGET/agent.yml" ] && [ "$FORCE" = "0" ]; then
    log "agent.yml exists — leaving untouched (use --force to overwrite)"
else
    log "writing agent.yml scaffold"
    cat > "$TARGET/agent.yml" <<'YML'
# kiln-lite agent configuration.
# All fields are optional; listed defaults apply when unset.

# Agent name — first component of <name>-<adj>-<noun> session IDs.
name: agent

# Optional: path (relative to $AGENT_HOME) of a file that replaces Pi's
# built-in system prompt. Omit to use Pi's default.
# system_prompt: prompts/base.md

# Files prepended to the system prompt on every session.
# `dynamic: true` re-reads on every turn; default is load-once at session_start.
context_injection: []
  # - path: memory/core.md
  #   label: Core Memory
  # - path: memory/volatile.md
  #   label: Working State
  #   dynamic: true

# Shell commands run sequentially at session_start.
# Useful for pulling git updates, warming caches, etc.
startup: []
  # - "git -C $AGENT_HOME pull --ff-only"

# Cleanup turn dispatched when the session wraps via /exit or /wrapup.
# Supports template vars: {today} {agent_id} {session_uuid} {summary_path}
# Leave empty to skip the cleanup turn.
# cleanup: |
#   You're wrapping up this session. Write a session summary to {summary_path}
#   covering: what happened, what you learned, unresolved threads.

# Directory (relative to $AGENT_HOME) for shell tool discovery.
tools_dir: tools

# Directory (relative to $AGENT_HOME) for per-agent inboxes.
# Extension writes to $AGENT_HOME/<inbox_dir>/<agent-id>/.
inbox_dir: inbox

# Directory (relative to $AGENT_HOME) for session id files + summaries.
sessions_dir: sessions
YML
fi

# --- skills: copy bundled ones in ---
log "installing bundled skills"
copy_skills

# --- tools: copy bundled ones in ---
log "installing bundled tools"
copy_tools

# --- venv ---
if [ -d "$TARGET/venv" ] && [ "$FORCE" = "0" ]; then
    log "venv exists — leaving untouched (use --force, --rebuild-venv, or --upgrade-deps to refresh)"
else
    create_venv
fi

install_deps

# --- done ---
cat <<DONE

[bootstrap] done.
  AGENT_HOME = $TARGET
  venv       = $TARGET/venv (python3 = $TARGET/venv/bin/python3)
  skills     = $(ls -1 "$TARGET/skills/" 2>/dev/null | grep -v '^\.gitkeep$' | tr '\n' ' ')

Next:
  1. Edit $TARGET/agent.yml — set 'name' and any context_injection files.
  2. Launch a session:
       AGENT_HOME=$TARGET pi -e $REPO_ROOT/extensions/kiln-lite/index.ts

DONE
