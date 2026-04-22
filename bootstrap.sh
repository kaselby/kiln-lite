#!/usr/bin/env bash
# bootstrap.sh — scaffold a kiln-lite agent home.
#
# Usage:
#   ./bootstrap.sh <agent-home>              # fresh install
#   ./bootstrap.sh <agent-home> --force      # overwrite existing files
#   ./bootstrap.sh <agent-home> --upgrade-deps   # refresh venv only
#   ./bootstrap.sh <agent-home> --refresh-skills # recopy bundled skills
#
# Scaffolds:
#   memory/     scratch/    tools/     inbox/
#   sessions/   skills/     venv/      agent.yml
#
# Also copies every bundled skill in <repo>/skills/* into <agent-home>/skills/.
# Installs <repo>/requirements.txt into the venv.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
}

# --- arg parsing ---
if [ $# -lt 1 ]; then
    usage
fi

TARGET=""
FORCE=0
UPGRADE_DEPS=0
REFRESH_SKILLS=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --upgrade-deps) UPGRADE_DEPS=1 ;;
        --refresh-skills) REFRESH_SKILLS=1 ;;
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

# --- deps-only refresh shortcut ---
if [ "$UPGRADE_DEPS" = "1" ] && [ "$REFRESH_SKILLS" = "0" ]; then
    [ -d "$TARGET/venv" ] || die "no venv at $TARGET/venv — run without --upgrade-deps first"
    log "upgrading python deps in $TARGET/venv"
    "$TARGET/venv/bin/pip" install --quiet --upgrade -r "$REPO_ROOT/requirements.txt"
    log "done."
    exit 0
fi

# --- skills-only refresh shortcut ---
if [ "$REFRESH_SKILLS" = "1" ] && [ "$UPGRADE_DEPS" = "0" ]; then
    [ -d "$TARGET/skills" ] || die "no skills/ dir at $TARGET — run without --refresh-skills first"
    log "refreshing skills from $REPO_ROOT/skills/"
    copy_skills
    exit 0
fi

# --- fresh install / forced install ---
if [ -e "$TARGET" ] && [ "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "$FORCE" = "0" ]; then
    die "target $TARGET is not empty — pass --force to overwrite, or --upgrade-deps/--refresh-skills for partial updates"
fi

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

# Cleanup turn dispatched when the session wraps via /wrapup.
# Supports template vars: {today} {agent_id} {session_uuid} {summary_path}
# Leave empty to skip the cleanup turn.
cleanup: |
  You're wrapping up this session. Write a session summary to {summary_path}
  covering: what happened, what you learned, unresolved threads.

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

# --- venv ---
if [ -d "$TARGET/venv" ] && [ "$FORCE" = "0" ]; then
    log "venv exists — leaving untouched (use --force or --upgrade-deps to refresh)"
else
    log "creating python venv at $TARGET/venv"
    command -v python3 >/dev/null || die "python3 not found on PATH"
    rm -rf "$TARGET/venv"
    python3 -m venv "$TARGET/venv"
fi

if [ -f "$REPO_ROOT/requirements.txt" ]; then
    log "installing python dependencies from requirements.txt"
    "$TARGET/venv/bin/pip" install --quiet --upgrade pip
    "$TARGET/venv/bin/pip" install --quiet -r "$REPO_ROOT/requirements.txt"
else
    warn "no requirements.txt found at $REPO_ROOT — skipping pip install"
fi

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
