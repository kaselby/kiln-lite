# Agent Home

The layout and ownership model of `~/.kl/` — the root that holds every agent home and the shared daemon state.

## Overview

kiln-lite's footprint on the host lives under **`~/.kl/`**. Two subtrees share that root:

- **`~/.kl/agents/<name>/`** — **agent homes**. Each agent gets its own home dir containing identity, config, memory, tools, skills, inboxes — everything one or more Pi sessions of that agent read or write. The starter agent is at `~/.kl/agents/agent/`. Add more with `kl new <name>`.
- **`~/.kl/daemon/`** — the **daemon state**. Contains the daemon's persistent state: subscriptions, known-sessions index, pid, log. Shared across all agents. Never touched by agent sessions directly; the daemon is the only writer.

Paths throughout the kiln-lite docs use `<home>` for the absolute path to a specific agent home. At runtime, `AGENT_HOME` points at it for every shell tool, startup command, and Pi-spawned subprocess of that agent's session.

Using a single `.kl/` root (rather than scattering across `~/.agent/`, `~/.cache/kiln-lite/`, `~/.config/kiln-lite/`, and so on) means there's exactly one place to look when something is off — logs, subscriptions, inbox, memory all share a prefix. Short name, matches the `kl` binary, obvious dotfile convention.

## Architecture

Top-level layout:

```
~/.kl/
├── agents/                             <- $KL_AGENTS_DIR
│   └── <name>/                         <- $AGENT_HOME for this agent's sessions
│       ├── agent.yml                   # config (name, context_injection, cleanup, ...)
│       ├── memory/                     # agent-written persistent state
│       │   └── sessions/               # session summaries (convention)
│       ├── scratch/                    # ephemeral working notes
│       ├── tools/                      # shell tools — copied here on bootstrap
│       ├── skills/                     # SKILL.md-based skill packages
│       ├── inbox/<agent-id>/           # per-session inboxes
│       ├── sessions/                   # session summaries (cleanup-turn output)
│       ├── venv/                       # python venv for shell tools (bootstrap-owned)
│       └── credentials/                # (optional) per-env-var secret files
│
└── daemon/
    ├── daemon.pid                  # cleaned on clean exit
    ├── daemon.log                  # all daemon output
    ├── known-sessions.json         # persistent index of every registered session
    ├── subscriptions/
    │   └── <session-id>.json       # per-session channel list
    └── channels/
        └── <name>/history.jsonl    # per-channel broadcast history
```

The Unix socket lives at **`$XDG_RUNTIME_DIR/kiln-lite.sock`** (macOS fallback: `/tmp/kiln-lite-$UID.sock`), not under `~/.kl/daemon/`. Keeping the socket in a home-neutral location means a future multi-home setup won't need a migration — today it's purely a forward-compat concession.

### Ownership

Three ownership tiers:

| Tier | Who writes | What goes there |
|------|------------|-----------------|
| Agent-written | The running agent | `memory/`, `tools/`, `skills/`, `scratch/`, `credentials/`, identity-doc edits |
| Scaffold-owned | `bootstrap.sh` / `install.sh` | `agent.yml` (template), `venv/`, bundled skills/tools (refreshable) |
| Daemon-owned | The daemon process | `~/.kl/daemon/*` |
| Session-owned | The kiln-lite extension | `inbox/<agent-id>/` (populated by daemon); session summaries written to `sessions/` by the cleanup turn |

Within the agent home, the extension treats agent-written files as read-only — it never mutates `memory/` or `scratch/`, only reads them through `context_injection`. The daemon never reads the agent home; it only writes inbox messages into `inbox/<agent-id>/` when a peer session publishes to a channel this session subscribes to, or sends it a DM.

### Scaffolding

A fresh `./install.sh` creates the starter agent at `~/.kl/agents/agent/`. Each subsequent `kl new <name>` creates the same shape under `~/.kl/agents/<name>/`:

- `<home>/agent.yml` from a template — `name:` is auto-patched to match the dir name; you wire `context_injection:` and the cleanup turn
- empty `memory/`, `scratch/`, `inbox/`, `sessions/` directories (with `.gitkeep` if you later init a git repo)
- `tools/` populated with bundled shell tools (`message`, `sessions`, `fetch`, `web-search`, `seek`, `explore`, `todo`)
- `skills/` populated with bundled skills (`messaging/`)
- `venv/` created by `uv` at the version in `<repo>/.python-version`, with `requirements.txt` installed

Re-running `install.sh` on an existing **starter** refreshes its bundled skills and tools but leaves `agent.yml`, `memory/`, `venv/`, and `scratch/` alone. To refresh non-starter agents, run `./bootstrap.sh ~/.kl/agents/<name> --refresh-skills` (and/or `--refresh-tools`) directly. See [`install.md`](./install.md) for the full flow including migration from legacy single-agent layouts.

## Reference

### The `<home>` placeholder

Throughout this reference, `<home>` stands in for the absolute path of the agent home. At runtime:

- Shell tools and startup commands see `$AGENT_HOME` — pointing at `~/.kl/agents/<name>/` for the agent kl launched, or whatever was passed via `AGENT_HOME=...` for the override case.
- Inside the extension, `state.agentHome` in `SessionState` holds the resolved path.
- `$AGENT_HOME` is exported by the extension into `process.env`, so every child process (Pi's built-in `bash` tool, shell tools, startup commands) inherits it.

### Env vars exported to every child process

Set by `env.ts` on `session_start`:

| Variable       | Value                                        |
|----------------|----------------------------------------------|
| `AGENT_HOME`   | Resolved agent home (default `~/.kl/agents/agent`) |
| `AGENT_ID`     | `<name>-<adj>-<noun>` for this session       |
| `AGENT_NAME`   | Name prefix (from `agent.yml` → `name:`)     |
| `SESSION_UUID` | Pi session UUID                              |
| `INBOX`        | `$AGENT_HOME/inbox/$AGENT_ID/`               |
| `PATH`         | `$AGENT_HOME/tools/`, `$AGENT_HOME/venv/bin/`, then inherited |

### Session presence

Presence ("who's alive right now, and where's their inbox") is owned by the daemon, not by files under the agent home. `session_start` calls `DaemonClient.register(...)`; `session_shutdown` calls `deregister(...)`. Other tools look up live sessions via `kl-msg list-sessions` (or the `sessions` shell tool). The `sessions/` directory under the agent home holds cleanup-turn summaries only — not a live session index.

### Daemon state files

See [`daemon.md`](./daemon.md) for the full schema. In short:

- `daemon.pid` — process id, removed on clean exit. Missing or stale pid means the daemon isn't running.
- `known-sessions.json` — append-only-in-practice index: every session that ever registered, plus its last-known `inbox_path`. Used by `send_direct` to resolve recipients that aren't currently alive.
- `subscriptions/<session-id>.json` — each session's channel subscription list. Written on `subscribe` / `unsubscribe`, removed on `deregister`.
- `channels/<name>/history.jsonl` — append-only log of every message published to each channel.

### Cross-references

- [`messaging.md`](./messaging.md) — inbox file format, channel fanout, how `<home>/inbox/<agent-id>/` is populated.
- [`extension.md`](./extension.md) — what the extension reads and writes per lifecycle hook.
- [`daemon.md`](./daemon.md) — daemon state files in detail.
- [`install.md`](./install.md) — scaffolding flow and migration from legacy single-agent layouts.
- [`tools.md`](./tools.md) — how `<home>/tools/` is discovered and rendered.
- [`skills.md`](./skills.md) — how `<home>/skills/` is discovered and activated.

## Conventions

- **Multi-agent is first-class.** Each agent lives under `$KL_AGENTS_DIR/<name>/` (default `~/.kl/agents/<name>/`). Create with `kl new <name>`, launch with `kl run <name>`. The daemon routes by per-session `inbox_path`, so agents coexist cleanly. `AGENT_HOME=/some/path` is the escape-hatch override for one-off homes outside the registry.
- **Secrets live under `credentials/`.** Each file's name is the env var it populates (e.g. `credentials/TAVILY_API_KEY` → `$TAVILY_API_KEY`). Bundled tools read this path; nothing else should.
- **Ephemeral work goes in `scratch/`.** It's never injected into context, never indexed, fair game to delete.
- **Don't edit daemon-owned state by hand.** `~/.kl/daemon/*` files are machine-written JSON — correct by construction when the daemon writes them. If you need to reset, stop the daemon and `rm -rf ~/.kl/daemon/`; the daemon will recreate what it needs on next autostart.

## Gotchas

- **`inbox/<agent-id>/` is per-session, not per-agent.** Two simultaneous sessions of the same agent *name* have different agent-ids and different inboxes. Renaming mid-run orphans messages.
- **`bootstrap.sh` copies bundled skills/tools — it doesn't symlink.** Once copied, edits to `<home>/tools/foo` are yours; they won't be stomped unless you pass `--refresh-tools` or `--force`. Conversely, fixes to the repo's bundled scripts won't propagate until you re-run `install.sh` (which refreshes skills + tools automatically) or `bootstrap.sh --refresh-tools`.
- **`venv/` is at the Python version in `<repo>/.python-version`.** Changing the pin requires `bootstrap.sh <home> --rebuild-venv` to apply.
- **The socket path is home-neutral on purpose.** If you move `~/.kl/` to another path, the socket location doesn't change — but a running daemon under the old path will conflict with a new one. Stop the daemon before moving the root.
- **Legacy `~/.agent/` and `~/.kl/agent/` still work if you point `AGENT_HOME` at one** — but `kl agents` / `kl history` won't see them (they're outside the registry). Run `install.sh` to be prompted to migrate the legacy dir to `~/.kl/agents/agent/`. See [`install.md`](./install.md).
