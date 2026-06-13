# CLI — `kl` and `kl-msg`

The two user-facing command-line tools that ship with kiln-lite: `kl` (session launcher) and `kl-msg` (messaging CLI).

## Overview

Two commands are npm-linked globally when you run `./install.sh`:

- **`kl`** — launches Pi sessions inside named tmux windows. Handles agent-id generation, env var export, and attach/detach. This is the ergonomic entry point for running a kiln-lite-enabled Pi session.
- **`kl-msg`** — thin wrapper around `DaemonClient` for messaging from the shell. Subcommands mirror the daemon's wire protocol. Mostly invoked indirectly by the `message` skill's bash script, but usable standalone.

Both are exposed via `package.json` `bin` entries. `npm link` (part of install) registers them on `$PATH`.

## `kl` — session launcher

### Usage

```
kl                          # spawn starter agent (~/.kl/agents/agent), attach
kl <name>                   # spawn a named agent (~/.kl/agents/<name>)
kl run [name] [--detach] [pi-args]  # with optional detach + pi passthrough
kl --detach [pi-args]       # spawn detached, print agent-id to stdout
kl attach <agent-id>        # reattach an existing tmux session
kl list                     # list active kl-shaped tmux sessions
kl agents                   # list installed agents on disk
kl new <name>               # scaffold a new agent
kl history [name]           # session history (all agents or one)
kl doctor [name]            # system + per-agent diagnostics
kl -h | --help              # show usage
```

`kl` (no args) is the common case — spawn the starter agent and attach. `kl <name>` spawns a named agent instead. Under the hood:

1. Resolve the agent home: positional name (`kl beth` → `~/.kl/agents/beth`), else `$AGENT_HOME` override, else the default starter at `~/.kl/agents/agent`.
2. Read `name:` from `agent.yml`.
3. Generate a fresh `<name>-<adj>-<noun>` agent-id (16 bytes of entropy → sha256 → pool indices).
4. Check for tmux session collision; suffix with 2 hex bytes if found.
5. `tmux new-session -d -s <agent-id> -e AGENT_ID=... -e AGENT_HOME=... -e _KL=1 pi -e <ext-path>`
6. Attach to the session (via `tmux switch-client` if already inside tmux, else `tmux attach-session`).

The tmux window name == the agent-id, so every live session has a stable address you can `kl attach` back to.

### `--detach` / peer-spawn

When you want to spawn a session programmatically (e.g. another agent wants to delegate work):

```bash
id=$(kl --detach --prompt "Go investigate the failing test in foo.py")
echo "spawned $id"
kl-msg send "$id" "ping"   # later — send a follow-up
```

`--detach` writes log output to stderr and the fresh agent-id to stdout, so shell capture (`$(...)`) grabs just the id.

### `attach` / `list`

```
kl list
# agent-ash-fern
# agent-quiet-elk
# agent-wild-brook

kl attach agent-quiet-elk
# (reattaches the tmux session; tmux switch-client if already inside tmux)
```

`kl list` uses a heuristic regex (`<word>-<word>-<word>`) to filter tmux sessions — it doesn't tag kl-owned sessions explicitly (would require a tmux user option). In practice the heuristic matches every kiln-lite session and nothing else.

### Env

| Variable | Meaning | Default |
|----------|---------|---------|
| `AGENT_HOME` | Override the agent home dir | `~/.kl/agents/agent` |
| `KL_AGENTS_DIR` | Override the agents root dir | `~/.kl/agents` |

### Reference: name pools

Adjective and noun pools live in both `bin/kl` and `extensions/kiln-lite/identity.ts`. They must match — otherwise the extension's derived id (for raw `pi` launches without `kl`) and `kl`-generated ids use different vocabularies. If you edit either pool, edit both.

## `kl-msg` — messaging CLI

### Usage

```
kl-msg send <to> <summary> [--body <text> | --body-stdin] [--priority normal|high]
kl-msg publish <channel> <summary> [--body <text> | --body-stdin] [--priority normal|high]
kl-msg subscribe <channel>
kl-msg unsubscribe <channel>
kl-msg list-subscriptions
kl-msg list-sessions [--agent NAME]
kl-msg status
```

Reads its identity from env vars:

| Variable | Meaning | Default |
|----------|---------|---------|
| `AGENT_ID` | This session's agent-id | required |
| `AGENT_HOME` | This session's home dir | required |
| `AGENT_NAME` | Agent name prefix | inferred from first `-` segment of `AGENT_ID` |
| `INBOX_DIR` | Inbox dir name under `AGENT_HOME` | `inbox` |

All set automatically by the kiln-lite extension on `session_start`. If you invoke `kl-msg` outside a session, you must set them yourself.

### Daemon autostart

Every `kl-msg` invocation ends up calling `DaemonClient.sendOnce(...)`, which autostarts the daemon if the socket is down (see [`daemon.md`](./daemon.md) §Autostart). First call after a cold machine takes ~1-2 s; subsequent calls are sub-millisecond.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Daemon-reported error (e.g. unknown recipient, daemon internal error) |
| 2 | Usage error (missing env var, bad flag) |

### Reference: commands

| Command | Args | What it does |
|---------|------|--------------|
| `send` | `<to> <summary>` + body | Write a DM to `<to>`'s inbox. |
| `publish` | `<channel> <summary>` + body | Fan out to every subscriber ≠ sender. |
| `subscribe` | `<channel>` | Add this session to the channel's subscriber set. |
| `unsubscribe` | `<channel>` | Remove from subscriber set. |
| `list-subscriptions` | — | Print channels this session is subscribed to. |
| `list-sessions` | `[--agent NAME]` | Print all daemon-known sessions, optionally filtered. |
| `status` | — | Print daemon status (pid, uptime, session count, channel count). |

Full wire protocol in [`daemon.md`](./daemon.md).

## Examples

### Normal launch

```bash
kl
# [kiln-lite: online as agent-bright-jay]
# pi session opens, attached

kl beth
# [kiln-lite: online as beth-silver-gate]
# spawns the 'beth' agent
```

### Peer-spawn with prompt

```bash
peer=$(kl --detach --prompt "Audit scratch/results.md and flag anything shaky")
echo "spawned: $peer"
# Later:
kl-msg send "$peer" "ping" --body "How's it going?"

# Spawn a specific agent detached:
peer=$(kl beth --detach --prompt "Review my draft")
```

### Inspect the daemon

```bash
kl-msg status
# pid: 45913
# uptime: 12m 34s
# sessions: 3
# channels: 2

kl-msg list-sessions
# agent-bright-jay    agent   running   pid 45123   since 19:40:00
# agent-quiet-elk     agent   running   pid 45821   since 19:45:02
# agent-wild-brook    agent   running   pid 45930   since 20:15:30
```

### Subscribe + publish from the shell

```bash
export AGENT_HOME=~/.kl/agents/agent
export AGENT_ID=shell-user-local
export INBOX=$AGENT_HOME/inbox/$AGENT_ID
mkdir -p "$INBOX"

kl-msg subscribe docs-review
kl-msg publish docs-review "drive-by note" --body "Consider breaking §4 into two."
```

Useful for one-off shell scripting, CI, or when you want to post from outside a Pi session.

### Create a new agent

```bash
kl new beth
# scaffolded: ~/.kl/agents/beth/
# edit ~/.kl/agents/beth/agent.yml to configure

kl agents
# agent    ~/.kl/agents/agent/
# beth     ~/.kl/agents/beth/
```

### Raw pi without kl

```bash
AGENT_HOME=~/.kl/agents/beth pi -e ~/Git/kiln-lite/extensions/kiln-lite/index.ts
```

No tmux, no `kl`, no `$AGENT_ID` pre-export — the extension derives the id from Pi's session UUID. Useful for extension development; less useful day-to-day because without a tmux session name you can't `kl attach` later.

## Conventions

- **Use `kl` for normal launches.** The tmux session + pre-exported `$AGENT_ID` keep everything coherent. Raw `pi` works but loses the stable tmux name.
- **Always use `--detach` for peer-spawn.** Without it, the parent process blocks on attach — which fails if you're spawning from inside a tool (no TTY).
- **`kl-msg` reads env; keep it set.** Inside a kiln-lite session, the extension sets everything. Outside, you must. Missing vars exit 2.
- **Bodies can come from stdin.** `kl-msg send x y --body-stdin < file.md` is the clean way to post large bodies; inline `--body "..."` hits shell-quoting limits fast.

## Gotchas

- **`kl` requires tmux.** `install.sh` warns but doesn't fail on missing tmux. `kl` itself dies with a clear error. Install tmux before running `kl`.
- **Collision-suffixed agent-ids desync from the extension.** If `kl` hits a collision and appends a `-xx` hex suffix, the extension receives the suffixed id via `$AGENT_ID` and uses it. Derivation from session UUID won't match — but that's fine because `$AGENT_ID` wins.
- **`kl list` is heuristic.** Any tmux session matching `<word>-<word>-<word>` gets listed. False positives are possible (though not in normal use) — check `tmux list-sessions` for the full view.
- **`kl-msg` won't find `kl-msg` recursively.** If you manage to invoke it from inside its own shell environment (unlikely), PATH resolution is fine because it's globally linked. The gotcha is only relevant when someone manually unlinks and tries to re-invoke.
- **`AGENT_NAME` inference is a guess.** If `$AGENT_NAME` isn't set, `kl-msg` takes the first `-` segment of `$AGENT_ID` as the name. Correct for the default `name: agent` and for any agent whose name is a single lowercase word. If your agent name contains a hyphen, export `$AGENT_NAME` explicitly.
- **`--body-stdin` is the `kl-msg` flag; `--stdin` is the `message` skill's flag.** The skill script translates. If you call `kl-msg` directly, use `--body-stdin`.

## Cross-references

- [`daemon.md`](./daemon.md) — wire protocol that `kl-msg` invokes.
- [`messaging.md`](./messaging.md) — the `message` bash frontend that wraps `kl-msg`.
- [`extension.md`](./extension.md) — where `$AGENT_ID` / `$AGENT_HOME` / `$INBOX` get set.
- [`install.md`](./install.md) — how `kl` and `kl-msg` get on `$PATH` (via `npm link`).
