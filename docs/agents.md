# Agents

An agent is a folder under `$KL_AGENTS_DIR` (default `~/.kl/agents/<name>/`).
Each `kl run <name>` starts a new session of it. Agents differ only in what
their folder holds. There is no "persistent agent" mode in code: memory is a
cleanup prompt plus a section that injects a file.

## The folder

`kl init <name>` creates:

```
agent.yml        config (below)
SYSTEM.md        identity prompt; HTML comments are stripped
```

`kl init <name> --full` adds:

```
memory/MEMORY.md     injected as the <memory> section
memory/sessions/     where the cleanup prompt asks for session summaries
prompts/cleanup.md   the cleanup turn's prompt
extensions/          the agent's own Pi extensions
skills/              the agent's own skills
scratch/
.git                 (git init)
```

kl loads `extensions/*.ts|*.js` and `extensions/<dir>/index.ts|js`, sorted by
name, each with its own `pi -e`. It passes `skills/` with `--skill`. If
`harness/pre-launch` exists and is executable, `kl run` runs it first (with
`AGENT_HOME` set) and aborts the launch if it exits non-zero.

Nothing else lives in the folder at run time. Transcripts, inboxes and the
session registry live under `~/.kl` (see [install.md](install.md)).

## agent.yml

Two layers, merged key by key: `~/.kl/config.yml` (defaults for every
agent), then `agent.yml`. A key in agent.yml replaces the global value
outright (`sections` is replaced as a whole list). Relative paths resolve
against the folder of the file that sets them. Unknown keys warn.

```yaml
name: scout                     # agent.yml only; [a-z][a-z0-9_]*
description: "reviews PRs"    # agent.yml only; shown by kl agents and the subagent tool
model: openai-codex/gpt-5.6-luna
thinking: medium              # off minimal low medium high xhigh max
system_prompt: SYSTEM.md      # identity file; default SYSTEM.md if present
project_context: true         # false drops AGENTS.md/CLAUDE.md
timestamps: true              # false, or {per_turn, every_calls, every_minutes}
session_state_interval: 15    # tool calls between [Session state] lines; 0 = off
cleanup: { path: prompts/cleanup.md }   # or inline text
sections:
  - {name: memory, path: memory/MEMORY.md}
  - {name: today, command: "date +%A"}
```

`model` and `thinking` apply to new sessions only, and only when you don't
pass `--model`/`--thinking` yourself. A resumed session keeps the model
recorded in its transcript.

## The system prompt

kl sets the top of the prompt and leaves the rest to Pi. In order:

1. the identity prompt (`SYSTEM.md`)
2. the kl baseline (`prompts/kl-baseline.md` in the repo), plus tool
   guidelines from the active tools
3. `<addendum>`: Pi's `APPEND_SYSTEM.md`. Put one in `~/.kl/pi/` for text
   every kl agent should get.
4. `<project_context>`: AGENTS.md etc. from the working directory
5. `<skills>`
6. `<cwd>`
7. `<session>`: agent, session name, model, home, inbox path
8. one `<name>` block per `sections:` entry, in order

Sections are rendered once, at session start. A `command` runs in the
folder of the file that declared it, with a 1 s timeout and a 64 KiB cap. A
missing file or a failing command warns and drops that section. Empty
output drops it silently. Section names must match `[a-z][a-z0-9_-]*` and
can't reuse Pi's built-in names or `session`.

Other extensions can still add their own sections. kl edits Pi's prompt
options; it never replaces the prompt wholesale.

## Ending and resetting

- `/exit` (or the `exit_session` tool) runs the cleanup turn, if `cleanup:` is
  set, then exits. `/fq` exits without it.
- `exit_session` with `continue: true` resets the context instead: after
  the cleanup turn, the model sees only the system prompt, your `handoff`
  text, and whatever comes next. It's the same session (same name, transcript,
  inbox and children). `autonomous: true` starts working on the handoff
  right away; otherwise the session waits for the next message.
- When a session exits for good, its running subagents are stopped. They
  stay resumable.

Every user turn gets a hidden `[time: …]` line. Every
`session_state_interval` tool calls, a tool result gets
`[Session state] context: 97k/200k | inbox: 2 unread`.

## Environment

Set in the session's process and inherited by its tools:

| var | value |
|---|---|
| `AGENT_HOME` | the agent folder |
| `AGENT_NAME` | the agent name (`scout`) |
| `AGENT_ID` | the session name (`scout-bright-raven`) |
| `SESSION_UUID` | the Pi session UUID |
| `KL_INBOX` | `~/.kl/run/inbox/<uuid>` |

An example of a larger setup is in [`example/`](../example/), and
[`examples/extensions/guardrails.ts`](../examples/extensions/guardrails.ts)
is an example agent extension.
