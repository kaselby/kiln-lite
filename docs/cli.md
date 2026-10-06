# CLI: `kl`

`kl --help` prints the same summary.

## Sessions and names

A session is a Pi session UUID plus a name, `<agent>-<adj>-<noun>`. A new
name is unique among running sessions and avoids names used in the last
three weeks. A resumed session keeps its name unless another running session
holds it, in which case it gets a fresh name for that run.

Anything that takes a `<session>` accepts:

- `scout-bright-raven`: the running session with that name, else the one that
  used it most recently. If others were skipped, kl says so.
- `scout-bright-raven@01a10db1`: a specific session, by UUID prefix (at least
  4 hex characters).
- `@01a10db1`: by UUID prefix alone.

- `scout` (an agent name): that agent's running session if exactly one is
  running, else its most recently used session; kl says which it picked. If
  several are running, it's an error that lists them.

## `kl`

```
kl run [<agent>] [-d|--detach] [--prompt-file F] [--parent S] [--wake park|auto] [pi args...]
kl [pi args...]               same as kl run with the default agent
kl resume <session> [-d] [pi args...]
kl attach <session> [-d]
kl sessions [-n N] [--all] [--json]
kl sessions <session> [--json]
kl message <command>          see below
kl agents
kl init <name> [--full]       (kl new is an alias)
kl doctor [<name>]
kl install <pkg> [pi install flags]
kl migrate [--dry-run] [<agent-home>...]
```

- **run** starts a new session of `<agent>` in a tmux session named after it
  and attaches. With no `<agent>`: `$AGENT_HOME`, else the agent called
  `agent`. A bare word that isn't an installed agent is an error, not a
  prompt. `-d` doesn't attach and prints the name on stdout
  (`name=$(kl run reviewer -d --prompt-file brief.md)`). `--parent` records
  the launching session (stored as a UUID), so `kl sessions` shows the tree.
  `--wake auto` is recorded in the registry, but nothing acts on it yet.
  Other arguments go to `pi`.
- **resume** and **attach** are the same: resolve the session, start it again
  from its transcript if nothing is running, then attach (`-d`: print the
  name instead). Mail that arrived while it was down is delivered on start.
- **sessions** shows recent sessions as parent/child trees; `*` marks
  running ones. DOING is the session's plan goal and progress (`2/5`), or
  the summary from its status file (below). `kl sessions <session>` shows
  one session in full: state, parent and children, cwd, home, transcript,
  inbox counts, status, and the plan with every task. `--json` prints the
  same as JSON. The `sessions` tool shows the same thing to agents.
- Inside a kl session (where `SESSION_UUID` is set, which includes anything
  an agent runs from its bash tool) **run**, **resume**, **attach** and a
  bare `kl` never attach: they act as `-d` and say so on stderr. Attaching
  would take over the agent's own terminal. Your own shell has no
  `SESSION_UUID`, so attaching from it works as usual.
- **inbox** shows a session's inbox directory and messages; `new` = unread.
- **agents** lists installed agents with their session count and description.
- **init** scaffolds an agent; see [agents.md](agents.md).
- **doctor** checks node, the pi kl runs, tmux, the daemon, the kl
  Pi dir (is `auth.json` the link to your Pi login? which packages are
  installed?) and each agent folder.

- **install** runs `pi install` with `PI_CODING_AGENT_DIR` set to the kl Pi
  dir (`~/.kl/pi`), so the package loads for every kl agent and base `pi`
  doesn't see it.
- **migrate** converts old agent folders in place (default: every agent in
  `$KL_AGENTS_DIR`), keeping `agent.yml.bak`. It prints what each key became;
  `--dry-run` only prints. See [install.md](install.md#upgrading).

Env:

| var | meaning |
|---|---|
| `KL_ROOT` | kl root (default `~/.kl`) |
| `KL_AGENTS_DIR` | where agents live (default `~/.kl/agents`) |
| `AGENT_HOME` | agent folder for `kl run` with no `<agent>` |
| `KL_PI` | pi binary (default: the repo's `node_modules/.bin/pi`, else `pi` on PATH) |
| `KL_TMUX_SOCKET` | run every tmux call as `tmux -L <socket>` (for isolated test runs) |

## `kl message`

Messaging from a shell, and the surface a UI can build on. Inside a session
(where `SESSION_UUID` and `AGENT_ID` are set) it acts as that session;
agents normally use the `message` tool, which calls the same code. From your
own shell, with no `SESSION_UUID`, you act as yourself (`from: $USER`) and
the recipient gets no agent-mail disclaimer; `subscribe` and `unsubscribe`
need a session.

```
kl message send <session|#channel> <summary> [--body <text> | --body-stdin] [--priority normal|high]
kl message subscribe <channel>
kl message unsubscribe <channel>
kl message channels [--json]
kl message history <session|#channel> [-n N] [--follow] [--json]
kl message status [--json]
```

- **send**: a DM to a session (any `<session>` form above), or `#channel`
  to everyone subscribed to it.
- **channels**: every channel that exists (has a subscriber or any
  history), with subscriber names, subscriber count, message count and the
  time of the last message. `*` marks the ones this session subscribes to.
- **history**: oldest first, the last `N` (default 20; `-n 0` = all).
  `#channel` reads the channel's history
  (`~/.kl/daemon/channels/<name>/history.jsonl`). A session reads the mail
  in its inbox (`~/.kl/run/inbox/<uuid>/`): what it received, DMs and
  channel copies, with `new` on what it hasn't been given yet. What a
  session sent is in the recipients' inboxes, not its own. `--follow` (`-f`)
  keeps printing new messages until interrupted.
- **status**: the daemon's pid, socket, session and channel counts.
- **--json**: `channels` prints an array, `status` an object, and
  `history` one JSON object per message per line (JSON Lines), so
  `--follow --json` streams the same shape. A message has `id`, `ts`,
  `from`, `from_session` (the sender's UUID, when the sender is a kl
  session), `to` and `read` (inbox mail), `channel`, `summary`, `body`,
  `priority`, `path` (inbox mail). Names, never UUIDs, in `from`, `to` and
  subscriber lists.

## Status files

A session can have an optional status file at
`~/.kl/run/status/<session uuid>.json` (`<kl root>/run/status/`). It is a
hook for tools outside kl, e.g. a memory tool saying which thread a session
is working on. kl never writes or deletes it; it only reads it in
`kl sessions` and the `sessions` tool. With no such tool installed, there
are no status files and everything comes from the plan.

```json
{ "summary": "fixing the login bug", "detail": "any text, any length", "updated_at": "2026-10-06T15:00:00Z" }
```

- `summary` (string, required): one line. It replaces the plan goal as the
  session's DOING in the list. Only its first line is shown, cut to 60
  characters.
- `detail` (string, optional): shown in the full view, above the plan.
- `updated_at` (ISO time, optional): shown next to the status.
- A file that isn't JSON or has no string `summary` is ignored.
- Write it atomically (write a temp file, then rename), keyed by the
  session's UUID (`$SESSION_UUID` inside the session).
- The writer owns it and should delete it when it no longer applies. A file
  left behind after the session ends is harmless: the session shows as not
  running. kl doesn't remove it, just as it keeps plans, since a session
  can be resumed.
