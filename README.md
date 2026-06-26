# kiln-lite

**kiln-lite turns [Pi](https://github.com/earendil-works/pi) sessions into persistent, addressable agents.**

Pi is a coding agent that runs in your terminal: you talk to a model, it
reads files, runs commands, and edits code. Out of the box, every Pi session
is anonymous and starts cold — no stable name, no memory of past sessions, no
way for two sessions to talk to each other.

kiln-lite is a Pi *package* (an extension plus a couple of CLIs) that layers
the missing infrastructure on top, without replacing anything Pi already does:

- **Stable identity.** Every session gets a deterministic agent ID like
  `cal-bright-raven` that survives `/resume`, so an agent has a name you can
  address and reattach to.
- **A config-driven home.** Each agent lives in its own directory
  (`~/.kl/agents/<name>/`) holding its config, system prompt, memory, tools,
  and skills. One `agent.yml` controls how the session is assembled.
- **Persistent memory.** You point `agent.yml` at markdown files; kiln-lite
  composes them into the system prompt every session. A configurable cleanup
  turn lets the agent write back to those files before it exits.
- **Custom tools and skills.** Drop an executable in `tools/` or a `SKILL.md`
  in `skills/` and the agent discovers it automatically.
- **Multi-agent messaging.** Run several sessions at once — the same agent
  twice or different agents — and they send each other direct messages and
  broadcast to channels through a lightweight background daemon. Each session
  has a file-based inbox.
- **A session launcher (`kl`).** Wraps Pi in a named tmux session so every
  agent is something you can launch, list, attach to, and resume by name.

> The name: "kiln" is a larger agent-infrastructure system; **kiln-lite** is
> the standalone, Pi-native subset. You don't need kiln to use it — this repo
> is self-contained.

Full reference docs live under [`docs/`](./docs/index.md). This README is the
guided tour: install it, scaffold an agent, and learn how to give that agent
memory, tools, skills, and peers.

---

## How it fits together

Four pieces, layered around Pi:

```
  kl run <name>
      │  launches a tmux + pi session
      ▼
  ┌─────────────────────────────────────────────┐
  │ pi session                                  │
  │   loads the kiln-lite extension:            │
  │   identity · system prompt · tool listing · │
  │   inbox · cleanup turn                      │
  └─────────────────────────────────────────────┘
      │  registers + routes messages through
      ▼
  ┌─────────────────────────────────────────────┐
  │ kiln-lite daemon   (one shared process)     │
  │   presence · channels · inbox routing       │
  └─────────────────────────────────────────────┘
      ▲
      └─ every session connects here, so they can
         message one another
```

- **The extension** loads into every Pi session. It reads `agent.yml`,
  assigns the agent ID, composes the system prompt (base prompt + your memory
  files + a listing of your tools), watches the inbox, and runs the cleanup
  turn on exit. It owns no process of its own and never touches Pi's model
  loop.
- **The daemon** is a small Node process that autostarts on first use and
  self-exits when idle. It's the only shared state between agents — it knows
  who's alive and routes messages. You never start or stop it manually.
- **The agent home** (`~/.kl/agents/<name>/`) is the on-disk identity: config,
  memory, tools, skills, inbox. It's yours to edit; kiln-lite only reads it.
- **`kl`** is the launcher. It wraps Pi in a tmux session named after the
  agent ID, so sessions are addressable and survive disconnects.

You can use raw `pi` if you want — the extension still works — but `kl` is the
ergonomic path for anything multi-session.

---

## Install

```bash
git clone <this-repo> kiln-lite
cd kiln-lite
./install.sh
```

`install.sh` does, in order:

1. `npm install` — Node dependencies.
2. `npm link` — puts `kl` and `kl-msg` on your `PATH` globally.
3. Migrates any legacy single-agent layout (`~/.agent/`, `~/.kl/agent/`) to
   the current `~/.kl/agents/agent/` layout, if present.
4. Scaffolds a starter agent at `~/.kl/agents/agent/`.

Prerequisites (checked up front): **Node ≥ 20**, **npm**, **pi**, **tmux**,
and **[uv](https://docs.astral.sh/uv/)** (for the Python tool venv — bootstrap
offers to install it if missing). Without tmux you get a warning, but `kl`
won't work.

```bash
./install.sh --no-starter    # install kl + kl-msg only; scaffold agents later
```

---

## Your first agent

Installing leaves a ready-to-run starter agent at `~/.kl/agents/agent/`:

```bash
kl run              # launch the starter agent (and attach to its tmux session)
```

That's a working Pi session with a stable ID, the bundled tools, and the
`messaging` skill. To create more agents, scaffold them by name:

```bash
kl new beth         # creates ~/.kl/agents/beth/
kl run beth         # launch it
kl agents           # list every agent on disk
```

Each `kl new` produces the standard home shape:

```
~/.kl/agents/beth/
├── agent.yml         # config — edit this
├── memory/           # your persistent memory files (you define the shape)
├── scratch/          # ephemeral working notes (never injected into context)
├── tools/            # shell tools — bundled ones copied here, add your own
├── skills/           # SKILL.md skill packages — messaging bundled
├── inbox/            # per-session inboxes live at inbox/<agent-id>/
├── sessions/         # session summaries (written by the cleanup turn)
└── venv/             # Python venv for the bundled tools
```

Everything below is about filling that home in: configuring the agent, giving
it memory, tools, skills, and peers.

---

## Configuring an agent: `agent.yml`

`agent.yml` is the one file that controls how a session is assembled. Every
field is optional except `name`. Here's a complete example with the pieces
explained:

```yaml
# Name prefix for the agent ID (<name>-<adj>-<noun>) and $AGENT_NAME.
name: beth

# Optional: a file (relative to the home) that REPLACES Pi's default system
# prompt. Omit to keep Pi's default.
system_prompt: BETH.md

# Files (or command output) prepended to the system prompt every session.
# This is how an agent gets memory — see "Giving an agent memory" below.
context_injection:
  - path: memory/core.md
    label: Core Memory
  - path: memory/volatile.md
    label: Working State
    dynamic: true              # re-read every turn instead of once at start

# Shell commands run once at session start (e.g. pull latest memory).
startup:
  - "git -C $AGENT_HOME pull --ff-only"

# A follow-up turn dispatched when the session exits via /exit or exit_session.
# Template vars: {today} {agent_id} {session_uuid} {summary_path}
cleanup: |
  You're wrapping up. Write a session summary to {summary_path} covering what
  we did, decisions made, and anything the next session needs to know.

# Directory names, relative to the home (defaults shown).
tools_dir: tools
inbox_dir: inbox
sessions_dir: sessions
```

A few notes:

- **`name`** seeds the agent ID. A session of the `beth` agent gets an ID like
  `beth-silver-gate`, deterministic from Pi's session UUID, so `/resume`
  recovers the same one.
- **`system_prompt`** lets you give the agent a custom identity/persona. If you
  also have a file named `<NAME>.md` (uppercased) in the home, it's injected as
  its own block automatically.
- **`startup`** commands run with the full agent environment and `cwd =` the
  home. Non-zero exits warn but don't abort startup.
- **`cleanup`** is the agent's chance to persist state before shutting down.
  It's a normal turn — the agent can edit files, run tools, commit to git.

Full schema and edge cases: [`docs/extension.md`](./docs/extension.md).

---

## Giving an agent memory

kiln-lite doesn't prescribe a memory format. You write markdown files under
the home (conventionally in `memory/`) and list them in `context_injection`.
Each listed entry becomes a labelled block in the system prompt:

```yaml
context_injection:
  - path: memory/core.md            # durable identity & facts
    label: Core Memory
  - path: memory/volatile.md        # in-flight working state
    label: Working State
    dynamic: true
  - command: project list           # inject command OUTPUT, not a file
    label: Active Projects
    dynamic: true
```

- **`path`** entries inject a file's contents. **`command`** entries inject a
  shell command's stdout instead (the two are mutually exclusive).
- **Static** entries (the default) are read once at session start and cached.
- **`dynamic: true`** re-reads the file (or re-runs the command) every turn —
  use it for files the agent edits mid-session, at the cost of prompt-cache
  reuse.

The loop that makes memory *persist*: list a file under `context_injection` so
the agent reads it at the start of every session, then write a `cleanup` prompt
that tells the agent to update that same file before it exits. The agent reads
its memory in, works, and writes it back out.

For a fully worked example — layered core/volatile/active memory, a
project-tracking convention, and a real multi-step cleanup turn — see
[`example/`](./example/). Drop the whole thing into a home or take the pieces
you want.

---

## Giving an agent tools

Tools beyond Pi's built-ins are plain executable scripts under the home's
`tools/` directory. They are **not** registered as Pi tools — they sit on
`$PATH` and the agent calls them through Pi's built-in `bash` tool. kiln-lite's
job is to discover them and list them in the system prompt so the agent knows
they exist.

A tool is any executable with a `# ---` YAML header:

```bash
#!/usr/bin/env bash
# ---
# name: ping
# brief: Check a service heartbeat
# arguments: "<url>"
# description: |
#   Curl a URL and report ok/down. Used for quick liveness checks.
# ---
set -euo pipefail
curl -sf "$1" >/dev/null && echo ok || echo down
```

```bash
chmod +x ~/.kl/agents/beth/tools/ping
```

Next session, the agent's prompt shows:

```
- **ping** `<url>` — Check a service heartbeat
```

and it can run `ping https://...` through bash. Header fields: `name`
(required), `description` or `brief` (at least one), optional `arguments`
(usage signature) and `cost` (renders a per-call price tag). The script needs
the executable bit, and only top-level files are scanned (no subdirectories).

Tools inherit `$AGENT_HOME`, `$AGENT_ID`, `$INBOX`, and friends, and the home's
`venv/bin` is on `$PATH` — so a `#!/usr/bin/env python3` tool resolves to the
agent's venv. Add Python deps with
`VIRTUAL_ENV="$AGENT_HOME/venv" uv pip install <pkg>`.

> Discovery runs at session start, so a tool added mid-session is callable
> immediately but won't appear in the prompt listing until the next session.

**Bundled tools** (copied into every home, editable in place):

| Tool | Purpose |
|------|---------|
| `message` | Send DMs / broadcast to channels / manage subscriptions. |
| `sessions` | Discover live peers — `list`, `show <agent-id>`, `resolve <uuid>`. |
| `fetch` | Fetch a web page as readable text (Chrome fallback for JS pages). |
| `web-search` | Web search via Tavily or Exa. |
| `seek` | Fast filename search (`fd` if present, else `find`). |
| `explore` | Spawn a Haiku subagent to read/summarize without burning context. |
| `todo` | Task tracker with project boards. |

Full reference: [`docs/tools.md`](./docs/tools.md).

---

## Giving an agent skills

A **skill** is packaged domain knowledge the agent opts into on demand. It's a
folder under `skills/` containing a `SKILL.md` with YAML frontmatter:

```
~/.kl/agents/beth/skills/docs-style/
└── SKILL.md
```

```markdown
---
name: docs-style
description: House style for reference docs — when to use, tone, structure.
---

# Docs Style

## Tone
- Mechanism-first, assume competent readers, short sections.
...
```

The difference from a tool: the **listing** (one line — name + description) is
always in the prompt, but the **body** only loads when the agent calls Pi's
`activate_skill` tool. So a long guide can exist without costing tokens every
session — the description is the "should I open this?" signal.

This is [Anthropic's open Skill format](https://www.anthropic.com/news/skills),
so the same skill folder works in Claude Code, Pi, and any Skill-aware runtime.
Put deep material in sibling files (`references/`, `assets/`) that the SKILL.md
body points the agent at. kiln-lite bundles one skill — `messaging` — into
every home.

Full reference: [`docs/skills.md`](./docs/skills.md).

---

## Sessions that talk to each other

Every live session — whether it's the same agent launched twice or two
different agents — gets its own unique ID (`<name>-<adj>-<noun>`) and its own
file-based inbox at `inbox/<agent-id>/`. Any session can message any other
live session by that ID. Routing goes through the daemon, which autostarts on
first use.

Sessions send messages with the built-in **`message`** tool:

```
message(action="send", to="beth-silver-gate", summary="…", body="…")     # DM
message(action="send", channel="review", summary="…", body="…")          # broadcast
message(action="subscribe", channel="review")
message(action="unsubscribe", channel="review")
```

Delivery depends on whether the recipient is busy:

- **Idle** — the message is delivered as a full user turn right away.
- **Mid-work** — a `[INBOX: N unread]` marker is appended to the agent's next
  tool result; it reads the message file when convenient.

To find peers, the `sessions` tool lists who's alive. From the shell, `kl-msg`
is the low-level CLI behind it all (`kl-msg status`, `kl-msg list-sessions`).
DMs reach only live sessions; channel broadcasts also reach offline
subscribers (parked in their inbox).

Full reference: [`docs/messaging.md`](./docs/messaging.md) and
[`docs/daemon.md`](./docs/daemon.md).

---

## Built-in tools and commands

The extension registers three tools beyond Pi's built-ins, available to every
agent:

| Tool | What it does |
|------|--------------|
| `plan` | Externalize a task breakdown (goal + ordered tasks). Periodically re-surfaced as a reminder so the agent stays on track. |
| `message` | Inter-agent messaging (DMs, channels) — see above. |
| `exit_session` | Exit autonomously, with optional self-continuation: spawn a fresh session inheriting the home, handing off context. |

Slash commands:

| Command | Effect |
|---------|--------|
| `/exit` | Run the `agent.yml:cleanup` turn, then shut down. |
| `/fq` | Force quit — skip cleanup, immediate shutdown. |

> `/quit`, Ctrl+D, and double Ctrl+C are intercepted by Pi *before* the
> extension and bypass cleanup. Use `/exit` when you want the cleanup turn to
> run.

---

## The `kl` launcher

`kl` wraps Pi in a named tmux session so every agent is addressable. The
canonical form is `kl run [name]`; bare `kl` is shorthand for the default
starter agent.

```bash
kl                          # launch the default starter agent
kl run beth                 # launch the 'beth' agent
kl run beth [pi-args...]    # extra args pass through to pi (e.g. --model)
kl resume beth-silver-gate  # resume a past session by agent ID
kl attach beth-silver-gate  # reattach to a live session
kl list                     # list live kl sessions
kl agents                   # list installed agents on disk
kl new beth                 # scaffold a new agent home
kl history [name]           # recent sessions, across all agents or one
kl doctor [name]            # system + per-agent diagnostic
```

> `kl <name>` (without `run`) is **not** a shortcut — an unknown leading token
> is an error, not an agent launch. Use `kl run <name>`.

At launch `kl` resolves the home (positional name → `~/.kl/agents/<name>`, else
`$AGENT_HOME` override, else the starter), generates the agent ID up front,
exports `AGENT_ID` / `AGENT_HOME` / `_KL=1`, and starts Pi inside tmux. Because
the ID is fixed before Pi starts, the tmux session name, the extension's ID,
and the inbox directory all agree from spawn.

**Iterating on the extension itself** (no install, no tmux):

```bash
AGENT_HOME=~/.kl/agents/agent pi -e ./extensions/kiln-lite/index.ts
```

`AGENT_HOME` is the escape-hatch override — it bypasses the `kl agents`
registry, so use it for one-off or throwaway homes only.

---

## Re-scaffolding and refreshing

`kl new` and `install.sh` call `bootstrap.sh` under the hood. You can call it
directly to refresh parts of an existing home:

| Command | Effect |
|---------|--------|
| `./bootstrap.sh <home> --force` | Overwrite all scaffolding (destructive). |
| `./bootstrap.sh <home> --refresh-tools` | Recopy bundled tools over local edits. |
| `./bootstrap.sh <home> --refresh-skills` | Recopy bundled skills. |
| `./bootstrap.sh <home> --upgrade-deps` | Upgrade Python deps in the existing venv. |
| `./bootstrap.sh <home> --rebuild-venv` | Nuke and recreate the venv. |

Re-running `install.sh` refreshes bundled tools and skills on the starter but
never touches `agent.yml`, `memory/`, `scratch/`, or `venv/`. Bundled tools and
skills are copied (not symlinked), so edits to them are yours until a refresh
overwrites them — rename a tool/skill if you want a custom version that sticks.

---

## Repo layout

```
kiln-lite/
├── bin/kl                       # session launcher (tmux wrap + agent ID)
├── extensions/kiln-lite/        # the Pi extension
│   ├── index.ts                 # entry — registers lifecycle hooks
│   ├── config.ts                # agent.yml loader + defaults
│   ├── identity.ts              # deterministic agent-id generation
│   ├── prompt.ts                # system prompt composition
│   ├── tools.ts                 # tool discovery + index rendering
│   ├── inbox.ts                 # inbox watcher + delivery
│   ├── cleanup.ts               # /exit /fq dispatch
│   ├── exit-session.ts          # exit logic — cleanup, continuation, shutdown
│   ├── plan-tool.ts             # plan tool + periodic reminders
│   ├── message-tool.ts          # message tool
│   ├── spawn.ts                 # peer / continuation spawning
│   └── lib/                     # stable public API (for custom harnesses)
├── src/
│   ├── daemon/                  # the messaging daemon (socket, registries, routing)
│   └── client/                  # DaemonClient + autostart + the kl-msg CLI
├── skills/messaging/            # bundled skill (copied into each home)
├── tools/                       # bundled shell tools (copied into each home)
├── example/                     # opinionated reference agent home
├── docs/                        # full reference docs (start at index.md)
├── install.sh                   # one-stop install
└── bootstrap.sh                 # scaffold / refresh a home
```

Need to customize behavior beyond `agent.yml` — your own event hooks, a
replaced prompt assembly, role-specific cleanup? Write a personal *harness* at
`<home>/harness/index.ts`; `kl` loads it in preference to the bundled
extension. See "Customizing via a personal harness" in
[`docs/extension.md`](./docs/extension.md).

---

## Reference docs

| Doc | Topic |
|-----|-------|
| [`docs/overview.md`](./docs/overview.md) | The 30-second shape — read this first. |
| [`docs/home.md`](./docs/home.md) | Agent home layout, `~/.kl/` ownership, exported env vars. |
| [`docs/extension.md`](./docs/extension.md) | How the extension wires into Pi; full `agent.yml` schema; custom harnesses. |
| [`docs/tools.md`](./docs/tools.md) | Shell tool discovery and the YAML header format. |
| [`docs/skills.md`](./docs/skills.md) | SKILL.md packaging and activation. |
| [`docs/messaging.md`](./docs/messaging.md) | Inbox format, DMs, channels, delivery modes. |
| [`docs/daemon.md`](./docs/daemon.md) | Daemon architecture, wire protocol, autostart. |
| [`docs/cli.md`](./docs/cli.md) | `kl` and `kl-msg` command reference. |
| [`docs/install.md`](./docs/install.md) | Install, scaffold, migration, uninstall. |
| [`docs/migration-multi-agent.md`](./docs/migration-multi-agent.md) | Upgrading from the legacy single-agent layout. |
| [`docs/tmux.md`](./docs/tmux.md) | Recommended `~/.tmux.conf` settings for `kl` sessions. |

---

## Uninstall

```bash
npm unlink -g kiln-lite     # remove the kl / kl-msg global links
rm -rf ~/.kl                 # agent homes + daemon state (your call)
```

Agent homes live under `~/.kl/agents/`, daemon state under `~/.kl/daemon/` —
remove them individually if you want to keep one while dropping the other.

---

## Status

v0.4, unreleased — not published to npm. Iterate in-place. The `lib/` surface
([`docs/extension.md`](./docs/extension.md)) is the stable public API for
custom harnesses; additions are non-breaking, renames are breaking.
