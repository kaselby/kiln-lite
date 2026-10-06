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
kl run [<agent>] [-d|--detach] [--prompt-file F] [--parent S] [--wake park|auto] [pi args...]
kl [-d] [pi args...]
kl resume <session> [-d] [pi args...]
kl attach <session> [-d]
kl sessions [-n N] [--all] [--json]
kl sessions <session> [--json]
kl message <command> ...
kl agents
kl init <name> [--full]
kl doctor [<name>]
kl install <pkg> [pi install flags]
kl migrate [--dry-run] [<agent-home>...]
kl -h | --help | help
```

Any other first word is an error, not a prompt or an agent name.

**run** starts a new session of `<agent>` (`$KL_AGENTS_DIR/<agent>`) in its
own tmux session and attaches to it.

- `<agent>` must be the first argument; a word in that spot that matches
  `[a-z][a-z0-9_]*` is always taken as an agent name and is an error if no
  such agent exists. With no `<agent>`: `$AGENT_HOME`, else the agent named
  `agent`.
- `-d`, `--detach`: don't attach; print the new name on stdout
  (`name=$(kl run reviewer -d --prompt-file brief.md)`).
- `--prompt-file F`: the first message, read from a file and passed to Pi
  as its last argument, so it never goes through a shell.
- `--parent S`: the session that launched this one (any `<session>` form,
  or a full UUID). Stored as a UUID; `kl sessions` shows the tree.
- `--wake park|auto`: recorded in the session's registry entry.
- Everything else, and everything after `--`, goes to `pi`.

Bare `kl`, or `kl` followed by a flag, is `kl run` with the default agent.

**resume** and **attach** do the same thing: resolve the session, start it
again from its transcript if it isn't running (same name, unless another
running session holds it), then attach. `-d` prints the name instead of
attaching. Mail that arrived while it was down is delivered when it starts.
`resume` passes extra arguments to `pi` when it starts the session, and
ignores them, with a note, if it's already running. `attach` takes none.
Put flags after `<session>`; the first argument that isn't `-d` is taken as
the session.

**Inside a kl session** (`SESSION_UUID` set, which includes anything an
agent runs from its bash tool), `run`, `resume`, `attach` and bare `kl`
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

**message**: see [`kl message`](#kl-message) below.

**agents** lists the agents under `$KL_AGENTS_DIR` (folders with an
`agent.yml`), each with its number of sessions and its description.

**init** (alias **new**) creates `$KL_AGENTS_DIR/<name>` with `agent.yml`
and `SYSTEM.md`. `--full` adds `memory/`, `scratch/`, `extensions/`,
`skills/`, `prompts/`, a cleanup prompt and a memory section, and runs
`git init`. Names match `[a-z][a-z0-9_]*`. See [agents.md](agents.md).

**doctor** checks paths, the kl Pi dir (is `auth.json` a link to your Pi
login? is kiln-lite wrongly installed there as a package?), node, pi, tmux,
the daemon, and each agent folder (or just `<name>`'s). It exits non-zero
if any check fails.

**install** runs `pi install` with `PI_CODING_AGENT_DIR` set to the kl Pi
dir (`<kl root>/pi`), so the package loads for every kl agent and base `pi`
doesn't see it.

**migrate** converts old agent folders in place (default: every agent in
`$KL_AGENTS_DIR`), keeping `agent.yml.bak`. `--dry-run` only prints. See
[install.md](install.md).

## `kl message`

Send and read messages from a shell. Inside a session it acts as that
session. From your own shell it acts as the user; see
[messaging.md](messaging.md#sending-from-your-shell).

```
kl message send <session|#channel> <summary...> [--body <text> | --body-stdin] [--priority normal|high]
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
- **subscribe**, **unsubscribe**: this session joins or leaves a channel
  (`#` optional). They need a session.
- **channels**: every channel, with subscriber count, message count, time of
  the last message, and subscriber names. `*` marks the ones this session
  subscribes to.
- **history**: oldest first, the last `N` messages (default 20, `0` = all).
  `#channel` reads the channel's history. A session reads the mail in its
  inbox, DMs and channel copies, with `new` on what it hasn't been given
  yet. What a session sent is in the recipients' inboxes, not its own.
  `--follow` keeps printing new messages until interrupted.
- **status**: the daemon's pid, socket, uptime, and its counts of running
  sessions and channels. It starts the daemon if it isn't running.
- **--json**: `channels` prints an array and `status` an object. `history`
  prints one object per line (also with `--follow`), with `id`, `ts`,
  `from`, `from_session` (when the sender is a kl session), `to`, `read`
  and `path` (inbox mail), `channel`, `summary`, `body`, `priority`.

Channel names can't contain `/` or start with `.`. Usage errors exit with
2, other failures with 1.

## Status files

`<kl root>/run/status/<session uuid>.json` is an optional hook for tools
outside kl, such as a memory tool saying which thread a session is on. kl
never writes or deletes it. `kl sessions` and the `sessions` tool read it.

```json
{ "summary": "fixing the login bug", "detail": "any text", "updated_at": "2026-10-06T15:00:00Z" }
```

- `summary` (string, required) replaces the plan goal as DOING. Only its
  first line shows in the list.
- `detail` (optional) and `updated_at` (optional) are shown in the full view.
- A file that isn't JSON, or has no string `summary`, is ignored.
- Write it atomically (temp file, then rename). The writer owns it and
  should delete it when it no longer applies.

## Environment

kl reads:

| var | meaning |
|---|---|
| `KL_ROOT` | kl root (default `~/.kl`) |
| `KL_AGENTS_DIR` | where agents live (default `~/.kl/agents`, even when `KL_ROOT` is set) |
| `AGENT_HOME` | agent folder for `kl run` with no `<agent>` |
| `KL_PI` | pi binary (default: the repo's `node_modules/.bin/pi`, else `pi` on PATH) |
| `KL_USER` | your name on messages sent from your shell |
| `KL_TMUX_SOCKET` | run every tmux call as `tmux -L <socket>`, for isolated test runs |
| `XDG_RUNTIME_DIR` | where the daemon's socket goes |
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

kl also passes `KL_ROOT` and `KL_TMUX_SOCKET` through to the session, and
sets `_KL`, `KL_NAME`, `KL_PARENT` and `KL_WAKE` for its own use at
startup.
