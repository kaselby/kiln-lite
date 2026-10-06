# Sessions

This covers what happens to a running agent: how a session gets its name,
how it starts, resumes and ends, how subagents work, and how kl tracks what
each session is doing. The commands themselves are in [cli.md](cli.md);
the agent folder and prompt are in [agents.md](agents.md).

## Names and the registry

A session is a Pi session, identified by its UUID. The name
(`scout-bright-raven`) is a handle for it. kl draws a name when a session
starts: `<agent>-<adjective>-<noun>`, never used by a running session and
avoiding names used in the last three weeks. A name can be reused after
that, which is why mail, plans and status files are keyed by UUID. How
names resolve (`name@<id>`, agent names) is in
[cli.md](cli.md#session-names).

Each session has two files in the kl folder ([config.md](config.md)):

- **Registry entry**, `run/sessions/<uuid>.yml`: the agent, the current
  name and every name it has run under, the agent folder, the transcript
  path, the working directory, the parent's UUID, and the creation time.
  The session's own process writes it when it starts. It is never removed.
- **Lease**, `run/leases/<uuid>.json`: the process id, its start time,
  the name, the tmux session, and `busy` or `idle`. The running process
  writes it and removes it when it exits. A session counts as running only
  if the lease's process is alive and is the same process (start time and
  boot match), so a crashed session's leftover lease reads as not running.

kl refuses to start a second process on a transcript that's already
running.

## Starting

**`kl run`** draws a name, runs the agent's
[pre-launch hook](agents.md#hooks), and starts pi in a detached tmux
session with that name in the current directory, then attaches. kl builds
the pi command line from the agent folder: its extensions, its skills, its
`model` and `thinking`, and `-a` so pi doesn't stop to ask whether to
trust the directory. Your own arguments come last.

**Detach guard.** Inside a kl session (where `SESSION_UUID` is set, which
includes anything an agent runs from its bash tool), `kl run`, `kl resume`
and `kl attach` never attach. They act as `--detach`, print the name, and
say so on stderr. Attaching would take over the agent's own terminal.

**`/spawn`** forks the current session. Pick a message; the new session
holds everything before it, gets its own name and tmux session, and runs
alongside this one. It's not a child, so it keeps running when this session
ends. It is started from this session's agent folder (`$AGENT_HOME`),
like `kl run`. Its first turn gets a hidden note saying it was forked.

Pi's in-session `/new`, `/fork` and `/resume` also work. The session they
switch to keeps its last name if nothing running holds it, else gets a
fresh one.

## Resuming

`kl resume <session>` and `kl attach <session>` do the same thing: if the
session is running, attach to it; if not, start it again from its
transcript, then attach. Starting it again:

- uses the session's last name, unless a running session holds it, in
  which case it gets a fresh name for this run (added to its registry
  entry);
- runs in the session's recorded working directory, or the agent folder if
  that's gone;
- keeps the model and thinking level the session last used (pi reads
  them from the transcript, so a `/model` change sticks), unless you pass
  `--model` or `--thinking`;
- keeps the identity, baseline and extra sections the transcript recorded
  ([agents.md](agents.md#the-system-prompt)); everything else (config,
  extensions, Pi's project context and skills) comes from the agent folder
  as it is now;
- runs the pre-launch hook, and waits up to 20 s for the new process to
  write its lease;
- gives the first turn a hidden note that the session was resumed and time
  may have passed.

A session that never exchanged a message has no transcript and can't be
resumed. Mail that arrived while a session was down is delivered when it
starts; see [messaging.md](messaging.md).

A message to a session that isn't running is kept in its inbox until
someone resumes it, and so is a wake from the `schedule` tool. The one
exception is a DM sent with `--wake` (or `wake: true` on the `message`
tool), which starts the session detached, as `kl resume -d` would; see
[messaging.md](messaging.md#sending).

## Subagents

The `subagent` tool starts a session of another agent as a child of this
one:

- **agent**: an agent folder under `$KL_AGENTS_DIR` with an `agent.yml`.
  The tool's description lists them (up to 15, with descriptions).
- **prompt**: the child's first message. kl puts a line before it saying
  who launched it and to send results with the `message` tool, to the
  parent's name.
- **wait** (default `false`): return at once with the child's name, or
  block until a message from the child arrives in the parent's inbox, the
  child goes idle after working, or it exits. Interrupting stops the wait;
  the child keeps running.

The child starts like `kl run --detach`, in the parent's working
directory, with the parent's UUID as its parent. `kl run --parent
<session>` sets the same link by hand.

**Results come back only as messages.** The tool returns the child's name,
never its output. If a child with a parent finishes a turn without
successfully sending its parent a message, it gets one visible reminder
and keeps going; the reminder doesn't fire during its cleanup turn.

**When the parent ends**, it sends SIGTERM to each of its children that's
still running. Children are not stopped when the parent resets its
context, and not if the parent's process dies without shutting down. A
stopped child keeps its transcript and parent link, and can be resumed.

## Exiting

- **`/exit`** runs the cleanup turn, if the agent has a
  [`cleanup:` prompt](agents.md#agentyml), then exits. A second `/exit`
  while the cleanup turn is running exits at once.
- **`/fq`** exits without the cleanup turn. So do Pi's `/quit`, Ctrl+C
  twice and Ctrl+D, which Pi handles before kl sees them.
- **`exit_session`** is the tool form of `/exit`, for an agent working on
  its own. `skip_cleanup: true` skips the cleanup turn.

The cleanup turn is the cleanup prompt sent as a user message once the
current turn ends. The session exits when that turn ends. Messages that
arrive meanwhile stay in the inbox for the next start (or, for a reset,
until the reset is done).

**Resets.** `exit_session` with `continue: true` resets the context instead
of exiting. After the cleanup turn (if any), the model sees only the system
prompt, the `handoff` text, and whatever comes next. `handoff` is text, or
an absolute or `~/` path to a file whose contents are used. With
`autonomous: true` the session starts a new turn right away with a short
user message from kl, visible in the transcript, telling the model to carry
on from the handoff; otherwise it waits for the next message. The session keeps its name, UUID, transcript, inbox, plan
and children. The reset rereads the identity, baseline and extra sections,
so the new context sees what the cleanup turn wrote.

## What a session is doing

**Plans.** The `plan` tool writes `run/plans/<uuid>.json`:

```json
{ "goal": "...", "project": "...", "worktree": "...",
  "tasks": [{ "description": "...", "status": "pending|in_progress|done" }],
  "updated_at": "ISO time" }
```

Each call replaces the task list. `project` and `worktree` are optional
and kept from the last call if omitted (`""` clears them). While a task is
in progress, every 15th tool result carries a `[Plan]` summary until the
plan is updated.

**Session state.** Every `session_state_interval` tool calls, a tool result
gets a line like `[Session state] context: 97k/200k | inbox: 2 unread`.

**`kl sessions` and the `sessions` tool** show the same thing: recent
sessions as parent/child trees, `*` for running ones, busy or idle, and a
DOING column. DOING is the plan goal and progress (`2/5`), or the summary
from a status file. Given a session, they show it in full: state, parent
and children, working directory, agent folder, transcript, inbox counts,
status, and the plan with every task.

## Status files

A status file, `run/status/<uuid>.json`, lets a tool outside kl say what a
session is doing, for example a memory tool naming the thread a session
is on. kl only reads it; nothing in kl writes one. Without one, DOING
comes from the plan.

```json
{ "summary": "fixing the login bug", "detail": "any text, any length", "updated_at": "2026-10-06T15:00:00Z" }
```

- `summary` (string, required) replaces the plan goal as DOING. Only its
  first line is shown, cut to 60 characters.
- `detail` (string, optional) is shown in the full view, above the plan.
- `updated_at` (ISO time, optional) is shown next to the status.
- A file that isn't JSON, or has no string `summary`, is ignored.
- Write it atomically (a temp file, then rename), named by the session's
  UUID (`$SESSION_UUID` inside the session).
- The writer owns it and should delete it when it no longer applies. One
  left behind after the session ends does no harm; kl doesn't remove it,
  just as it keeps plans, since the session can be resumed.

## Environment

kl sets these in the session's process; its tools and commands inherit
them:

| var | value |
|---|---|
| `AGENT_HOME` | the agent folder |
| `AGENT_NAME` | the agent name (`scout`) |
| `AGENT_ID` | the session name (`scout-bright-raven`) |
| `SESSION_UUID` | the session's UUID |
| `KL_INBOX` | the session's inbox, `<kl root>/run/inbox/<uuid>/` |
