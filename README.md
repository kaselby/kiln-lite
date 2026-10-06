# kiln-lite

**kiln-lite (`kl`) runs [Pi](https://github.com/earendil-works/pi) sessions as named agents that can message each other.**

kl is a Pi extension plus a launcher. It doesn't replace anything Pi does. It adds:

- **Agents.** An agent is a folder (`~/.kl/agents/<name>/`) with an
  `agent.yml` and an `IDENTITY.md`. kl builds the system prompt from it and
  passes the agent's own Pi extensions and skills to Pi.
- **Names.** Every session gets a name like `scout-bright-raven`. You can
  attach to it, resume it, or send it mail by that name, even while it isn't
  running.
- **Messaging.** Sessions send each other direct messages and channel
  broadcasts through a small daemon. Every inbox is a plain directory of
  markdown files.
- **Subagents, wakes, resets.** Built-in tools let a session start a child
  agent, schedule a wake for itself, and reset its own context to continue in
  the same session.

Requires Pi 1.0.3 or newer, Node 20+, and tmux.

## Install

```bash
git clone <this repo> ~/Git/kiln-lite && cd ~/Git/kiln-lite
./install.sh          # npm install, npm link (puts kl on PATH), starter agent
```

`kl install <pkg>` installs a Pi package for every kl agent (into the kl Pi
dir, not base Pi). `kl migrate` converts agent folders from an older
kiln-lite layout.

kl logs in with your Pi credentials: `~/.kl/pi/auth.json` is a symlink to
`~/.pi/agent/auth.json`. Log in once with base `pi` (`/login`) first. Details
are in [docs/install.md](docs/install.md).

## First agent

```bash
kl init scout              # agent.yml + IDENTITY.md
kl init scout --full       # also memory/, a cleanup prompt, extensions/, skills/, git
$EDITOR ~/.kl/agents/scout/IDENTITY.md
kl run scout               # starts scout-<adj>-<noun> in tmux and attaches
```

Inside the session, `/exit` runs the agent's cleanup turn (if it has one) and
quits. `/fq` quits immediately.

## Day to day

```bash
kl sessions              # recent sessions as parent/child trees; * = running
kl resume scout-bright-raven   # start it again in the background
kl attach scout-bright-raven   # look at it (asks before resuming a stopped one)
kl run reviewer -d --prompt-file brief.md   # detached; prints the new name
kl message history scout-bright-raven   # a session's mail; "new" = unread
kl agents                # installed agents
kl doctor                # diagnostics
```

## Docs

- [docs/agents.md](docs/agents.md): what an agent and a session are, the
  agent folder, `kl init`, `agent.yml`, hooks
- [docs/harness.md](docs/harness.md): how the system prompt is built,
  timestamps, which extensions load
- [docs/sessions.md](docs/sessions.md): names, starting and resuming,
  subagents, exiting and resets, plans and status files
- [docs/messaging.md](docs/messaging.md): sending and delivery, parked mail,
  channels, message files, the daemon
- [docs/cli.md](docs/cli.md): every `kl` and `kl message` command and flag,
  name resolution, env vars
- [docs/tools.md](docs/tools.md): the built-in tools and slash commands, and
  adding your own
- [docs/config.md](docs/config.md): the `~/.kl` layout and global `config.yml`
- [docs/install.md](docs/install.md): install.sh, `kl install`, `kl migrate`,
  uninstall
- [docs/skills.md](docs/skills.md): skills
- [docs/tmux.md](docs/tmux.md): recommended tmux settings

## Uninstall

```bash
npm unlink -g kiln-lite
mv ~/.kl ~/.kl.bak       # agents, sessions, inboxes, daemon state
```

## License

See [LICENSE](LICENSE).
