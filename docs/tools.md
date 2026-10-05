# Tools and commands

## Built-in tools

Every kl session has these, next to Pi's own tools:

- **message**: send a DM (`to`: a session name, see [cli.md](cli.md)) or a
  channel broadcast, or subscribe/unsubscribe to a channel. The result says
  whether the message was delivered (`sent to X`) or parked because X isn't
  running. See [messaging.md](messaging.md).
- **subagent** `{agent, prompt, wait?}`: start a new session of an installed
  agent (the tool description lists them) as a child of this one, with
  `prompt` as its first message. The child is told to send its results to
  the parent with `message`. Returns the child's name right away; with
  `wait: true` it blocks until the child messages you, goes idle, or exits.
  A child that finishes a run without messaging its parent gets one
  reminder. Children are stopped when the parent exits for good. They stay
  resumable, and `kl attach <child>` works.
- **schedule** `{action: at|watch|list|cancel, ...}`: wake yourself later.
  `at` takes `delay` (`30s`, `10m`, `2h`, `1d`) or `time` (ISO 8601);
  `watch` fires when process `pid` exits. The wake arrives as a message to
  your own inbox carrying `note`. Wakes are files under
  `~/.kl/run/schedule/<uuid>/`, each with its own small worker process.
- **plan** `{goal, tasks, project?, worktree?}`: write your working plan
  (each call replaces the task list). Stored at
  `~/.kl/run/plans/<uuid>.json`; while a task is in progress, a one-line
  `[Plan]` summary is appended to a tool result every 15 calls.
- **exit_session** `{skip_cleanup?, continue?, handoff?, autonomous?}`:
  end the session, or reset its context and continue. See
  [agents.md](agents.md#ending-and-resetting).

## Commands

- `/exit`: cleanup turn (if configured), then exit.
- `/fq`: exit now, no cleanup.
- `/spawn`: fork this session at a user message you pick, into a new session
  of the same agent in its own tmux session. The fork is a peer, not a
  child.

## Your own tools

Tools are Pi tools: write a Pi extension that calls `registerTool`, and put
it in the agent's `extensions/` folder. Pi's tool exposure settings decide
whether the model sees a tool directly or finds it through `tool_search`
(kl's Pi settings enable `tool_search` by default). See Pi's
`docs/extensions.md`.

Extensions you put in base Pi's `~/.pi/agent/extensions/` load into kl
agents too, each with its own `-e`, after kl's core and before the agent's
own. To keep them out of an agent, set `pi_extensions: false` in its
agent.yml (or in `~/.kl/config.yml` for all agents). Pi packages are separate:
install them for kl with `kl install` (see [install.md](install.md)).

kl no longer puts shell scripts from a `tools/` folder on PATH or lists them
in the prompt.
