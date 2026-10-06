# kiln-lite

**kiln-lite (`kl`) runs [Pi](https://github.com/earendil-works/pi) sessions as named agents that can message each other.**

kl is a Pi extension plus a launcher. It doesn't replace anything Pi does. It adds:

- **Agents.** An agent is a folder (`~/.kl/agents/<name>/`) with an
  `agent.yml` and a `SYSTEM.md`. kl builds the system prompt from it and
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
dir, not base Pi). Coming from an older kiln-lite, run `kl migrate` once to
convert your agent folders.

kl logs in with your Pi credentials: `~/.kl/pi/auth.json` is a symlink to
`~/.pi/agent/auth.json`. Log in once with base `pi` (`/login`) first. Details
are in [docs/install.md](docs/install.md).

## First agent

```bash
kl init scout              # agent.yml + SYSTEM.md
kl init scout --full       # also memory/, a cleanup prompt, extensions/, skills/, git
$EDITOR ~/.kl/agents/scout/SYSTEM.md
kl run scout               # starts scout-<adj>-<noun> in tmux and attaches
```

Inside the session, `/exit` runs the agent's cleanup turn (if it has one) and
quits. `/fq` quits immediately.

## Day to day

```bash
kl sessions              # recent sessions as parent/child trees; * = running
kl resume scout-bright-raven   # start it again (if needed) and attach
kl run reviewer -d --prompt-file brief.md   # detached; prints the new name
kl inbox scout-bright-raven    # a session's inbox
kl agents                # installed agents
kl doctor                # diagnostics
```

## Docs

- [docs/agents.md](docs/agents.md): the agent folder, `agent.yml`, the system
  prompt, cleanup and resets
- [docs/cli.md](docs/cli.md): `kl` and `kl message`, names and how they resolve
- [docs/tools.md](docs/tools.md): the built-in tools and commands, and adding
  your own
- [docs/messaging.md](docs/messaging.md): message delivery, inboxes, parking,
  channels, the daemon
- [docs/install.md](docs/install.md): install, the `~/.kl` layout, the kl Pi dir
- [docs/skills.md](docs/skills.md): skills
- [docs/tmux.md](docs/tmux.md): recommended tmux settings

## Uninstall

```bash
npm unlink -g kiln-lite
mv ~/.kl ~/.kl.bak       # agents, sessions, inboxes, daemon state
```

## License

See [LICENSE](LICENSE).
