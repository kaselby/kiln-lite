# Agents

An **agent** is a folder: a config file, an identity prompt, and whatever
else you give it. **A session** is one run of an agent: a Pi conversation
with its own name (`scout-bright-raven`), transcript and inbox. `kl run scout`
starts a new session of the agent `scout`; many sessions of one agent can run
at once. Sessions are covered in [sessions.md](sessions.md); what kl adds to
a running session (the system prompt, timestamps, extensions) is in
[harness.md](harness.md).

Agents live at `$KL_AGENTS_DIR/<name>/` (default `<kl root>/agents/<name>/`,
so `~/.kl/agents/<name>/`). Agents differ only in what their folder holds.

kl has no persistence code. A "persistent" agent is an agent whose folder
has memory files, a `prompt.extra_sections` entry that puts them in the
prompt, and a cleanup prompt that asks it to update them before it exits.
`kl init --full` sets that up; everything else is the same as for any
agent.

## The folder

| path | what it is |
|---|---|
| `agent.yml` | config (below). `kl agents` and the `subagent` tool only list folders that have one. |
| `IDENTITY.md` | identity prompt, used when `prompt.identity` isn't set |
| `extensions/` | the agent's own Pi extensions |
| `skills/` | the agent's own skills; see [skills.md](skills.md) |
| `hooks/pre-launch` | optional executable run before every launch |

Anything else (memory files, prompts, scratch space) is the agent's own
business; kl only reads what `agent.yml` points at. Transcripts, inboxes
and the session registry live in the kl folder, not here; see
[config.md](config.md).

**The agent's name** is `name:` in `agent.yml`, or the folder name if
that's unset. It must match `[a-z][a-z0-9_]*`, because session names are
`<name>-<adj>-<noun>`. `kl run <name>` and the `subagent` tool find the
agent by folder name, so keep the two the same.

## `kl init`

`kl init <name>` creates `$KL_AGENTS_DIR/<name>/` with an `agent.yml`
(`name`, an empty `description`, and the optional keys commented out) and a
`IDENTITY.md` holding only an HTML comment, so the agent has the built-in
identity until you write one. It refuses a name that's taken.
`kl new` is the same command.

`kl init <name> --full` also creates:

```
memory/MEMORY.md     empty; injected as the <memory> section
memory/sessions/     where the cleanup prompt asks for session summaries
prompts/cleanup.md   the cleanup prompt
extensions/
skills/
scratch/
.git                 git init, if git is installed
```

and adds to `agent.yml`:

```yaml
cleanup: { path: prompts/cleanup.md }
prompt:
  extra_sections:
    - {name: memory, path: memory/MEMORY.md}
```

The cleanup prompt asks the agent to write a summary to
`memory/sessions/<date>-<session name>.md`, update anything in `memory/`
that should outlast the session, then stop.

## agent.yml

Settings come from two files: `<kl root>/config.yml` (defaults for every
agent; see [config.md](config.md)), then the agent's `agent.yml`. A
top-level key in `agent.yml` replaces the global value; `prompt:` merges
one key at a time. An unknown key, or a value of the wrong type, prints a
warning and is ignored.

```yaml
name: scout
description: Reviews PRs for the web team.
model: openai-codex/gpt-5.6-luna
thinking: medium
prompt:
  identity: IDENTITY.md
  extra_sections:
    - {name: memory, path: memory/MEMORY.md}
cleanup: { path: prompts/cleanup.md }
```

| key | where | default | meaning |
|---|---|---|---|
| `name` | agent.yml only | folder name | the agent name, `[a-z][a-z0-9_]*` |
| `description` | agent.yml only | none | one line shown by `kl agents` and in the `subagent` tool's agent list |
| `model` | both | Pi's | `provider/id`, optionally with a `:<thinking>` suffix |
| `thinking` | both | Pi's | `off` `minimal` `low` `medium` `high` `xhigh` `max` |
| `prompt` | both | | what goes into the system prompt; see [harness.md](harness.md#the-system-prompt) |
| `cleanup` | both | none | the cleanup prompt, inline or `{path: ...}`; see [sessions.md](sessions.md#exiting) |
| `timestamps` | both | on | see [harness.md](harness.md#timestamps) |
| `session_state_interval` | both | `15` | tool calls between `[Session state]` lines; `0` turns them off |
| `pi_extensions` | both | `true` | load base Pi's global extensions (`~/.pi/agent/extensions/`) too |
| `user_name` | config.yml only | `user` | see [config.md](config.md) |

`model` and `thinking` apply to new sessions when you don't pass `--model`
or `--thinking` yourself; a resumed session keeps what it last used.

## Hooks

If `hooks/pre-launch` exists and is executable, kl runs it before starting
pi: for a new session (`kl run`, the `subagent` tool, `/spawn`) and when
`kl resume` or `kl attach` starts a session that isn't running. It runs in
the session's working directory with `AGENT_HOME`, `AGENT_NAME` (the agent)
and `KL_NAME` (the session name about to be used) set. A non-zero exit
cancels the launch and kl prints the hook's output. kl holds the name lock
while the hook runs, so it has a 30 s timeout; keep it quick.
