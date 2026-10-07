---
name: kl-agents
description: How to find, start and work with other kl agents and sessions. Use when launching a subagent or peer, checking what other sessions are doing, resuming a stopped session, or looking at another agent's setup.
---

# Agents and sessions

An **agent** is a folder with an `agent.yml`: its identity prompt, model,
extensions and skills. A **session** is one run of an agent, with its own
name (`scout-bright-raven`), transcript and inbox. One agent can have many
sessions, running or stopped, and any stopped session can be resumed.

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

The `subagent` tool starts a session of another agent as your child, in
your working directory. Use it for work you want done and reported back:
a review, a search, a build in parallel.

**Brief it like a colleague.** Its first message is your `prompt`, and it
starts with none of your context. Say why the work matters, what you
already know, where to look, and what to send back. A bare checklist gets
mechanical work.

**Results come back only as messages.** The tool returns the child's name
at once. Keep working and its message arrives like any other mail, or pass
`wait: true` to block until it messages you, goes idle, or exits. Treat
what it reports as a lead to check, not a fact, until you've seen the
evidence.

**Lifetime.** Your children are stopped when you exit. A stopped child
keeps its transcript and can be resumed with `kl resume`.

## Peers

`kl run <agent> --prompt-file brief.md` starts an independent session that
isn't tied to yours and keeps running after you exit. Only start a peer
when the user asks for one. Inside a session, `kl run` always starts
detached and prints the new name; it never takes over your terminal. Pass
the brief as a file so no shell quoting gets in the way.

## Resuming

`kl resume <session>` restarts a stopped session from its transcript, in
the background, under its old name if that's free. It picks up its agent
folder as it is now, plus any mail that came while it was down. To have a
stopped session handle a message straight away, send the message with
`wake: true` instead.

## Your own session

- **Plan.** For multi-step work, keep the `plan` tool current. Other
  sessions and the user see your goal and progress in `sessions`.
- **Exiting.** `exit_session` ends your session when you're working on your
  own, after your agent's cleanup turn if it has one.

For the full details on names, resuming, subagent lifecycle and agent
configuration, read `../../docs/sessions.md` and `../../docs/agents.md`
(relative to this file).
