---
name: kl-agents
description: How to find, start and work with other kl agents and sessions. Use when launching a subagent or peer, checking what other sessions are doing, resuming a stopped session, looking at another agent's setup, or creating or changing an agent.
---

# Agents and sessions

An **agent** is a folder with an `agent.yml`: its identity prompt, model,
extensions and skills. A **session** is one run of an agent, with its own
name (`scout-bright-raven`), transcript and inbox. One agent can have many
sessions, running or stopped, and any stopped session can be resumed. Each
session is wrapped in a tmux session.

Your identity prompt may include instructions about what agents you are
allowed to spawn - if so follow those guidelines.

To create or change an agent, read `references/defining-agents.md`.

## Finding out what's there

- `kl agents` lists the installed agents with their descriptions. The
  `subagent` tool's description lists them too.
- The `sessions` tool shows recent sessions as parent/child trees: which
  are running, busy or idle, and what each is doing (its plan goal or
  status). Give it a name for one session in full: its plan, inbox, working
  directory and transcript.
- An agent's setup is plain files in its folder (`$AGENT_HOME` is yours),
  so read them directly.

## Subagents

Kiln-lite subagents are simply regular agent sessions whose lifecycle is
tied to yours. They communicate with the message tool like any other session.
Spawn them with the `subagent` tool. Leaving agent unset uses the default
worker agent - this should be your default unless specified otherwise.

Remember:

**The prompt is all it gets.** Its first message is your `prompt`, and it
starts with none of your context. Say what to do, where to look, and what
to send back.

**Results come back only as messages.** The tool returns the child's name
at once. Keep working and its message arrives like any other mail, or pass
`wait: true` to block until it messages you, goes idle, or exits.

**Lifetime.** Your children are stopped when you exit. A stopped child
keeps its transcript and can be resumed with `kl resume`.

## Peers

You can also simply use bash to spawn peer sessions directly, with
`kl run <agent> --prompt-file brief.md`. These are peer sessions not
directly tied to your lifecycle - prefer subagents unless the user
specifies otherwise.

## Resuming

`kl resume <session>` restarts a stopped session from its transcript, in
the background, under its old name if that's free. It picks up its agent
folder as it is now, plus any mail that came while it was down. Sending a
message to a stopped session with `wake: true` automatically resumes it.

## Your own session

- **Plan.** For multi-step work, keep the `plan` tool current. Other
  sessions and the user see your goal and progress in `sessions`.
- **Exiting.** `exit_session` ends your session when you're working on your
  own, after your agent's cleanup turn if it has one.

For the full details on names, resuming, subagent lifecycle and agent
configuration, read `sessions.md` and `agents.md` in kl's docs folder (its
path is in your system prompt).
