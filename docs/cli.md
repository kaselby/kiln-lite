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

An agent name alone (`scout`) is not a session.

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

<!-- TODO(merge): kl install -->
<!-- TODO(merge): kl migrate -->

Env:

| var | meaning |
|---|---|
| `KL_ROOT` | kl root (default `~/.kl`) |
| `KL_AGENTS_DIR` | where agents live (default `~/.kl/agents`) |
| `AGENT_HOME` | agent folder for `kl run` with no `<agent>` |
| `KL_PI` | pi binary (default: the repo's `node_modules/.bin/pi`, else `pi` on PATH) |
| `KL_TMUX_SOCKET` | run every tmux call as `tmux -L <socket>` (for isolated test runs) |

## `kl-msg`

The messaging CLI, for shell scripts running inside a session. It needs the
session's `SESSION_UUID` and `AGENT_ID`. Agents normally use the `message`
tool instead.

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
