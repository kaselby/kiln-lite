# kiln-lite

A Pi package that brings Kiln/Beth-style infrastructure to Pi sessions. Designed for
use on machines where the full Kiln runtime isn't appropriate — e.g. a work laptop
that can't run arbitrary Python daemons but still benefits from persistent identity,
dynamic prompt assembly, and inter-session messaging.

## What it gives you

- **Config-driven lifecycle.** One `agent.yml` in `$AGENT_HOME` controls system
  prompt composition, context injection, startup commands, and the cleanup turn.
- **Stable session identity.** Every Pi session gets a deterministic agent ID
  (`<name>-<adj>-<noun>`, seeded from the session UUID) that survives `/resume`.
- **Dynamic system prompt.** `context_injection` entries are labelled and composed
  into the prompt per turn. Entries marked `dynamic: true` are re-read every turn.
- **Shell tool conventions.** Scripts in `$AGENT_HOME/tools/` (and bundled in the
  package's `tools/`) are auto-discovered via YAML headers and registered as Pi
  tools with a single `args: string` parameter.
- **File-based messaging.** Each session has an inbox at
  `$AGENT_HOME/inbox/<agent-id>/`. Peers drop markdown files in; the extension
  watches for new arrivals and delivers them as user turns (if idle) or as
  `[INBOX: N unread]` suffixes on the next tool result (if mid-work).
- **Cleanup flow.** `/wrapup` (and aliased `/exit`, `/quit`) runs the configured
  cleanup prompt as a follow-up turn before shutdown. `/fq` force-exits without
  cleanup. Escape hatch: a second exit command during cleanup force-exits.

## What it isn't

v1 is intentionally small. Out of scope for now:

- Daemon-based channels (`message subscribe` is stubbed)
- Cross-machine messaging
- Recall-style session search
- Gateway bridging (Discord, Slack, etc.)
- Tree-branched summary semantics
- Typed parameter schemas for shell tools (everything takes `args: string`)

Memory architecture is also out of scope — `agent.yml:context_injection` names
files, you decide what's in them.

## Install

From source while iterating:

```bash
cd /path/to/kiln-lite
npm install
pi -e ./extensions/kiln-lite/index.ts     # load extension for this pi run only
```

From git (once pushed):

```bash
pi install git:github.com/<your-handle>/kiln-lite
```

## Quick start

1. Set `$AGENT_HOME` (or use the default `~/.agent/`)
2. Drop an `agent.yml` there:

```yaml
name: pi
system_prompt: system.md

context_injection:
  - path: memory/core.md
    label: Core Memory
  - path: memory/volatile.md
    label: Volatile
    dynamic: true

startup:
  - "echo 'kiln-lite online'"

cleanup: |
  [Session ending]
  Write a session summary to {summary_path}. Cover what you worked on,
  key decisions, anything left unfinished.
```

3. Run `pi` — the extension loads, assigns you an agent ID, exports env vars
   (`$AGENT_HOME`, `$AGENT_ID`, `$INBOX`, etc), and hooks the lifecycle.

## Layout

```
kiln-lite/
├── extensions/kiln-lite/
│   ├── index.ts         # Entry + lifecycle wiring
│   ├── config.ts        # agent.yml loader + defaults
│   ├── identity.ts      # Deterministic agent ID from session UUID
│   ├── env.ts           # Env var export (hoisted to process.env)
│   ├── prompt.ts        # System prompt composition
│   ├── tools.ts         # YAML-header tool discovery + pi.registerTool
│   ├── inbox.ts         # fs.watch, idle delivery, mid-turn pings
│   ├── cleanup.ts       # /wrapup /exit /quit /fq + agent_end dispatch
│   └── types.ts         # Shared interfaces
├── skills/messaging/
│   ├── SKILL.md         # Documents message + sessions scripts
│   └── scripts/
│       ├── message      # send, read, list, clear, stats
│       └── sessions     # peer discovery (active agents, uuid resolve)
└── tools/               # Bundled shell tools (auto-registered)
    ├── fetch            # Web page fetcher (trafilatura + Chrome fallback)
    ├── web-search       # Tavily/Exa backends
    ├── seek             # Fast file search (fd-or-find wrapper)
    ├── explore          # Haiku subagent for code exploration
    └── todo             # Task tracker with project boards
```

## Runtime dependencies

- **Node** ≥ 20 (Pi's requirement)
- **Python 3** — for `fetch`, `web-search`, `todo` (+ `PyYAML` for `todo`,
  `requests` for `web-search`)
- **Optional**: `fd` (faster `seek`), headless Chrome (JS fallback in `fetch`),
  `claude` CLI (for `explore`)
- **API keys** (for `web-search`): `TAVILY_API_KEY` or `EXA_API_KEY`, read from
  environment or `$AGENT_HOME/credentials/`

## Commands

Slash commands added by the extension:

| Command   | Effect                                                            |
|-----------|-------------------------------------------------------------------|
| `/wrapup` | Run cleanup prompt → shutdown                                     |
| `/exit`   | Alias for `/wrapup` (overrides Pi's builtin)                      |
| `/quit`   | Alias for `/wrapup` (overrides Pi's builtin)                      |
| `/fq`     | Force quit — skip cleanup, immediate shutdown                     |

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
