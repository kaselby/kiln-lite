# Overview

What kiln-lite is, what it does, and how it fits around Pi.

## What it is

**kiln-lite** is a Pi package that adds persistent-agent infrastructure on top of the [Pi coding agent](https://github.com/earendil-works/pi): stable identity across sessions, a composed system prompt driven by config, shell tool conventions, and inter-session messaging through a lightweight Node daemon.

Concretely, installing kiln-lite gives you:

- a **Pi extension** that assembles a system prompt from `agent.yml`, runs startup commands, watches the inbox, and handles the cleanup turn;
- a **Node daemon** that routes messages between sessions (direct messages and channel pub/sub) and autostarts on first use;
- an `agent.yml`-driven **home directory layout** under `~/.kl/` — memory, tools, skills, sessions, inboxes;
- a `kl` **launcher** that wraps Pi in a named tmux session so every agent has a stable address;
- **bundled shell tools and the `messaging` skill**, installed into the home and editable in place;
- a **`kl-msg` CLI** for scripting messaging from the shell or agent prompt.

## What it isn't

Out of scope for kiln-lite:

- Gateway bridging to Discord / Slack / other platforms
- A scheduler for cron or one-shot triggers
- Cross-machine messaging
- Cross-session search over conversation history
- A prescribed memory shape — `context_injection` names files, you decide what's in them
- Self-continuation across context limits

## How it layers

Pi owns the model loop, the TUI, session persistence, and the built-in tools (`bash`, `read`, `edit`, `write`, `task`, etc). kiln-lite is a Pi *extension* — it hooks into Pi's lifecycle events (`session_start`, `before_agent_start`, `tool_result`, `agent_end`, `session_shutdown`, `resources_discover`) to layer its own behaviour on top. The extension never replaces Pi's core — it composes with it.

The daemon is a separate Node process spawned on demand by the extension. It owns the state that needs to be shared across sessions (channel subscriptions, session presence, inbox routing), and nothing else. Pi has no idea the daemon exists.

```
┌─────────────────────────────────────────┐
│  pi (session N)                         │
│  ┌─────────────────────────────┐        │
│  │  kiln-lite extension        │──────┐ │
│  │  (system prompt, tools,     │      │ │
│  │   inbox, cleanup, daemon    │      │ │
│  │   register/deregister)      │      │ │
│  └─────────────────────────────┘      │ │
└───────────────────────────────────────┼─┘
                                        │
                                        ▼
                          ┌──────────────────────────┐
                          │  kiln-lite daemon        │
                          │  (channels, presence,    │
                          │   inbox routing)         │
                          └──────────────────────────┘
                                        ▲
                                        │
┌───────────────────────────────────────┼─┐
│  pi (session N+1)                     │ │
│  kiln-lite extension ─────────────────┘ │
└─────────────────────────────────────────┘
```

## Repo layout

```
kiln-lite/
├── bin/
│   └── kl                      # session launcher (tmux wrap)
├── extensions/kiln-lite/       # the Pi extension
│   ├── index.ts                # entry — lifecycle wiring
│   ├── config.ts               # agent.yml loader
│   ├── identity.ts             # deterministic agent-id generation
│   ├── env.ts                  # env-var export
│   ├── prompt.ts               # system prompt composition
│   ├── tools.ts                # tool discovery + index rendering
│   ├── inbox.ts                # fs.watch inbox delivery
│   ├── cleanup.ts              # /wrapup /exit /fq
│   ├── bootstrap.ts            # first-run auto-scaffold
│   └── types.ts                # shared interfaces
├── src/
│   ├── daemon/                 # the daemon (~800 LOC TS)
│   │   ├── index.ts            # socket listener, lifecycle
│   │   ├── protocol.ts         # wire envelope + builders
│   │   ├── state.ts            # registries + stores
│   │   ├── handlers.ts         # per-message handlers
│   │   ├── inbox.ts            # message file writing
│   │   └── reconcile.ts        # tmux-poll zombie cleanup
│   └── client/
│       ├── index.ts            # DaemonClient class
│       ├── autostart.ts        # spawn daemon if socket is down
│       └── cli.ts              # kl-msg — user-facing CLI
├── skills/
│   └── messaging/              # bundled skill (copied into agent home)
├── tools/                      # bundled shell tools (copied into agent home)
├── docs/                       # this directory
├── install.sh                  # one-stop install
├── bootstrap.sh                # scaffold / refresh an agent home
└── package.json                # pi package manifest + bin entries
```

## Lifecycle in one paragraph

`./install.sh` runs `npm install`, `npm link` (putting `kl` and `kl-msg` on your PATH), `pi install .` (registering the extension globally), then `./bootstrap.sh` (scaffolding the agent home at `~/.kl/agent/`, unless one already exists — in which case bundled skills and tools are just refreshed). `kl` spawns a Pi session inside a tmux window, exporting `AGENT_ID` / `AGENT_HOME` / `_KL=1`. The extension fires on `session_start`: loads `agent.yml`, resolves identity, exports env vars, discovers tools, composes the first system prompt, starts the inbox watcher, and fires off a fire-and-forget `register` to the daemon (which autostarts if it isn't already up). From there the session runs — you work with Pi normally. When the session wraps via `/wrapup`, the configured cleanup prompt runs as a final turn; on `session_shutdown` the extension deregisters from the daemon (which self-exits 30 seconds later if no other sessions are alive).

## Where to go next

For the filesystem shape of an agent home, see [`home.md`](./home.md). For how the extension wires into Pi, [`extension.md`](./extension.md). For the daemon — wire protocol, registries, autostart — [`daemon.md`](./daemon.md). For inbox delivery, channels, and the `message` skill, [`messaging.md`](./messaging.md). Shell tool format is [`tools.md`](./tools.md); skills are [`skills.md`](./skills.md). `kl` / `kl-msg` are in [`cli.md`](./cli.md). Install + migration: [`install.md`](./install.md).

## Conventions

- **Agent home is agent-owned.** `bootstrap.sh` seeds it; after that, it's yours to edit. Re-running `install.sh` refreshes bundled skills and tools but leaves `agent.yml`, `memory/`, and `venv/` alone.
- **Daemon is invisible.** There's no `kl start-daemon`. Autostart on first client call, 30-second idle auto-shutdown. If you're debugging, `kl-msg status` tells you it's there; `ps | grep tsx.*daemon` confirms.
- **Single `.kl/` root.** Agent home and daemon state both live under `~/.kl/` — one root, two subdirs (`agent/`, `daemon/`). The socket lives at `$XDG_RUNTIME_DIR/kiln-lite.sock` (or `/tmp/kiln-lite-$UID.sock` on macOS) because a future multi-home setup would want it home-neutral.

## Version

v0.3 (current, unreleased). v0.1 was the initial Pi extension without a daemon; v0.2 added bootstrap + unified skills; v0.3 added the daemon + channel support and moved the home from `~/.agent/` to `~/.kl/agent/`. See `archive/` for historical design docs.
