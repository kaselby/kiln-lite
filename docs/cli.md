# CLI: `kl` and `kl-msg`

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
kl sessions [-n N] [--all]
kl inbox <session>
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
  running ones.
- **inbox** shows a session's inbox directory and messages; `new` = unread.
- **agents** lists installed agents with their session count and description.
- **init** scaffolds an agent; see [agents.md](agents.md).
- **doctor** checks node, pi, tmux, kl-msg, the daemon and each agent folder.

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

## `kl-msg`

The messaging CLI. Inside a session (where `SESSION_UUID` and `AGENT_ID` are
set) it sends as that session; agents normally use the `message` tool
instead. From your own shell, with no `SESSION_UUID`, `send` and `publish`
go out as you (`from: $USER`) and the recipient gets no agent-mail
disclaimer. `subscribe`, `unsubscribe`, `list-subscriptions` and
`deliver-self` need a session.

```
kl-msg send <to> <summary> [--body <text> | --body-stdin] [--priority normal|high]
kl-msg publish <channel> <summary> [--body <text> | --body-stdin] [--priority ...]
kl-msg subscribe <channel>
kl-msg unsubscribe <channel>
kl-msg list-subscriptions
kl-msg status
```

`kl-msg deliver-self` (used by scheduled wakes) and `list-sessions` also
exist. For finding sessions, use `kl sessions`.
