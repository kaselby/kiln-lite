# kiln-lite

A Pi package that adds persistent-agent infrastructure to Pi sessions: stable
identity across `/resume`, a composed system prompt driven by `agent.yml`,
shell tool conventions, a bundled `messaging` skill, and inter-session
messaging (direct + channel pub/sub) through a lightweight autostart daemon.

> **Full docs live under [`docs/`](./docs/index.md).** Start with
> [`docs/overview.md`](./docs/overview.md) for the shape; drill into topic docs
> (`home.md`, `daemon.md`, `messaging.md`, …) for depth. This README is
> quick-start only.

## What it gives you

- **Config-driven lifecycle.** One `agent.yml` in `$AGENT_HOME` controls system
  prompt composition, context injection, startup commands, and the cleanup turn.
- **Stable session identity.** Every Pi session gets a deterministic agent ID
  (`<name>-<adj>-<noun>`, seeded from the session UUID) that survives `/resume`.
- **Dynamic system prompt.** `context_injection` entries are labelled and composed
  into the prompt per turn. Entries marked `dynamic: true` are re-read every turn.
- **Shell tool conventions.** Scripts in `$AGENT_HOME/tools/` are plain
  executables with a YAML header. kiln-lite discovers them at session start
  and injects a compact tool index into the system prompt; the agent invokes
  them through Pi's built-in `bash` tool (the tools dir is prepended to
  `PATH`, so bare names work). Bundled tools are copied there by
  `bootstrap.sh` — edit or replace them freely; `--refresh-tools` recopies
  from the package.
- **File-based messaging.** Each session has an inbox at
  `$AGENT_HOME/inbox/<agent-id>/`. Peers drop markdown files in; the extension
  watches for new arrivals and delivers them as user turns (if idle) or as
  `[INBOX: N unread]` suffixes on the next tool result (if mid-work).
- **Cleanup flow.** `/exit` runs the configured cleanup prompt as a follow-up
  turn before shutdown. `/fq` force-exits without cleanup. The `exit_session`
  tool adds autonomous exit with optional self-continuation (spawn a new session
  with a handoff message, inheriting the agent home and template).

## What it isn't

v1 is intentionally small. Out of scope for now:

- Daemon-based channels (`message subscribe` is stubbed)
- Cross-machine messaging
- Recall-style session search
- Gateway bridging (Discord, Slack, etc.)
- Tree-branched summary semantics

Memory architecture is also out of scope — `agent.yml:context_injection` names
files, you decide what's in them.

## Install

```bash
cd /path/to/kiln-lite
./install.sh                 # installs kl + scaffolds starter at ~/.kl/agents/agent
./install.sh --no-starter    # install kl only; scaffold agents explicitly later
```

`install.sh` runs, in order:

1. `npm install` — node deps
2. `npm link` — registers `kl` globally so you can run it from any shell
3. Cleans up any legacy global pi registration of kiln-lite (idempotent)
4. Migrates legacy `~/.agent` or `~/.kl/agent` to `~/.kl/agents/agent/` if present
5. Scaffolds the starter agent at `~/.kl/agents/agent/` via `bootstrap.sh`

Prerequisites checked up front: `node`, `npm`, `pi`, `tmux`. Missing `tmux`
produces a warning, not a hard fail — but `kl` won't work without it.

To add more agents after install, use `kl new <name>`:

```bash
kl new beth        # scaffolds ~/.kl/agents/beth/
kl new dalet       # scaffolds ~/.kl/agents/dalet/
kl agents          # list installed agents
```

To re-scaffold or refresh parts of an existing agent home, call `bootstrap.sh`
directly with the agent's path:

```bash
./bootstrap.sh ~/.kl/agents/beth --force            # full overwrite (destructive)
./bootstrap.sh ~/.kl/agents/beth --upgrade-deps     # just Python deps
./bootstrap.sh ~/.kl/agents/beth --refresh-skills   # recopy bundled skills
./bootstrap.sh ~/.kl/agents/beth --refresh-tools    # recopy bundled tools
./bootstrap.sh ~/.kl/agents/beth --rebuild-venv     # nuke + recreate venv
```

### Quick start after install

```bash
# Edit ~/.kl/agents/agent/agent.yml — set 'name' and any context_injection files
kl                       # spawn the starter agent (~/.kl/agents/agent)
kl beth                  # spawn the 'beth' agent (~/.kl/agents/beth)
kl agents                # list installed agents on disk
kl list                  # list live tmux sessions
kl attach beth-bright-fox  # reattach by agent-id
```

### Extension-only iteration (during dev)

If you want to load the extension against a one-off home without registering
anything globally:

```bash
AGENT_HOME=~/.my-agent pi -e ./extensions/kiln-lite/index.ts
```

`AGENT_HOME` is the escape-hatch override — kl honors it, bypassing the
`~/.kl/agents/<name>` lookup.

## Launching with `kl`

`kl` (ships as `bin/kl`, linked via the `bin` entry in `package.json`) is
the normal way to start a session. It wraps pi in a tmux session, generates
an agent-id up front, and names the tmux session after it — so every live
session has a stable name you can attach back to.

```bash
kl                          # spawn the default starter agent (and attach)
kl beth                     # spawn the 'beth' agent (~/.kl/agents/beth)
kl run [name] [pi-args...]  # same, with arg passthrough to pi
kl attach beth-bright-fox   # attach an existing session
kl list                     # list kl-shaped tmux sessions
kl agents                   # list installed agents on disk
kl history [name]           # session history across all (or one) agent
kl doctor [name]            # system + per-agent diagnostic
```

What `kl` does at launch:

1. Resolves the agent home: positional name (`kl beth` → `~/.kl/agents/beth`),
   else `$AGENT_HOME` override, else the default starter at `~/.kl/agents/agent`.
2. Reads `name:` from `agent.yml` and generates an agent-id via the same
   `<name>-<adj>-<noun>` scheme the extension uses.
3. Runs `tmux new-session -d -s <agent-id> pi -e <ext-path>`, exporting
   `AGENT_ID`, `AGENT_HOME`, and `_KL=1` into the session env.
4. `tmux attach-session` (or `switch-client` if already inside tmux).

The kiln-lite extension prefers `$AGENT_ID` from env over UUID-derivation,
so the tmux session name, the extension's agent-id, and the inbox directory
all agree from spawn time.

Raw `pi` launches still work — the extension falls back to deriving the
agent-id from Pi's session UUID when `$AGENT_ID` isn't set, so `/resume`
recovers the same id. You don't have to use `kl`; it's the ergonomic path
for multi-session / multi-agent workflows.

## Quick start

To scaffold manually (without running Pi):

```bash
./bootstrap.sh ~/.my-agent
# then edit ~/.my-agent/agent.yml — set `name`, wire context_injection, etc.
```

The resulting home looks like:

```
~/.my-agent/
├── agent.yml         # config (edit this)
├── memory/           # your memory files (Core/Volatile/sessions — your shape)
├── scratch/          # working notes
├── tools/            # your own shell tools (override bundled by shared name)
├── inbox/            # per-session inboxes live at inbox/<agent-id>/
├── sessions/         # session summaries (written by the cleanup turn)
├── skills/           # active skills — bundled ones copied here by bootstrap
└── venv/             # python venv with bundled-tool deps
```

For a more opinionated reference — a fully populated agent home with
custom identity, layered context injection, a real cleanup turn, and
project-memory scaffolding — see [`example/`](./example/). Drop the
whole thing into `$AGENT_HOME` or pick the pieces you want.

Re-running bootstrap flags (for explicit re-scaffolds):

| Flag                | Effect                                                     |
|---------------------|------------------------------------------------------------|
| *(none, target full)* | Refuses. Use one of the below.                           |
| `--force`           | Overwrite existing scaffolding (destructive)               |
| `--upgrade-deps`    | Only: upgrade Python deps in the existing venv             |
| `--rebuild-venv`    | Only: nuke and recreate the venv at the pinned version     |
| `--refresh-skills`  | Only: recopy `<repo>/skills/*` into `$AGENT_HOME/skills/`  |
| `--refresh-tools`   | Only: recopy `<repo>/tools/*` into `$AGENT_HOME/tools/`    |

## Uninstall

```bash
npm unlink -g kiln-lite           # remove the kl global link
rm -rf ~/.kl                       # agent homes + daemon state (your call)
```

Agent homes live under `~/.kl/agents/`; daemon state under `~/.kl/daemon/`.
Remove individually if you want to keep one while dropping the other.

Skills and tools are a single source of truth: `$AGENT_HOME/skills/` and
`$AGENT_HOME/tools/`. The extension registers the skills dir via Pi's
`resources_discover` event and scans the tools dir at `session_start` to
render the tool index into the system prompt. Tools are plain scripts,
invoked by the agent via Pi's built-in `bash` tool — not registered as pi
tools. Any `SKILL.md` or executable script you drop in is picked up on next
session or `/reload`. kiln-lite's bundled skills (currently just `messaging`)
and tools (`explore`, `fetch`, `seek`, `todo`, `web-search`) are installed by
`bootstrap.sh` — you can edit them freely after install; re-running with
`--refresh-skills` or `--refresh-tools` overwrites.

## Layout

```
kiln-lite/
├── bin/
│   └── kl               # Session launcher — tmux wrap + agent-id + exec pi
├── extensions/kiln-lite/
│   ├── index.ts             # Entry + lifecycle wiring
│   ├── config.ts            # agent.yml loader + defaults
│   ├── identity.ts          # Deterministic agent ID from session UUID
│   ├── env.ts               # Env var export (hoisted to process.env)
│   ├── prompt.ts            # System prompt composition
│   ├── tools.ts             # YAML-header tool discovery + tool-index rendering
│   ├── inbox.ts             # fs.watch, idle delivery, mid-turn pings
│   ├── cleanup.ts           # /exit /fq dispatch
│   ├── exit-session.ts      # Exit logic — cleanup, continuation, shutdown
│   ├── exit-session-tool.ts # exit_session tool (autonomous exit + self-continuation)
│   ├── plan.ts              # Plan state persistence + reminder logic
│   ├── plan-tool.ts         # plan tool registration + periodic reminders
│   ├── message-tool.ts      # message tool registration
│   ├── session-state.ts     # SessionState type + shared state
│   ├── spawn.ts             # Peer/continuation session spawning
│   ├── template.ts          # Template resolution
│   ├── types.ts             # Shared interfaces
│   └── lib/                 # Internal helpers
├── skills/messaging/
│   ├── SKILL.md         # Documents message + sessions scripts
│   └── scripts/
│       ├── message      # send, read, list, clear, stats
│       └── sessions     # peer discovery (active agents, uuid resolve)
└── tools/               # Bundled shell scripts (copied to $AGENT_HOME/tools/)
    ├── fetch            # Web page fetcher (trafilatura + Chrome fallback)
    ├── web-search       # Tavily/Exa backends
    ├── seek             # Fast file search (fd-or-find wrapper)
    ├── explore          # Haiku subagent for code exploration
    └── todo             # Task tracker with project boards
```

## Runtime dependencies

- **Node** ≥ 20 (Pi's requirement)
- **[uv](https://docs.astral.sh/uv/)** — used for Python version management and
  package install. If `uv` isn't on `PATH` when you run `bootstrap.sh`, the
  script offers to install it via the official installer
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`). Set `AUTO_INSTALL_UV=1`
  to skip the prompt and install silently (useful in CI), or install uv
  yourself ahead of time. Bootstrap then calls
  `uv venv --python $(cat .python-version)` to create `$AGENT_HOME/venv/` at
  the pinned Python version (uv auto-downloads the interpreter if needed),
  then `uv pip install -r requirements.txt` (`PyYAML` for `todo`, `trafilatura`
  for `fetch`; `web-search` is stdlib-only). The extension prepends `venv/bin`
  to `PATH` at `session_start` so tools with `#!/usr/bin/env python3` resolve
  to the venv.
- **Python version** — pinned via `.python-version` at the repo root (currently
  `3.12`). Edit that file to change it; re-run `./bootstrap.sh <home> --rebuild-venv`
  to apply.
- **Optional**: `fd` (faster `seek`), headless Chrome/Chromium (JS fallback in
  `fetch` — set `$CHROME` to override path), `claude` CLI (for `explore`)
- **API keys** (for `web-search`): `TAVILY_API_KEY` or `EXA_API_KEY`, read from
  environment or `$AGENT_HOME/credentials/`

## Commands

Slash commands added by the extension:

| Command   | Effect                                                            |
|-----------|-------------------------------------------------------------------|
| `/exit`   | Run cleanup prompt → shutdown                                     |
| `/fq`     | Force quit — skip cleanup, immediate shutdown                     |

Note: `/quit`, Ctrl+D, and double Ctrl+C bypass the cleanup flow — pi's
interactive mode intercepts them before extension dispatch. Use `/exit` when
you want cleanup to run.

## Exported environment

Available to every child process (startup commands, tools, Pi's `bash`, etc):

| Var             | Value                                   |
|-----------------|-----------------------------------------|
| `AGENT_HOME`    | Resolved agent home                     |
| `AGENT_ID`      | `<name>-<adj>-<noun>` for this session  |
| `AGENT_NAME`    | Name prefix (from `agent.yml`)          |
| `SESSION_UUID`  | Pi session UUID                         |
| `INBOX`         | `$AGENT_HOME/inbox/$AGENT_ID/`          |

## Status

v1, pre-release. Not published to npm. Iterate in-place for now.
