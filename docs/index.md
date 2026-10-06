# kiln-lite docs

kiln-lite (kl) runs Pi sessions as named agents that can find and message
each other. Start with the [README](../README.md).

- [agents.md](agents.md): what an agent and a session are, the agent
  folder, `kl init`, `agent.yml` keys, hooks
- [harness.md](harness.md): how the system prompt is built, timestamps,
  which extensions load
- [sessions.md](sessions.md): names and the registry, starting and resuming,
  subagents, exiting and resets, plans and status files, session env vars
- [messaging.md](messaging.md): sending and delivery, parked mail, read
  markers, channels, message files, the daemon
- [cli.md](cli.md): every `kl` and `kl message` command and flag, session
  name resolution, env vars
- [tools.md](tools.md): the built-in tools (message, sessions, plan, schedule,
  subagent, exit_session), /exit /fq /spawn, adding your own tools
- [config.md](config.md): the kl folder (`~/.kl`) layout, what's safe to
  delete, global `config.yml`
- [install.md](install.md): install.sh, `kl install`, `kl migrate`, uninstall
- [skills.md](skills.md): skills
- [tmux.md](tmux.md): recommended tmux settings
