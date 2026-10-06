# Tools and commands

The tools kl gives every session, as the model sees them, kl's slash
commands, and how an agent adds tools of its own. A tool that fails returns
an error result with the message shown.

## message

Send DMs and broadcasts, manage subscriptions, read mail. How delivery
works is in [messaging.md](messaging.md).

| param | used by | meaning |
|---|---|---|
| `action` | all | `send`, `subscribe`, `unsubscribe`, `channels`, `history` |
| `to` | send, history | a session ([name forms](cli.md#session-names)) |
| `channel` | send, subscribe, unsubscribe, history | channel name, without `#` |
| `summary`, `body` | send | both required |
| `priority` | send | `normal` (default) or `high` |
| `limit` | history | newest messages to show, default 20 |

- **send** takes `to` or `channel`, not both. Returns `sent to <name>`, the
  `parked: …` reply, or `Message broadcast to channel '<c>' (N
  recipient(s)).`
- **subscribe**, **unsubscribe** take only `channel`. Subscriptions end when
  the session does.
- **channels** lists every channel, as `kl message channels` does.
- **history** with `channel` reads the channel's history; with `to`, the
  session's inbox (`new` = not yet given to it). Oldest first.

## sessions

`{name?, all?, limit?}`. With no `name`: recent sessions as parent/child
trees, running ones marked, with busy/idle and what each is doing. With
`name`: that session in full. The same text as `kl sessions`; see
[cli.md](cli.md#commands).

## plan

`{goal, tasks, project?, worktree?}`, where `tasks` is a list of
`{description, status}` and `status` is `pending`, `in_progress` or `done`.
Each call replaces the whole plan. `project` and `worktree` keep their
previous value when omitted, and `""` clears them. Returns `Plan updated. 2/5
done, 1 in progress, 2 pending.`

The plan is saved to `<kl root>/run/plans/<session uuid>.json` and shown by
`kl sessions` and the `sessions` tool. Every 15 tool calls without a plan
update, while a task is `in_progress`, kl appends a `[Plan]` summary to a
tool result.

## schedule

Wake this session later. The wake is a message to its own inbox, from its
own name, with summary `Scheduled wake` (or `Watched process <pid>
exited`) and the note as its body, delivered like any other mail.

| action | params | does |
|---|---|---|
| `at` | `delay` (`30s`, `10m`, `2h`, `1d`) or `time` (ISO 8601 with a timezone), `note?` | fire once, at that time |
| `watch` | `pid`, `note?` | fire when the process exits (checked every 2 s) |
| `list` | | pending wakes, whether each worker is alive, any delivery error |
| `cancel` | `id` | remove a wake |

`at` and `watch` return `Wake <id> scheduled: fires … Worker pid <n>.` Each
wake is a record in `<kl root>/run/schedule/<session uuid>/` plus a small
detached process that waits and then delivers. If the session has exited,
the wake parks in its inbox. Wakes don't survive a reboot. Delivery is
tried 3 times, after which the error is kept and shown by `list`.

## subagent

`{agent, prompt, wait?}`. Starts a new session of an installed agent (the
tool description lists up to 15 of them), in its own tmux session, as a
child of this one, in this session's working directory. Its first message
is `prompt`, after a line telling it who launched it and to send results
back with the `message` tool.

- Returns `Launched subagent <name> (agent <agent>). It will message you
  when done.` at once.
- `wait: true` blocks until a message from the child arrives (`its message
  arrived`), the child goes idle (`it went idle without messaging you`) or
  exits (`it exited without messaging you`). Interrupting stops the wait,
  not the child.
- The child's results come back as ordinary mail.

The lifecycle (the reminder a child gets when a run ends without
messaging its parent, and children being stopped when the parent exits) is
in [sessions.md](sessions.md).

## exit_session

`{skip_cleanup?, continue?, handoff?, autonomous?}`. Exit the session, or
reset its context and keep going in the same session. All default to false.

- `skip_cleanup`: skip the agent's cleanup turn, if it has one.
- `continue`: reset instead of exiting. Only `handoff` stays in context.
- `handoff`: text, or an absolute or `~/` path whose contents are read.
- `autonomous`: after the reset, start working on the handoff right away
  instead of waiting for the next message.

See [agents.md](agents.md) for the cleanup turn and resets.

## Commands

- `/exit`: run the cleanup turn (if the agent has one), then exit. A second
  `/exit` while the cleanup turn runs exits at once.
- `/fq`: exit now, with no cleanup turn.
- `/spawn`: pick one of your earlier messages and fork the session at that
  point into a new session of the same agent, in its own tmux session. The
  fork has everything before that message. It's a separate session, not a
  child, so it keeps running when this one ends.

## Your own tools

kl has no tool format of its own. A tool is a Pi tool: write a Pi extension
that calls `registerTool` and put it in the agent's `extensions/` folder.
kl loads each `*.ts` or `*.js` file there, and each subfolder's
`package.json` `pi.extensions` entries (else its `index.ts` or `index.js`),
in name order, each with its own `-e`. See Pi's `docs/extensions.md`.

Extensions in base Pi's `~/.pi/agent/extensions/` load into kl agents too,
after kl's own and before the agent's. Set `pi_extensions: false` in
`agent.yml` (or `<kl root>/config.yml` for every agent) to leave them out.
Pi packages are installed with `kl install`; see [install.md](install.md).
