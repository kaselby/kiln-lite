# Overview

What kiln-lite is, what it does, and how it fits around Pi.

## What it is

**kiln-lite** is a Pi package that adds persistent-agent infrastructure on top of the [Pi coding agent](https://github.com/earendil-works/pi): stable identity across sessions, a composed system prompt driven by config, shell tool conventions, and inter-session messaging through a lightweight Node daemon.

Concretely, installing kiln-lite gives you:

- a **Pi extension** that assembles a system prompt from `agent.yml`, runs startup commands, watches the inbox, and handles the cleanup/exit turn;
- **built-in tools**: `plan` (externalized task breakdown with periodic reminders), `exit_session` (autonomous exit with self-continuation and handoff), and `message` (inter-agent messaging);
- a **Node daemon** that routes messages between sessions (direct messages and channel pub/sub) and autostarts on first use;
- a **multi-agent home layout** under `~/.kl/agents/<name>/` — each agent gets its own memory, tools, skills, sessions, inboxes;
- a `kl` **launcher** that wraps Pi in a named tmux session so every agent has a stable address (`kl new`, `kl <name>`, `kl agents`);
- **bundled shell tools and the `messaging` skill**, installed into each home and editable in place;
- a **`kl-msg` CLI** for scripting messaging from the shell or agent prompt.

## What it isn't

Out of scope for kiln-lite:

- Gateway bridging to Discord / Slack / other platforms
- A scheduler for cron or one-shot triggers
- Cross-machine messaging
- Cross-session search over conversation history
- A prescribed memory shape — `context_injection` names files, you decide what's in them

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
│   ├── cleanup.ts              # /exit /fq dispatch
│   ├── exit-session.ts         # exit logic — cleanup, continuation, shutdown
│   ├── exit-session-tool.ts    # exit_session tool registration
│   ├── plan.ts                 # plan state management
│   ├── plan-tool.ts            # plan tool registration + periodic reminders
│   ├── message-tool.ts         # message tool registration
│   ├── session-state.ts        # SessionState type + shared state
│   ├── spawn.ts                # peer/continuation session spawning
│   ├── template.ts             # template resolution
│   ├── gates.ts                # plan/message tool gate checks
│   ├── placeholders.ts         # template variable substitution
│   ├── bootstrap.ts            # first-run auto-scaffold
│   ├── types.ts                # shared interfaces
│   └── lib/                    # internal helpers
│       ├── index.ts            # re-exports
│       ├── agent-end.ts        # agent_end lifecycle helper
│       ├── formatting.ts       # text formatting utilities
│       ├── install.ts          # install detection
│       ├── resolve-agent-id.ts # agent-id recovery from state
│       └── snapshot-writer.ts  # session snapshot persistence
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

`./install.sh` runs `npm install`, `npm link` (putting `kl` and `kl-msg` on your PATH), migrates any legacy single-agent layout, then scaffolds a starter agent at `~/.kl/agents/agent/` (or refreshes its bundled skills and tools if it already exists). Add more agents with `kl new <name>`. `kl` (or `kl <name>`) spawns a Pi session inside a tmux window, exporting `AGENT_ID` / `AGENT_HOME` / `_KL=1`. The extension fires on `session_start`: loads `agent.yml`, resolves identity, exports env vars, discovers tools, composes the first system prompt, starts the inbox watcher, and fires off a fire-and-forget `register` to the daemon (which autostarts if it isn't already up). From there the session runs — you work with Pi normally. When the session exits via `/exit` (or the `exit_session` tool), the configured cleanup prompt runs as a final turn; on `session_shutdown` the extension deregisters from the daemon (which self-exits 30 seconds later if no other sessions are alive). If the exit requested self-continuation, a new session is spawned with the handoff text as its initial prompt.

## Where to go next

For the filesystem shape of an agent home, see [`home.md`](./home.md). For how the extension wires into Pi, [`extension.md`](./extension.md). For the daemon — wire protocol, registries, autostart — [`daemon.md`](./daemon.md). For inbox delivery, channels, and the `message` skill, [`messaging.md`](./messaging.md). Shell tool format is [`tools.md`](./tools.md); skills are [`skills.md`](./skills.md). `kl` / `kl-msg` are in [`cli.md`](./cli.md). Install + migration: [`install.md`](./install.md).

## Conventions

- **Agent home is agent-owned.** `bootstrap.sh` seeds it; after that, it's yours to edit. Re-running `install.sh` refreshes bundled skills and tools but leaves `agent.yml`, `memory/`, and `venv/` alone.
- **Daemon is invisible.** There's no `kl start-daemon`. Autostart on first client call, 30-second idle auto-shutdown. If you're debugging, `kl-msg status` tells you it's there; `ps | grep tsx.*daemon` confirms.
- **Single `.kl/` root.** All agent homes and daemon state live under `~/.kl/` — agents at `~/.kl/agents/<name>/`, daemon at `~/.kl/daemon/`. The socket lives at `$XDG_RUNTIME_DIR/kiln-lite.sock` (or `/tmp/kiln-lite-$UID.sock` on macOS), home-neutral so all agents share one daemon.

## Version

v0.4 (current, unreleased). v0.1 was the initial Pi extension without a daemon; v0.2 added bootstrap + unified skills; v0.3 added the daemon + channel support and moved the home from `~/.agent/` to `~/.kl/agent/`; v0.4 added multi-agent support (`~/.kl/agents/<name>/`), the plan tool, and the exit_session tool (self-continuation + handoff). See `archive/` for historical design docs.
