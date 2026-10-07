# Agents

This covers what an agent is and everything that belongs to one: its
folder, `agent.yml`, how its system prompt is put together, its skills,
extensions and hooks, and `kl init`. What happens to a running agent
(names, resuming, subagents, exiting) is in [sessions.md](sessions.md).

An agent is a folder at `$KL_AGENTS_DIR/<name>/` (default
`<kl root>/agents/<name>/`, so `~/.kl/agents/<name>/`). Each `kl run <name>` starts a new session of it.
Agents differ only in what their folder holds.

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
top-level key in `agent.yml` replaces the global value outright. The
exception is `prompt:`, which merges one level down: `agent.yml` can set
`include_kl_prompt` and keep the global `identity`. A list inside it, like
`extra_sections`, still replaces the global list. An unknown key, or a
value of the wrong type, prints a warning and is ignored (the lower
layer's value stands). Warnings show on `kl run`'s
stderr and in the session's UI.

| key | where | default | meaning |
|---|---|---|---|
| `name` | agent.yml only | folder name | the agent name, `[a-z][a-z0-9_]*` |
| `description` | agent.yml only | none | one line shown by `kl agents` and in the `subagent` tool's agent list |
| `model` | both | Pi's | `provider/id`, optionally with a `:<thinking>` suffix |
| `thinking` | both | Pi's | `off` `minimal` `low` `medium` `high` `xhigh` `max` |
| `prompt` | both | below | what goes into the system prompt |
| `cleanup` | both | none | the cleanup prompt: inline text, or `{path: ...}` |
| `timestamps` | both | on | `false`, `true`, or a mapping (below) |
| `session_state_interval` | both | `15` | tool calls between `[Session state]` lines; `0` turns them off |
| `pi_extensions` | both | `true` | load base Pi's global extensions (`~/.pi/agent/extensions/`) too |
| `user_name` | config.yml only | `user` | see [config.md](config.md) |

**Paths.** `prompt.identity` and `prompt.extra_sections[].path` are
relative to the folder of the file that sets them, so a global section can
point into the kl folder and an agent's into its own. A `cleanup` path is
always relative to the agent folder, even when set in `config.yml`.

**model and thinking** apply only to new sessions, and only when you don't
pass `--model` or `--thinking` to `kl run` yourself. `thinking` is also
skipped when the model carries a `:<thinking>` suffix. A resumed session
keeps the model and thinking level it last used (see
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

```yaml
prompt:
  identity: IDENTITY.md          # default: IDENTITY.md in the agent folder if present
  include_kl_prompt: true        # kl's <harness> block
  include_appended_prompt: true  # Pi's <addendum>
  include_project_context: true  # Pi's <project_context>
  extra_sections:                # none by default
    - {name: memory, path: memory/MEMORY.md}
```

kl writes the top of the prompt and leaves the rest to Pi. In order:

1. The identity prompt: the `identity` file. If there is none, the file is
   missing (that warns), or it's empty once comments are stripped, the
   agent gets "You are <name> - an expert coding assistant operating
   inside pi..."
2. `<harness>`, holding three parts:
   - the baseline, `prompts/kl-baseline.md` in the repo;
   - `<tools>`: one line per active tool that has a prompt snippet;
   - `<rules>`: the active tools' guidelines, deduplicated. Pi's own
     built-in rules are not included.

   `include_kl_prompt: false` drops the whole block, `<tools>` and
   `<rules>` included. The identity then stands alone at the top, so
   that plus your own identity file is how you replace kl's prompt.
3. Pi's sections: `<addendum>` (`APPEND_SYSTEM.md` in the kl Pi dir, or
   `--append-system-prompt`; `include_appended_prompt: false` drops it),
   `<project_context>` (`AGENTS.md` and similar from the working
   directory; `include_project_context: false` drops it), `<skills>`,
   `<cwd>`, and any sections other extensions add.
4. `<session>`: the agent name, session name, model, agent folder and
   inbox path.
5. One `<name>` block per `extra_sections` entry, in order.

HTML comments are stripped from the identity prompt and the baseline, so
use them for notes to yourself. kl edits Pi's prompt options rather than
replacing the prompt, which is why other extensions' sections survive.

kl reads the identity, the baseline and the extra sections when the
session starts or resumes, and again at each reset (`exit_session` with
`continue`).

**Baseline placeholders.** The baseline can use `{{kl_docs}}` (this
`docs/` folder), `{{pi_readme}}`, `{{pi_docs}}` and `{{pi_examples}}` (in
the Pi install that's running). Each becomes an absolute path. An unknown
or unresolvable placeholder warns and is left as written.

**extra_sections.** Each entry is `{name, path}` (the file's contents) or
`{name, command}` (the command's stdout):

```yaml
prompt:
  extra_sections:
    - {name: memory, path: memory/MEMORY.md}
    - {name: today, command: "date +%A"}
```

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
