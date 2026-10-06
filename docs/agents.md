# Agents

This covers what an agent is and everything that belongs to one: its
folder, `agent.yml`, how its system prompt is put together, its skills,
extensions and hooks, and `kl init`. What happens to a running agent
(names, resuming, subagents, exiting) is in [sessions.md](sessions.md).

An agent is a folder at `$KL_AGENTS_DIR/<name>/` (default
`~/.kl/agents/<name>/`). Each `kl run <name>` starts a new session of it.
Agents differ only in what their folder holds.

kl has no persistence code. A "persistent" agent is an agent whose folder
has memory files, a `sections:` entry that puts them in the prompt, and a
cleanup prompt that asks it to update them before it exits. `kl init
--full` sets that up; everything else is the same as for any agent.

## The folder

| path | what it is |
|---|---|
| `agent.yml` | config (below). `kl agents` and the `subagent` tool only list folders that have one. |
| `SYSTEM.md` | identity prompt, used when `system_prompt` isn't set |
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
`SYSTEM.md` holding only an HTML comment. It refuses a name that's taken.
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
sections:
  - {name: memory, path: memory/MEMORY.md}
```

The cleanup prompt asks the agent to write a summary to
`memory/sessions/<date>-<session name>.md`, update anything in `memory/`
that should outlast the session, then stop.

## agent.yml

Settings come from two files: `<kl root>/config.yml` (defaults for every
agent; see [config.md](config.md)), then the agent's `agent.yml`. A
top-level key in `agent.yml` replaces the global value outright, so
`sections:` in `agent.yml` replaces the global list rather than adding to
it. An unknown key, or a value of the wrong type, prints a warning and is
ignored (the lower layer's value stands). Warnings show on `kl run`'s
stderr and in the session's UI.

| key | where | default | meaning |
|---|---|---|---|
| `name` | agent.yml only | folder name | the agent name, `[a-z][a-z0-9_]*` |
| `description` | agent.yml only | none | one line shown by `kl agents` and in the `subagent` tool's agent list |
| `model` | both | Pi's | `provider/id`, optionally with a `:<thinking>` suffix |
| `thinking` | both | Pi's | `off` `minimal` `low` `medium` `high` `xhigh` `max` |
| `system_prompt` | both | `SYSTEM.md`, if the agent folder has one | the identity prompt file |
| `project_context` | both | `true` | `false` drops `AGENTS.md`/`CLAUDE.md` from the prompt |
| `sections` | both | none | extra prompt sections (below) |
| `cleanup` | both | none | the cleanup prompt: inline text, or `{path: ...}` |
| `timestamps` | both | on | `false`, `true`, or a mapping (below) |
| `session_state_interval` | both | `15` | tool calls between `[Session state]` lines; `0` turns them off |
| `pi_extensions` | both | `true` | load base Pi's global extensions (`~/.pi/agent/extensions/`) too |
| `user_name` | config.yml only | `user` | see [config.md](config.md) |

**Paths.** `system_prompt` and `sections[].path` are relative to the folder
of the file that sets them, so a global section can point into the kl
folder and an agent's into its own. A `cleanup` path is always relative to
the agent folder, even when set in `config.yml`.

**model and thinking** apply only to new sessions, and only when you don't
pass `--model` or `--thinking` to `kl run` yourself. `thinking` is also
skipped when the model carries a `:<thinking>` suffix. A resumed session
uses the model and thinking level it started with (see
[sessions.md](sessions.md#resuming)).

**timestamps.** With timestamps on, each user turn gets a hidden
`[time: Thu, Jun 18, 2026, 15:42 PDT · 2h 13m since last timestamp]`
message, and during long runs of tool calls a tool result gets the same
line every `every_calls` calls or `every_minutes` minutes, whichever comes
first. A mapping overrides any of the defaults
`{per_turn: true, every_calls: 20, every_minutes: 10}`; `0` turns a
periodic trigger off.

**cleanup** is read when it's used, not at session start, so edits to the
file during a session apply. HTML comments in it are dropped. An empty or
missing cleanup prompt means no cleanup turn. How the turn runs is in
[sessions.md](sessions.md#exiting).

## The system prompt

kl writes the top of the prompt and leaves the rest to Pi. In order:

1. The identity prompt (`system_prompt`, usually `SYSTEM.md`).
2. The kl baseline, `prompts/kl-baseline.md` in the repo.
3. `<tools>`: one line per active tool that has a prompt snippet.
4. `<rules>`: the active tools' guidelines, deduplicated. Pi's own
   built-in rules are not included.
5. Pi's sections: `<addendum>` (`APPEND_SYSTEM.md` in the kl Pi dir, or
   `--append-system-prompt`), `<project_context>` (`AGENTS.md` and
   similar from the working directory), `<skills>`, `<cwd>`, and any
   sections other extensions add.
6. `<session>`: the agent name, session name, model, agent folder and
   inbox path.
7. One `<name>` block per `sections:` entry, in order.

HTML comments are stripped from the identity prompt and the baseline, so
use them for notes to yourself. kl edits Pi's prompt options rather than
replacing the prompt, which is why other extensions' sections survive.
`<session>` is refreshed every turn, so a `/model` change shows up there.

**Baseline placeholders.** The baseline can use `{{kl_docs}}` (this
`docs/` folder), `{{pi_readme}}`, `{{pi_docs}}` and `{{pi_examples}}` (in
the Pi install that's running). Each becomes an absolute path. An unknown
or unresolvable placeholder warns and is left as written.

**sections.** Each entry is `{name, path}` (the file's contents) or
`{name, command}` (the command's stdout):

```yaml
sections:
  - {name: memory, path: memory/MEMORY.md}
  - {name: today, command: "date +%A"}
```

- Sections are rendered once, at session start. Edits to the file show up
  in the next session, not after a reset.
- A command runs in the folder of the file that declared it, with the
  session's [environment](sessions.md#environment), a 1 s timeout and a
  64 KiB output limit.
- A missing file or a failing command warns and drops that section. Empty
  output drops it silently.
- Names must match `[a-z][a-z0-9_-]*`, be unique, and can't be `preamble`,
  `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`
  or `session`.

## Extensions

kl passes Pi these extensions, each with its own `-e`, in this order:

1. kl's own extension.
2. Base Pi's global extensions in `~/.pi/agent/extensions/`, unless
   `pi_extensions: false`.
3. The agent's `extensions/`.

In each folder kl takes `*.ts` and `*.js` files (not `*.d.ts`), and for each
subfolder the entries listed under `pi.extensions` in its `package.json`,
else its `index.ts` or `index.js`. Entries are sorted by name; dotfiles and
`node_modules` are skipped. Pi packages installed with `kl install` load as
well; see [install.md](install.md).

[`examples/extensions/guardrails.ts`](../examples/extensions/guardrails.ts)
is an example agent extension, and [`example/`](../example/) is a larger
agent setup.

## Hooks

If `hooks/pre-launch` exists and is executable, kl runs it before starting
pi: for a new session (`kl run`, the `subagent` tool, `/spawn`) and when
`kl resume` or `kl attach` starts a session that isn't running. It runs in
the session's working directory with `AGENT_HOME`, `AGENT_NAME` (the agent)
and `KL_NAME` (the session name about to be used) set. A non-zero exit
cancels the launch and kl prints the hook's output. kl holds the name lock
while the hook runs, so it has a 30 s timeout; keep it quick.
