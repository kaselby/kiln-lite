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

One-step (recommended): install the extension and let it auto-scaffold
your agent home on first launch.

```bash
# Local path install (during dev, or once you've cloned the repo)
cd /path/to/kiln-lite
npm install
pi install .

# First launch with AGENT_HOME set triggers auto-scaffold
AGENT_HOME=~/.my-agent pi
```

Or from git (once pushed):

```bash
pi install git:github.com/<your-handle>/kiln-lite
AGENT_HOME=~/.my-agent pi
```

The first launch notices `$AGENT_HOME/agent.yml` is missing and invokes
`bootstrap.sh` automatically — creating the standard layout, copying
bundled skills, and building a Python venv. Subsequent launches see the
scaffold and skip straight to session start.

If `AGENT_HOME` is unset, the extension falls back to built-in defaults
and does **not** auto-scaffold (we don't want to silently create
`~/.agent/`). To opt into auto-scaffold, set `AGENT_HOME` explicitly.

One-shot for extension-only iteration:

```bash
pi -e ./extensions/kiln-lite/index.ts
```

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
├── sessions/         # session id files + cleanup summaries
├── skills/           # active skills — bundled ones copied here by bootstrap
└── venv/             # python venv with bundled-tool deps
```

Re-running bootstrap flags (for explicit re-scaffolds):

| Flag                | Effect                                                     |
|---------------------|------------------------------------------------------------|
| *(none, target full)* | Refuses. Use one of the below.                           |
| `--force`           | Overwrite existing scaffolding (destructive)               |
| `--upgrade-deps`    | Only: refresh Python deps in the venv                      |
| `--refresh-skills`  | Only: recopy `<repo>/skills/*` into `$AGENT_HOME/skills/`  |

## Uninstall

```bash
pi remove <same-source-string>    # e.g. 'pi remove .' or 'pi remove git:...'
rm -rf ~/.my-agent                 # agent home is separate — Pi doesn't touch it
```

Skills are a single source of truth: `$AGENT_HOME/skills/`. The extension
registers it via Pi's `resources_discover` event, so any `SKILL.md` you drop
in there is picked up on next session or `/reload`. kiln-lite's bundled skills
(currently just `messaging`) are installed by `bootstrap.sh` — you can edit
them freely after install; re-running with `--refresh-skills` overwrites.

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
- **Python 3** — bootstrap creates a venv at `$AGENT_HOME/venv/` and installs
  from `requirements.txt` (`PyYAML` for `todo`, `trafilatura` for `fetch`;
  `web-search` is stdlib-only). The extension prepends `venv/bin` to `PATH`
  at `session_start` so tools with `#!/usr/bin/env python3` resolve to the venv.
- **Optional**: `fd` (faster `seek`), headless Chrome/Chromium (JS fallback in
  `fetch` — set `$CHROME` to override path), `claude` CLI (for `explore`)
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
