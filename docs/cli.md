# CLI: `kl`

Every `kl` subcommand and flag, how session names resolve, and the
environment variables kl reads and sets. `kl --help` and `kl message
--help` print shorter summaries. How sessions live and end is in
[sessions.md](sessions.md), and how messages travel is in
[messaging.md](messaging.md). `<kl root>` is `$KL_ROOT`, else `~/.kl`.

## Session names

A session is a Pi session UUID with a name, `<agent>-<adj>-<noun>`. A new
name is unique among running sessions. Anything below that takes a
`<session>` accepts these forms, tried in this order:

1. `scout-bright-raven`: the running session with that name.
2. Otherwise the session that used that name most recently. If others used
   it too, kl says so and how to reach them.
3. `scout-bright-raven@01a10db1` or `@01a10db1`: the session whose UUID
   starts with that prefix (dashes ignored, at least 4 characters). With a
   name, it must also have run under that name. A prefix that matches more
   than one session is an error.
4. `scout` (an agent name): that agent's running session if exactly one is
   running, else its most recently used session. kl says which it picked.
   If several are running, it's an error that lists them.

An unknown name is an error. Notes about what kl picked go to stderr.

## Commands

```
kl run [<agent>] [-d|--detach] [--prompt-file F] [--parent S] [pi args...]
kl [-d] [pi args...]
kl resume <session>
kl attach <session> [-d]
kl sessions [-n N] [--all] [--json]
kl sessions <session> [--json]
kl config [<session>] [key=value | key= ...]
kl message <command> ...
kl agents
kl init <name> [--full]
kl doctor [<name>]
kl install <pkg> [pi install flags]
kl -h | --help | help
```

Any other first word is an error, not a prompt or an agent name.

**run** starts a new session of `<agent>` (`$KL_AGENTS_DIR/<agent>`) in its
own tmux session and attaches to it.

- `<agent>` must be the first argument; a word in that spot that matches
  `[a-z][a-z0-9_]*` is always taken as an agent name and is an error if no
  such agent exists. An agent is a folder with an `agent.yml`; a folder
  without one is an error. With no `<agent>`: the default agent,
  `$KL_DEFAULT_AGENT`, else `default_agent` in `config.yml`, else `worker`
  (which `install.sh` creates). If it isn't installed, kl says so and
  points at `kl init <name>`. `$AGENT_HOME` plays no part, so a bare
  `kl run` from inside a session doesn't start another of the same agent.
- `-d`, `--detach`: don't attach; print the new name on stdout
  (`name=$(kl run reviewer -d --prompt-file brief.md)`).
- `--prompt-file F`: the first message, read from a file and passed to Pi
  as its last argument, so it never goes through a shell.
- `--parent S`: the session that launched this one (any `<session>` form,
  or a full UUID). Stored as a UUID; `kl sessions` shows the tree.
- Everything else, and everything after `--`, goes to `pi`.

Bare `kl`, or `kl` followed by a flag, is `kl run` with the default agent.

**resume** starts a stopped session again from its transcript, in the
background, exactly as it was (same name, unless another running session
holds it), and prints its name. It never attaches and takes no pi
arguments. Mail that arrived while it was down is delivered when it starts.

**attach** attaches to a running session. For a stopped one it asks
`<name> isn't running. Resume it? [y/N]`; without a terminal to ask in
(including inside a kl session) it's an error that points to `kl resume`.

**Inside a kl session** (`SESSION_UUID` set, which includes anything an
agent runs from its bash tool), `run`, `attach` and bare `kl`
always act as `-d` and say so on stderr, because attaching would take over
the agent's own terminal.

**sessions** lists recent sessions as parent/child trees, newest first,
with `*` on running ones:

- Columns: NAME (with `(you)` on the asking session), STATE (`busy`,
  `idle`, or `-`), LAST SEEN (transcript mtime), ID (the shortest unique
  UUID prefix, at least 8 characters), DOING, CWD.
- DOING is the session's plan goal with progress (`2/5`), or a status
  file's summary (below), cut to 60 characters.
- `-n N`: show N trees (default 20).
- `--all`: every tree, including sessions that never exchanged a message,
  which are otherwise hidden unless running.
- `kl sessions <session>`: one session in full: state, last seen and
  created, parent and children, cwd, home, transcript, inbox counts, UUID,
  every name it has run under, its status, and its plan with every task.
- `--json`: the same data as JSON.

**config** shows or changes one session's runtime settings
(`timestamps`, `session_state_interval`), kept in `run/<uuid>/config.yml`
([config.md](config.md#per-session-settings)). The session picks up a
change at its next turn or tool result.

- With no `key=...`: each effective value and where it comes from
  (`session`, `agent.yml`, `config.yml` or `default`), then the files.
- `key=value` sets; the value is YAML (`timestamps=false`,
  `session_state_interval=5`). `timestamps.per_turn`,
  `timestamps.every_calls` and `timestamps.every_minutes` set one timestamp
  field (over `timestamps: true/false` in the file, they replace it with a
  mapping, which turns timestamps on).
- `key=` unsets. A file left empty is removed.
- An invalid value or unknown key is an error and nothing is written.
- Inside a kl session `<session>` may be left out: it means this session.

**message**: see [`kl message`](#kl-message) below.

**agents** lists the agents under `$KL_AGENTS_DIR` (folders with an
`agent.yml`), each with its number of sessions and its description.

**init** (alias **new**) creates `$KL_AGENTS_DIR/<name>` with `agent.yml`
and `IDENTITY.md`. `--full` adds `memory/`, `scratch/`, `extensions/`,
`skills/`, `prompts/`, a cleanup prompt and a memory section, and runs
`git init`. Names match `[a-z][a-z0-9_]*`. See [agents.md](agents.md).

**doctor** checks paths, the kl Pi dir (is `auth.json` a link to your Pi
login? is kiln-lite wrongly installed there as a package?), node, pi, tmux,
the daemon, and each agent folder (or just `<name>`'s). It exits non-zero
if any check fails.

**install** runs `pi install` with `PI_CODING_AGENT_DIR` set to the kl Pi
dir (`<kl root>/pi`), so the package loads for every kl agent and base `pi`
doesn't see it.

## `kl message`

Send and read messages from a shell. Inside a session it acts as that
session. From your own shell it acts as the user; see
[messaging.md](messaging.md#sending-from-your-shell).

```
kl message send <session|#channel> <summary...> [--body <text> | --body-stdin] [--wake]
kl message subscribe <channel>
kl message unsubscribe <channel>
kl message channels [--json]
kl message history <session|#channel> [-n N] [-f|--follow] [--json]
kl message status [--json]
```

- **send**: a DM to `<session>` (any form above), or a broadcast to
  `#channel`. The words after the target are the summary. The body is
  `--body`, or stdin with `--body-stdin`, else empty. Prints the daemon's
  reply (`sent to …`, `parked: …`, or `sent to #c (N recipients)`).
  `--wake` starts a session that isn't running so it reads the message
  now; see [messaging.md](messaging.md#sending). It exits 1 if the message
  was parked but the wake failed, and is an error with a `#channel`.
- **subscribe**, **unsubscribe**: this session joins or leaves a channel
  (`#` optional). They need a session. A subscription lasts until
  `unsubscribe`, across exits and resumes.
- **channels**: every channel, with subscriber count, message count, time of
  the last message, and subscriber names. `*` marks the ones this session
  subscribes to.
- **history**: oldest first, the last `N` messages (default 20, `0` = all).
  `#channel` reads the channel's history. A session reads the mail in its
  inbox, DMs and channel copies, with `new` on what it hasn't been given
  yet. What a session sent is in the recipients' inboxes, not its own.
  `--follow` keeps printing new messages until interrupted.
- **status**: whether the daemon is running and, if so, its pid, socket,
  uptime, and its counts of running sessions and channels. It never starts
  the daemon.
- **--json**: `channels` prints an array and `status` an object. `history`
  prints one object per line (also with `--follow`), with `id`, `ts`,
  `from`, `from_session` (when the sender is a kl session), `to`, `read`
  and `path` (inbox mail), `channel`, `summary`, `body`.

Channel names are letters, digits, `.`, `_` and `-`, starting with a
letter or digit, up to 128 characters. Usage errors exit with 2, other
failures with 1.

## Status files

An extension can override what `kl sessions` shows as DOING by writing
`<kl root>/run/<session uuid>/status.json`. The format is in
[sessions.md](sessions.md#status-files).

## Environment

kl reads:

| var | meaning |
|---|---|
| `KL_ROOT` | kl root (default `~/.kl`) |
| `KL_AGENTS_DIR` | where agents live (default `<kl root>/agents`) |
| `KL_DEFAULT_AGENT` | the agent for `kl`/`kl run` with no `<agent>` and the `subagent` tool with no `agent` (overrides `default_agent` in config.yml; default `worker`) |
| `KL_PI` | pi binary (default: the repo's `node_modules/.bin/pi`, else `pi` on PATH) |
| `KL_USER` | your name on messages sent from your shell |
| `KL_TMUX_SOCKET` | run every tmux call as `tmux -L <socket>`, for isolated test runs |
| `SESSION_UUID` | set means "inside a kl session" (see above) |

Inside a session, kl sets these for the agent and everything it runs:

| var | value |
|---|---|
| `SESSION_UUID` | the session's UUID |
| `AGENT_ID` | the session's name |
| `AGENT_NAME` | the agent's name |
| `AGENT_HOME` | the agent's folder |
| `KL_INBOX` | the session's inbox directory |
| `PI_CODING_AGENT_DIR` | the kl Pi dir |

kl also passes `KL_ROOT` and `KL_TMUX_SOCKET` through
to the session, and sets `_KL`, `KL_NAME` and `KL_PARENT` for its own use
at startup.
